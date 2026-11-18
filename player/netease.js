'use strict';
/**
 * 网易云音源适配层（主进程）
 * ---------------------------------------------------------------------------
 * 职责边界：
 *   1. 只做「HTTP + 字段归一化」，不碰 DOM、不碰播放器状态；
 *   2. 输出统一映射到项目现有的 Track 结构（见 mapSong），与本地文件共用同一套
 *      曲库、去重、封面缓存、持久化逻辑；
 *   3. 所有失败都以 NeError 抛出（带 code），由 IPC 层统一转成 {ok:false,error}，
 *      渲染层据此做降级提示，而不是把异常抛进播放链。
 *
 * 关于 path：网易云曲目的 path 取 `ne:<id>`。整个项目都用 path 做唯一键
 * （去重、封面缓存键、排序后重定位、写盘），保持这个约定就不必给每条链路
 * 都加一套 source 分支 —— 与本地文件天然共存。
 *
 * 接口是非正式契约（方案 7.2 已声明），字段随时可能改名，因此读取一律走
 * 「多候选键 + 缺省值」，任何单字段缺失都不应让整首歌解析失败。
 */
const https = require('node:https');
const http = require('node:http');
const qrcode = require('qrcode-generator');

const REQ_TIMEOUT = 12000;
const JSON_MAX = 16 * 1024 * 1024;
const COVER_MAX = 8 * 1024 * 1024;
const COVER_CACHE_MAX = 60;
const COVER_TTL = 10 * 60 * 1000;
const URL_TTL = 5 * 60 * 1000;      // 接口给的地址 20 分钟过期，这里留足余量

class NeError extends Error {
  constructor(message, code = 'NE_ERROR') {
    super(message);
    this.name = 'NeError';
    this.code = code;
  }
}

const state = { cookie: '', qr: null };
const baseUrl = () => String(process.env.NE_BASE || 'https://music.163.com').replace(/\/+$/, '');

/* ---------------- 音质档位 ----------------
 * 实测结论（2026-11，非正式契约，随时可能变）：
 *   - `/api/song/enhance/player/url`（v0）**完全忽略 level 参数**，永远按 br 走，
 *     传 level=standard 仍回 320k —— 这正是「换了音质没反应」的根因；
 *   - `/api/song/enhance/player/url/v1` 认 level：standard→128k、higher→192k、
 *     exhigh→320k；
 *   - 无损要有会员权限，无权限时接口不会报错，而是**静默降到 320k MP3**，
 *     所以界面必须按「实际返回」显示，而不是按用户选的档位显示；
 *   - v1 不可用时退回 v0 + br，保证换档至少能降级、不会整首放不出来。
 */
const QUALITY = {
  standard: { label: '标准', level: 'standard', br: 128000 },
  higher: { label: '较高', level: 'higher', br: 192000 },
  exhigh: { label: '极高', level: 'exhigh', br: 320000 },
  lossless: { label: '无损', level: 'lossless', br: 999000 }
};
const QUALITY_RANK = { standard: 0, higher: 1, exhigh: 2, lossless: 3 };
let quality = 'exhigh';

const qualityOf = q => (Object.prototype.hasOwnProperty.call(QUALITY, q) ? q : 'exhigh');
const getQuality = () => quality;

/** 切档必须清空地址缓存：缓存里存的是「上一档解析出来的地址」，不清就等于没切 */
function setQuality(q) {
  const next = qualityOf(q);
  if (next === quality) return quality;
  quality = next;
  urlCache.clear();
  return quality;
}

/* ---------------- HTTP ---------------- */
function baseHeaders(extra) {
  const cookie = ['os=pc', 'appver=2.10.13'];
  if (state.cookie) cookie.push(state.cookie);
  return Object.assign({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': baseUrl() + '/',
    'Cookie': cookie.join('; ')
  }, extra || {});
}

/* Node 的网络错误码直接甩给用户就是一堆 ENOTFOUND / ECONNREFUSED：
 * 断网、公司代理、DNS 污染的表现各不相同，但对用户来说只有「连不上」这一件事。 */
function netMessage(e) {
  const c = (e && e.code) || '';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return '连不上网易云（域名解析失败），请检查网络或代理设置';
  if (c === 'ECONNREFUSED') return '连接被拒绝，请检查网络或代理设置';
  if (c === 'ECONNRESET' || c === 'EPIPE') return '连接被中断，请重试';
  if (c === 'ETIMEDOUT' || c === 'ESOCKETTIMEDOUT') return '连接超时，请检查网络';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return '网络不可达，请检查网络连接';
  return '网络请求失败：' + ((e && e.message) || e);
}

function request(target, { method = 'GET', headers, timeout = REQ_TIMEOUT, maxBytes = JSON_MAX } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target, baseUrl() + '/'); } catch { return reject(new NeError('链接格式不对', 'NE_BAD_URL')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new NeError('只支持 http/https', 'NE_BAD_URL'));
    const mod = u.protocol === 'https:' ? https : http;

    const req = mod.request(u, { method, timeout, headers: baseHeaders(headers) }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', d => {
        size += d.length;
        if (size > maxBytes) { req.destroy(new NeError('返回内容过大', 'NE_TOO_BIG')); return; }
        chunks.push(d);
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, buf: Buffer.concat(chunks) }));
      res.on('error', e => reject(new NeError('读取响应失败：' + ((e && e.message) || e), 'NE_NET')));
    });
    req.on('timeout', () => req.destroy(new NeError('请求超时（' + Math.round(timeout / 1000) + 's）', 'NE_TIMEOUT')));
    req.on('error', e => reject(e instanceof NeError ? e : new NeError(netMessage(e), 'NE_NET')));
    req.end();
  });
}

