'use strict';
/* 哔哩哔哩音源层：只做 HTTP 与字段归一化，不碰 DOM、不碰 Electron API。
 *
 * 与 netease.js 同构：对外抛 BilError(code)，由主进程 IPC 包成 { ok:false, error }。
 * 三条链路：
 *   搜索  GET /x/web-interface/wbi/search/type   —— 必须 WBI 签名（裸调 -403）
 *   详情  GET /x/web-interface/view?bvid=        —— 取 cid（playurl 必须要）
 *   取流  GET /x/player/wbi/playurl?fnval=16     —— dash.audio[]，多 CDN 备份地址
 *
 * 为什么不直接给渲染层 CDN 地址：地址约 2 小时过期、绑定 Referer 与 IP，
 * 且主 CDN 有时是 mcdn（P2P 节点，实测在部分网络直接超时）—— 所以统一走
 * bilaudio:// 协议，由主进程换链重试（见 main.js 的 registerBilProtocol）。
 */
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const qrcode = require('qrcode-generator');

const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

const REQ_TIMEOUT = 12000;
const JSON_MAX = 16 * 1024 * 1024;
const COVER_MAX = 8 * 1024 * 1024;
const COVER_CACHE_MAX = 60;
const COVER_TTL = 10 * 60 * 1000;
const URL_TTL = 100 * 60 * 1000;        // 官方约 2h，留一小时余量
const WBI_TTL = 20 * 60 * 1000;         // 混表 key 官方 20 分钟一换

class BilError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BilError';
    this.code = code || 'BIL_ERROR';
  }
}

/* WBI 混表：imgKey+subKey 拼成 64 字符后按这张表取前 32 位。
 * 表本身是固定的，会变的是 key —— 所以 key 放缓存、失败时刷新一次即可。 */
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

const state = {
  cookie: '',
  sessdata: '',
  biliJct: '',
  userId: 0,
  nickname: '',
  verified: false,
  qr: null
};

function request(target, { method = 'GET', headers = {}, timeout = REQ_TIMEOUT, maxBytes = JSON_MAX, body = null } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch (e) { return reject(new BilError('地址不合法：' + target, 'BIL_BAD_URL')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      method,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        Origin: 'https://www.bilibili.com',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers
      },
      timeout
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new BilError('响应过大', 'BIL_TOO_BIG')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new BilError('请求超时', 'BIL_TIMEOUT')));
    req.on('error', e => reject(e instanceof BilError ? e : new BilError(String((e && e.message) || e), 'BIL_NET')));
    if (body) req.write(body);
    req.end();
  });
}

async function getJSON(target, opts) {
  const r = await request(target, opts);
  if (r.status === 404) throw new BilError('接口不存在（404）', 'BIL_404');
  if (r.status === 412) throw new BilError('被风控拦截（412），请稍后重试', 'BIL_403');
  if (r.status >= 500) throw new BilError('B 站服务异常（' + r.status + '）', 'BIL_5XX');
  let json;
  try { json = JSON.parse(r.body.toString('utf8')); }
  catch (e) { throw new BilError('返回不是 JSON（HTTP ' + r.status + '）', 'BIL_BAD_JSON'); }
  return { json, headers: r.headers, status: r.status };
}

/* ---------------- WBI 签名 ---------------- */
let wbi = { key: '', at: 0 };

const pickName = u => String(u || '').split('/').pop().replace(/\.(png|jpg|jpeg|webp)$/i, '');

async function wbiKey(force) {
  if (!force && wbi.key && Date.now() - wbi.at < WBI_TTL) return wbi.key;
  const { json } = await getJSON(API + '/x/web-interface/nav', {
    headers: state.cookie ? { Cookie: state.cookie } : {}
  });
  const img = (json.data && json.data.wbi_img) || {};
  if (!img.img_url || !img.sub_url) {
    // nav 有时在风控下只回 code=-101 且 data 里没有 wbi_img：这时候重试也没用
    throw new BilError('没能取到 WBI 密钥（code=' + json.code + '）', 'BIL_WBI_KEY');
  }
  const raw = pickName(img.img_url) + pickName(img.sub_url);
  wbi = { key: MIXIN_TAB.slice(0, 32).map(n => raw[n] || '').join(''), at: Date.now() };
  return wbi.key;
}

function signParams(params, key) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    clean[k] = String(v).replace(/[!'()*]/g, '');
  }
  const qs = Object.keys(clean).sort()
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(clean[k]))
    .join('&');
  const wts = Math.floor(Date.now() / 1000);
  const w_rid = crypto.createHash('md5').update(qs + '&wts=' + wts + key).digest('hex');
  return qs + '&wts=' + wts + '&w_rid=' + w_rid;
}

