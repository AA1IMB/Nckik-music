'use strict';
/*
 * 酷狗音源（免费曲版本）
 * ---------------------------------------------------------------
 * 定位与 netease.js 一致：只做「HTTP + 字段归一化」，不碰 DOM、不碰 BrowserWindow。
 * 输出也映射到同一套 Track 结构，唯一键是 `kg:<hash>` —— 和本地文件路径、
 * 网易云的 `ne:<id>` 共用同一套去重 / 封面缓存 / 队列重定位逻辑。
 *
 * 这一版只取「免费曲」：
 *   搜索结果里的 `pay_type` 决定能不能放（0 = 免费，3 = 付费/会员）。
 *   付费曲不是错误，是「没有播放权限」，用 KgError('需要酷狗会员', 'KG_PAID') 表达，
 *   上层据此提示并跳过，而不是当成网络故障。
 *
 * 登录只留了接口形状（status / qrCreate / qrPoll）：扫码登录的链路要按 web 端
 * 参数对齐，还没验证通过，所以这里明确返回 KG_LOGIN_STUB，不做半成品实现。
 */

const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');

const REQ_TIMEOUT = 12000;
const JSON_MAX = 8 * 1024 * 1024;
const COVER_MAX = 8 * 1024 * 1024;
const COVER_CACHE_MAX = 80;
const COVER_TTL = 10 * 60 * 1000;
const URL_TTL = 4 * 60 * 1000;      // 实测直链存活 ≥5 分钟，这里留一分钟余量
const LINE_TTL = 5 * 60 * 1000;

const API_MOBILE = () => String(process.env.KG_API || 'https://mobiles.kugou.com').replace(/\/+$/, '');
const WEB_MOBILE = () => String(process.env.KG_WEB || 'https://m.kugou.com').replace(/\/+$/, '');
const LYRICS_BASE = () => String(process.env.KG_LYRICS || 'https://lyrics.kugou.com').replace(/\/+$/, '');
const KRCS_BASE = () => String(process.env.KG_KRCS || 'https://krcs.kugou.com').replace(/\/+$/, '');

class KgError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'KgError';
    this.code = code || 'KG_ERROR';
  }
}

/* 设备指纹：酷狗的移动接口只要求带上 kg_mid / kg_dfid 这两个 cookie，
 * 值本身就是随机 32 位十六进制，没有额外的签名步骤。进程内固定，
 * 换号/重登时由 setCookie 作废缓存即可。 */
const KG_MID = crypto.randomBytes(16).toString('hex');
const KG_DFID = crypto.randomBytes(16).toString('hex');
const BASE_COOKIE = `kg_mid=${KG_MID}; kg_dfid=${KG_DFID}; kg_dfid_collect=${KG_DFID}`;

const state = { cookie: BASE_COOKIE, token: '', userid: 0 };

const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function baseHeaders(extra) {
  return Object.assign({
    'User-Agent': UA_MOBILE,
    Referer: WEB_MOBILE() + '/',
    Cookie: state.cookie || BASE_COOKIE
  }, extra || {});
}

/* 和 netease 的同名函数保持一致的语义：超时、大小上限、错误翻译成 KgError。
 * 不引第三方依赖，用 node 原生 http/https，避免把 Electron 的 net 拖进纯 Node 测试。 */
function request(target, { method = 'GET', headers, timeout = REQ_TIMEOUT, maxBytes = JSON_MAX, body } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch { return reject(new KgError('链接格式不对', 'KG_BAD_URL')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new KgError('只支持 http/https', 'KG_BAD_URL'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, timeout, headers: baseHeaders(headers) }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', d => {
        size += d.length;
        if (size > maxBytes) { req.destroy(new KgError('返回内容过大', 'KG_TOO_BIG')); return; }
        chunks.push(d);
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, buf: Buffer.concat(chunks) }));
      res.on('error', e => reject(new KgError('读取响应失败：' + ((e && e.message) || e), 'KG_NET')));
    });
    req.on('timeout', () => req.destroy(new KgError('请求超时（' + Math.round(timeout / 1000) + 's）', 'KG_TIMEOUT')));
    req.on('error', e => reject(e instanceof KgError ? e : new KgError('网络请求失败：' + ((e && e.message) || e), 'KG_NET')));
    if (body) req.write(body);
    req.end();
  });
}

async function getJSON(target, opts) {
  const r = await request(target, opts);
  if (r.status === 404) throw new KgError('接口不存在，可能已失效', 'KG_404');
  if (r.status === 429) throw new KgError('请求过于频繁，请稍后再试', 'KG_429');
  if (r.status >= 500) throw new KgError('酷狗服务暂时不可用（' + r.status + '）', 'KG_5XX');
  let j;
  try { j = JSON.parse(r.buf.toString('utf8')); }
  catch { throw new KgError('接口返回了非 JSON 内容，可能被限制', 'KG_BAD_JSON'); }
  if (!j || typeof j !== 'object') throw new KgError('接口返回内容不是对象', 'KG_BAD_JSON');
  return j;
}

