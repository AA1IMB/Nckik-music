import type {
  Account,
  Credential,
  LoginWindowHost,
  Logger,
  ProviderId,
  QrPayload,
  QualityId,
  Transport
} from '../types';
import type { AudioAttempt, AudioFetchContext, StreamProvider } from '../stream';
import type { LoginPollResult } from '../loginSession';
import { AccountError, classifyUpstream, providerError, wrapUnknown } from '../errors';

/**
 * Provider 契约
 * ---------------------------------------------------------------------------
 * 一个平台只实现三件事：①扫码登录（出码 / 轮询 / 取消）；②用凭据校验并给出账号；
 * ③按档位取一个直链。其余（状态机计时、凭据加密、多账号切换、降级决策）都在上层，
 * 平台实现里不出现 setTimeout、不自己写文件 —— 换平台只是新增一个文件。
 */

export interface LoginStartResult {
  qr: QrPayload;
  message: string;
}

export interface ProviderPollResult extends LoginPollResult {
  /** 确认那一拍带回凭据；上层立即加密落盘，绝不出主进程 */
  credential?: Credential;
}

export interface ProviderLogin {
  start(): Promise<LoginStartResult>;
  poll(): Promise<ProviderPollResult>;
  cancel(): Promise<void>;
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  readonly login: ProviderLogin;
  readonly stream: StreamProvider;
  /** 用已有凭据校验账号信息（重启后的补验也走这里） */
  verify(credential: Credential): Promise<Account>;
}

/** 官方登录页形式的平台共用配置 */
export interface PageProviderConfig {
  id: ProviderId;
  label: string;
  /** 官方登录页地址：只读它自己出的二维码与 cookie，不伪造任何签名 */
  loginUrl: string;
  /** 独立 session 分区，避免与主窗口、另一个平台共用 cookie */
  partition: string;
  /** 白名单：只读这些名字，其余一律不碰 */
  cookieNames: readonly string[];
  /** 判定「已登录」必须同时具备的名字 */
  requiredCookieNames: readonly string[];
  qrTimeoutMs: number;
  qrTtlMs: number;
  expiredPatterns: readonly RegExp[];
  scannedPatterns: readonly RegExp[];
  /**
   * 合规上游地址（自建开放平台网关 / 官方 API 代理）。
   * 没配置时：校验退化为本地解析 cookie，取流返回 E_NOT_IMPLEMENTED 并给出可读提示。
   */
  upstreamBase?: string;
  userAgent?: string;
}

export interface PageProviderDeps {
  cfg: PageProviderConfig;
  host: LoginWindowHost;
  transport: Transport;
  logger: Logger;
  /** 档位降级链，由具体平台给出 */
  ladder: Record<QualityId, QualityId[]>;
  /** 具体平台的取流实现 */
  fetchAudio: (ctx: AudioFetchContext) => Promise<AudioAttempt>;
  now?: () => number;
}

/** 把「官方页 + 读 cookie + 校验」这段逻辑收敛到一处，平台只补 config 与取流 */
export class PageLoginProvider implements Provider {
  readonly id: ProviderId;
  readonly label: string;
  readonly login: ProviderLogin;
  readonly stream: StreamProvider;

  protected readonly cfg: PageProviderConfig;
  protected readonly host: LoginWindowHost;
  protected readonly transport: Transport;
  protected readonly logger: Logger;
  protected readonly now: () => number;

  constructor(deps: PageProviderDeps) {
    this.cfg = deps.cfg;
    this.host = deps.host;
    this.transport = deps.transport;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.id = deps.cfg.id;
    this.label = deps.cfg.label;
    this.login = { start: () => this.start(), poll: () => this.poll(), cancel: () => this.host.close() };
    this.stream = { id: this.id, ladder: deps.ladder, fetchAudio: deps.fetchAudio };
  }

  /* ---------------- 登录 ---------------- */

  protected async start(): Promise<LoginStartResult> {
    await this.host.open(this.cfg.loginUrl, {
      partition: this.cfg.partition,
      size: { width: 960, height: 720 }
    });
    const deadline = this.now() + this.cfg.qrTimeoutMs;
    while (this.now() < deadline) {
      const image = await this.host.readQrImage();
      if (image && isUsableQr(image)) {
        return { qr: { image, expiresAt: this.now() + this.cfg.qrTtlMs }, message: '请用手机 App 扫码' };
      }
      await sleep(300);
    }
    throw providerError(this.id, 'E_RISK_CONTROL', '登录页没有出现二维码，可能被风控或页面改版，请稍后再试。', {
      hint: '也可以改用「导入已登录 Cookie」'
    });
  }

