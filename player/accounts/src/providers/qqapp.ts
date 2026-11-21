import type { Account, Credential, Logger, ProviderId, QrPayload, QualityId, Transport } from '../types';
import type { AudioAttempt, AudioFetchContext } from '../stream';
import type { LoginStartResult, Provider, ProviderPollResult } from './base';
import { AccountError, classifyUpstream, providerError } from '../errors';
import { MqttSubscription, type MqttConnect } from '../mqtt';

/**
 * QQ 音乐 App 扫码（协议通道）
 * ---------------------------------------------------------------------------
 * 和 `providers/qq.ts`（打开官方网页、读页面二维码）是两条**并列**的路：
 * 这条路不需要任何窗口，也不需要跑官方的网页资源，直接打 QQ 音乐客户端自己的登录协议：
 *
 *   1. POST musicu.fcg  module=music.login.LoginServer method=CreateQRCode
 *      → { qrcodeID, qrcode:"data:image/png;base64,…", expiresIn:900 }
 *   2. 连 MQTT（wss://mu.y.qq.com/ws/handshake），订阅 management.qrcode_login/<qrcodeID>
 *      → 手机用「QQ 音乐 App」扫码后，服务端往这个主题推 scanned / cookies 两条消息
 *   3. cookies 里的 qqmusic_key 是**交换令牌**（300 秒），必须再调 Login 换 musickey：
 *      comm 覆盖 tmeLoginType: 6、musicid 必须是数字，否则回 1000 / 10006 / 104400
 *   4. 拿 musickey 调 music.UserInfo.userInfoServer / GetLoginUserInfo 校验并取昵称
 *
 * 这条路同样不做任何签名/绕过：二维码由平台自己签发，登录由用户在手机 App 上确认。
 * 取流与网页通道共用同一套合规上游约定（未配置即 E_NOT_IMPLEMENTED）。
 */

const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const MQTT_URL = 'wss://mu.y.qq.com/ws/handshake';
/** 官方 Android 客户端固定送 6；换凭证时不覆盖这个值会被拒 */
const APP_LOGIN_TYPE = 6;
/** 平台给的二维码有效期（expiresIn 900 秒），这里留一点余量 */
const QR_TTL_MS = 14 * 60 * 1000;
const USER_AGENT = 'QQMusic 14090008(android 14)';

const LADDER: Record<QualityId, QualityId[]> = {
  standard: ['standard'],
  high: ['high', 'standard'],
  lossless: ['lossless', 'high', 'standard'],
  hires: ['hires', 'lossless', 'high', 'standard']
};

/** musicu 的公共参数；协议要求这些字段，缺一个就会被当成浏览器来路 */
function comm(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ct: 11,
    cv: 14090008,
    v: 14090008,
    chid: '10003505',
    tmeAppID: 'qqmusic',
    ...extra
  };
}

interface MusicuReply {
  code?: number;
  req_0?: { code?: number; data?: Record<string, unknown> } | null;
}

async function callMusicu(
  transport: Transport,
  module: string,
  method: string,
  param: Record<string, unknown>,
  commExtra: Record<string, unknown> = {},
  cookie?: string
): Promise<Record<string, unknown>> {
  const res = await transport.postJson<MusicuReply>(
    MUSICU,
    { comm: comm(commExtra), req_0: { module, method, param } },
    {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        ...(cookie ? { Cookie: cookie } : {})
      },
      timeoutMs: 15_000,
      label: `qqapp:${method}`
    }
  );
  const body = res.body ?? {};
  const item = body.req_0 ?? {};
  if (body.code !== 0 || item.code !== 0) {
    throw classifyUpstream('qqapp', {
      httpStatus: res.status,
      code: item.code ?? body.code,
      message: `${method} 失败（code ${body.code ?? '?'} / req_0 ${item.code ?? '?'}）`
    });
  }
  return (item.data ?? {}) as Record<string, unknown>;
}

/** 从手机推送的 cookies 消息里挑出换凭证要用的四件套 */
export function pickedPushCookies(json: Record<string, unknown>): Record<string, string> {
  const raw = (json.cookies ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value && typeof value === 'object') {
      const v = (value as Record<string, unknown>).value;
      if (typeof v === 'string' && v) out[name] = v;
    } else if (typeof value === 'string' && value) {
      out[name] = value;
    }
  }
  return out;
}

/** MQTT 推送的事件类型：scanned 只是「扫了」，cookies 才是「确认了」 */
function pushKind(json: Record<string, unknown>): 'scanned' | 'cookies' | 'other' {
  if (json.cookies && typeof json.cookies === 'object') return 'cookies';
  if (typeof json.userNick === 'string' || json.appName !== undefined) return 'scanned';
  return 'other';
}

export interface QqAppDeps {
  transport: Transport;
  logger: Logger;
  /** 建 WebSocket（主进程传 ws 实现，单测传假的） */
  connect: MqttConnect;
  ladder?: Record<QualityId, QualityId[]>;
  fetchAudio?: (ctx: AudioFetchContext) => Promise<AudioAttempt>;
  upstreamBase?: string;
  now?: () => number;
  readyTimeoutMs?: number;
  /** 单测可注入一个假的 broker 地址 */
  mqttUrl?: string;
}