/* -460 风控 / -462 要求绑定手机 / 301 未登录：都翻成人话，不要直接把数字丢给用户 */
const API_MSG = {
  '-460': '请求过于频繁，请稍后再试',
  '-462': '该接口要求登录或绑定手机',
  '301': '需要登录后才能访问'
};

/**
 * 拿到原始响应（不校验业务 code）。
 * 扫码轮询必须用这个：800/801/802 都是「业务码」，不是错误，但 getJSON 会把它们当异常。
 */
async function rawJSON(pathname, opts) {
  const r = await request(pathname, opts);
  if (r.status === 404) throw new NeError('接口不存在，可能已失效', 'NE_404');
  if (r.status === 429) throw new NeError('请求过于频繁，请稍后再试', 'NE_429');
  if (r.status >= 500) throw new NeError('网易云服务暂时不可用（' + r.status + '）', 'NE_5XX');

  let j;
  try { j = JSON.parse(r.buf.toString('utf8')); }
  catch { throw new NeError('接口返回了非 JSON 内容，可能被风控', 'NE_BAD_JSON'); }
  if (!j || typeof j !== 'object') throw new NeError('接口返回内容不是对象', 'NE_BAD_JSON');
  return { status: r.status, headers: r.headers, json: j };
}

async function getJSON(pathname, opts) {
  const { json: j } = await rawJSON(pathname, opts);
  const code = typeof j.code === 'number' ? j.code : 200;
  if (code !== 200 && code !== 0) {
    throw new NeError(API_MSG[String(code)] || j.message || j.msg || ('接口返回 ' + code), 'NE_API_' + code);
  }
  return j;
}

/* ---------------- 归一化 ---------------- */
/* 只升级网易云自家 CDN 的 http → https（音频 CDN 与图片 CDN 都实测支持 https），
 * 其他来源原样保留，方便把 NE_BASE 指到本地 mock 服务做离线测试。 */
const httpsify = u => {
  const s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return '';
  return /^http:\/\/([a-z0-9-]+\.)*(music\.126\.net|126\.net|163\.com)\//i.test(s)
    ? s.replace(/^http:/i, 'https:')
    : s;
};