  protected async poll(): Promise<ProviderPollResult> {
    const cookies = await this.host.readCookies(this.cfg.cookieNames);
    if (this.cfg.requiredCookieNames.every(n => !!cookies[n])) {
      const credential: Credential = {
        cookie: cookiesToHeader(cookies, this.cfg.cookieNames),
        extra: pickExtra(this.id, cookies),
        updatedAt: this.now(),
        verifiedAt: 0
      };
      const account = await this.verify(credential);
      return { phase: 'confirmed', account, credential };
    }

    const text = await this.host.readPageText();
    if (this.cfg.expiredPatterns.some(re => re.test(text))) return { phase: 'expired' };
    if (this.cfg.scannedPatterns.some(re => re.test(text))) return { phase: 'scanned' };
    return { phase: 'waiting' };
  }

  /* ---------------- 校验 ---------------- */

  async verify(credential: Credential): Promise<Account> {
    const fallback = this.localAccount(credential);
    if (!this.cfg.upstreamBase) return fallback;
    try {
      const res = await this.transport.getJson<Record<string, unknown>>(joinUrl(this.cfg.upstreamBase, this.profilePath()), {
        headers: { Cookie: credential.cookie, ...(this.cfg.userAgent ? { 'User-Agent': this.cfg.userAgent } : {}) },
        timeoutMs: 12_000,
        label: `${this.id}:profile`
      });
      const mapped = this.mapProfile(res.body, fallback);
      return { ...mapped, lastLoginAt: this.now() };
    } catch (e) {
      throw this.mapTransportError(e);
    }
  }

  protected profilePath(): string {
    return '/user/detail';
  }

  /** 子类按上游字段映射昵称与头像；缺字段一律回落到 fallback */
  protected mapProfile(_body: Record<string, unknown>, fallback: Account): Account {
    return fallback;
  }

  /** 没有上游时：从 cookie 里取 uid 兜底，昵称等下次有上游再补 */
  protected localAccount(credential: Credential): Account {
    const userId = credential.extra.uid || 'unknown';
    return {
      id: `${this.id}:${userId}`,
      provider: this.id,
      name: 'uid ' + userId,
      userId,
      avatarUrl: '',
      createdAt: this.now(),
      lastLoginAt: this.now()
    };
  }

  protected mapTransportError(e: unknown): AccountError {
    if (e instanceof AccountError) return e;
    const anyErr = e as { status?: number; code?: string | number; message?: string; retryAfterMs?: number };
    if (anyErr && (anyErr.status || anyErr.code)) {
      return classifyUpstream(this.id, {
        httpStatus: anyErr.status,
        code: anyErr.code,
        message: anyErr.message,
        retryAfterMs: anyErr.retryAfterMs
      });
    }
    return wrapUnknown(this.id, e);
  }
}

/* ---------------- 小工具 ---------------- */

export function cookiesToHeader(cookies: Record<string, string>, order: readonly string[]): string {
  const names = new Set(order);
  return Object.entries(cookies)
    .filter(([k, v]) => names.has(k) && !!v)
    .map(([k, v]) => k + '=' + v)
    .join('; ');
}

/** 有的平台把 uid 放 uin（可能自带 o 前缀），有的放 userid / kugouid；这里统一成 uid */
export function pickExtra(provider: ProviderId, cookies: Record<string, string>): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(cookies)) if (v) extra[k] = v;
  const rawUid = cookies.uin || cookies.wxuin || cookies.userid || cookies.kugouid || '';
  const uid = rawUid.replace(/^o/, '');
  if (uid) extra.uid = uid;
  if (provider === 'qq' && cookies.p_skey) extra.g_tk = gtkOf(cookies.p_skey);
  return extra;
}

/** QQ 官网自己用 skey 算 g_tk（hash 约定，不是签名算法，也不用于绕过任何校验） */
export function gtkOf(skey: string): string {
  let hash = 5381;
  for (let i = 0; i < skey.length; i += 1) hash += (hash << 5) + skey.charCodeAt(i);
  return String(hash & 0x7fffffff);
}

/** 页面刚渲染时常见一张约 900 字符的占位白图，真码 base64 通常 4～8KB */
export function isUsableQr(image: string): boolean {
  if (!image) return false;
  if (image.startsWith('data:image/svg')) return image.length > 800;
  return image.length >= 1500;
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