export class QqAppProvider implements Provider {
  readonly id: ProviderId = 'qqapp';
  readonly label = 'QQ 音乐（App 扫码）';
  readonly stream: import('../stream').StreamProvider;

  readonly login = {
    start: () => this.start(),
    poll: () => this.poll(),
    cancel: () => this.cancel()
  };

  private readonly transport: Transport;
  private readonly logger: Logger;
  private readonly connect: MqttConnect;
  private readonly now: () => number;
  private readonly readyTimeoutMs: number;
  private readonly mqttUrl: string;

  private sub: MqttSubscription | null = null;
  private phase: 'idle' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed' | 'cancelled' =
    'idle';
  private qr: QrPayload | undefined;
  private qrcodeId = '';
  private expiresAt = 0;
  private nickname = '';
  private avatar = '';
  private credential: Credential | undefined;
  private account: Account | undefined;
  private failure: AccountError | undefined;

  constructor(deps: QqAppDeps) {
    this.transport = deps.transport;
    this.logger = deps.logger;
    this.connect = deps.connect;
    this.now = deps.now ?? Date.now;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? 12_000;
    this.mqttUrl = deps.mqttUrl ?? MQTT_URL;
    this.stream = {
      id: this.id,
      ladder: deps.ladder ?? LADDER,
      fetchAudio:
        deps.fetchAudio ??
        (async () => {
          throw providerError(this.id, 'E_NOT_IMPLEMENTED', '尚未接入合规上游：取流需要配置 NCKK_QQ_UPSTREAM', {
            hint: '登录与账号管理不受影响'
          });
        })
    };
  }

  /* ---------------- 扫码登录 ---------------- */

  private async start(): Promise<LoginStartResult> {
    await this.cancel();
    this.phase = 'waiting';
    this.failure = undefined;
    this.credential = undefined;
    this.account = undefined;

    const data = await callMusicu(this.transport, 'music.login.LoginServer', 'CreateQRCode', {
      tmeAppID: 'qqmusic',
      ct: 11,
      cv: 14090008
    });
    const qrcodeId = String(data.qrcodeID ?? '');
    const image = String(data.qrcode ?? '');
    if (!qrcodeId || !/^data:image\//.test(image)) {
      throw providerError(this.id, 'E_UPSTREAM_UNAVAILABLE', '平台没有返回二维码，请稍后重试。');
    }
    const ttlSec = Number(data.expiresIn ?? 900);
    this.qrcodeId = qrcodeId;
    this.expiresAt = this.now() + Math.min(ttlSec * 1000, QR_TTL_MS);
    this.qr = { image, expiresAt: this.expiresAt };

    // 推送通道：订阅成功之前收到扫码也不会丢，因为平台是「确认后才推 cookies」，
    // 只要有订阅在就能收到；订阅失败直接把错误抛给 UI，不静默等。
    const sub = new MqttSubscription({
      url: this.mqttUrl,
      topic: `management.qrcode_login/${qrcodeId}`,
      clientId: `${this.now()}${Math.floor(Math.random() * 9000 + 1000)}`,
      authMethod: 'pass',
      connectProperties: [
        { key: 'tmeAppID', value: 'qqmusic' },
        { key: 'business', value: 'management' },
        { key: 'hashTag', value: qrcodeId },
        { key: 'clientTag', value: 'management.user' },
        { key: 'userID', value: qrcodeId }
      ],
      subscribeProperties: [
        { key: 'authorization', value: 'tmelogin' },
        { key: 'pubsub', value: 'unicast' }
      ],
      connect: this.connect,
      logger: this.logger,
      readyTimeoutMs: this.readyTimeoutMs,
      now: this.now
    });
    sub.onClosed = reason => {
      if (this.phase === 'waiting' || this.phase === 'scanned') {
        this.logger.warn('[acc] QQ 音乐推送通道断开', { reason, provider: this.id });
      }
    };
    sub.onEvent = e => void this.onPush(e.json);
    this.sub = sub;

    try {
      await sub.open();
    } catch (err) {
      await this.cancel();
      this.phase = 'failed';
      this.failure = providerError(this.id, 'E_UPSTREAM_UNAVAILABLE', `推送通道连不上：${(err as Error).message}`, {
        hint: '检查网络或代理后点「重新获取」'
      });
      throw this.failure;
    }

    this.logger.info('[acc] QQ 音乐 App 扫码已出码', { provider: this.id, expiresIn: ttlSec });
    return { qr: this.qr, message: '请用手机 QQ 音乐 App 扫一扫' };
  }