/* ---------------- 归一化 ---------------- */

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/* 酷狗歌词与标题里会塞 HTML 实体，统一解掉（否则 esc() 会二次转义成 "&amp;"） */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function deent(input) {
  return String(input == null ? '' : input).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, k) => {
    if (k[0] === '#') {
      const n = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = ENT[k.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const httpsify = u => {
  const s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return '';
  return /^http:\/\/([a-z0-9-]+\.)*(kugou\.com|kgimg\.com|kugou\.net)\//i.test(s)
    ? s.replace(/^http:/i, 'https:')
    : s;
};

/* 搜索结果里的 `hash` 是唯一键：同一首歌可能有多条（不同清晰度/不同授权），
 * 用 hash 而不是 audio_id，因为取链接口只认 hash。 */
function mapSong(raw) {
  if (!raw || !raw.hash) return null;
  const hash = String(raw.hash).toLowerCase();
  const pay = Number(raw.pay_type) || 0;
  const t = {
    source: 'kugou',
    path: 'kg:' + hash,
    kgHash: hash,
    title: deent(raw.songname || raw.filename) || '未知曲目',
    artist: deent(raw.singername) || '未知艺人',
    album: deent(raw.album_name) || '',
    duration: num(raw.duration) ? Math.round(num(raw.duration)) : 0,
    coverUrl: '',                     // 搜索接口不带图，播放前由 coverData 补
    codec: 'mp3',
    sampleRate: 0,
    bitDepth: 0,
    bitrate: (num(raw.bitrate) || 0) * 1000,
    lossless: false,
    payType: pay,
    vip: pay !== 0                    // 付费/会员曲：只标出来，别拦着显示
  };
  return t;
}

/* ---------------- 搜索 ---------------- */
async function searchSongs(q, limit = 30) {
  const kw = String(q || '').trim();
  if (!kw) return [];
  const n = Math.min(100, Math.max(1, Number(limit) || 30));
  const url = API_MOBILE() + '/api/v3/search/song?' + new URLSearchParams({
    format: 'json', keyword: kw, page: '1', pagesize: String(n),
    showtype: '1', version: '8000', plat: '0', tag: '1', sver: '2'
  });
  const j = await getJSON(url);
  const list = (j.data && j.data.info) || [];
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const t = mapSong(raw);
    // 同一 hash 在结果里重复出现时只留一条（接口偶尔重复）
    if (!t || seen.has(t.kgHash)) continue;
    seen.add(t.kgHash);
    out.push(t);
  }
  return out;
}

/* ---------------- 直链 ---------------- */
const urlCache = new Map();   // hash -> { url, br, type, size, at }

/**
 * 免费曲直链：移动端 playInfo 只要 hash，不需要签名。
 * 付费曲返回的是 `{status:0, error:'需要付费'}`，这里翻成 KG_PAID，
 * 让渲染层显示「需要酷狗会员」而不是「网络错误」。
 */
async function songUrl(hash) {
  const h = String(hash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new KgError('曲目标识不对', 'KG_BAD_ID');

  const hit = urlCache.get(h);
  if (hit && Date.now() - hit.at < URL_TTL) return hit;

  const j = await getJSON(WEB_MOBILE() + '/app/i/getSongInfo.php?' + new URLSearchParams({ cmd: 'playInfo', hash: h }));
  if (!j || Number(j.status) !== 1 || !j.url) {
    const msg = String((j && j.error) || '');
    if (/付费|会员|vip/i.test(msg) || Number(j && j.pay_type) !== 0) {
      throw new KgError('该曲目需要酷狗会员，暂不支持播放', 'KG_PAID');
    }
    throw new KgError(msg || '该曲目暂时无法播放', 'KG_UNAVAILABLE');
  }
  const out = {
    url: httpsify(j.url),
    // playInfo 的 bitRate 是 kbps（128），和 search 的 bitrate 字段单位不同，统一成 bps
    br: num(j.bitRate) ? (num(j.bitRate) < 10000 ? num(j.bitRate) * 1000 : num(j.bitRate)) : 0,
    type: String(j.extName || 'mp3').toLowerCase(),
    size: num(j.fileSize),
    duration: num(j.timeLength),
    at: Date.now()
  };
  urlCache.set(h, out);
  while (urlCache.size > 400) urlCache.delete(urlCache.keys().next().value);
  return out;
}

function invalidateUrl(hash) {
  urlCache.delete(String(hash || '').trim().toLowerCase());
}

/* ---------------- 封面 ----------------
 * 搜索接口不给图，playInfo 里才有（`imgUrl`）。缩略图与详情共用一份缓存，
 * 按 hash 存 data URL：CSP 不用给每个 CDN 开域名，canvas 取色也不会跨域。 */
const coverCache = new Map();   // hash -> { dataUrl, bytes, at }

async function coverData(hash, size = 300) {
  const h = String(hash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new KgError('曲目标识不对', 'KG_BAD_ID');

  const hit = coverCache.get(h);
  if (hit && Date.now() - hit.at < COVER_TTL) return hit;

  const info = await getJSON(WEB_MOBILE() + '/app/i/getSongInfo.php?' + new URLSearchParams({ cmd: 'playInfo', hash: h }));
  /* playInfo 给两张：`album_img` 是专辑封面、`imgUrl` 是歌手头像（有时只有头像）。
   * 两者的路径里都带 `{size}` 占位符，得自己替换成实际边长，否则 404。 */
  const raw = httpsify((info && (info.album_img || info.imgUrl)) || '');
  if (!raw) throw new KgError('该曲目没有封面', 'KG_NO_COVER');

  const px = size && size >= 400 ? 400 : 240;
  let target = raw
    .replace(/\{size\}/gi, String(px))
    .replace(/\/(?:150|240|400|480)\//, '/' + px + '/');
  if (target === raw && !/\{size\}/i.test(raw)) target = raw;

  const r = await request(target, { timeout: 15000, maxBytes: COVER_MAX, headers: { 'User-Agent': UA_DESKTOP } });
  if (r.status !== 200) throw new KgError('封面请求失败（HTTP ' + r.status + '）', 'KG_COVER_HTTP');
  const type = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) throw new KgError('封面不是图片（' + (type || '未知类型') + '）', 'KG_COVER_TYPE');
  if (r.buf.length < 128) throw new KgError('封面数据为空', 'KG_COVER_EMPTY');

  const out = { dataUrl: 'data:' + (type === 'image/jpg' ? 'image/jpeg' : type) + ';base64,' + r.buf.toString('base64'), bytes: r.buf.length, at: Date.now() };
  coverCache.set(h, out);
  while (coverCache.size > COVER_CACHE_MAX) coverCache.delete(coverCache.keys().next().value);
  return out;
}

/* ---------------- 歌词 ---------------- */
const lyricCache = new Map();   // hash -> { text, source, at }

/* 两步：先在 krcs 搜候选（拿到 id + accesskey），再下 lrc。
 * 不做逐字（krc 加密格式），只给标准 LRC —— 渲染层本来就能用行级时间戳摊字。 */
async function lyric(hash) {
  const h = String(hash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new KgError('曲目标识不对', 'KG_BAD_ID');
  const hit = lyricCache.get(h);
  if (hit && Date.now() - hit.at < LINE_TTL) return hit;

  let cands = [];
  try {
    const j = await getJSON(KRCS_BASE() + '/search?' + new URLSearchParams({
      ver: '1', man: 'yes', client: 'mobi', keyword: '', duration: '', hash: h
    }));
    cands = (j && Array.isArray(j.candidates) ? j.candidates : []);
  } catch (e) {
    if (e.code === 'KG_TIMEOUT' || e.code === 'KG_NET') throw e;
    cands = [];
  }
  const best = cands.find(c => c && c.id && c.accesskey);
  if (!best) {
    const out = { text: '', source: '酷狗', note: '该曲目暂无歌词' };
    lyricCache.set(h, Object.assign(out, { at: Date.now() }));
    return out;
  }

  const j2 = await getJSON(LYRICS_BASE() + '/download?' + new URLSearchParams({
    ver: '1', client: 'pc', id: String(best.id), accesskey: String(best.accesskey), fmt: 'lrc', charset: 'utf8'
  }));
  const b64 = (j2 && (j2.content || j2.krc)) || '';
  /* 酷狗返回的 LRC 带 UTF-8 BOM：不剥掉的话第一行 `\uFEFF[id:…]` 不会被时间戳
   * 正则认出，会被当成正文塞进第一行歌词里。 */
  const text = b64 ? Buffer.from(b64, 'base64').toString('utf8').replace(/^\uFEFF/, '') : '';
  const out = { text: /\[\d{1,3}:\d{1,2}/.test(text) ? text : '', source: '酷狗' };
  if (!out.text) out.note = '该曲目暂无歌词';
  lyricCache.set(h, Object.assign(out, { at: Date.now() }));
  return out;
}

/* ---------------- 登录（接口占位） ----------------
 * 扫码登录要按 web 端参数对齐（实测缺参数时 login-user 返回 20010「参数错误」），
 * 这一版先不接：接口保留成同形状，接入时只需要把这三个函数填上，
 * 上层（renderer / main）不用改。 */
function setCookie(cookie, extra = {}) {
  state.cookie = String(cookie || '').trim() || BASE_COOKIE;
  state.token = String(extra.token || '');
  state.userid = num(extra.userid);
  urlCache.clear();
  lyricCache.clear();
}

async function status() {
  return {
    provider: 'kugou',
    loggedIn: !!state.token,
    hasCookie: !!state.token,
    nickname: '',
    vip: false,
    stub: !state.token,
    note: '酷狗登录尚未接入：当前只支持免费曲目'
  };
}

async function qrCreate() {
  throw new KgError('酷狗登录尚未接入', 'KG_LOGIN_STUB');
}

async function qrPoll() {
  throw new KgError('酷狗登录尚未接入', 'KG_LOGIN_STUB');
}

function logout() {
  setCookie('');
}

module.exports = {
  KgError,
  searchSongs, songUrl, invalidateUrl, coverData, lyric,
  status, setCookie, logout, qrCreate, qrPoll,
  // 纯函数，便于测试/排查
  mapSong, deent, httpsify, BASE_COOKIE
};