/* 签名请求：-403 表示 key 轮换了（或参数不被接受），刷新一次 key 再试；
 * 仍然 -403 才向上抛，交给界面提示「被风控」。 */
async function signedGet(pathname, params) {
  const call = async force => {
    const key = await wbiKey(force);
    return getJSON(API + pathname + '?' + signParams(params, key), {
      headers: state.cookie ? { Cookie: state.cookie } : {}
    });
  };
  let r = await call(false);
  if (r.json.code === -403) r = await call(true);
  if (r.json.code === -403) throw new BilError('搜索接口要求签名，刷新密钥后仍被拒（-403）', 'BIL_403');
  if (r.json.code === -352) throw new BilError('触发风控（-352），请稍后再试', 'BIL_403');
  return r;
}

/* ---------------- 字段归一化 ---------------- */
const httpsify = s => (typeof s === 'string' && s.startsWith('//') ? 'https:' + s : s || '');

function parseDur(v) {
  if (typeof v === 'number') return v;
  const s = String(v || '');
  const parts = s.split(':').map(Number);
  if (parts.some(n => Number.isNaN(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '');
}

/* 搜索结果 → Track。duration 在视频搜索里是 "mm:ss"，view 里是秒。 */
function mapVideo(v, extra = {}) {
  const bvid = String(v.bvid || extra.bvid || '');
  const cid = Number(v.cid || extra.cid || 0) || 0;
  return {
    source: 'bilibili',
    path: 'bil:' + bvid + ':' + cid,
    bilBvid: bvid,
    bilCid: cid,
    title: stripTags(v.title).slice(0, 120) || bvid,
    artist: String(v.author || (v.owner && v.owner.name) || '').slice(0, 80),
    album: '哔哩哔哩',
    duration: parseDur(v.duration || extra.duration),
    coverUrl: httpsify(v.pic || v.cover || extra.pic),
    playCount: Number(v.play) || 0,
    codec: 'aac',
    sampleRate: 0,
    bitDepth: 0,
    bitrate: 0,
    lossless: false
  };
}

/* ---------------- 搜索 ---------------- */
async function searchVideos(kw, { page = 1, order = 'click' } = {}) {
  const q = String(kw || '').trim();
  if (!q) return { items: [], page, total: 0, hasMore: false };
  const { json } = await signedGet('/x/web-interface/wbi/search/type', {
    search_type: 'video', keyword: q, order, page
  });
  if (json.code !== 0) throw new BilError(String(json.message || '搜索失败'), 'BIL_SEARCH');
  const data = json.data || {};
  const items = (data.result || [])
    .filter(v => v && v.bvid)
    .map(v => mapVideo(v));
  return { items, page, total: Number(data.numResults) || items.length, hasMore: items.length > 0 };
}

/* ---------------- 详情（多 P 展开） ---------------- */
async function viewInfo(bvid) {
  const id = String(bvid || '');
  if (!/^BV[0-9A-Za-z]{10}$/.test(id)) throw new BilError('视频号不合法', 'BIL_BAD_ID');
  const { json } = await getJSON(API + '/x/web-interface/view?bvid=' + encodeURIComponent(id));
  if (json.code !== 0 || !json.data) throw new BilError(String(json.message || '取不到视频详情'), 'BIL_VIEW');
  const d = json.data;
  const pages = (d.pages || []).map(p => ({
    cid: Number(p.cid) || 0,
    page: Number(p.page) || 0,
    part: String(p.part || ''),
    duration: Number(p.duration) || 0
  })).filter(p => p.cid);
  return {
    bvid: id,
    title: stripTags(d.title),
    owner: String((d.owner && d.owner.name) || ''),
    pic: httpsify(d.pic),
    duration: Number(d.duration) || 0,
    pages
  };
}

/* ---------------- 取流 ---------------- */
const urlCache = new Map();     // "bvid:cid" -> { info, at }

/* mcdn 是 P2P 节点：同一份文件在部分网络会连不上（实测 20 秒超时），
 * 备份地址反而是常规 CDN。这里把 mcdn 排到最后，主进程再按顺序重试。 */
const hostRank = u => {
  try {
    const h = new URL(u).host;
    return /mcdn/i.test(h) ? 1 : 0;
  } catch { return 0; }
};

function sortUrls(urls) {
  return [...new Set(urls.filter(Boolean))].sort((a, b) => hostRank(a) - hostRank(b));
}

async function playUrl(bvid, cid) {
  const key = String(bvid) + ':' + String(cid);
  const hit = urlCache.get(key);
  if (hit && Date.now() - hit.at < URL_TTL) return hit.info;

  const { json } = await signedGet('/x/player/wbi/playurl', {
    bvid, cid, fnval: 16, fnver: 0, fourk: 1
  });
  if (json.code !== 0) throw new BilError(String(json.message || '取不到播放地址'), 'BIL_PLAYURL');
  const d = json.data || {};
  const dash = d.dash || {};
  const audios = (dash.audio || []).slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));

  let info = null;
  if (audios.length) {
    const best = audios[0];
    const urls = sortUrls([best.base_url || best.baseUrl, ...(best.backup_url || best.backupUrl || [])]);
    if (!urls.length) throw new BilError('音轨没有可用地址', 'BIL_NO_AUDIO');
    info = {
      urls,
      br: Math.round((best.bandwidth || 0) / 1000),
      mime: best.mime_type || 'audio/mp4',
      codecs: String(best.codecs || ''),
      trackId: Number(best.id) || 0,
      duration: Number(dash.duration) || 0,
      at: Date.now()
    };
  } else if (Array.isArray(d.durl) && d.durl[0] && d.durl[0].url) {
    /* 极少数稿件没有 DASH（老视频/直播回放）：退回 durl，音质会很差但至少能响 */
    info = {
      urls: sortUrls([d.durl[0].url, ...((d.durl[0].backup_url) || [])]),
      br: 0, mime: 'video/mp4', codecs: '', trackId: 0,
      duration: Number(d.timelength || 0) / 1000, at: Date.now(), fallback: true
    };
  } else {
    throw new BilError('这个视频没有可用的音轨（可能需要登录或大会员）', 'BIL_NO_AUDIO');
  }

  urlCache.set(key, { info, at: Date.now() });
  while (urlCache.size > 200) urlCache.delete(urlCache.keys().next().value);
  return info;
}

