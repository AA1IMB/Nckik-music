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

const state = {
  cookie: BASE_COOKIE,
  token: '',
  userid: 0,
  /* 登录态的三个派生字段：
   *   verified —— 有没有真的用凭证去问过一次「会员曲能不能取到链」；
   *   vip      —— 上一次自检的结论（true 表示账号能取到付费曲的直链）；
   *   checkedAt—— 自检时间，UI 用它显示「刚刚/几分钟前」。 */
  verified: false,
  vip: false,
  checkedAt: 0
};

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

/* ---------------- 直链 ----------------
 * 取链不是一条路：同一个 hash，免费曲、会员曲、带不带凭证，命中的接口都不一样。
 * 所以这里按「候选路径」依次试，谁先给出一条能用的地址就用谁，并把结论
 * （是需要会员、还是接口本身不可用）汇总给上层，避免把「没权限」报成「网络错误」。 */
const urlCache = new Map();   // hash -> { url, br, type, size, at, path }

const md5 = s => crypto.createHash('md5').update(String(s)).digest('hex');

/* playInfo 家族的返回体：`url` 可能叫 `play_url` / `backup_url`，付费时全为空。 */
function readPlayInfo(j) {
  if (!j || typeof j !== 'object') return { miss: true, paid: false };
  const url = httpsify(j.url || j.play_url || j.play_backup_url || j.backup_url || '');
  if (url) {
    return {
      url,
      // playInfo 的 bitRate 是 kbps（128），和 search 的 bitrate 字段单位不同，统一成 bps
      br: num(j.bitRate) ? (num(j.bitRate) < 10000 ? num(j.bitRate) * 1000 : num(j.bitRate)) : 0,
      type: String(j.extName || 'mp3').toLowerCase(),
      size: num(j.fileSize),
      duration: num(j.timeLength)
    };
  }
  const pay = Number(j.pay_type) || 0;
  const priv = Number(j.privilege) || 0;
  const msg = String(j.error || '');
  const paid = pay !== 0 || priv > 0 || /付费|会员|vip|购买/i.test(msg);
  return { miss: true, paid, msg };
}

/* 1) 老 WAP playInfo：免费曲不需要凭证；登录后把 token/userid 一起带上，
 *    部分账号在这条路上就能拿到会员曲的地址。 */
async function resolveWap(h) {
  const q = { cmd: 'playInfo', hash: h };
  if (state.token || state.userid) {
    if (state.token) q.token = state.token;
    if (state.userid) q.userid = String(state.userid);
  }
  const j = await getJSON(WEB_MOBILE() + '/app/i/getSongInfo.php?' + new URLSearchParams(q));
  return readPlayInfo(j);
}

/* 2) trackercdn v2：key = md5(hash + 'kgcloudv2')，必须带设备号与账号。
 *    清晰度按 flac → hq → sq 试，账号有什么权限就拿到什么档。 */
async function resolveCdn2(h, br) {
  const params = {
    hash: h, key: md5(h + 'kgcloudv2'), br: br || 'hq', appid: '1005', pid: '2',
    mid: KG_MID, dfid: KG_DFID, version: '9108', cmd: '25', behavior: 'play'
  };
  if (state.token) params.token = state.token;
  if (state.userid) params.userid = String(state.userid);
  const j = await getJSON('https://trackercdn.kugou.com/i/v2/?' + new URLSearchParams(params));
  const got = readPlayInfo(j);
  if (got.url) return got;
  /* v2 失败时 `error` 是英文的 "The Resource Needs to be Paid"，
   * readPlayInfo 的付费判据吃不到，这里补一条。 */
  if (!got.paid && /paid|privilege|purchase/i.test(String((j && (j.error || j.msg)) || ''))) {
    return { miss: true, paid: true, msg: String(j.error || j.msg || '') };
  }
  return got;
}