/** 封面地址：补齐 https，并按需加 `?param=WyW` 限制尺寸（原图动辄几 MB） */
function coverUrl(raw, size = 500) {
  const s = httpsify(raw);
  if (!s) return '';
  try {
    const u = new URL(s);
    u.searchParams.delete('param');
    if (/(^|\.)music\.126\.net$/i.test(u.hostname)) u.searchParams.set('param', size + 'y' + size);
    return u.toString();
  } catch { return ''; }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** 接口偶尔返回 HTML 实体（`&amp;`），直接塞进 esc() 会二次转义成 "&amp;" */
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

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/* 两套接口的字段名不一样：
 *   song/detail → artists[] / album{duration}    （duration 单位 ms）
 *   playlist    → ar[]      / al    / dt         （dt 单位 ms）
 *   search      → artists[] / album / duration   （无封面）
 * 这里全部兼容，缺哪个就用另一个。 */
function artistsOf(raw) {
  const list = raw.ar || raw.artists || [];
  const names = (Array.isArray(list) ? list : []).map(a => deent(a && a.name)).filter(Boolean);
  return names.length ? names.join(' / ') : '未知艺人';
}
function albumOf(raw) {
  const al = raw.al || raw.album || {};
  return {
    id: num(al.id),
    name: deent(al.name),
    coverUrl: coverUrl(al.picUrl || al.blurPicUrl || '', 500)
  };
}
function durationOf(raw) {
  const ms = num(raw.dt) || num(raw.duration);
  return ms ? Math.round(ms / 1000) : 0;
}

/**
 * 单曲 → 项目 Track 结构。
 * 缺字段时给安全缺省：标题兜底、艺人为「未知艺人」、时长 0（UI 显示 `—` 而不是 0:00）、
 * 封面为空（由渲染层走无封面占位），绝不返回半成品让下游崩。
 */
function mapSong(raw, opt = {}) {
  if (!raw) return null;
  const id = num(raw.id);
  if (!id) return null;
  const al = albumOf(raw);
  const t = {
    source: 'netease',
    path: 'ne:' + id,
    netId: id,
    title: deent(raw.name || raw.title) || '未知曲目',
    artist: artistsOf(raw),
    album: al.name || deent(opt.albumName) || '',
    duration: durationOf(raw),
    coverUrl: al.coverUrl || coverUrl(opt.albumCover, 500),
    albumId: al.id || num(opt.albumId),
    codec: '', sampleRate: 0, bitDepth: 0, bitrate: 0, lossless: false,
    fee: Number(raw.fee) || 0
  };
  // fee: 0 免费 / 1 会员 / 4 付费专辑 / 8 免费低音质。
  // 只用来做提示，真正能不能播以 url 接口为准（有会员 cookie 时 fee=1 也能拿到地址）。
  if (t.fee === 1 || t.fee === 4) t.vip = true;
  return t;
}

/* ---------------- 接口 ---------------- */
async function songDetail(ids) {
  const uniq = [...new Set((ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  const got = new Map();
  for (let i = 0; i < uniq.length; i += 200) {
    const chunk = uniq.slice(i, i + 200);
    const j = await getJSON('/api/song/detail?ids=' + encodeURIComponent('[' + chunk.join(',') + ']'));
    for (const s of j.songs || []) {
      const t = mapSong(s);
      if (t) got.set(t.netId, t);
    }
  }
  // 保持调用方给的顺序（歌单顺序有意义）
  return uniq.map(id => got.get(id)).filter(Boolean);
}

async function searchSongs(q, limit = 30) {
  const kw = String(q || '').trim();
  if (!kw) return [];
  const n = Math.min(100, Math.max(1, Number(limit) || 30));
  const j = await getJSON('/api/search/get?s=' + encodeURIComponent(kw) + '&type=1&limit=' + n + '&offset=0');
  const raw = (j.result && j.result.songs) || [];
  const brief = raw.map(s => mapSong(s)).filter(Boolean);
  if (!brief.length) return [];

  // 搜索接口不返回封面，补一次批量详情；补不到就退回简要字段（无封面 → 占位图）
  try {
    const full = await songDetail(brief.map(t => t.netId));
    const byId = new Map(full.map(t => [t.netId, t]));
    return brief.map(t => {
      const f = byId.get(t.netId);
      if (!f) return t;
      return Object.assign({}, f, {
        title: f.title || t.title,
        artist: f.artist === '未知艺人' ? t.artist : f.artist,
        fee: t.fee
      });
    });
  } catch {
    return brief;
  }
}

async function playlistDetail(id) {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) throw new NeError('歌单 ID 不对', 'NE_BAD_ID');
  const j = await getJSON('/api/v6/playlist/detail?id=' + pid + '&n=1000');
  const p = j.playlist;
  if (!p) throw new NeError('歌单不存在或已下架', 'NE_NO_PLAYLIST');

  const trackIds = (Array.isArray(p.trackIds) ? p.trackIds : []).map(x => num(x && x.id)).filter(Boolean);
  let tracks = (Array.isArray(p.tracks) ? p.tracks : []).map(s => mapSong(s)).filter(Boolean);
  // `tracks` 只带前若干首，完整列表要按 trackIds 再取一次（详情里才有封面）
  if (trackIds.length > tracks.length) tracks = await songDetail(trackIds);

  return {
    id: pid,
    kind: 'playlist',
    name: deent(p.name) || '歌单',
    coverUrl: coverUrl(p.coverImgUrl, 500),
    count: num(p.trackCount) || trackIds.length || tracks.length,
    tracks
  };
}

async function albumDetail(id) {
  const aid = Number(id);
  if (!Number.isInteger(aid) || aid <= 0) throw new NeError('专辑 ID 不对', 'NE_BAD_ID');
  // `/api/album/<id>` 现在会要求绑定手机（code -462），用 v1 这个老接口更稳
  const j = await getJSON('/api/v1/album/' + aid);
  const al = j.album || {};
  const songs = Array.isArray(j.songs) ? j.songs : [];
  if (!songs.length && !al.name) throw new NeError('专辑不存在或已下架', 'NE_NO_ALBUM');
  return {
    id: aid,
    kind: 'album',
    name: deent(al.name) || '专辑',
    coverUrl: coverUrl(al.picUrl, 500),
    count: songs.length,
    tracks: songs.map(s => mapSong(s, { albumName: al.name, albumCover: al.picUrl, albumId: aid })).filter(Boolean)
  };
}

async function lyric(id) {
  const sid = Number(id);
  if (!Number.isInteger(sid) || sid <= 0) throw new NeError('曲目 ID 不对', 'NE_BAD_ID');
  /* yv=-1 取逐字歌词（yrc）：每行形如 [1000,2000](1000,300,0)你(1300,250,0)好，
   * 每个字都有真实的起止时间。渲染层优先用它按字对齐进度；
   * 老接口不认 yv 时只是少这个字段，不影响 lrc。 */
  const j = await getJSON('/api/song/lyric?id=' + sid + '&lv=-1&kv=-1&tv=-1&yv=-1');
  const text = String((j.lrc && j.lrc.lyric) || '');
  const yrc = String((j.yrc && j.yrc.lyric) || '');
  // 没有时间戳的（纯音乐说明、只有一句版权信息）不算歌词：
  // 渲染层是按行时间戳擦除的，塞进去只会得到一堆同时间的行。
  const timed = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text);
  if (!text.trim() && !yrc.trim()) return { text: '', source: '', note: '该曲目暂无歌词' };
  if (!timed && !yrc.trim()) return { text: '', source: '', note: '该曲目只有纯文本歌词，没有时间轴' };
  return { text: timed ? text : '', yrc: yrc.trim() ? yrc : '', source: '网易云' };
}

const urlCache = new Map();   // `${id}|${level}` -> { url, br, type, level, size, expi, at }

/* v1 的 code 常见取值：200 正常、404 无版权/已下架；旧接口用 -110 表示无版权。
 * 两者都要能翻成一句用户看得懂的话。 */
function unavailableReason(d) {
  const code = num(d && d.code);
  if (code === -110 || code === 404) return '该曲目暂无版权或已下架';
  if (!state.cookie) return '该曲目需要登录后才有播放权限，扫码登录后再试';
  return '当前账号没有这首的播放权限（可能需要会员）';
}

async function fetchUrlV1(sid, lv) {
  const j = await getJSON(
    '/api/song/enhance/player/url/v1?ids=' + encodeURIComponent('[' + sid + ']')
    + '&level=' + lv.level
    + '&encodeType=' + (lv.level === 'lossless' ? 'flac' : 'mp3')
  );
  return (Array.isArray(j.data) ? j.data : [])[0] || null;
}

/* v0 只认 br：作为 v1 不可用时的兜底，保证「换档」最差也能按码率降级 */
async function fetchUrlV0(sid, lv) {
  const j = await getJSON('/api/song/enhance/player/url?ids=' + encodeURIComponent('[' + sid + ']') + '&br=' + lv.br);
  return (Array.isArray(j.data) ? j.data : [])[0] || null;
}

async function songUrl(id, want) {
  const sid = Number(id);
  if (!Number.isInteger(sid) || sid <= 0) throw new NeError('曲目 ID 不对', 'NE_BAD_ID');

  const lv = QUALITY[qualityOf(want || quality)];
  const key = sid + '|' + lv.level;
  const hit = urlCache.get(key);
  if (hit && Date.now() - hit.at < URL_TTL) return hit;

  let d = null;
  let via = 'v1';
  try {
    d = await fetchUrlV1(sid, lv);
  } catch (e) {
    // v1 整体不可用（改版 / 风控 / 5xx）才退 v0；接口明确说「没版权」时不重试，
    // 否则每首不可播的曲子都要多打一次请求
    if (!d) { d = await fetchUrlV0(sid, lv).catch(() => null); via = 'v0'; }
    if (!d) throw e;
  }
  if (!d || !d.url) {
    // v1 回空数据（极少见）也试一次 v0，避免因为接口小改版导致整首放不出来
    if (d && !d.url && via === 'v1' && !num(d.code)) {
      const alt = await fetchUrlV0(sid, lv).catch(() => null);
      if (alt && alt.url) { d = alt; via = 'v0'; }
    }
  }
  if (!d || !d.url) {
    const e = new NeError(unavailableReason(d), 'NE_UNAVAILABLE');
    e.upstreamCode = num(d && d.code);
    throw e;
  }

  const actual = String(d.level || '') || inferLevel(num(d.br));
  const out = {
    url: httpsify(d.url),
    br: num(d.br),
    type: String(d.type || '').toLowerCase(),
    level: actual,
    requested: lv.level,
    // 请求「无损」却拿到 320k 是无权限降级，界面要说清楚，而不是继续写「无损」
    downgraded: (QUALITY_RANK[actual] ?? 3) < QUALITY_RANK[lv.level],
    size: num(d.size),
    expi: num(d.expi) || 1200,
    at: Date.now()
  };
  urlCache.set(key, out);
  return out;
}

function inferLevel(br) {
  if (br >= 900000) return 'lossless';
  if (br >= 300000) return 'exhigh';
  if (br >= 180000) return 'higher';
  return 'standard';
}

/* 同一首歌在所有档位下的缓存一起清掉：地址是按档位分键的，
 * 只删当前档会留下别的档位的旧地址，下次切过去又是过期的。 */
function invalidateUrl(id) {
  const prefix = Number(id) + '|';
  for (const k of [...urlCache.keys()]) if (k.startsWith(prefix)) urlCache.delete(k);
}

/* ---------------- 封面 ---------------- */
const coverCache = new Map();   // url -> { dataUrl, bytes, at }

/**
 * 封面下载：远程图统一转 data URL 交给渲染层。
 * 这样做有三个好处：CSP 只需要放开 data:（不用给每个 CDN 域名开口子）；
 * canvas 取色不会因跨域被污染（Palette 直接读像素）；断网后同一首歌不重复拉图。
 */
async function coverData(raw, size = 500) {
  const u = coverUrl(raw, size);
  if (!u) throw new NeError('该曲目没有封面地址', 'NE_NO_COVER');

  const hit = coverCache.get(u);
  if (hit && Date.now() - hit.at < COVER_TTL) return hit;

  const r = await request(u, { timeout: 15000, maxBytes: COVER_MAX });
  if (r.status !== 200) throw new NeError('封面请求失败（HTTP ' + r.status + '）', 'NE_COVER_HTTP');

  // 注意：CDN 返回的是非标准的 `image/jpg`，不是 `image/jpeg`
  const type = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) {
    throw new NeError('封面不是图片（' + (type || '未知类型') + '）', 'NE_COVER_TYPE');
  }
  if (r.buf.length < 128) throw new NeError('封面数据为空', 'NE_COVER_EMPTY');

  const mime = type === 'image/jpg' ? 'image/jpeg' : type;
  const out = { dataUrl: 'data:' + mime + ';base64,' + r.buf.toString('base64'), bytes: r.buf.length, at: Date.now() };
  coverCache.set(u, out);
  while (coverCache.size > COVER_CACHE_MAX) coverCache.delete(coverCache.keys().next().value);
  return out;
}

/* ---------------- 链接解析 ---------------- */
const KIND_RE = /music\.163\.com\/(?:[a-z]+?\/)*(?:#\/)?(song|playlist|album)(?:[/?]|\?id=)(\d+)/i;

/**
 * 支持这些写法（实测均为用户实际会粘贴的形态）：
 *   https://music.163.com/song?id=123
 *   https://music.163.com/#/song?id=123
 *   https://y.music.163.com/m/playlist?id=123
 *   https://music.163.com/playlist/123
 *   https://music.163.com/album?id=123
 *   12345678            （纯数字按歌曲处理）
 */
function parseLink(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d{3,}$/.test(s)) return { kind: 'song', id: Number(s) };
  const m = KIND_RE.exec(s);
  if (m) return { kind: m[1].toLowerCase(), id: Number(m[2]) };
  // 兜底：URL 里有 id 但没有类型路径（如 /#/song?id=）
  const m2 = /music\.163\.com\/.*?\/(song|playlist|album)\//i.exec(s);
  if (m2) {
    const idm = /[?&/]id=(\d+)/.exec(s) || /\/(\d+)(?:[?&#/]|$)/.exec(s);
    if (idm) return { kind: m2[1].toLowerCase(), id: Number(idm[1]) };
  }
  return null;
}

/** 短链（163cn.tv / 带跳转的分享链接）逐跳跟随，最多 4 跳 */
async function resolveLink(input) {
  const direct = parseLink(input);
  if (direct) return direct;
  const s = String(input || '').trim();
  if (!/^https?:\/\//i.test(s)) return null;

  let url = s;
  for (let hop = 0; hop < 4; hop++) {
    const r = await request(url, { method: 'GET', maxBytes: 512 * 1024 });
    const loc = r.headers.location;
    if (r.status >= 300 && r.status < 400 && loc) {
      try { url = new URL(loc, url).toString(); } catch { return null; }
      const hit = parseLink(url);
      if (hit) return hit;
      continue;
    }
    return parseLink(url) || null;
  }
  return null;
}

/* ---------------- 扫码登录 ----------------
 * 音源权限跟着账号走，所以登录不能做成「让用户自己去浏览器翻 Cookie」：
 * 走官方网页同一条扫码链路，主进程全程只碰会话串，不碰账号密码。
 *   1. POST /api/login/qrcode/unikey?type=1        → unikey（一次性）
 *   2. 二维码内容 = https://music.163.com/login?codekey=<unikey>
 *   3. GET  /api/login/qrcode/client/login?key=&type=1 轮询
 *        code 800 过期 / 801 等待扫码 / 802 已扫码待确认 / 803 登录成功
 *   4. 803 的会话 Cookie 只在响应头 Set-Cookie 里（body 的 cookie 字段不含 MUSIC_U），
 *      必须从 headers 拼；拼不出 MUSIC_U 就按失败处理，绝不把半截凭证写进播放链。
 */
const QR_TTL = 180 * 1000;          // 官方约 300s，这里按 180s 收口，过期就重取
const QR_GUARD = 20 * 1000;         // 超过 ttl 这么久就别再打接口了
const ACCOUNT_TTL = 60 * 1000;
const QR_MSG = {
  800: '二维码已过期',
  801: '等待扫码',
  802: '已扫码，请在手机上确认',
  803: '登录成功'
};

async function qrCreate() {
  const { json } = await rawJSON('/api/login/qrcode/unikey?type=1', { method: 'POST' });
  const key = String(json.unikey || '').trim();
  if (!key) throw new NeError('没能取到二维码，可能被风控，请稍后重试', 'NE_QR_KEY');
  state.qr = { key, at: Date.now() };
  return {
    key,
    url: 'https://music.163.com/login?codekey=' + encodeURIComponent(key),
    ttl: QR_TTL
  };
}

async function qrPoll() {
  const q = state.qr;
  if (!q || !q.key) throw new NeError('二维码已失效，请重新获取', 'NE_QR_GONE');
  if (Date.now() - q.at > QR_TTL + QR_GUARD) {
    state.qr = null;
    throw new NeError('二维码已过期，请重新获取', 'NE_QR_EXPIRED');
  }

  const { headers, json } = await rawJSON(
    '/api/login/qrcode/client/login?key=' + encodeURIComponent(q.key) + '&type=1'
  );
  const code = Number(json.code) || 0;
  const out = { code, message: QR_MSG[code] || ('未知状态 ' + code) };

  if (code === 803) {
    state.qr = null;                                     // key 一次性，成功即作废
    const cookie = cookieFromSetCookie(headers['set-cookie']) || String(json.cookie || '');
    if (!/(^|;\s*)MUSIC_U=/.test(cookie)) {
      throw new NeError('登录成功但没拿到会话凭证，请重新扫码', 'NE_QR_NO_COOKIE');
    }
    setCookie(cookie);
    out.cookie = cookie;
    out.nickname = deent(json.nickname);
    out.avatarUrl = httpsify(json.avatarUrl);
    // 刚登录就立刻再问一次账号接口有竞态（cookie 生效有毫秒级延迟、也可能被风控），
    // 拿 803 自带的信息先顶 60s，避免自己把「刚登录成功」误判成「登录已过期」
    accountCache = {
      at: Date.now(),
      value: {
        loggedIn: true,
        nickname: out.nickname || '',
        avatarUrl: out.avatarUrl || '',
        userId: 0,
        vipType: 0,
        fresh: true
      }
    };
    warmUid();          // 顺手把 uid 补上，登录后立刻拉歌单时不用再等
    return out;
  }
  // 过期后同一个 key 再问永远是 800，直接作废，等渲染层重新取码
  if (code === 800) state.qr = null;
  return out;
}

/**
 * 从 Set-Cookie 拼会话串。
 * 剔除空值/已失效项（退出登录或被顶号时服务端会下发 Max-Age=0 的空 cookie），
 * 同名只留第一条，避免把新旧 MUSIC_U 拼在一起。
 */
function cookieFromSetCookie(list) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  const out = [];
  const seen = new Set();
  for (const line of arr) {
    const parts = String(line).split(';');
    const head = parts[0];
    const eq = head.indexOf('=');
    if (eq <= 0) continue;
    const name = head.slice(0, eq).trim();
    const value = head.slice(eq + 1).trim();
    if (!name || !value) continue;
    if (parts.some(p => /^\s*max-age\s*=\s*0\s*$/i.test(p))) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name + '=' + value);
  }
  return out.join('; ');
}

/** 二维码：只负责把布尔矩阵画成 SVG（内联，CSP 不用给图片域名开口子） */
function qrSvg(text, opt = {}) {
  const s = String(text || '');
  if (!s) throw new NeError('二维码内容为空', 'NE_QR_EMPTY');
  const qr = qrcode(0, opt.ecc === 'L' ? 'L' : 'M');
  qr.addData(s);
  qr.make();
  const n = qr.getModuleCount();
  const margin = opt.margin == null ? 3 : Math.max(0, Math.min(8, Math.trunc(opt.margin)));
  const total = n + margin * 2;

  // 逐行合并连续的暗块：一个 path 比 n² 个 <rect> 小一个数量级
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
  // 白底黑块固定不变：反色或透明底在很多扫码器上认不出来
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total +
    '" shape-rendering="crispEdges" role="img" aria-label="网易云音乐登录二维码">' +
    '<rect width="' + total + '" height="' + total + '" fill="#ffffff"/>' +
    '<path d="' + d + '" fill="#111111"/></svg>';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 当前账号（也用来判断保存的凭证是否还有效：cookie 过期时 profile 为 null） */
let accountCache = { at: 0, value: null };

const profileToAccount = p => ({
  loggedIn: true,
  nickname: deent(p.nickname) || ('用户' + num(p.userId)),
  avatarUrl: httpsify(p.avatarUrl),
  userId: num(p.userId),
  vipType: num(p.vipType)
});

/**
 * 强制问一次账号接口。
 * 803 刚回来时 profile 可能还是 null（cookie 生效有毫秒级延迟），
 * 所以这里带有限重试；`keepFresh` 用于登录后的预热：
 * 即使这次问不到，也不要把账号判死，保留 803 带回来的那份。
 */
async function accountRefresh({ keepFresh = false, attempts = 2 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(300);
    try {
      const j = await getJSON('/api/nuser/account/get');
      const p = j.profile || null;
      if (p) {
        const v = profileToAccount(p);
        accountCache = { at: Date.now(), value: v };
        return v;
      }
      // profile 为 null：真过期，或者刚登录还没生效。最后一轮才下结论。
      if (i === attempts - 1) {
        if (keepFresh && accountCache.value && accountCache.value.loggedIn) return accountCache.value;
        const v = { loggedIn: false };
        accountCache = { at: Date.now(), value: v };
        return v;
      }
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) {
        if (keepFresh && accountCache.value && accountCache.value.loggedIn) return accountCache.value;
        throw e;
      }
    }
  }
  throw lastErr || new NeError('账号信息获取失败', 'NE_ACCOUNT');
}

async function account() {
  if (!state.cookie) return { loggedIn: false };
  const c = accountCache.value;
  // 缓存里可能是 803 带回来的「只有昵称、还没有 uid」那一份：照样直接返回，
  // 需要 uid 的调用方（歌单）自己再调 accountRefresh 去补，不去打扰别的路径。
  if (c && Date.now() - accountCache.at < ACCOUNT_TTL) return c;
  return accountRefresh({ attempts: 2 });
}

/* 登录成功后 803 只带昵称、没有 uid，而「我的歌单」必须拿 uid 去查。
 * profile 生效有毫秒级延迟，所以这里做一次有上限的轮询预热：
 * 界面此刻看到的是「正在加载歌单」，等 uid 到手再一次性渲染，不会先闪一条报错。 */
let uidWarm = null;
function warmUid() {
  const cookieAtStart = state.cookie;
  uidWarm = (async () => {
    for (let i = 0; i < 6; i++) {
      if (i) await sleep(400);
      if (state.cookie !== cookieAtStart) return null;     // 期间退出/换号，这次预热作废
      try {
        const j = await getJSON('/api/nuser/account/get');
        if (j.profile) {
          const v = profileToAccount(j.profile);
          accountCache = { at: Date.now(), value: v };
          return v;
        }
      } catch {}
    }
    return null;
  })();
  return uidWarm;
}

/* ---------------- 我的歌单 / 推荐 ----------------
 * 扫码登录成功后抽屉里要先有东西可看：自己创建的歌单 + 每日推荐 + 私人FM。
 * 三条硬约束：
 *   1. 只列「自己创建」的：creator.userId === uid 且没有 subscribed 标记。
 *      收藏来的歌单不进这段列表 —— 几十个歌单混在一起时根本找不到自己的；
 *   2. 内容必须属于当前账号：uid 每次现取，缓存按 uid 分键，换账号（setCookie）直接清空；
 *   3. 各段独立失败：推荐歌单挂了不能把「我的歌单」也变成一片空白。
 */
const MINE_TTL = 2 * 60 * 1000;
const PICKED_TTL = 10 * 60 * 1000;
const DAY_TTL = 5 * 60 * 1000;

let mineCache = { uid: 0, at: 0, value: null };
let pickedCache = { at: 0, value: null };
let dailyCache = { day: '', at: 0, value: null };

const errInfo = e => ({ code: (e && e.code) || 'NE_ERROR', message: String((e && e.message) || e) });
const dayKey = (d = new Date()) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

/** 需要登录的接口：把「301 需要登录 / -462 要绑手机」统一翻成可判断的登录失效 */
async function authed(pathname) {
  try {
    return await getJSON(pathname);
  } catch (e) {
    const code = String((e && e.code) || '');
    if (code === 'NE_API_301' || code === 'NE_API_-462') {
      accountCache = { at: 0, value: null };
      throw new NeError('登录已过期，请重新扫码', 'NE_LOGIN_REQUIRED');
    }
    throw e;
  }
}

/**
 * 歌单卡片的统一形状。
 * user/playlist、personalized/playlist 两套接口的字段名不一样（coverImgUrl / picUrl），
 * 这里都吃；缺 id 的条目直接丢掉，别让一格空白占着位置。
 */
function mapPlaylistCard(p) {
  if (!p) return null;
  const id = num(p.id);
  if (!id) return null;
  const creator = p.creator || {};
  const special = num(p.specialType);
  return {
    id,
    name: deent(p.name) || '歌单',
    coverUrl: coverUrl(p.coverImgUrl || p.picUrl, 200),
    count: num(p.trackCount) || num(p.songCount),
    playCount: num(p.playCount),
    creatorId: num(creator.userId) || num(p.userId),
    special: special === 5 ? 'like' : '',   // 5 = 我喜欢的音乐
    subscribed: p.subscribed === true,       // 收藏来的
    privacy: num(p.privacy)
  };
}

/** 当前账号「创建」的歌单（含我喜欢的音乐）；同时回报被隐藏的收藏数量 */
async function myPlaylists() {
  const a = await account();
  if (!a.loggedIn) {
    throw new NeError(hasCookie() ? '登录已过期，请重新扫码' : '登录后才能加载你的歌单', 'NE_LOGIN_REQUIRED');
  }

  let uid = a.userId;
  if (!uid) {
    // 803 刚回来只知道昵称：先等预热拿到 uid，绝不能拿 uid=0 去请求别人的歌单
    const w = await (uidWarm || warmUid());
    if (w && w.userId) uid = w.userId;
  }
  if (!uid) {
    const b = await accountRefresh({ keepFresh: true, attempts: 2 });
    if (!b.loggedIn) throw new NeError(hasCookie() ? '登录已过期，请重新扫码' : '登录后才能加载你的歌单', 'NE_LOGIN_REQUIRED');
    uid = b.userId;
    if (!uid) throw new NeError('账号信息还没就绪，请稍后重试', 'NE_NO_UID');
  }
  if (mineCache.value && mineCache.uid === uid && Date.now() - mineCache.at < MINE_TTL) return mineCache.value;

  // 单页 500，最多翻 4 页：正常账号一次就够，歌单特别多的也不用请求几十次
  const all = [];
  for (let offset = 0; offset < 2000; offset += 500) {
    const j = await authed('/api/user/playlist?uid=' + uid + '&limit=500&offset=' + offset);
    const arr = Array.isArray(j.playlist) ? j.playlist : [];
    all.push(...arr);
    if (!j.more || arr.length < 500) break;
  }

  const mine = [];
  const seen = new Set();
  let hidden = 0;
  for (const p of all) {
    const c = mapPlaylistCard(p);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    if (c.creatorId === uid && !c.subscribed) mine.push(c);
    else hidden++;
  }
  // 我喜欢的音乐永远置顶（接口本来就排在前面，这里不依赖它的顺序）
  mine.sort((x, y) => (y.special === 'like' ? 1 : 0) - (x.special === 'like' ? 1 : 0));

  const value = {
    uid,
    nickname: deent(a.nickname) || '',
    list: mine,
    subscribed: hidden,
    at: Date.now()
  };
  mineCache = { uid, at: Date.now(), value };
  return value;
}

/** 推荐歌单（公开接口，未登录也有）：给「登录/加载失败」时留一点可看的内容 */
async function pickedPlaylists(limit = 6) {
  const n = Math.min(12, Math.max(1, Number(limit) || 6));
  if (pickedCache.value && Date.now() - pickedCache.at < PICKED_TTL) return pickedCache.value;
  const j = await getJSON('/api/personalized/playlist?limit=' + n);
  const list = (Array.isArray(j.result) ? j.result : []).map(mapPlaylistCard).filter(Boolean);
  const value = { list, at: Date.now() };
  pickedCache = { at: Date.now(), value };
  return value;
}

/** 每日推荐歌曲（必须登录；返回结构在不同版本里键名不一样，全部兼容一遍） */
async function dailySongs() {
  const a = await account();
  if (!a.loggedIn) {
    throw new NeError(hasCookie() ? '登录已过期，请重新扫码' : '登录后才能看每日推荐，请先扫码', 'NE_LOGIN_REQUIRED');
  }
  const day = dayKey();
  if (dailyCache.value && dailyCache.day === day && Date.now() - dailyCache.at < DAY_TTL) return dailyCache.value;

  const j = await authed('/api/discovery/recommend/songs');
  const d = j.data || {};
  const raw = d.dailySongs || j.dailySongs || j.recommend || [];
  const tracks = (Array.isArray(raw) ? raw : []).map(s => mapSong(s)).filter(Boolean);
  const value = { tracks, day, at: Date.now() };
  dailyCache = { day, at: Date.now(), value };
  return value;
}

/**
 * 私人FM：`/api/radio/get` 一次只回一首（实测 limit 参数无效），
 * 所以并发 3 路连取、按 id 去重，凑够一批就停。
 * 全线失败才抛错；部分成功就把拿到的交出去，总比空手强。
 */
async function personalFm(count = 8) {
  const a = await account();
  if (!a.loggedIn) throw new NeError('登录后才能用私人FM，请先扫码', 'NE_LOGIN_REQUIRED');

  const want = Math.min(12, Math.max(1, Number(count) || 8));
  const got = new Map();
  let lastErr = null;
  let calls = 0;
  let dead = 0;
  const maxCalls = want + 4;

  while (got.size < want && calls < maxCalls) {
    // 每波不超过「还差多少首」，否则要 4 首会拿到 6 首
    const wave = Math.min(3, want - got.size, maxCalls - calls);
    calls += wave;
    const rs = await Promise.all(Array.from({ length: wave }, () =>
      getJSON('/api/radio/get').catch(e => { lastErr = e; return null; })));
    let added = 0;
    for (const j of rs) {
      const raw = j && (Array.isArray(j.data) ? j.data[0] : j.data);
      const t = mapSong(raw);
      if (t && !got.has(t.netId)) { got.set(t.netId, t); added++; }
    }
    // 连续两波都没新歌（接口在重复吐同一批）就收手，别把请求数打满
    if (!added) { if (++dead >= 2) break; } else dead = 0;
  }

  if (!got.size) {
    const code = (lastErr && lastErr.code) || '';
    if (code === 'NE_API_301' || code === 'NE_API_-462') throw new NeError('登录已过期，请重新扫码', 'NE_LOGIN_REQUIRED');
    throw lastErr || new NeError('私人FM 暂时没有返回曲目，稍后再试', 'NE_FM_EMPTY');
  }
  return { tracks: [...got.values()] };
}

/** 抽屉首页一次拿齐：账号 + 我的歌单 + 推荐歌单，两段各自独立成败 */
async function home() {
  const a = await account();
  const loggedIn = !!a.loggedIn;
  const out = {
    loggedIn,
    hasCookie: hasCookie(),
    uid: a.userId || 0,
    nickname: a.nickname || '',
    vipType: a.vipType || 0,
    mine: null,
    mineError: null,
    picked: null,
    pickedError: null
  };

  const [m, p] = await Promise.allSettled([
    loggedIn ? myPlaylists() : Promise.resolve(null),
    pickedPlaylists(6)
  ]);

  if (m.status === 'fulfilled' && m.value) {
    out.mine = { list: m.value.list, subscribed: m.value.subscribed };
    out.uid = m.value.uid || out.uid;
    out.nickname = m.value.nickname || out.nickname;
  } else if (m.status === 'rejected') {
    out.mineError = errInfo(m.reason);
  }
  if (p.status === 'fulfilled') out.picked = { list: p.value.list };
  else out.pickedError = errInfo(p.reason);
  return out;
}

/* ---------------- 凭证 ---------------- */
function setCookie(cookie) {
  state.cookie = String(cookie || '').trim();
  state.qr = null;
  uidWarm = null;
  accountCache = { at: 0, value: null };   // 换账号，昵称/权限缓存都要作废
  mineCache = { uid: 0, at: 0, value: null };   // 上一个账号的歌单绝不能留给下一个账号
  dailyCache = { day: '', at: 0, value: null };
  urlCache.clear();          // 换账号后可用音质会变，旧地址不能复用
  coverCache.clear();
}
const hasCookie = () => !!state.cookie;

module.exports = {
  NeError,
  setCookie, hasCookie,
  searchSongs, songDetail, playlistDetail, albumDetail, lyric,
  songUrl, invalidateUrl, coverData,
  QUALITY, setQuality, getQuality,
  qrCreate, qrPoll, qrSvg, account,
  home, myPlaylists, pickedPlaylists, dailySongs, personalFm,
  // 纯函数，供单测/排查直接调用
  mapSong, mapPlaylistCard, parseLink, resolveLink, coverUrl, deent, httpsify, cookieFromSetCookie
};
