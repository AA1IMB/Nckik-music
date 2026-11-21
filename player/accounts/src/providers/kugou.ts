import type { Account, QualityId } from '../types';
import type { AudioAttempt, AudioFetchContext } from '../stream';
import { PageLoginProvider, joinUrl, type PageProviderConfig, type PageProviderDeps, type LoginStartResult, type ProviderPollResult } from './base';
import { AccountError, classifyUpstream } from '../errors';

/**
 * 酷狗音乐
 * ---------------------------------------------------------------------------
 * 扫码链路：打开酷狗官方登录页（login-user.kugou.com，appid=1014）→ 页面自己出码并轮询
 *          → 手机酷狗 App 扫码确认 → 登录成功回调后 cookie 里出现 token / userid / dfid。
 * 与 QQ 同一套：不开新窗口、不伪造签名，只读官方页面自己产生的 cookie。
 *
 * 取流必须配置合规上游（`upstreamBase`）：
 *   GET {base}/song/url?hash=<hash>&quality=<128|320|flac>&album_id=<id>
 *   返回 { data: { url, bitrate } } 或 { data: { url: '', restriction: { code, hint } } }
 */

const QUALITY_PARAM: Record<QualityId, string> = {
  standard: '128',
  high: '320',
  lossless: 'flac',
  hires: 'high'
};

const LADDER: Record<QualityId, QualityId[]> = {
  standard: ['standard'],
  high: ['high', 'standard'],
  lossless: ['lossless', 'high', 'standard'],
  hires: ['hires', 'lossless', 'high', 'standard']
};

export const KUGOU_CONFIG: PageProviderConfig = {
  id: 'kugou',
  label: '酷狗音乐',
  // 注意：带 callback 参数时酷狗会回 ERR_FAILED(-2) 加载失败，去掉即可正常出码
  loginUrl: 'https://login-user.kugou.com/login/?appid=1014',
  partition: 'persist:acc-kugou',
  qrMessage: '请用手机酷狗 App 扫一扫',
  cookieNames: ['token', 'userid', 'dfid', 'kugouid', 'kg_mid', 'kg_dfid', 'NickName'],
  requiredCookieNames: ['token', 'userid'],
  qrTimeoutMs: 15_000,
  qrTtlMs: 5 * 60 * 1000,
  // 酷狗在那个位置 315s 后才写「已失效 请点击刷新」，且不换图 —— 必须认出这句话
  expiredPatterns: [/已失效/, /二维码已过期/, /请点击刷新/],
  scannedPatterns: [/已扫码/, /扫描成功/, /请在手机上确认/, /登录中/]
};

export class KugouProvider extends PageLoginProvider {
  /** 页面的轮询响应里拿到的权威状态：4 = 手机上已确认，token 可直接换会话 */
  private watch: { status: number; token: string; userId: string; exchanged: string } = {
    status: 0,
    token: '',
    userId: '',
    exchanged: ''
  };
  private tapOff: (() => void) | null = null;

  constructor(deps: Omit<PageProviderDeps, 'cfg' | 'ladder' | 'fetchAudio'> & { upstreamBase?: string }) {
    const cfg: PageProviderConfig = { ...KUGOU_CONFIG, upstreamBase: deps.upstreamBase };
    super({ ...deps, cfg, ladder: LADDER, fetchAudio: ctx => fetchKugouAudio(ctx, cfg.upstreamBase) });
  }

  /**
   * 酷狗登录页在隐藏窗口里有时不会自己把「手机已确认」换成会话（页面要靠 regok 回跳/
   * opener 交接），所以这里旁听它自己的轮询响应：拿到 data.status === 4 与 token 后，
   * 直接调页面自己的 `KgUser.QRCodeLogin(appid, userid, token, cb)` 完成换会话。
   * 换出来的 token/userid 会由页面写入同一分区 cookie，随后 poll() 自然命中。
   */
  protected override async start(): Promise<LoginStartResult> {
    const r = await super.start();
    this.watch = { status: 0, token: '', userId: '', exchanged: '' };
    this.tapOff?.();
    this.tapOff = this.host.tapJson?.(
      ['*get_userinfo_qrcode*', '*login_qr_check*'],
      json => {
        const root = json as Record<string, unknown> | null;
        const data = root && (root.data as Record<string, unknown> | null);
        if (!data || typeof data !== 'object') return;
        const st = Number(data.status);
        if (Number.isFinite(st)) this.watch.status = st;
        if (typeof data.token === 'string' && data.token) this.watch.token = data.token;
        const uid = data.userid ?? data.userId ?? data.kugouid;
        if (uid !== undefined && uid !== null && String(uid)) this.watch.userId = String(uid);
      }
    ) ?? null;
    return r;
  }