/* 3) trackercdn v1：key = md5(hash + 'kgcloud')，老接口，少量曲目只有它给地址。 */
async function resolveCdn1(h) {
  const params = { hash: h, key: md5(h + 'kgcloud'), br: 'sq', appid: '1005', pid: '2', mid: KG_MID, dfid: KG_DFID };
  if (state.token) params.token = state.token;
  if (state.userid) params.userid = String(state.userid);
  const j = await getJSON('https://trackercdn.kugou.com/i/?' + new URLSearchParams(params));
  return readPlayInfo(j);
}

async function songUrl(hash) {
  const h = String(hash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new KgError('曲目标识不对', 'KG_BAD_ID');

  const hit = urlCache.get(h);
  if (hit && Date.now() - hit.at < URL_TTL) return hit;

  /* 顺序有讲究：免费曲走 wap 最快；登录后先试 v2 的 flac/hq（会员权益通常在这一档），
   * 最后才回落到 v1。失败路径只在「可能要会员」时才多花几次请求。 */
  const plan = [
    { name: 'wap', run: () => resolveWap(h) },
    { name: 'cdn2-flac', run: () => resolveCdn2(h, 'flac') },
    { name: 'cdn2-hq', run: () => resolveCdn2(h, 'hq') },
    { name: 'cdn1', run: () => resolveCdn1(h) }
  ];

  let paid = false;
  let msg = '';
  let netErr = null;
  const tried = [];
  for (const step of plan) {
    let got;
    try { got = await step.run(); }
    catch (e) {
      tried.push(step.name + ':err:' + ((e && e.code) || 'x'));
      if (e && (e.code === 'KG_TIMEOUT' || e.code === 'KG_NET')) { netErr = e; continue; }
      continue;                                    // 单条路径 404/非 JSON：换下一条，不中断
    }
    tried.push(step.name + ':' + (got && got.url ? 'ok' : 'miss'));
    if (got && got.url) {
      const out = Object.assign({}, got, { at: Date.now(), path: step.name });
      urlCache.set(h, out);
      while (urlCache.size > 400) urlCache.delete(urlCache.keys().next().value);
      return out;
    }
    if (got && got.paid) paid = true;
    if (got && got.msg) msg = got.msg;
  }

  if (!paid && netErr) throw netErr;
  if (paid) {
    throw new KgError(
      loggedIn() ? '当前账号没有这首曲目的播放权限（可能需要更高等级的会员）' : '该曲目需要酷狗会员，登录后可播放',
      'KG_PAID'
    );
  }
  throw new KgError(msg || '该曲目暂时无法播放', 'KG_UNAVAILABLE');
}

function invalidateUrl(hash) {
  urlCache.delete(String(hash || '').trim().toLowerCase());
}

/* ---------------- 封面 ----------------
 * 搜索接口不给图，playInfo 里才有（`imgUrl`）。缩略图与详情共用一份缓存，
 * 按 hash 存 data URL：CSP 不用给每个 CDN 开域名，canvas 取色也不会跨域。 */
const coverCache = new Map();   // hash -> { dataUrl, bytes, at }

/* 很多地址里直接写着 `{size}` 占位符（`imge.kugou.com/stdmusic/{size}/…`），
 * 不替换会 404；少数地址写的是具体边长，按同段替换成目标尺寸。 */
function coverAt(raw, size = 240) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const px = size >= 400 ? 400 : 240;
  return httpsify(s)
    .replace(/\{size\}/gi, String(px))
    .replace(/\/(?:150|240|320|400|480)\//, '/' + px + '/');
}

/* 曲库里的歌单/榜单封面只给地址，进图走这里；和 coverData 共用一份 URL 缓存，
 * 所以同一张图在列表缩略图与详情里只下一次。 */
async function coverByUrl(raw, size = 240) {
  const u = coverAt(raw, size);
  if (!u) throw new KgError('没有封面地址', 'KG_NO_COVER');
  const hit = coverCache.get(u);
  if (hit && Date.now() - hit.at < COVER_TTL) return hit.dataUrl;
  const r = await request(u, { timeout: 15000, maxBytes: COVER_MAX, headers: { 'User-Agent': UA_DESKTOP, accept: 'image/*' } });
  if (r.status !== 200) throw new KgError('封面请求失败（HTTP ' + r.status + '）', 'KG_COVER_HTTP');
  const type = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!/^image\//.test(type)) throw new KgError('封面返回的不是图片', 'KG_COVER_TYPE');
  if (r.buf.length < 128) throw new KgError('封面内容为空', 'KG_COVER_EMPTY');
  const dataUrl = 'data:' + type + ';base64,' + r.buf.toString('base64');
  coverCache.set(u, { dataUrl, bytes: r.buf.length, at: Date.now() });
  while (coverCache.size > COVER_CACHE_MAX) coverCache.delete(coverCache.keys().next().value);
  return dataUrl;
}

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

/* ---------------- 登录 ----------------
 * 采用「导入已登录 Cookie」：酷狗的扫码/短信接口都要签名（缺参数时 login-user 直接回
 * 20010「参数错误」），而浏览器里登录后的 Cookie 本身就能被接口认作会话 —— 不需要
 * 破任何签名，也不接触账号密码。取舍写在 §14 记录里。
 *
 * 凭证只经 applyAuth() 进内存；落盘由 main.js 用 safeStorage 加密到 kg-auth.bin，
 * 这里不碰文件、不打印明文。 */
const loggedIn = () => !!(state.token || state.userid);

/* 会员自检用的探测曲：发如雪（付费曲，pay_type=3）。登录后拿它试一次取链，
 * 能拿到地址就说明这个账号确实有会员权益；拿不到就只当「已登录但无权益」。 */
const VIP_PROBE_HASH = '1f7e7659b9fff4fb6f71562a61bbc25f';

function applyAuth({ cookie, token, userid } = {}) {
  state.cookie = String(cookie || '').trim() || BASE_COOKIE;
  state.token = String(token || '');
  state.userid = num(userid);
  state.verified = false;
  state.vip = false;
  state.checkedAt = 0;
  urlCache.clear();
  lyricCache.clear();
}

/* 账号摘要：只出现脱敏后的 token 与长度，渲染层/探针拿不到明文。 */
function authInfo() {
  const tok = String(state.token || '');
  return {
    provider: 'kugou',
    loggedIn: loggedIn(),
    userid: Number(state.userid) || 0,
    tokenMasked: tok ? tok.slice(0, 4) + '…(' + tok.length + ')' : '',
    cookieLen: String(state.cookie || '').length,
    verified: !!state.verified,
    vip: !!state.vip,
    checkedAt: Number(state.checkedAt) || 0
  };
}

/* 自检：拿会员探测曲试一次。返回 { loggedIn, vip, reason }，不改播放链路。
 * reason 用于 UI/探针解释「登录了但还是播不了会员曲」的原因：
 *   no-rights = 接口明确说需要权限（账号不是会员 / 会员等级不够）
 *   其它值   = 网络或接口问题（KG_NET/KG_TIMEOUT/KG_UNAVAILABLE） */
async function verify() {
  if (!loggedIn()) {
    state.verified = true;
    state.vip = false;
    state.checkedAt = Date.now();
    return { loggedIn: false, vip: false, reason: 'anonymous' };
  }
  urlCache.delete(VIP_PROBE_HASH);
  let vip = false;
  let reason = '';
  try { await songUrl(VIP_PROBE_HASH); vip = true; }
  catch (e) { reason = e && e.code === 'KG_PAID' ? 'no-rights' : ((e && e.code) || 'error'); }
  state.verified = true;
  state.vip = vip;
  state.checkedAt = Date.now();
  return { loggedIn: true, vip, reason };
}

/* 兼容老名字：main.js 之前只调 setCookie/logout。 */
function setCookie(cookie, extra = {}) {
  applyAuth({ cookie, token: extra.token, userid: extra.userid });
}

async function status() {
  const a = authInfo();
  const note = !a.loggedIn
    ? '未登录：只能播放免费曲（128k mp3）'
    : !a.verified
      ? '已登录：正在自检会员权益…'
      : a.vip
        ? '已登录：账号有会员权益，可播放会员曲'
        : '已登录：账号没有会员权益，会员曲会提示后跳过';
  return Object.assign({}, a, {
    hasCookie: a.loggedIn,        // 与网易云同语义：有凭证（可能过期）
    nickname: '',
    stub: !a.loggedIn,
    note
  });
}

/* ---------------- 曲库：榜单（充当「推荐歌单」） ----------------
 * 实测（见 §14.20）：`everyday/recommend`、`personalized/recommend`、`user/playlist`
 * 对匿名与 Cookie 登录都回纯文本 `Access Deny !!!`（服务端白名单 + 签名），
 * 只有 `rank/list` 与 `rank/song` 能匿名取到。所以曲库页里：
 *   每日推荐   → 不可用（能力矩阵 daily:false），界面给原因，不造数据
 *   推荐歌单   → 由排行榜充当，rankid 就当歌单 id
 *   我创建的歌单 → 不可用（mine:false），界面引导去登录/导入 Cookie
 */
const RANK_TTL = 10 * 60 * 1000;
let rankMemo = { at: 0, items: [] };

function mapRankSong(raw) {
  if (!raw || !raw.hash) return null;
  const hash = String(raw.hash).toLowerCase();
  const authors = Array.isArray(raw.authors) ? raw.authors : [];
  const artist = authors.map(a => deent(a && a.author_name)).filter(Boolean).join(' / ')
    || deent(String(raw.filename || '').split(' - ')[0]) || '未知艺人';
  const tp = raw.trans_param || {};
  const pay = Number(raw.pay_type) || 0;
  return {
    source: 'kugou',
    path: 'kg:' + hash,
    kgHash: hash,
    title: deent(raw.songname || raw.filename) || '未知曲目',
    artist,
    album: '',
    duration: num(raw.duration) ? Math.round(num(raw.duration)) : 0,
    coverUrl: coverAt(tp.union_cover || raw.album_sizable_cover || '', 240),
    codec: 'mp3', sampleRate: 0, bitDepth: 0, bitrate: 0, lossless: false,
    payType: pay,
    vip: pay !== 0
  };
}

/* 榜单本身每天只变一两次，缓存十分钟；切标签来回看不会反复打接口。 */
async function ranks(page = 1, size = 30) {
  const p = Math.max(1, Number(page) || 1);
  const n = Math.min(60, Math.max(1, Number(size) || 30));
  if (p === 1 && rankMemo.items.length >= n && Date.now() - rankMemo.at < RANK_TTL) {
    return { items: rankMemo.items.slice(0, n), page: 1, hasMore: rankMemo.items.length > n };
  }
  const qs = new URLSearchParams({ format: 'json', page: String(p), pagesize: String(n), plat: '0', version: '8000' });
  const j = await getJSON(API_MOBILE() + '/api/v3/rank/list?' + qs);
  const info = (j && j.data && j.data.info) || [];
  const items = info.map(r => ({
    source: 'kugou',
    id: String(r.rankid),
    name: deent(r.rankname) || '未命名榜单',
    coverUrl: coverAt(r.imgurl || r.img_cover || '', 240),
    count: num(r.songcount || r.song_count),
    playCount: num(r.play_times),
    updateText: deent(r.update_frequency || ''),
    desc: deent(r.intro || '')
  }));
  if (p === 1) rankMemo = { at: Date.now(), items };
  const total = num(j && j.data && j.data.total);
  return { items, page: p, hasMore: total ? p * n < total : info.length >= n };
}

async function rankSongs(rankid, page = 1, size = 50) {
  const id = String(rankid || '').trim();
  if (!/^\d+$/.test(id)) throw new KgError('榜单标识不对', 'KG_BAD_ID');
  const p = Math.max(1, Number(page) || 1);
  const n = Math.min(100, Math.max(1, Number(size) || 50));
  const qs = new URLSearchParams({ format: 'json', rankid: id, page: String(p), pagesize: String(n), plat: '0', version: '8000' });
  const j = await getJSON(API_MOBILE() + '/api/v3/rank/song?' + qs);
  const info = (j && j.data && j.data.info) || [];
  const total = num(j && j.data && j.data.total);
  const items = info.map(mapRankSong).filter(Boolean);
  return { items, page: p, total, hasMore: total ? p * n < total : info.length >= n };
}

/* ---------------- 登录：扫码（显式降级） ----------------
 * `login-user.kugou.com/v1/qrcode` 对 appid/plat 的四种常见组合都回
 * `{"status":0,"error_code":20010,"data":"参数错误"}` —— 这套接口要 web 端那套
 * 签名（mid/dfid/clienttime + md5），本版不做逆向。所以扫码被实现成
 * 「试一次、拿不到就明确抛 KG_QR_UNSIGNED」，由界面降级到「导入 Cookie」，
 * 而不是转圈到超时或假装成功。 */
const QR_TARGET = () => 'https://login-user.kugou.com/v1/qrcode?' + new URLSearchParams({
  appid: '1005', plat: '4', srcappid: '2919', clientver: '2000', clienttime: String(Date.now())
});

async function qrCreate() {
  /* 一次网络抖动不该让用户看到「需要签名」这种误导性结论：超时/断网先重试一次，
   * 两次都拿不到才下结论；而且结论里要区分「接口拒绝」与「网络不通」。 */
  let detail = '';
  let netFail = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request(QR_TARGET(), { timeout: 12000, maxBytes: 256 * 1024, headers: { accept: 'application/json' } });
      let j = null;
      try { j = JSON.parse(r.buf.toString('utf8')); } catch { j = null; }
      if (j && j.status === 1 && j.data && j.data.qrcode) {
        /* 上游哪天放开了就自动可用：这里不写死「永远失败」 */
        return {
          provider: 'kugou',
          key: String(j.data.qrcode),
          img: j.data.qrcode_img || j.data.img || '',
          expiresAt: Date.now() + 120000
        };
      }
      detail = j ? '（error_code ' + (j.error_code || j.status) + '）' : '（HTTP ' + r.status + '）';
      netFail = null;
      break;
    } catch (e) {
      netFail = (e && e.code) || 'KG_NET';
      detail = '（' + netFail + '）';
      if (attempt === 0) continue;          // 网络类错误重试一次
      break;
    }
  }
  if (netFail) {
    throw new KgError('获取酷狗二维码失败' + detail + '：网络不通或接口不可达；可改用「导入 Cookie」登录', 'KG_QR_UNSIGNED');
  }
  throw new KgError('酷狗扫码接口需要签名，当前版本无法完成扫码' + detail + '；请改用「导入 Cookie」登录', 'KG_QR_UNSIGNED');
}

async function qrPoll(key) {
  if (!key) throw new KgError('缺少二维码标识', 'KG_BAD_ID');
  throw new KgError('酷狗扫码接口需要签名，当前版本无法轮询扫码状态；请改用「导入 Cookie」登录', 'KG_QR_UNSIGNED');
}

function logout() {
  applyAuth({});
}

module.exports = {
  KgError,
  searchSongs, songUrl, invalidateUrl, coverData, coverAt, coverByUrl, lyric,
  ranks, rankSongs,
  status, applyAuth, authInfo, verify, logout, setCookie, qrCreate, qrPoll, loggedIn,
  VIP_PROBE_HASH,
  // 纯函数，便于测试/排查
  mapSong, mapRankSong, deent, httpsify, readPlayInfo, BASE_COOKIE
};
