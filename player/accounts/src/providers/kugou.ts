import { createHash, randomBytes, randomUUID } from 'crypto';
import type { Account, Credential, Logger, ProviderId, QualityId, Transport } from '../types';
import type { AudioAttempt, AudioFetchContext, StreamProvider } from '../stream';
import { AccountError, classifyUpstream } from '../errors';
import type { Provider, ProviderPollResult } from './base';

/**
 * 酷狗音乐：官方 App 扫码（客户端通道）
 * ---------------------------------------------------------------------------
 * 与 QQ 音乐 App 扫码同一形态：二维码由平台签发、手机 App 确认，我们只读结果，
 * 不伪造任何签名、不逆向私有协议。
 *
 * 三个接口（都是 login-user.kugou.com，web 签名，参数按键名排序后拼接）：
 *   1. /v2/qrcode                  出码，返回 qrcode(key) 与 qrcode_img(data:image/png)
 *   2. /v2/get_userinfo_qrcode     轮询：status 0 过期 / 1 等待 / 2 已扫待确认 / 4 授权成功
 *   3. status=4 时同一响应里给 token + userid —— 这是**客户端 token**，
 *      会员权益按 appid 1001/1005 + 设备 mid/dfid 发放，付费曲才有直链。
 *
 * 为什么不用网页登录页：网页登录抓到的 web 会话 token 在 trackercdn 上不算会员凭证，
 * 付费曲固定回 20018 / priv_status 0（见方案文档 §十四）。客户端 token 才有权益。
 */

const WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const API = 'https://login-user.kugou.com';
const APPID = '1001';
const SRCAPPID = '2919';
const CLIENTVER = '20489';
const H5_QR = 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1005&';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const LADDER: Record<QualityId, readonly QualityId[]> = {
  standard: ['standard'],
  high: ['high', 'standard'],
  lossless: ['lossless', 'high', 'standard'],
  hires: ['hires', 'lossless', 'high', 'standard']
};

const QUALITY_PARAM: Record<QualityId, string> = {
  standard: '128',
  high: '320',
  lossless: 'flac',
  hires: 'high'
};