  protected override async poll(): Promise<ProviderPollResult> {
    let r = await super.poll();
    if (r.phase === 'confirmed') return r;

    if (this.watch.token && this.watch.exchanged !== this.watch.token) {
      this.watch.exchanged = this.watch.token;
      const args = JSON.stringify([1014, this.watch.userId || '0', this.watch.token]);
      const code = `new Promise(r => {
        const done = v => { try { r(String(v).slice(0, 120)); } catch { r('cb-error'); } };
        const t = setTimeout(() => r('timeout'), 8000);
        try {
          if (!window.KgUser || typeof KgUser.QRCodeLogin !== 'function') { clearTimeout(t); return r('no-fn'); }
          const a = ${args};
          KgUser.QRCodeLogin(a[0], a[1], a[2], function (res) { clearTimeout(t); done(res); });
        } catch (e) { clearTimeout(t); done('throw ' + e.message); }
      })`;
      const out = await this.host.evalInPage?.(code);
      this.logger.info('[acc] 酷狗换会话', { result: String(out ?? '').slice(0, 60) });
      // 换会话后 cookie 立刻可读，再判一次
      await new Promise(res => setTimeout(res, 600));
      r = await super.poll();
    }
    if (this.watch.status === 4 && r.phase !== 'confirmed') {
      // 已确认但 cookie 还没读到：保持 scanned，别退回 waiting
      return { phase: 'scanned' };
    }
    return r;
  }

  protected override profilePath(): string {
    return '/user/detail';
  }

  protected override mapProfile(body: Record<string, unknown>, fallback: Account): Account {
    const data = (body.data ?? body) as Record<string, unknown>;
    const name = str(data.nickname) || str(data.username) || str(data.NickName) || fallback.name;
    const avatar = str(data.pic) || str(data.avatar) || '';
    const uid = String(data.userid ?? data.uid ?? fallback.userId);
    return { ...fallback, id: `kugou:${uid}`, userId: uid, name, avatarUrl: avatar };
  }
}

async function fetchKugouAudio(ctx: AudioFetchContext, upstreamBase?: string): Promise<AudioAttempt> {
  if (!upstreamBase) {
    throw new AccountError('E_NOT_IMPLEMENTED', '酷狗音乐：尚未接入合规上游，无法取流。', {
      hint: '请在设置中填写自建网关地址'
    });
  }
  const qs = new URLSearchParams({ hash: ctx.songId, quality: QUALITY_PARAM[ctx.quality] });
  if (ctx.albumId) qs.set('album_id', ctx.albumId);
  const res = await fetchJson(joinUrl(upstreamBase, '/song/url') + '?' + qs.toString());
  const data = (res.body.data ?? res.body) as Record<string, unknown>;
  const url = str(data.url);
  if (!url) {
    const restriction = (data.restriction ?? {}) as Record<string, unknown>;
    const hint = str(restriction.hint) || str(restriction.code);
    const kind = /vip|pay|会员/.test(hint) ? 'vip' : /region|地区/.test(hint) ? 'region' : 'copyright';
    return { block: { kind, code: hint, message: str(data.message) } };
  }
  return { url, bitrateKbps: Number(data.bitrate) || 0 };
}

async function fetchJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const doFetch = (globalThis as { fetch?: (u: string, init?: RequestInit) => Promise<Response> }).fetch;
  if (!doFetch) throw new AccountError('E_UPSTREAM_UNAVAILABLE', '酷狗音乐：取流通道不可用（缺少 fetch）。');
  const res = await doFetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 429) throw classifyUpstream('kugou', { httpStatus: 429, message: 'rate limit' });
  if (!res.ok) throw classifyUpstream('kugou', { httpStatus: res.status, message: res.statusText });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

export { LADDER as KUGOU_LADDER };
