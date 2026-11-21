import type { Account, Credential, LoginPhase, LoginSnapshot, Logger, ProviderId, QrPayload } from './types';
import { AccountError, providerError, wrapUnknown } from './errors';

/**
 * 扫码登录状态机（平台无关）
 * ---------------------------------------------------------------------------
 * provider 每拍只回「上游现在说什么」，所有计时与终态判断都在这里：
 *   - 轮询间隔由本类给出（retryAfterMs），渲染层不要自己拍脑袋；
 *   - 二维码有自己的过期时刻，到点即 expired，不依赖上游报；
 *   - 「已扫码」之后若 60s 没确认就按超时收尾（酷狗/QQ 都有过扫码后永不报过期的情况）；
 *   - 网络类失败允许连续几次，超过阈值才判失败，避免一次抖动就让用户重扫码；
 *   - generation 用于丢弃上一代晚到的结果（用户点了「重新获取二维码」之后旧结果必须作废）。
 */

export interface LoginPollResult {
  phase: LoginPhase;
  qr?: QrPayload;
  message?: string;
  account?: Account;
  /** 确认那一拍带回的凭据；只在上层落盘时取用，绝不回渲染层 */
  credential?: Credential;
  retryAfterMs?: number;
  error?: AccountError;
}

export interface LoginSessionOptions {
  provider: ProviderId;
  poll(): Promise<LoginPollResult>;
  now(): number;
  logger: Logger;
  /** 默认 2000ms：与 folia-major 的 PROVIDER_LOGIN_POLL_INTERVAL_MS 对齐 */
  intervalMs?: number;
  /** 默认 60000ms：停在「已扫码」多久算超时 */
  scannedHoldMs?: number;
  /** 默认 180000ms：整次登录的总时限 */
  ttlMs?: number;
  /** 默认 2 次：连续网络类失败容忍次数 */
  transientLimit?: number;
  /** 代号：每次重新出码递增，晚到的旧结果直接丢弃 */
  generation?: number;
}

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_SCANNED_HOLD_MS = 60_000;
const DEFAULT_TTL_MS = 180_000;
const DEFAULT_TRANSIENT_LIMIT = 2;

const PHASE_MESSAGE: Partial<Record<LoginPhase, string>> = {
  starting: '正在打开登录页…',
  waiting: '请用手机 App 扫码',
  scanned: '已扫码，请在手机上确认',
  confirmed: '登录成功',
  expired: '二维码已失效，请重新获取',
  cancelled: '已取消登录'
};

export class LoginSession {
  readonly provider: ProviderId;
  readonly generation: number;

  private readonly poll: () => Promise<LoginPollResult>;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly scannedHoldMs: number;
  private readonly ttlMs: number;
  private readonly transientLimit: number;

  private phase: LoginPhase = 'starting';
  private qr: QrPayload | undefined;
  private message = PHASE_MESSAGE.starting as string;
  private error: AccountError | undefined;
  private account: Account | undefined;
  private credential: Credential | undefined;
  private startedAt: number;
  private scannedAt = 0;
  private transientFailures = 0;
  private ended = false;

  constructor(opts: LoginSessionOptions) {
    this.provider = opts.provider;
    this.poll = opts.poll;
    this.now = opts.now;
    this.logger = opts.logger;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.scannedHoldMs = opts.scannedHoldMs ?? DEFAULT_SCANNED_HOLD_MS;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.transientLimit = opts.transientLimit ?? DEFAULT_TRANSIENT_LIMIT;
    this.generation = opts.generation ?? 1;
    this.startedAt = this.now();
  }

  /** 出码成功：进入 waiting */
  opened(qr: QrPayload, message?: string): LoginSnapshot {
    this.qr = qr;
    this.phase = 'waiting';
    this.message = message || PHASE_MESSAGE.waiting!;
    this.startedAt = this.now();
    return this.snapshot();
  }

  /** 出码阶段就失败（例如登录页被风控） */
  fail(err: AccountError | unknown): LoginSnapshot {
    const error = err instanceof AccountError ? err : wrapUnknown(this.provider, err);
    this.phase = error.code === 'E_CANCELLED' ? 'cancelled' : 'failed';
    this.error = error;
    this.message = error.message;
    this.ended = true;
    return this.snapshot();
  }