function invalidateUrl(bvid, cid) {
  urlCache.delete(String(bvid) + ':' + String(cid));
}

/* ---------------- 封面 ---------------- */
const coverCache = new Map();   // url@size -> { dataUrl, at }

async function coverData(rawUrl, size = 300) {
  const src = httpsify(String(rawUrl || ''));
  if (!src) throw new BilError('没有封面地址', 'BIL_NO_COVER');
  const px = [96, 160, 300, 480].find(n => n >= Number(size)) || 480;
  const key = src + '@' + px;
  const hit = coverCache.get(key);
  if (hit && Date.now() - hit.at < COVER_TTL) return hit.dataUrl;

  // B 站图片 CDN 支持 @<宽>w_<高>h 后缀缩放，省流量也省解码时间
  const u = /@\d+w_\d+h/.test(src) ? src : src + '@' + px + 'w_' + px + 'h.jpg';
  const r = await request(u, { maxBytes: COVER_MAX });
  if (r.status === 404) throw new BilError('封面不存在', 'BIL_NO_COVER');
  if (r.status !== 200) throw new BilError('封面下载失败（' + r.status + '）', 'BIL_COVER_HTTP');
  const type = String(r.headers['content-type'] || 'image/jpeg');
  if (!/^image\//.test(type)) throw new BilError('封面不是图片：' + type, 'BIL_COVER_TYPE');
  const dataUrl = 'data:' + type + ';base64,' + r.body.toString('base64');
  coverCache.set(key, { dataUrl, at: Date.now() });
  while (coverCache.size > COVER_CACHE_MAX) coverCache.delete(coverCache.keys().next().value);
  return dataUrl;
}

/* ---------------- 扫码登录 ---------------- */
const QR_TTL = 180 * 1000;
const QR_GUARD = 20 * 1000;

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  const margin = 3;
  const total = n + margin * 2;
  let d = '';
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!qr.isDark(y, x)) { x++; continue; }
      let w = 1;
      while (x + w < n && qr.isDark(y, x + w)) w++;
      d += 'M' + (x + margin) + ' ' + (y + margin) + 'h' + w + 'v1h-' + w + 'z';
      x += w;
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total +
    '" shape-rendering="crispEdges" role="img" aria-label="哔哩哔哩登录二维码">' +
    '<rect width="' + total + '" height="' + total + '" fill="#ffffff"/>' +
    '<path d="' + d + '" fill="#111111"/></svg>';
}

async function qrCreate() {
  const { json } = await getJSON(PASSPORT + '/x/passport-login/web/qrcode/generate');
  const d = (json && json.data) || {};
  if (json.code !== 0 || !d.url || !d.qrcode_key) {
    throw new BilError('没能取到二维码（code=' + json.code + '）', 'BIL_QR_KEY');
  }
  state.qr = { key: d.qrcode_key, at: Date.now() };
  return { key: d.qrcode_key, url: d.url, ttl: QR_TTL };
}

