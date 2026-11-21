import type { Account, Credential, QualityId } from '../types';
import type { AudioAttempt, AudioFetchContext } from '../stream';
import { PageLoginProvider, joinUrl, pickExtra, type PageProviderConfig, type PageProviderDeps } from './base';
import { AccountError, classifyUpstream } from '../errors';

/**
 * QQ 音乐
 * ---------------------------------------------------------------------------
 * 扫码链路：打开 QQ 音乐官方站 → 页面自己出二维码 → 手机 QQ / 微信 / QQ 音乐 App 扫码
 *          → 页面把登录态写进 cookie（qm_keyst / qqmusic_key / p_skey …）→ 读白名单 cookie。
 *
 * 我们**不实现**任何 QQ 侧签名算法：确认登录只靠官方页面自己完成，这里只负责
 * 「开页面、读二维码、读 cookie」三件事，因此不构成任何绕过。
 *
 * 取流必须配置合规上游（`upstreamBase`）：
 *   GET {base}/music/play?songmid=<mid>&quality=<128|320|flac>
 *   返回 { data: { url, bitrate } } 或 { data: { url: '', restriction: { code, hint } } }
 * 未配置时 fetchAudio 抛 E_NOT_IMPLEMENTED，UI 明确提示「尚未接入合规上游」。
 */

const QUALITY_PARAM: Record<QualityId, string> = {
  standard: '128',
  high: '320',
  lossless: 'flac',
  hires: 'flac'
};

/** 与 folia 的 QQ_QUALITY_FALLBACKS 同构，但参数与错误码是本项目自己的 */
const LADDER: Record<QualityId, QualityId[]> = {
  standard: ['standard'],
  high: ['high', 'standard'],
  lossless: ['lossless', 'high', 'standard'],
  hires: ['hires', 'lossless', 'high', 'standard']
};

export const QQ_CONFIG: PageProviderConfig = {
  id: 'qq',
  label: 'QQ 音乐',
  loginUrl: 'https://y.qq.com/',
  partition: 'persist:acc-qq',
  // 首页要点「登录」→ 弹层里点「QQ登录」→ 再点「扫码登录」才出 QQ 二维码；
  // 「微信登录」页签的二维码是另一路（open.weixin.qq.com 的普通 PNG）。
  clickTexts: ['登录', 'QQ登录', '扫码登录'],
  qrMessage: '请用手机 QQ 扫一扫',
  // 只读这些名字；qqmusic_key 是老版名，qm_keyst 是新版名，二者出现其一即算登录
  cookieNames: ['qm_keyst', 'qqmusic_key', 'p_skey', 'skey', 'uin', 'p_uin', 'luin', 'euin', 'wxuin', 'psrf_qqunionid', 'psrf_musickey_createtime'],
  requiredCookieNames: [],
  qrTimeoutMs: 15_000,
  qrTtlMs: 3 * 60 * 1000,
  expiredPatterns: [/二维码已?失效/, /已过期/, /重新获取/],
  scannedPatterns: [/已扫码/, /扫描成功/, /请在手机上确认/, /确认登录/]
};

export class QqProvider extends PageLoginProvider {
  constructor(deps: Omit<PageProviderDeps, 'cfg' | 'ladder' | 'fetchAudio'> & { upstreamBase?: string }) {
    const cfg: PageProviderConfig = { ...QQ_CONFIG, upstreamBase: deps.upstreamBase };
    super({ ...deps, cfg, ladder: LADDER, fetchAudio: ctx => fetchQqAudio(ctx, cfg.upstreamBase) });
  }

  /**
   * 「已登录」的判据：qm_keyst 或 qqmusic_key 至少有一个非空。
   * 二者同时缺失时按未登录处理（页面还在登录流程里）。
   */
  protected override async poll() {
    const cookies = await this.host.readCookies(this.cfg.cookieNames);
    const hasKey = !!cookies.qm_keyst || !!cookies.qqmusic_key;
    // 只要 uin / wxuin 有一个，才是真的有人登录过（未登录时这两个都是空的，
    // 而登录层一打开就会写 qm_keyst 之类的占位值 —— 早期版本就栽在这里）。
    const hasUid = !!(cookies.uin || cookies.p_uin || cookies.luin || cookies.euin || cookies.wxuin);
    if (hasKey && hasUid) {
      const credential: Credential = {
        cookie: buildCookieHeader(cookies),
        extra: pickExtra('qq', cookies),
        updatedAt: this.now(),
        verifiedAt: 0
      };
      const account = await this.verify(credential);
      return { phase: 'confirmed' as const, account, credential };
    }
    return super.poll();
  }

  protected override profilePath(): string {
    return '/user/detail';
  }

  protected override mapProfile(body: Record<string, unknown>, fallback: Account): Account {
    const data = (body.data ?? body) as Record<string, unknown>;
    const name = str(data.nick) || str(data.nickname) || fallback.name;
    const avatar = str(data.avatarUrl) || str(data.headpic) || '';
    const uid = String(data.uin ?? data.uid ?? fallback.userId);
    return { ...fallback, id: `qq:${uid}`, userId: uid, name, avatarUrl: avatar };
  }
}

function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([, v]) => !!v)
    .map(([k, v]) => k + '=' + v)
    .join('; ');
}

async function fetchQqAudio(ctx: AudioFetchContext, upstreamBase?: string): Promise<AudioAttempt> {
  if (!upstreamBase) {
    throw new AccountError('E_NOT_IMPLEMENTED', 'QQ 音乐：尚未接入合规上游，无法取流。', {
      hint: '请在设置中填写自建网关地址（或改用支持官方开放能力的音源）'
    });
  }
  const url = joinUrl(upstreamBase, '/music/play') + `?songmid=${encodeURIComponent(ctx.songId)}&quality=${QUALITY_PARAM[ctx.quality]}`;
  const res = await fetchJson(url);
  const data = (res.body.data ?? res.body) as Record<string, unknown>;
  const playUrl = str(data.url);
  if (!playUrl) {
    const restriction = (data.restriction ?? {}) as Record<string, unknown>;
    const hint = str(restriction.hint) || str(restriction.code);
    const kind = /vip|membership|付费|会员/.test(hint) ? 'vip' : /region|地区/.test(hint) ? 'region' : 'copyright';
    return { block: { kind, code: hint, message: str(data.message) } };
  }
  return { url: playUrl, bitrateKbps: Number(data.bitrate) || 0 };
}

export interface RawJsonResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 取流专用的小 fetch：不依赖 node:http，主进程注入的 globalThis.fetch 即可。
 * 放这里是为了让 provider 自洽（测试直接替换 globalThis.fetch 就能跑）。
 */
async function fetchJson(url: string): Promise<RawJsonResponse> {
  const doFetch = (globalThis as { fetch?: (u: string, init?: RequestInit) => Promise<Response> }).fetch;
  if (!doFetch) throw new AccountError('E_UPSTREAM_UNAVAILABLE', 'QQ 音乐：取流通道不可用（缺少 fetch）。');
  const res = await doFetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 429) {
    throw classifyUpstream('qq', { httpStatus: 429, message: 'rate limit' });
  }
  if (!res.ok) {
    throw classifyUpstream('qq', { httpStatus: res.status, message: res.statusText });
  }
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

export { LADDER as QQ_LADDER };