  /** 用户主动取消（渲染层关面板 / 换平台） */
  cancel(): void {
    if (this.ended) return;
    this.phase = 'cancelled';
    this.message = PHASE_MESSAGE.cancelled!;
    this.ended = true;
  }

  get done(): boolean {
    return this.ended;
  }

  /** 走一拍；已终态时直接回当前快照（幂等，渲染层多调一次也不会重复请求） */
  async tick(): Promise<LoginSnapshot> {
    if (this.ended) return this.snapshot();

    const now = this.now();
    if (now - this.startedAt > this.ttlMs) {
      return this.expire(providerError(this.provider, 'E_LOGIN_TIMEOUT', '登录超时，请重新获取二维码。'));
    }
    if (this.qr && now > this.qr.expiresAt) {
      return this.expire(providerError(this.provider, 'E_QR_EXPIRED', '二维码已失效，请重新获取。'));
    }
    if (this.phase === 'scanned' && this.scannedAt && now - this.scannedAt > this.scannedHoldMs) {
      return this.expire(
        providerError(this.provider, 'E_LOGIN_TIMEOUT', '已扫码但手机端没有确认，请重新扫码。', {
          hint: '确认后 60 秒内没有响应就会自动失效'
        })
      );
    }

    let result: LoginPollResult;
    try {
      result = await this.poll();
    } catch (e) {
      const err = e instanceof AccountError ? e : wrapUnknown(this.provider, e, '网络不稳，正在重试…');
      const transient = err.code === 'E_UPSTREAM_UNAVAILABLE' || err.code === 'E_RATE_LIMITED';
      this.transientFailures += 1;
      if (!transient || this.transientFailures > this.transientLimit) {
        this.logger.warn('扫码轮询失败', { provider: this.provider, attempt: this.transientFailures, code: err.code });
        return this.fail(err);
      }
      this.logger.info('扫码轮询瞬时失败，继续重试', { provider: this.provider, attempt: this.transientFailures });
      this.message = err.message || '网络不稳，正在重试…';
      return this.snapshot();
    }

    this.transientFailures = 0;
    if (result.qr) this.qr = result.qr;
    if (result.retryAfterMs) {
      /* provider 若给了更细的节奏（例如限流），以它为准，但下限仍是 intervalMs */
    }
    if (result.message) this.message = result.message;

    switch (result.phase) {
      case 'confirmed':
        this.phase = 'confirmed';
        this.account = result.account;
        this.credential = result.credential;
        this.message = result.message || PHASE_MESSAGE.confirmed!;
        this.ended = true;
        return this.snapshot();

      case 'scanned':
        this.phase = 'scanned';
        if (!this.scannedAt) this.scannedAt = this.now();
        this.message = result.message || PHASE_MESSAGE.scanned!;
        return this.snapshot();

      case 'waiting':
        this.phase = 'waiting';
        return this.snapshot();

      case 'expired':
        return this.expire(result.error ?? providerError(this.provider, 'E_QR_EXPIRED', '二维码已失效，请重新获取。'));

      case 'cancelled':
        this.cancel();
        return this.snapshot();

      case 'failed':
        return this.fail(result.error ?? providerError(this.provider, 'E_UPSTREAM_UNAVAILABLE', result.message || '登录失败，请稍后重试。'));

      default:
        /* idle / starting 一类不应从 poll 里回来的相位：按等待处理，别把状态机弄坏 */
        return this.snapshot();
    }
  }

  snapshot(): LoginSnapshot {
    const snap: LoginSnapshot = {
      provider: this.provider,
      phase: this.phase,
      message: this.message,
      retryAfterMs: this.ended ? 0 : this.intervalMs
    };
    if (this.qr) snap.qr = this.qr;
    if (this.error) snap.error = this.error.toPayload();
    if (this.account && this.phase === 'confirmed') snap.account = this.account;
    return snap;
  }

  /** 取走确认时带回的凭据（只能用一次） */
  takeCredential(): Credential | null {
    const c = this.credential ?? null;
    this.credential = undefined;
    return c;
  }

  private expire(err: AccountError): LoginSnapshot {
    this.phase = err.code === 'E_QR_EXPIRED' ? 'expired' : 'failed';
    this.error = err;
    this.message = err.message;
    this.ended = true;
    this.logger.info('扫码会话结束', { provider: this.provider, phase: this.phase, code: err.code });
    return this.snapshot();
  }
}