  /** 收到一条推送：scanned 只更新相位，cookies 才去换凭据（换凭证要几秒，不能在事件里做太久） */
  private async onPush(json: Record<string, unknown>): Promise<void> {
    const kind = pushKind(json);
    if (kind === 'scanned') {
      this.nickname = String(json.userNick ?? this.nickname ?? '');
      this.avatar = String(json.userLogo ?? this.avatar ?? '');
      if (this.phase === 'waiting') {
        this.phase = 'scanned';
        this.logger.info('[acc] QQ 音乐已扫码，等待手机确认', { provider: this.id, nick: this.nickname });
      }
      return;
    }
    if (kind !== 'cookies') return;

    const ck = pickedPushCookies(json);
    const token = ck.qqmusic_key || ck.qqmusic_key_at || '';
    const musicid = ck.qqmusic_uin || ck.uin || '';
    const qrcodeId = ck.qrcode_id || this.qrcodeId;
    if (!token || !musicid) {
      this.logger.warn('[acc] QQ 音乐推送里没有换凭证要的字段', {
        provider: this.id,
        names: Object.keys(ck)
      });
      return;
    }
    try {
      const exchanged = await callMusicu(
        this.transport,
        'music.login.LoginServer',
        'Login',
        { musicid: Number(musicid), qrCodeID: qrcodeId, token },
        { tmeLoginType: APP_LOGIN_TYPE }
      );
      const musickey = String(exchanged.musickey ?? '');
      const uid = String(exchanged.str_musicid ?? musicid);
      if (!musickey) {
        throw providerError(this.id, 'E_AUTH_REQUIRED', '平台确认了登录但没有下发凭据，请重新扫一次。');
      }
      const cookie = [
        `uin=${uid}`,
        `qqmusic_uin=${uid}`,
        `qm_keyst=${musickey}`,
        `qqmusic_key=${musickey}`
      ].join('; ');
      const loginType = String(exchanged.loginType ?? '2');
      const credential: Credential = {
        cookie,
        extra: {
          uin: uid,
          musicid: uid,
          musickey,
          loginType,
          qrCodeId: qrcodeId,
          nick: String(exchanged.nick ?? this.nickname ?? '')
        },
        updatedAt: this.now(),
        verifiedAt: 0
      };
      const account = await this.verify(credential);
      this.credential = { ...credential, verifiedAt: this.now() };
      this.account = account;
      this.phase = 'confirmed';
      this.logger.info('[acc] QQ 音乐 App 扫码登录成功', { provider: this.id, userId: account.userId });
      await this.closeSub();
    } catch (err) {
      const e = err instanceof AccountError ? err : providerError(this.id, 'E_UPSTREAM_UNAVAILABLE', (err as Error).message);
      this.logger.warn('[acc] QQ 音乐换凭证失败', { provider: this.id, code: e.code, message: e.message });
      this.failure = e;
      this.phase = 'failed';
      await this.closeSub();
    }
  }

  private async poll(): Promise<ProviderPollResult> {
    if (this.phase === 'confirmed' && this.credential && this.account) {
      return { phase: 'confirmed', account: this.account, credential: this.credential, message: `已登录：${this.account.name}` };
    }
    if (this.phase === 'failed' && this.failure) {
      return { phase: 'failed', error: this.failure, message: this.failure.message };
    }
    if (this.now() > this.expiresAt) {
      this.phase = 'expired';
      await this.closeSub();
      return {
        phase: 'expired',
        error: providerError(this.id, 'E_QR_EXPIRED', '二维码已过期，请点「重新获取」。'),
        message: '二维码已过期'
      };
    }
    if (this.phase === 'scanned') {
      return { phase: 'scanned', qr: this.qr, message: '已扫码，请在手机上确认', retryAfterMs: 1500 };
    }
    return { phase: 'waiting', qr: this.qr, message: '请用手机 QQ 音乐 App 扫一扫', retryAfterMs: 1500 };
  }

  private async closeSub(): Promise<void> {
    const sub = this.sub;
    this.sub = null;
    sub?.close('done');
  }

  private async cancel(): Promise<void> {
    await this.closeSub();
    if (this.phase !== 'confirmed') this.phase = this.phase === 'failed' ? 'failed' : 'cancelled';
  }

  /* ---------------- 校验与取流 ---------------- */

  async verify(credential: Credential): Promise<Account> {
    const uid = credential.extra.uin || credential.extra.musicid || '';
    const musickey = credential.extra.musickey || '';
    if (!uid || !musickey) {
      throw providerError(this.id, 'E_AUTH_REQUIRED', '凭据不完整，请重新扫码登录。');
    }
    const data = await callMusicu(
      this.transport,
      'music.UserInfo.userInfoServer',
      'GetLoginUserInfo',
      {},
      { qq: uid, authst: musickey, tmeLoginType: 2 },
      credential.cookie
    );
    const info = (data.info ?? {}) as Record<string, unknown>;
    const name = String(info.nick ?? credential.extra.nick ?? `uid ${uid}`);
    const avatar = String(info.icon ?? this.avatar ?? '');
    const now = this.now();
    return {
      id: `${this.id}:${uid}`,
      provider: this.id,
      name,
      userId: uid,
      avatarUrl: avatar,
      createdAt: now,
      lastLoginAt: now
    };
  }
}