function cookieFromSetCookie(list) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  const keep = new Map();
  for (const line of arr) {
    const first = String(line).split(';')[0].trim();
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const k = first.slice(0, i).trim();
    const v = first.slice(i + 1).trim();
    if (!k) continue;
    keep.set(k, v);                // 同名后者覆盖前者，避免拼出半截旧值
  }
  return [...keep.entries()].map(([k, v]) => k + '=' + v).join('; ');
}

async function qrPoll() {
  const q = state.qr;
  if (!q || !q.key) throw new BilError('二维码已失效，请重新获取', 'BIL_QR_GONE');
  if (Date.now() - q.at > QR_TTL + QR_GUARD) {
    state.qr = null;
    throw new BilError('二维码已过期，请重新获取', 'BIL_QR_EXPIRED');
  }
  const { json, headers } = await getJSON(
    PASSPORT + '/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(q.key)
  );
  const d = (json && json.data) || {};
  const code = Number(d.code);
  const out = { code, message: String(d.message || '') };

  if (code === 0) {
    state.qr = null;
    const cookie = cookieFromSetCookie(headers['set-cookie']);
    if (!/(^|;\s*)SESSDATA=/.test(cookie)) {
      throw new BilError('登录成功但没拿到 SESSDATA，请重新扫码', 'BIL_QR_NO_COOKIE');
    }
    applyAuth(cookie);
    out.cookie = cookie;
  } else if (code === 86101) out.state = 'waiting';
  else if (code === 86090) out.state = 'scanned';
  else if (code === 86038) out.state = 'expired';
  return out;
}

/* ---------------- 凭证 ---------------- */
function parseCookie(raw) {
  const out = {};
  String(raw || '')
    .replace(/^cookie:\s*/i, '')
    .split(/[;\n\r]+/)
    .forEach(part => {
      const s = part.trim();
      if (!s) return;
      const i = s.indexOf('=');
      if (i <= 0) return;
      out[s.slice(0, i).trim().toLowerCase()] = s.slice(i + 1).trim();
    });
  return out;
}

function applyAuth(rawCookie) {
  const c = parseCookie(rawCookie);
  state.cookie = Object.entries(c).map(([k, v]) => k + '=' + v).join('; ');
  state.sessdata = c.sessdata || '';
  state.biliJct = c.bili_jct || '';
  state.userId = Number(c.dedeuserid || 0) || 0;
  state.nickname = '';
  state.verified = false;
  urlCache.clear();          // 身份变了，缓存的地址可能对应不同权限，别复用
  return loggedIn();
}

function loggedIn() { return !!state.sessdata; }

function authInfo() {
  return {
    provider: 'bilibili',
    loggedIn: loggedIn(),
    userId: state.userId,
    nickname: state.nickname,
    sessdataMasked: state.sessdata ? state.sessdata.slice(0, 4) + '…(' + state.sessdata.length + ')' : '',
    verified: state.verified
  };
}

/* 校验：nav 带 Cookie 请求，code=0 且 isLogin=true 才算真的登录上了。
 * 只判断「有没有 SESSDATA」是不够的 —— 过期的 SESSDATA 也能拼出字符串。 */
async function verify() {
  if (!loggedIn()) { state.verified = false; return { loggedIn: false, ok: false, reason: 'no-auth' }; }
  try {
    const { json } = await getJSON(API + '/x/web-interface/nav', { headers: { Cookie: state.cookie } });
    const d = (json && json.data) || {};
    state.verified = json.code === 0 && !!d.isLogin;
    state.nickname = String(d.uname || '');
    state.userId = Number(d.mid || state.userId) || state.userId;
    return { loggedIn: state.verified, ok: state.verified, nickname: state.nickname, userId: state.userId, vip: Number((d.vipStatus || 0)) > 0 };
  } catch (e) {
    state.verified = false;
    return { loggedIn: false, ok: false, reason: (e && e.code) || 'BIL_NET', message: String((e && e.message) || e) };
  }
}

function status() {
  return {
    ...authInfo(),
    note: loggedIn()
      ? (state.verified ? '已登录：会员稿件可尝试高音质' : '已登录：尚未验证，播放时以实际取流为准')
      : '未登录：只能播放公开稿件，收藏夹不可用'
  };
}

function logout() {
  applyAuth('');
  return status();
}

module.exports = {
  BilError, request, getJSON,
  searchVideos, viewInfo, playUrl, invalidateUrl, coverData,
  qrCreate, qrPoll, qrSvg,
  applyAuth, authInfo, status, verify, logout, loggedIn,
  mapVideo, parseCookie, httpsify
};