function md5(s: string): string {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

/** 客户端 mid：官方实现是 md5(guid) 的十六进制大整数转十进制串 */
function midOf(guid: string): string {
  return BigInt('0x' + md5(guid)).toString();
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

interface KugouDeps {
  transport: Transport;
  logger: Logger;
  now?: () => number;
  /** 兼容旧装配（网页登录时代传过 hidden host）；本实现不需要窗口 */
  host?: unknown;
  upstreamBase?: string;
}

export class KugouProvider implements Provider {
  readonly id: ProviderId = 'kugou';
  readonly label = '酷狗音乐（App 扫码）';
  readonly login: Provider['login'];
  readonly stream: StreamProvider;

  private readonly transport: Transport;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly upstreamBase?: string;

  /** 每次出码换一套设备身份：token 与 mid/dfid 绑定，取流时必须原样带上 */
  private device = { mid: '', dfid: '' };
  private current: { key: string; at: number; expiresAt: number } | null = null;
  private scannedAt = 0;
  private lastCredential: Credential | null = null;

  constructor(deps: KugouDeps) {
    this.transport = deps.transport;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.upstreamBase = deps.upstreamBase;
    this.login = { start: () => this.start(), poll: () => this.poll(), cancel: () => this.cancel() };
    this.stream = { id: this.id, ladder: LADDER, fetchAudio: ctx => this.fetchAudio(ctx) };
  }

  /* ---------------- 登录 ---------------- */

  private async start(): Promise<{ qr: { image: string; expiresAt: number }; message: string }> {
    this.cancel();
    const guid = randomUUID();
    this.device = { mid: midOf(guid), dfid: randomBytes(12).toString('hex') };

    const params = this.signed({
      dfid: this.device.dfid,
      mid: this.device.mid,
      uuid: '-',
      appid: APPID,
      clientver: CLIENTVER,
      clienttime: String(Math.floor(this.now() / 1000)),
      type: '1',
      plat: '4',
      qrcode_txt: H5_QR,
      srcappid: SRCAPPID
    });

    const res = await this.get<{ status?: number; error_code?: number; data?: Record<string, unknown>; data2?: unknown }>(
      '/v2/qrcode',
      params
    );
    const body = (res.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? body) as Record<string, unknown>;
    const key = str(data.qrcode) || str(data.key);
    const image = str(data.qrcode_img);
    if (!key || !image.startsWith('data:image')) {
      const code = Number(body.error_code || body.status) || 0;
      throw new AccountError('E_UPSTREAM_UNAVAILABLE', `酷狗音乐：出码失败（${code}）。`, {
        hint: '稍后重试；若持续失败可能是 IP 被限流。'
      });
    }

    const ttlMs = 5 * 60 * 1000;
    this.current = { key, at: this.now(), expiresAt: this.now() + ttlMs };
    this.scannedAt = 0;
    this.logger.info('[acc] 酷狗 App 扫码已出码', { mid: this.device.mid.slice(0, 6) + '…' });
    return { qr: { image, expiresAt: this.current.expiresAt }, message: '请用手机酷狗 App 扫一扫' };
  }

  private async poll(): Promise<ProviderPollResult> {
    const cur = this.current;
    if (!cur) {
      if (this.lastCredential) return { phase: 'confirmed', message: '已登录' };
      throw new AccountError('E_AUTH_REQUIRED', '酷狗音乐：登录窗口已关闭，请重新获取二维码。');
    }
    if (this.now() > cur.expiresAt) {
      this.current = null;
      throw new AccountError('E_QR_EXPIRED', '酷狗音乐：二维码已过期，请重新获取。');
    }

    const params = this.signed({
      dfid: this.device.dfid,
      mid: this.device.mid,
      uuid: '-',
      appid: APPID,
      clientver: CLIENTVER,
      clienttime: String(Math.floor(this.now() / 1000)),
      plat: '4',
      qrcode: cur.key,
      srcappid: SRCAPPID
    });
    const res = await this.get<Record<string, unknown>>('/v2/get_userinfo_qrcode', params);
    const body = (res.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;
    const status = Number(data.status);

    if (status === 4) {
      const token = str(data.token) || str(body.token);
      const userid = str(data.userid) || str(data.user_id) || str(body.userid);
      if (!token || !userid) {
        return { phase: 'scanned', message: '已扫码，正在换取登录态…', retryAfterMs: 1500 };
      }
      const credential: Credential = {
        cookie: `token=${token}; userid=${userid}; mid=${this.device.mid}; dfid=${this.device.dfid}`,
        extra: { token, userid, mid: this.device.mid, dfid: this.device.dfid },
        updatedAt: this.now(),
        verifiedAt: this.now()
      };
      const account: Account = {
        id: `kugou:${userid}`,
        provider: 'kugou',
        name: `酷狗 ${userid}`,
        userId: userid,
        avatarUrl: '',
        createdAt: this.now(),
        lastLoginAt: this.now()
      };
      this.lastCredential = credential;
      this.current = null;
      this.logger.info('[acc] 酷狗 App 扫码确认', { userid });
      return { phase: 'confirmed', message: `已登录：酷狗 ${userid}`, credential, account };
    }

    if (status === 0) {
      this.current = null;
      throw new AccountError('E_QR_EXPIRED', '酷狗音乐：二维码已失效，请重新获取。');
    }
    if (status === 2 || status === 3) {
      if (!this.scannedAt) this.scannedAt = this.now();
      if (this.now() - this.scannedAt > 60_000) {
        this.current = null;
        throw new AccountError('E_LOGIN_TIMEOUT', '酷狗音乐：手机上一直没确认，二维码已作废。', {
          hint: '重新扫一次，并在手机上点确认。'
        });
      }
      return { phase: 'scanned', message: '已扫码，请在手机上确认', retryAfterMs: 1500 };
    }
    return { phase: 'waiting', message: '请用手机酷狗 App 扫一扫', retryAfterMs: 2000 };
  }

  private async cancel(): Promise<void> {
    this.current = null;
    this.scannedAt = 0;
  }

  /** 凭据校验：token/userid 还在就认为有效（昵称接口不公开，名字用 uid） */
  async verify(credential: Credential): Promise<Account> {
    const userid = str(credential.extra.userid) || /(?:^|;\s*)userid=([^;]+)/.exec(credential.cookie)?.[1] || '';
    const token = str(credential.extra.token) || /(?:^|;\s*)token=([^;]+)/.exec(credential.cookie)?.[1] || '';
    if (!userid || !token) {
      throw new AccountError('E_AUTH_REQUIRED', '酷狗音乐：登录已失效，请重新扫码。');
    }
    return {
      id: `kugou:${userid}`,
      provider: 'kugou',
      name: `酷狗 ${userid}`,
      userId: userid,
      avatarUrl: '',
      createdAt: this.now(),
      lastLoginAt: this.now()
    };
  }

  /* ---------------- 取流 ---------------- */

  private async fetchAudio(ctx: AudioFetchContext): Promise<AudioAttempt> {
    if (!this.upstreamBase) {
      throw new AccountError('E_NOT_IMPLEMENTED', '酷狗音乐：尚未接入合规上游，无法取流。', {
        hint: '请在设置中填写自建网关地址'
      });
    }
    const qs = new URLSearchParams({ hash: ctx.songId, quality: QUALITY_PARAM[ctx.quality] });
    if (ctx.albumId) qs.set('album_id', ctx.albumId);
    const url = this.upstreamBase.replace(/\/$/, '') + '/song/url?' + qs.toString();
    const res = await this.transport.getJson<Record<string, unknown>>(url, { headers: { Accept: 'application/json' } });
    if (res.status === 429) throw classifyUpstream('kugou', { httpStatus: 429, message: 'rate limit' });
    if (res.status >= 400) throw classifyUpstream('kugou', { httpStatus: res.status, message: 'upstream error' });
    const body = (res.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? body) as Record<string, unknown>;
    const playUrl = str(data.url);
    if (!playUrl) {
      const restriction = (data.restriction ?? {}) as Record<string, unknown>;
      const hint = str(restriction.hint) || str(restriction.code);
      const kind = /vip|pay|会员/.test(hint) ? 'vip' : /region|地区/.test(hint) ? 'region' : 'copyright';
      return { block: { kind, code: hint, message: str(data.message) } };
    }
    return { url: playUrl, bitrateKbps: Number(data.bitrate) || 0 };
  }

  /* ---------------- 工具 ---------------- */

  private signed(params: Record<string, string>): Record<string, string> {
    const raw = Object.keys(params)
      .sort()
      .map(k => `${k}=${params[k]}`)
      .join('');
    return { ...params, signature: md5(WEB_SALT + raw + WEB_SALT) };
  }

  private async get<T>(path: string, params: Record<string, string>) {
    const url = API + path + '?' + new URLSearchParams(params).toString();
    const res = await this.transport.getJson<T>(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        clienttime: params.clienttime,
        mid: params.mid,
        dfid: params.dfid
      }
    });
    if (res.status === 429) throw classifyUpstream('kugou', { httpStatus: 429, message: 'rate limit' });
    if (res.status >= 400) {
      throw new AccountError('E_UPSTREAM_UNAVAILABLE', `酷狗音乐：接口不可用（HTTP ${res.status}）。`, {
        hint: '稍后重试。'
      });
    }
    return res;
  }
}

export { LADDER as KUGOU_LADDER };
