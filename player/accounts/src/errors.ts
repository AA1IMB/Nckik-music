import type { AccountErrorCode, AccountErrorPayload, ProviderId, QualityId } from './types';
import { PROVIDER_LABEL, QUALITY_LABEL } from './types';

/**
 * 统一错误：每个失败点都抛出 AccountError，由 IPC 层转成 { ok:false, error }。
 * 设计原则：
 *   1. code 是给程序看的（switch 用），message 是给用户看的中文整句；
 *   2. 不在渲染层做「code → 文案」映射，避免两处文案漂移；
 *   3. 需要重试的带上 retryAfterMs，UI 据此禁用按钮 N 秒，而不是弹一串 toast。
 */
export class AccountError extends Error {
  readonly code: AccountErrorCode;
  readonly hint?: string;
  readonly retryAfterMs?: number;
  readonly provider?: ProviderId;
  readonly quality?: QualityId;

  constructor(
    code: AccountErrorCode,
    message: string,
    opts: { hint?: string; retryAfterMs?: number; provider?: ProviderId; quality?: QualityId; cause?: unknown } = {}
  ) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
    this.hint = opts.hint;
    this.retryAfterMs = opts.retryAfterMs;
    this.provider = opts.provider;
    this.quality = opts.quality;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }

  toPayload(): AccountErrorPayload {
    const payload: AccountErrorPayload = { code: this.code, message: this.message };
    if (this.hint) payload.hint = this.hint;
    if (this.retryAfterMs) payload.retryAfterMs = this.retryAfterMs;
    return payload;
  }
}

/** 平台名 + 动作前缀，保证所有提示都以「QQ 音乐：」开头，用户知道是哪一侧出问题 */
export function providerError(
  provider: ProviderId,
  code: AccountErrorCode,
  message: string,
  opts: { hint?: string; retryAfterMs?: number; quality?: QualityId; cause?: unknown } = {}
): AccountError {
  return new AccountError(code, `${PROVIDER_LABEL[provider]}：${message}`, { ...opts, provider });
}

/** 音质取不到时的标准文案：带上请求档位与实际可用的档位 */
export function qualityError(
  provider: ProviderId,
  requested: QualityId,
  available: QualityId[],
  code: AccountErrorCode = 'E_QUALITY_UNAVAILABLE'
): AccountError {
  const tail = available.length
    ? `账号目前只能取到「${available.map(q => QUALITY_LABEL[q]).join('、')}」。`
    : '这个账号下没有任何可用档位。';
  return providerError(provider, code, `「${QUALITY_LABEL[requested]}」不可用，${tail}`, { quality: requested });
}

/**
 * 上游错误 → 统一码。上游字段各平台不同，这里只做「按优先级取第一个命中的特征」，
 * 命中不了的落到 fallback，绝不把上游原文直接丢给用户。
 */
export interface UpstreamFailure {
  httpStatus?: number;
  /** 上游业务码（qq: code/message；kugou: error_code/status） */
  code?: number | string;
  message?: string;
  /** 上游自带的「稍后重试」提示（秒或毫秒都可能，统一交给调用方归一化） */
  retryAfterMs?: number;
}

const RISK_PATTERNS = [/risk/i, /verify/i, /captcha/i, /风控/, /异常登录/, /安全验证/];
const RATE_PATTERNS = [/rate.?limit/i, /too.?many/i, /频繁/, /限流/];

export function classifyUpstream(provider: ProviderId, f: UpstreamFailure): AccountError {
  const text = `${f.message || ''} ${f.code ?? ''}`;

  if (f.httpStatus === 429 || RATE_PATTERNS.some(re => re.test(text))) {
    return providerError(provider, 'E_RATE_LIMITED', '请求过于频繁，平台暂时拒绝，请稍后再试。', {
      hint: '一般等待 1～5 分钟后恢复',
      retryAfterMs: f.retryAfterMs ?? 60_000
    });
  }
  if (RISK_PATTERNS.some(re => re.test(text))) {
    return providerError(provider, 'E_RISK_CONTROL', '平台的登录风控拦下了这次操作，请到手机 App 确认登录状态后重试。', {
      hint: '若反复出现，建议改用手机端已登录的 Cookie 导入'
    });
  }
  if (f.httpStatus === 401 || f.httpStatus === 403 || f.code === 401 || f.code === 403) {
    return providerError(provider, 'E_AUTH_REQUIRED', '登录已失效，请重新扫码登录。');
  }
  if (typeof f.httpStatus === 'number' && f.httpStatus >= 500) {
    return providerError(provider, 'E_UPSTREAM_UNAVAILABLE', '平台服务暂时不可用，请稍后重试。', { retryAfterMs: 30_000 });
  }
  return providerError(provider, 'E_UPSTREAM_UNAVAILABLE', '请求失败，请稍后重试。', { retryAfterMs: 10_000 });
}

/** 未知异常兜底：保留原始 message 到日志，但不把它当用户文案 */
export function wrapUnknown(provider: ProviderId, e: unknown, fallbackMessage = '操作失败，请稍后重试。'): AccountError {
  if (e instanceof AccountError) return e;
  const detail = e instanceof Error ? e.message : String(e);
  const err = providerError(provider, 'E_UPSTREAM_UNAVAILABLE', fallbackMessage, { cause: e });
  // 原始原因只进日志，不进用户文案
  Object.defineProperty(err, 'detail', { value: detail, enumerable: false });
  return err;
}

export function errorMessage(e: unknown): string {
  if (e instanceof AccountError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function errorCodeOf(e: unknown): AccountErrorCode {
  return e instanceof AccountError ? e.code : 'E_UPSTREAM_UNAVAILABLE';
}
