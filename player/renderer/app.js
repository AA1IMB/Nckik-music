'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const audio = new Audio();
audio.preload = 'auto';

const S = {
  tracks: [],                       // 曲库（素材库）：导入/搜索得到的曲目，不决定播放顺序
  libIndex: new Map(),              // path -> track，队列解析用 O(1) 定位
  q: [],                            // 播放队列：settings.playlist 的运行时投影，等长同序
  shufPool: new Set(),              // 随机播放「本轮还没播过」的 id 池（存 id 不存下标）
  shufDone: new Set(),              // 本轮已经播过的 id：列表增删重排时重建池也不许把它们放回来
  shufFail: new Map(),              // id -> 本轮失败次数：连着放不出来的歌暂时别抽（避免两首坏歌来回跳）
  i: -1,                            // ★ 队列下标（不是曲库下标）；取当前曲目请用 curTrack()
  playing: false,
  lyrics: [],
  lyIdx: -1,
  lyricSrc: '',
  accent: '#5b5b66',
  idn: { current: '', providers: [] },   // 当前账号（标题栏右上角头像）
  up: { qqapp: { status: 'idle', items: [], err: '' }, kugou: { status: 'idle', items: [], err: '' } },
  settings: null,
  devices: [],
  seekDrag: false,
  lastLy: -1,
  lnNodes: [],
  lnChars: [],                     // 每行的字节点数组（没有逐字数据的行是 null）
  curCh: -2,                       // 当前正在填的字下标：-2 还没开始，n 已完成 n 个
  curFrac: -1,                     // 当前字内的比例，避免每帧重复写同一个样式值
  gapNode: null,                   // 正在演的空档「…」节点（没有就是 null）
  gapP: -1,                        // 「…」上一帧的填充比例，避免重复写样式
  gapOp: -1,                       // 「…」上一帧的透明度，同上
  hist: [],
  libDirty: false,
  srcMode: 'local',                 // 曲库抽屉的音轨：local / net / bil
  ne: {
    items: [], busy: false, err: '', loggedIn: false, nick: '', seq: 0,
    hasCookie: false, uid: 0,
    /* view：home 歌单首页 / search 搜索结果 / coll 打开的歌单
     * 三者共用下面同一个列表容器，靠 view 决定画哪一块，避免多套 DOM 抢同一块空间 */
    view: 'home',
    home: { status: 'idle', err: '', data: null },   // idle / loading / ready / error
    homeSeq: 0,
    coll: null,                                      // { kind, id, name, sub, status, err, tracks }
    collSeq: 0
  },
  /* 哔哩哔哩：搜索 + 我的收藏夹两条路径。view 决定列表区画什么：
   * idle（空态/首页引导） / search（搜索结果） / fav（某个收藏夹的条目） / error。 */
  bil: {
    items: [], busy: false, err: '', seq: 0, view: 'idle',
    status: null, total: 0,
    favs: { status: 'idle', err: '', items: [], seq: 0 },   // 收藏夹（文件夹）列表
    fav: { id: '', title: '', page: 0, hasMore: false, items: [], busy: false, err: '' }
  }
};

/* ------------------------------------------------------------------ 音源 */
/*
 * 网易云曲目的 path 是 `ne:<id>`、哔哩哔哩的是 `bil:<bvid>:<cid>`，与本地路径
 * 共用同一个唯一键空间：去重、封面缓存、排序后重定位、写盘全都沿用原有逻辑，
 * 不需要到处加 source 分支 —— 只有「取封面 / 取流」这两处必须按音源分流。
 */
const NET_PREFIX = 'ne:';
const isNet = k => !!k && k.source === 'netease';
const netIdOf = k => (isNet(k) ? Number(k.netId || String(k.path).slice(NET_PREFIX.length)) : 0);

const BIL_PREFIX = 'bil:';
const isBil = k => !!k && k.source === 'bilibili';
const bilBvidOf = k => (isBil(k) ? String(k.bilBvid || String(k.path).split(':')[1] || '') : '');
const bilCidOf = k => (isBil(k) ? Number(k.bilCid || String(k.path).split(':')[2] || 0) : 0);

/* ------------------------------------------------------------------ 播放队列
 * 播放列表是唯一播放源：S.q 是 settings.playlist 的运行时投影，等长同序。
 * 曲库 S.tracks 只是素材库，负责提供曲目对象；顺序完全由列表决定。
 * S.i 是「队列下标」——所有取当前曲目的地方都走 curTrack()，别再写 S.tracks[S.i]。
 *
 * 队列行里不预先塞 track 对象：列表可以上万首，全量 map 一遍纯属白占内存，
 * 第 k 行第一次被用到时再查 S.libIndex（见 qTrack）。
 */
function rebuildLibIndex() {
  S.libIndex = new Map();
  for (const t of S.tracks) if (t && t.path) S.libIndex.set(t.path, t);
}

/* path → track。表里没有就回曲库线性找一次并补进表：
 * 曲库也可能被别的路径改动（导入、探针直接 push），不能假设表永远最新。 */
function resolveTrack(id) {
  let t = S.libIndex.get(id) || null;
  if (!t) {
    t = S.tracks.find(x => x && x.path === id) || null;
    if (t) S.libIndex.set(id, t);
  }
  return t;
}

/* 队列重建。keep='id' 表示按 id 保住当前曲目（重排、插歌都走这条）；
 * 不传就只把下标夹回合法范围。历史栈一律清空——它的下标已经失效了。
 * 返回当前曲是否还在新队列里：调用方（尤其是「覆盖导入」）要据此决定播放头怎么摆。 */
function rebuildQueue(keep) {
  const cur = keep === 'id' ? curTrack() : null;
  S.q = plItems().map(item => ({ id: item.id, item, t: resolveTrack(item.id) }));
  const at = cur ? S.q.findIndex(x => x.id === cur.path) : -1;
  if (at >= 0) S.i = at;
  /* 当前曲已经不在新列表里：游标必须清空。
   * 之前这里只是「不越界就保留旧下标」，于是导入之后游标会落在新列表的第 N 首上，
   * 顺序播放就从中间开始、前面的歌永远播不到。 */
  else if (cur) S.i = -1;
  else if (S.i >= S.q.length) S.i = S.q.length ? S.q.length - 1 : -1;
  S.hist.length = 0;
  resetShufPool(keep === 'id');           // 只是列表变了 → 保留本轮已播；整单换掉 → 开新一轮
  return at >= 0;
}

/* 队列里可能有一首「曲库里没有、但确实是网易云曲目」的歌：导入歌单时并没有把整张单子
 * 塞进曲库（曲库是「我的收藏」，不是「当前歌单」），于是这些行的 id 在 S.tracks 里查不到。
 * 这类行不是坏行 —— neaudio 只认 ne:<id>，按 id 现造一个最小 Track 就能播。
 * 以前它们被当成坏行交给 skipDead 按列表顺序往后找，随机播放就会老跳回那两三首可播的邻居。 */
function synthNetTrack(item) {
  const id = String((item && item.id) || '');
  if (!id.startsWith(NET_PREFIX)) return null;
  const netId = Number(id.slice(NET_PREFIX.length));
  if (!netId) return null;
  return {
    path: id,                        // 队列/持久化都以 path 为键，合成曲目也用同一个 id
    source: 'netease',
    netId,
    title: item.title || '',
    artist: item.artist || '',
    album: '',
    duration: Number(item.duration) || 0,
    codec: '', bitrate: 0, lossless: false, coverUrl: ''
  };
}

/* 哔哩哔哩同理：点「加入播放列表」时只拿到 bvid（搜索结果里没有 cid），
 * 播放列表里这一行存的就是 bil:<bvid>:0。播放时 playAt 会把 cid 补进去并把
 * 曲目与列表项一起改成 bil:<bvid>:<cid>；但重启后（或没播过就关掉）列表里仍是 :0，
 * 这些行必须还能解析成可播曲目，否则会被当成坏行跳过。 */
function synthBilTrack(item) {
  const id = String((item && item.id) || '');
  if (!id.startsWith(BIL_PREFIX)) return null;
  const parts = id.slice(BIL_PREFIX.length).split(':');
  const bvid = parts[0] || '';
  const cid = Number(parts[1] || 0) || 0;
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return null;
  return {
    path: id,
    source: 'bilibili',
    bilBvid: bvid,
    bilCid: cid,                     // 0 表示还没补，playAt 的预检会填
    title: item.title || '',
    artist: item.artist || '',
    album: '哔哩哔哩',
    duration: Number(item.duration) || 0,
    codec: 'aac', bitrate: 0, lossless: false,
    coverUrl: item.coverUrl || ''
  };
}

/* 上游音源（酷狗 kg:<hash> / QQ 音乐 qq:<mid>）的曲目不进本地曲库，
 * 但它们照样能播：用队列里的元数据现造一条可播行，别再判成「不在曲库里」。 */
function synthUpTrack(item) {
  if (!item) return null;
  const id = String(item.id || '');
  if (!/^(kg:[0-9A-Fa-f]{32}|qq:[0-9A-Za-z]{8,24})$/.test(id)) return null;
  return {
    path: id,
    title: item.title || item.name || '未知曲目',
    artist: item.artist || '',
    duration: Number(item.duration || 0) || 0,
    codec: id.startsWith('kg:') ? 'MP3' : 'AAC'
  };
}

function qTrack(qi) {
  const row = S.q[qi];
  if (!row) return null;
  if (!row.t) {
    row.t = resolveTrack(row.id) || synthNetTrack(row.item) || synthBilTrack(row.item) || synthUpTrack(row.item);
  }
  return row.t;
}

const curTrack = () => (S.i >= 0 ? qTrack(S.i) : null);
const curItem = () => (S.i >= 0 && S.q[S.i] ? S.q[S.i].item : null);

/* 随机池：只装「还没播过」的 id。用 id 而不是下标，
 * 这样重排/删除/失效之后池也不会指错歌。
 * soft=true：列表只是增删/重排，本轮已播的记录要留着 —— 否则 rebuildQueue 一调用，
 * 播过的歌就会重新进池，用户就会听到「随机又切回刚才那首」。 */
function resetShufPool(soft) {
  if (!soft || !S.shufDone) S.shufDone = new Set();
  S.shufPool = new Set(S.q.map(x => x.id).filter(id => !S.shufDone.has(id)));
  const k = curTrack();
  if (k) S.shufPool.delete(k.path);       // 当前曲不进池，避免一抽就抽回自己
}

function shufNext() {
  if (!S.shufPool.size) {                 // 一轮播完 → 开新一轮（清空已播记录再洗）
    S.shufDone = new Set();
    S.shufFail = new Map();               // 新一轮给坏歌一次机会
    resetShufPool(false);
  }
  if (!S.shufPool.size) return -1;        // 只有一首且就是当前曲
  /* 只从「真的能播」的行里抽：本地文件被删掉之后那一行不该占掉本轮的名额，
   * 否则一次随机可能连着跳好几次，听感就是卡顿、乱跳。
   * 本轮已经失败过两次的歌也先别抽（网易云偶发 5xx 时，两首坏歌会互相弹回去）。 */
  const live = [...S.shufPool].filter(id => {
    if ((S.shufFail.get(id) || 0) >= 2) return false;
    const qi = S.q.findIndex(x => x.id === id);
    return qi >= 0 && !!qTrack(qi);
  });
  const ids = live.length ? live : [...S.shufPool];
  const pick = ids[Math.floor(Math.random() * ids.length)];
  S.shufPool.delete(pick);
  S.shufDone.add(pick);
  const qi = S.q.findIndex(x => x.id === pick);
  if (qi < 0) return -1;
  if (S.i >= 0) { S.hist.push(S.i); if (S.hist.length > 500) S.hist.shift(); }
  return qi;
}

/* 随机模式下「放不出来」记账：同一首连失两次就暂时踢出本轮候选。 */
function markShufFail(path) {
  if (!path) return;
  const n = (S.shufFail.get(path) || 0) + 1;
  S.shufFail.set(path, n);
}

function shufBack() {
  while (S.hist.length) {
    const qi = S.hist.pop();
    if (qi >= 0 && qi < S.q.length) return qi;
  }
  return -1;                              // 没有来路：停在当前，不硬跳
}


/* 无封面 / 取色失败时的中性色（方案 3.1：低饱和或黑白封面降级为中性灰，不引入第二种彩色） */
const NEUTRAL = '#5b5b66';

/* ------------------------------------------------------------------ 工具 */
const fmt = t => {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const hex2rgb = h => {
  const s = h.replace('#', '');
  const n = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
};
const rgb2hex = (r, g, b) =>
  '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => {
  const A = hex2rgb(a), B = hex2rgb(b);
  return rgb2hex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
};
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hsl2rgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue2 = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < .5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2(p, q, h + 1 / 3) * 255, hue2(p, q, h) * 255, hue2(p, q, h - 1 / 3) * 255];
}

/* 账号切换/登录/退出：主进程推来的 revision 一变就作废该平台的相关缓存。
 * 这里只做「失效」，真正重新拉取由各平台自己的 ensureXxx() 在需要时触发，
 * 避免切号瞬间同时打十几个请求。 */
window.__accToast = (m) => toast(m);
window.__accOnAccountChange = (provider, revision) => {
  try {
    thumbUrl.clear();
    if (window.api && window.api.accInvalidate) window.api.accInvalidate(provider);
    S.accRev = S.accRev || {};
    S.accRev[provider] = revision;
    if (provider === 'bil' || provider === 'bilibili') bilFavsReset();
  } catch (e) { /* 缓存清理失败不影响主流程 */ }
};

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.classList.remove('act');
  scanToastActive = false;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  if (ms > 0) toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ------------------------------------------------------------------ 主题 */
function sunTimes(lat, lon, date = new Date()) {
  const rad = Math.PI / 180;
  const start = new Date(date.getFullYear(), 0, 0);
  const n = Math.floor((date - start) / 86400000);
  const lngHour = lon / 15;
  const one = rise => {
    const t = n + ((rise ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    let L = M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634;
    L = (L + 360) % 360;
    let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
    RA = (RA + 360) % 360;
    const Lq = Math.floor(L / 90) * 90, RAq = Math.floor(RA / 90) * 90;
    RA = (RA + Lq - RAq) / 15;   // 与 L 对齐象限：RA + (Lq - RAq)
    const sinDec = 0.39782 * Math.sin(L * rad);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = ((rise ? -1 : 1) * Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    if (cosH > 1 || cosH < -1) return null;           // 极昼 / 极夜
    let H = rise ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad;
    H /= 15;
    const T = H + RA - 0.06571 * t - 6.622;
    return (T - lngHour + 24) % 24;                    // UTC 小时
  };
  const toLocal = ut => (ut === null ? null : (((ut * 60 - date.getTimezoneOffset()) / 60) % 24 + 24) % 24);
  return { rise: toLocal(one(true)), set: toLocal(one(false)) };
}

/* 相对亮度与对比度：只用于判断擦除色能不能和歌词文字分开 */
const relLum = h => {
  const [r, g, b] = hex2rgb(h).map(v => {
    v /= 255;
    return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4);
  });
  return .2126 * r + .7152 * g + .0722 * b;
};
const contrast = (a, b) => {
  const l1 = relLum(a), l2 = relLum(b);
  return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
};
const FG = { dark: '#f5f5f7', light: '#141418' };   // 与 --fg 同步
const INK_MIN = 2.4;                                // 36px 大字，够看清分界即可

/**
 * 擦除色 = 封面主色，但必须与歌词文字色拉开对比度。
 *
 * 只按固定比例混白/混黑是不够的：暗色主题里文字是白的，碰到浅色封面
 * （雪景、白底专辑、米色设计）主色本身就接近白，混白 12% 后对比度只剩
 * 1.0–1.5，擦除分界等于没做 —— 和当初「混白 55%」是同一类错误，只是触发
 * 条件换成了「封面很亮」。所以这里带一个下限：不足时沿同一色相反向压
 * （暗色压黑、日间提亮），色相不变，仍然只有「封面这一个颜色」。
 */
function inkFor(accent, dark) {
  const fg = dark ? FG.dark : FG.light;
  const toward = dark ? '#ffffff' : '#000000';   // 原策略：暗色混白 12%，日间混黑 18%
  const away = dark ? '#000000' : '#ffffff';     // 对比不足时的修正方向
  let c = mix(accent, toward, dark ? .12 : .18);
  if (contrast(c, fg) >= INK_MIN) return c;
  for (let k = .1; k <= 1.0001; k += .08) {
    c = mix(accent, away, k);
    if (contrast(c, fg) >= INK_MIN) return c;
  }
  return dark ? '#000000' : '#ffffff';
}

function syncAccentInk() {
  const dark = document.body.dataset.theme === 'dark';
  document.body.style.setProperty('--acInk', inkFor(S.accent, dark));
}

function applyTheme() {
  const st = S.settings;
  const { rise, set } = sunTimes(st.lat, st.lon);   // 一次算出，模式判断与显示共用
  let mode = st.theme;
  if (mode === 'auto') {
    if (rise === null || set === null) mode = 'dark';
    else {
      const now = new Date();
      const h = now.getHours() + now.getMinutes() / 60;
      mode = h >= rise && h < set ? 'light' : 'dark';
    }
  }
  document.body.dataset.theme = mode;
  syncAccentInk();
  $$('#segTheme b').forEach(b => b.classList.toggle('on', b.dataset.t === st.theme));

  const hm = h => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
  $('#sunTxt').textContent = rise === null ? '极昼 / 极夜' : `${hm(rise)} · ${hm(set)}`;
}

function commitGeo() {
  const el = $('#inGeo');
  const m = /(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)/.exec(el.value || '');
  if (!m) {
    el.value = `${S.settings.lat}, ${S.settings.lon}`;
    toast('坐标格式：纬度, 经度');
    return;
  }
  S.settings.lat = clamp(parseFloat(m[1]), -89.9, 89.9);
  S.settings.lon = clamp(parseFloat(m[2]), -180, 180);
  el.value = `${S.settings.lat}, ${S.settings.lon}`;
  applyTheme();
  saveSettings();
  toast('已按新坐标计算日出日落');
}

/* ------------------------------------------------------------------ 取色 */
/**
 * Palette：从「真实封面」取唯一主色。
 *
 * 数据源可能是本地内嵌图、同目录 cover.jpg，或网易云返回的封面（已在主进程转成
 * data URL）。三条来源最终都落成同一个 src，所以取色只有这一份实现。
 *
 * 返回 null 表示「没取到」（解码失败 / 图是坏的），由调用方降级为中性色；
 * 返回中性灰表示「取到了但封面是黑白的」—— 两者原因不同，日志与文案要能分开。
 */
async function accentFrom(src) {
  if (!src) return null;
  let img;
  try {
    img = new Image();
    img.src = src;
    await img.decode();
  } catch { return null; }

  try {
    const c = document.createElement('canvas');
    c.width = c.height = 28;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, 28, 28);
    const d = x.getImageData(0, 0, 28, 28).data;
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      const lum = (R * .299 + G * .587 + B * .114) / 255;
      if (lum < .07 || lum > .95) continue;                 // 剔纯黑纯白
      const sat = (mx - mn) / 255;
      const wt = .12 + sat * 1.9;                           // 优先取饱和像素
      r += R * wt; g += G * wt; b += B * wt; w += wt;
    }
    if (!w) return null;
    let [h, s, l] = rgb2hsl(r / w, g / w, b / w);
    if (s < .10) {                                          // 低饱和封面降级为中性灰
      const grey = Math.round(clamp(l, .30, .55) * 255);
      return rgb2hex(grey, grey, grey);
    }
    s = clamp(s, .44, .74);
    l = clamp(l, .40, .56);
    const [R, G, B] = hsl2rgb(h, s, l);
    return rgb2hex(R, G, B);
  } catch { return null; }   // canvas 被污染 / 显存不足
}

let acTween = 0;
function applyAccentVars(hex) {
  S.accent = hex;
  const b = document.body.style;
  b.setProperty('--ac', hex);
  b.setProperty('--acDeep', mix(hex, '#000000', .52));
  b.setProperty('--acRgb', hex2rgb(hex).join(','));
  syncAccentInk();
  $('#acTxt').textContent = hex.toUpperCase();
}
/* 主色做一次短补间：渐变 background 无法被 CSS transition 平滑插值，
 * 直接换变量会"跳一下"，所以在 JS 里插值 --ac。 */
function setAccent(hex, animate = true) {
  cancelAnimationFrame(acTween);
  const from = S.accent;
  if (!animate || from === hex) { applyAccentVars(hex); return; }
  const t0 = performance.now(), dur = 380;
  const step = now => {
    const k = Math.min(1, (now - t0) / dur);
    applyAccentVars(mix(from, hex, 1 - Math.pow(1 - k, 3)));
    if (k < 1) acTween = requestAnimationFrame(step);
  };
  acTween = requestAnimationFrame(step);
}

/* ------------------------------------------------------------------ 封面缓存 */
/* 内嵌封面动辄几 MB 的 base64，不能永久挂在曲目对象上；只留最近若干张。 */
const coverCache = new Map();
const COVER_MAX = 10;
const getCover = p => coverCache.get(p) || null;
function setCover(p, dataUrl) {
  if (!dataUrl) return;
  coverCache.delete(p);
  coverCache.set(p, dataUrl);
  while (coverCache.size > COVER_MAX) coverCache.delete(coverCache.keys().next().value);
}

/* 封面取不到时 5 分钟内不再重试：切歌来回跳不至于每次都打一次网络。
 * 超过时限再试，避免一次断网把封面永久钉死。 */
const coverFail = new Map();
const COVER_FAIL_TTL = 5 * 60 * 1000;

/**
 * 封面唯一入口。三条来源最终都变成 data URL：
 *   本地内嵌图 / 同目录 cover.*（主进程读文件）→ trackDetail.cover
 *   网易云 coverUrl（主进程下载）            → neCover
 * 失败一律返回 null，由调用方降级到中性色与占位文案，不抛异常打断播放链。
 */
async function loadArt(k) {
  if (!k) return null;
  const hit = getCover(k.path);
  if (hit) return hit;

  /* 哔哩哔哩：封面就是搜索结果里的 pic，按 URL 向主进程要一次小图。
   * 没有 pic 的稿件给 null，由调用方降级到中性色占位。 */
  if (isBil(k)) {
    if (!k.coverUrl) { k.coverError = ''; return null; }
    const failAt = coverFail.get(k.path);
    if (failAt && Date.now() - failAt < COVER_FAIL_TTL) return null;
    let rb;
    try { rb = await window.api.bilCover(k.coverUrl, 500); }
    catch (e) { rb = { ok: false, error: { message: String((e && e.message) || e) } }; }
    if (rb && rb.ok && rb.dataUrl) {
      setCover(k.path, rb.dataUrl);
      k.coverError = '';
      return rb.dataUrl;
    }
    coverFail.set(k.path, Date.now());
    k.coverError = (rb && rb.error && rb.error.message) || '封面加载失败';
    return null;
  }

  if (!isNet(k)) return null;

  if (!k.coverUrl) {
    /* 早期版本从搜索结果入库的曲目没有专辑图字段，库里的 coverUrl 就是空的；
     * 光靠本机数据永远补不上，先按 netId 向接口要一次再决定要不要放弃。 */
    if (await healNetCover(k)) persistLibrary();
  }
  if (!k.coverUrl) { k.coverError = ''; return null; }   // 接口也没给：不是加载失败
  const at = coverFail.get(k.path);
  if (at && Date.now() - at < COVER_FAIL_TTL) return null;

  let r;
  try { r = await window.api.neCover(k.coverUrl); }
  catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }

  if (r && r.ok && r.dataUrl) {
    setCover(k.path, r.dataUrl);
    k.coverError = '';
    return r.dataUrl;
  }
  coverFail.set(k.path, Date.now());
  k.coverError = (r && r.error && r.error.message) || '封面加载失败';
  return null;
}

/* 网易云曲目缺封面地址时按 netId 向接口补一次。
 * 背景：早期版本从搜索结果入库的歌没有专辑图字段，coverUrl 一直是空的，
 * 界面上就是「网易云没有为该曲目提供封面」——其实接口是有的，只是没再问过。
 * 只补内存字段，落盘由调用方决定。 */
const coverHeal = new Set();         // 正在补的 netId，避免同一首并发打两次
async function healNetCover(t) {
  if (!t || !isNet(t) || t.coverUrl || !t.netId) return false;
  if (coverHeal.has(t.netId)) return false;
  coverHeal.add(t.netId);
  try {
    const r = await window.api.neSongs([t.netId]);
    const hit = (r && r.ok && Array.isArray(r.tracks)) ? r.tracks[0] : null;
    if (!hit || !hit.coverUrl) return false;
    t.coverUrl = hit.coverUrl;
    if (!t.album && hit.album) t.album = hit.album;
    if (!t.albumId && hit.albumId) t.albumId = hit.albumId;
    return true;
  } catch { return false; }          // 离线：保持占位，下次启动再补
  finally { coverHeal.delete(t.netId); }
}

/* 启动后扫一遍曲库里缺封面的网易云曲目（一次接口最多 200 个 id），
 * 补到的写回 library.json 并重画列表，用户不用手动清缓存。 */
async function healNetCovers() {
  const miss = S.tracks.filter(t => isNet(t) && t.netId && !t.coverUrl);
  if (!miss.length) return 0;
  let changed = 0;
  for (let i = 0; i < miss.length; i += 100) {
    const chunk = miss.slice(i, i + 100);
    let tracks = null;
    try {
      const r = await window.api.neSongs(chunk.map(t => t.netId));
      tracks = (r && r.ok && Array.isArray(r.tracks)) ? r.tracks : null;
    } catch { tracks = null; }
    if (!tracks) continue;
    const byId = new Map(tracks.map(x => [x.netId, x]));
    for (const t of chunk) {
      const hit = byId.get(t.netId);
      if (!hit || !hit.coverUrl) continue;
      t.coverUrl = hit.coverUrl;
      if (!t.album && hit.album) t.album = hit.album;
      if (!t.albumId && hit.albumId) t.albumId = hit.albumId;
      changed++;
    }
  }
  if (!changed) return 0;
  persistLibrary();
  if (S.srcMode !== 'net') renderLibrary();
  // 正在放的这首刚好就是补到的：把封面和主色一起补上
  const k = curTrack();
  if (k && isNet(k) && k.coverUrl && !getCover(k.path)) {
    const art = await loadArt(k);
    if (art) {
      const c = await accentFrom(art);
      if (c) setAccent(c);
      paintMeta();
    }
  }
  return changed;
}

/* ------------------------------------------------------------------ LRC */

/* 增强型 LRC 的行内逐字标签：<mm:ss.xx>字。QQ / 酷狗 与部分本地 LRC 会带。
 * 返回 [{ t, text }]；没有标签返回 null，交给「按字摊开」的兜底。 */
function parseWordTags(raw) {
  const marks = [...raw.matchAll(/<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g)];
  if (!marks.length) return null;
  const words = [];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const from = m.index + m[0].length;
    const to = i + 1 < marks.length ? marks[i + 1].index : raw.length;
    const seg = raw.slice(from, to).replace(/<[^>]*>/g, '');
    const ss = parseFloat(String(m[2]).replace(':', '.'));
    const t = parseInt(m[1], 10) * 60 + ss;
    if (!Number.isNaN(t) && seg) words.push({ t, text: seg });
  }
  return words.length ? words : null;
}

function parseLRC(src) {
  if (!src) return [];
  const lines = src.split(/\r?\n/);
  let offset = 0;
  const tag = /^\[(ti|ar|al|by|offset):(.*)\]$/i;
  for (const l of lines) {
    const m = tag.exec(l.trim());
    if (m && m[1].toLowerCase() === 'offset') offset = (parseInt(m[2], 10) || 0) / 1000;
  }
  const out = [];
  for (const raw of lines) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const words = parseWordTags(raw);
    // 行内 <...> 是时间标签，不能留在正文里（老代码只剥了 [...]，带逐字标签的
    // LRC 会把尖括号原样画出来）
    const text = raw.replace(/\[[^\]]*\]/g, '').replace(/<[^>]*>/g, '').trim();
    if (!text) continue;
    for (const s of stamps) {
      const mm = parseInt(s[1], 10);
      const ss = parseFloat(String(s[2]).replace(':', '.'));
      if (Number.isNaN(ss)) continue;
      out.push({ t: mm * 60 + ss - offset, text, words });
    }
  }
  out.sort((a, b) => a.t - b.t);
  /* 双语 LRC 的常见写法：同一个时间戳连着两行，第二行是译文。
   * 早先这里直接按时间戳去重，第二行会被整行丢掉；现在挂到前一行上当译文。 */
  const merged = [];
  for (const l of out) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(l.t - prev.t) < 0.001) {
      if (!prev.tr && l.text !== prev.text) prev.tr = l.text;
      continue;
    }
    merged.push(l);
  }
  return merged;
}

/* ------------------------------------------------------------ 逐字时间轴
 * 填充的粒度是「一个字」，所以每行先摊出一串 { c, t0, t1 }。
 * 时间来源三级，越靠前越准：
 *   1. 网易云 yrc：每个字都有真实起止（parseYRC）；
 *   2. 增强型 LRC 的行内 <mm:ss.xx>：每段真实起点，段内再按字宽分；
 *   3. 只有行时间戳：把 [本行, 下一行) 按字宽摊开。这条是估计，但单位仍是
 *      「字」——每个字有自己的起止，不会出现整行一口气扫过去的忽快忽慢。
 * 摊开时给每个字压上限（MAX_CH）：长间奏就提前唱完，剩下交给「…」占位，
 * 而不是让最后一个字拖十几秒才填满。
 */
const MAX_CH = 1.4;        // 单字填充时长上限（秒）
/* 空档的判定与节奏：
 * 两句之间真的空出 GAP_MIN 秒以上，才把「…」当成一句来唱 —— 句间正常换气
 * （0.5–2 秒）不该闪一下「…」。填满的时机与渐隐都相对下一句的起点算，
 * 而不是相对上一句的结尾，这样不管间奏多长，收尾都落在同一个位置。 */
const GAP_MIN = 3;         // 空档超过 3 秒才启用「…」
const GAP_LEAD = 0.5;      // 下一句开口前 0.5 秒正好填满
const GAP_FADE = 0.5;      // 填满后的渐隐时长（收在下一句起点上）
const GAP_IN = 0.25;       // 「…」出现时的淡入

function charWeight(c) {
  if (!c || /\s/.test(c)) return 0.34;                                 // 空格几乎没有字宽
  if (/[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(c)) return 1;   // 汉字 / 假名 / 谚文 / 全角
  if (/[，。！？、；：,.!?;:'"（）()]/.test(c)) return 0.85;             // 标点：有字宽但短
  return 0.55;                                                        // 拉丁字母 / 数字
}

/* 把一段文字按字宽摊到 [t0, t0 + span) 上 */
function spreadChars(out, text, t0, span) {
  const list = [...String(text)];
  if (!list.length || !(span > 0)) return;
  const wsum = list.reduce((s, c) => s + charWeight(c), 0) || 1;
  const per = Math.min(span / wsum, MAX_CH);
  let t = t0;
  for (const c of list) {
    const d = per * charWeight(c);
    out.push({ c, t0: t, t1: t + d });
    t += d;
  }
}

function assignChars(lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.chars && l.chars.length) continue;
    const next = lines[i + 1];
    const chars = [];
    if (l.words && l.words.length) {
      for (let w = 0; w < l.words.length; w++) {
        const seg = l.words[w];
        const end = w + 1 < l.words.length
          ? l.words[w + 1].t
          : Math.min(seg.t + 2.4, next ? next.t : seg.t + 2.4);
        spreadChars(chars, seg.text, seg.t, Math.max(0.12, end - seg.t));
      }
    } else {
      spreadChars(chars, l.text, l.t, next ? Math.max(0.3, next.t - l.t) : 4);
    }
    l.chars = chars;
  }
  return lines;
}

/* 网易云 yrc（逐字歌词）：一行形如
 *   [1000,2000](1000,300,0)你(1300,250,0)好
 * 时间单位是毫秒：行首 [起点, 行时长]，每个 (字起点, 字时长, 0) 后面跟这个字。
 * 有它就能真正按字对齐，不需要任何估计。 */
function parseYRC(src) {
  if (!src) return [];
  const out = [];
  for (const raw of String(src).split(/\r?\n/)) {
    const head = /^\[(\d+),(\d+)\](.*)$/.exec(raw.trim());
    if (!head) continue;
    const chars = [];
    const re = /\((\d+),(\d+),-?\d+\)([^()]*)/g;
    let m;
    while ((m = re.exec(head[3]))) {
      const st = Number(m[1]) / 1000;
      const du = Number(m[2]) / 1000;
      const txt = m[3];
      if (!txt) continue;
      // 一个时间戳可能带多个字（含空格），按字宽均分这一小段
      const list = [...txt];
      const wsum = list.reduce((s, c) => s + charWeight(c), 0) || 1;
      let t = st;
      for (const c of list) {
        const d = du > 0 ? (du / wsum) * charWeight(c) : 0;
        chars.push({ c, t0: t, t1: t + d });
        t += d;
      }
    }
    /* yrc 的正文带前导空格（「 作词 : 法老」这种元信息行），
     * 而行文本要 trim，否则「字数 = 节点数」对不上、行首还会多一个空 span。
     * 两边一起去掉首尾空白字，保持一致。 */
    while (chars.length && !chars[0].c.trim()) chars.shift();
    while (chars.length && !chars[chars.length - 1].c.trim()) chars.pop();
    const text = chars.map(c => c.c).join('').trim();
    if (!text) continue;
    out.push({ t: Number(head[1]) / 1000, text, chars });
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((l, i) => i === 0 || l.t !== out[i - 1].t);
}

/* 给每行记下「下一句开口的时刻」和「最近一句有字的行」，都跳过空行。
 * 空档判定因此是一次减法，不用每帧往后扫歌词；空行（有 [mm:ss] 但没文字）
 * 不会被当成一个空档的边界，而是直接跨过去。 */
function linkLines(lines) {
  let next = Infinity;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    l.nextT = next;
    if (l.chars && l.chars.length) next = l.chars[0].t0;
  }
  let prev = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].chars && lines[i].chars.length) prev = i;
    lines[i].prevTimed = prev;
  }
  return lines;
}

/* 歌词入口：有逐字数据就用逐字，否则按行时间摊到字。
 * 译文只是「挂在行上的一个字符串」，合并完原词的时间轴与字数完全不变 ——
 * 逐字填充、空档「…」都只认 chars / nextT / prevTimed，看不到 tr。 */
function buildLyrics(ly) {
  if (!ly) return [];
  const lrc = parseLRC(ly.text);
  const trs = ly.tr ? parseLRC(ly.tr) : [];
  /* 译文先挂到 lrc 行上：tlyric 与 lrc 是同一次接口返回的，行首时间戳一一对应，
   * 这一层几乎不会错。注意不能直接拿 yrc 的行首去对译文 —— 见下面的注释。 */
  if (trs.length) mergeTranslation(lrc, trs);
  const y = parseYRC(ly.yrc);
  if (!y.length) return linkLines(assignChars(lrc));
  /* 有逐字数据时，行序与 lrc 是同一份（同一首歌、同一段歌词），
   * 但 yrc 的行首是「真正开口的时刻」，比 lrc 的行首晚，实测能差 0.7s 以上
   * （lrc 5.45 / yrc 5.46、lrc 8.12 / yrc 8.73……）。若按时间戳去配译文，
   * 一大半会超出容差被丢掉 —— 这正是「有译文的句子空白」的根因。
   * 所以先按行序把译文搬过来，再对剩下没搬到的行用时间戳兜底。 */
  transferTranslation(y, lrc);
  if (trs.length) mergeTranslation(y, trs);
  return linkLines(y);
}

/* ------------------------------------------------------------ 歌词翻译
 * 数据来源三级，越靠前越可信：
 *   1. 行内译文：同一个时间戳连着两行（双语 LRC），parseLRC 已挂到 l.tr；
 *   2. 独立翻译时间轴：网易云 tlyric / 本地 `同名.zh.lrc` / 内嵌第二条，
 *      先对齐到 lrc 行（时间戳一一对应），再按行序搬到逐字行上；
 *   3. 没有译文：l.tr 为空，渲染层不生成节点，布局与改动前完全一致。
 * 任何不确定的情况都选择「不显示」，而不是把上一句的译文错位贴到这一句。
 */
const TR_TOL = 0.4;                                   // 译文与原文的行首允许偏差（秒）

const normText = s => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');
const hasLetter = s => /[0-9A-Za-z\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(String(s || ''));

function mergeTranslation(lines, trs) {
  if (!lines.length || !trs || !trs.length) return lines;
  let j = 0;
  for (const l of lines) {
    // 两个时间轴都单调，指针只往前走
    while (j + 1 < trs.length && Math.abs(trs[j + 1].t - l.t) <= Math.abs(trs[j].t - l.t)) j++;
    const c = trs[j];
    if (!c) break;
    if (l.tr) continue;                               // 行内译文优先
    if (Math.abs(c.t - l.t) > TR_TOL) continue;        // 对不上就不挂
    if (!hasLetter(c.text)) continue;                 // 「//」之类的占位
    if (normText(c.text) === normText(l.text)) continue;  // 中文歌的「译文」与原文相同
    l.tr = c.text;
  }
  return lines;
}

/* 把 lrc 行上已挂好的译文，按「同样的行序 + 同样的正文」搬到逐字行上。
 * 只认归一化后正文完全相同的行，且在 6 行窗口内找 —— 对不上就不搬，
 * 后面还有时间戳兜底，宁可不显示也不贴错。 */
function transferTranslation(lines, lrc) {
  if (!lines.length || !lrc.length) return lines;
  let j = 0;
  for (const l of lines) {
    const key = normText(l.text);
    let hit = -1;
    for (let w = 0; w < 6 && j + w < lrc.length; w++) {
      if (normText(lrc[j + w].text) === key) { hit = j + w; break; }
    }
    if (hit < 0) continue;
    if (!l.tr && lrc[hit].tr) l.tr = lrc[hit].tr;
    j = hit + 1;
  }
  return lines;
}

function renderLyrics() {
  const box = $('#lnInner');
  box.innerHTML = '';
  S.lnNodes = [];
  S.lnChars = [];
  S.curCh = -2;
  S.curFrac = -1;
  S.gapNode = null;
  S.gapP = -1;
  S.gapOp = -1;
  S.lastLy = -1;
  $('#lyrEmpty').classList.toggle('show', S.lyrics.length === 0);
  if (!S.lyrics.length) {
    box.style.transform = 'translateY(0)';
    box.style.paddingTop = '0px';       // 不清掉会残留上一首的居中补白
    box.style.paddingBottom = '0px';
    delete box.dataset.pad;
    return;
  }
  const frag = document.createDocumentFragment();
  S.lyrics.forEach((l, i) => {
    const d = document.createElement('div');
    d.className = 'ln';
    d.dataset.i = i;
    /* 原文与「…」都放进 .ln-tx：它是 inline-block，宽度贴合文字本身，
     * 「…」才能靠 left:100% 挂在句子末尾。译文 .tr 是它的兄弟块 ——
     * 长译文只会自己换行，不会把行宽撑宽、把「…」推到右边去。 */
    const tx = document.createElement('span');
    tx.className = 'ln-tx';
    /* 每个字一个 span：填充按字推进（--p 逐字写），不是整行扫一条渐变。
     * 单个 span 仍然只栅格化一层渐变裁进字形，不会出现两层文字的白边。 */
    const chars = l.chars && l.chars.length ? l.chars : null;
    if (chars) {
      const spans = [];
      const cf = document.createDocumentFragment();
      for (const ch of chars) {
        const s = document.createElement('span');
        s.className = 'ch';
        s.textContent = ch.c;
        cf.appendChild(s);
        spans.push(s);
      }
      tx.appendChild(cf);
      S.lnChars.push(spans);
    } else {
      tx.textContent = l.text;         // 兜底：没有任何字级数据时按整行
      S.lnChars.push(null);
    }
    /* 空档里的「…」：它不是装饰，而是「这一句还没唱完」的延续 ——
     * 挂在本句末尾，跟着时间轴匀速填满、再渐隐，细节见 paintGap()。
     * 分两层：外层 .gap 由 JS 按时间轴写出入场 / 渐隐（--p 也写在它上面），
     * 内层 .gap-t 只用 CSS 关键帧做呼吸 —— 两者相乘，互不干扰。 */
    const gap = document.createElement('span');
    gap.className = 'gap';
    const gapText = document.createElement('span');
    gapText.className = 'gap-t';
    gapText.textContent = '…';
    gap.appendChild(gapText);
    tx.appendChild(gap);
    d.appendChild(tx);
    /* 译文：只有真的对齐上了、且不是空白才建节点。它是纯静态文本，不参与 --p、
     * 不参与空档判定 —— 逐字填充与「…」永远只作用在原文那一层。
     * 匹配不到时干脆不建节点（降级为不显示），而不是留一个空块把行撑高。 */
    const trText = l.tr ? String(l.tr).trim() : '';
    if (trText) {
      const tr = document.createElement('div');
      tr.className = 'tr';
      tr.textContent = trText;
      d.appendChild(tr);
    }
    d.addEventListener('click', () => { audio.currentTime = l.t; });
    frag.appendChild(d);
    S.lnNodes.push(d);
  });
  box.appendChild(frag);
}

function currentLineIndex(t = audio.currentTime) {
  const arr = S.lyrics;
  let lo = 0, hi = arr.length - 1, idx = -1;
  while (lo <= hi) {                 // 二分，长歌词也不至于每帧线性扫
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= t + 0.04) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx;
}

function centerLine(i) {
  const box = $('#lnInner');
  const col = box.parentElement;
  const el = box.children[i];
  if (!el) return;
  // 上下各补「容器的一半」：首句与尾句也能滚到中轴，而不是被顶在边上。
  // 补白只跟容器高度有关，不跟某一行的行高有关 —— 早先按
  // (容器高 − 本行高)/2 算，长句折行时 padding 会突变，而 padding 不受
  // transition 管、transform 有 0.55s 过渡，两者叠在一起，切行时能看见
  // 歌词「先跳一下再滑过去」。固定半高后只有 transform 在动。
  const pad = Math.max(0, Math.round(col.clientHeight / 2));
  if (box.dataset.pad !== String(pad)) {
    box.style.paddingTop = pad + 'px';
    box.style.paddingBottom = pad + 'px';
    box.dataset.pad = String(pad);
  }
  // offsetTop 从列的 padding 盒算起，而中轴要的是整列（含 padding）的中线，
  // 少补这一项，窗口模式下每一句都会整体偏低 8px（列有 padding-top: 8px）
  const padTop = parseFloat(getComputedStyle(col).paddingTop) || 0;
  const y = el.offsetTop + el.offsetHeight / 2 + padTop - col.clientHeight / 2;
  box.style.transform = 'translateY(' + (-y) + 'px)';
}

let centerTimer = 0;
/**
 * 当前句字号是 0.4s 过渡过去的，过渡期间读到的 offsetHeight 还是中间值，
 * 位移就会算偏（实测首句偏 18px）。所以切行后先按当时的值走，
 * 等字号过渡结束再按最终行高校正一次 —— transform 自己也有过渡，
 * 这次校正是在滑动途中改目标，看起来是平滑收尾，不会跳。
 */
function centerAfterGrow(i) {
  clearTimeout(centerTimer);
  centerTimer = setTimeout(() => {
    if (S.lastLy === i) centerLine(i);
  }, 430);
}

/* 窗口尺寸变化（含进/出全屏）期间的歌词稳定器
 * ---------------------------------------------------------------------------
 * 让歌词「抽搐」的是两组过渡撞在一起：`.ln` 的字号有 0.4s 过渡，行高在过渡
 * 期间一直在变；`.ln-inner` 的位移又有 0.55s 过渡。改一次尺寸，我们按当时的
 * 中间值算好位移并起一段过渡，字号却还在长，等 480ms 后再校正第二遍 ——
 * 眼睛里就是先抖一下、再滑一段。全屏来回切时尺寸连变好几次，抖动被叠加得更明显。
 *
 * 做法：尺寸变化期间给 body 挂 `lyr-resize`（CSS 里把这两条过渡都关掉），
 * 并逐帧把当前句钉在中轴上；最后一帧尺寸稳定后再等 hold 毫秒，摘掉类、
 * 把过渡交还给正常切行。因为解锁时布局已经不动了，那一次 centerLine 的目标
 * 与当前值相同，不会再产生可见位移。
 */
let lyrLockTimer = 0, lyrLockRAF = 0;

function centerFrame() {
  if (S.lastLy >= 0) centerLine(S.lastLy);
}

function lockLyricMotion(hold = 220, morph = false) {
  clearTimeout(centerTimer);          // 别让字号过渡的旧校正插入这一次
  document.body.classList.add('lyr-resize');
  /* morph：进/出全屏时顺带把「换版」软化成一次 240ms 的推近 + 淡入
   * （样式在 app.css 的 fsSettle）。正在拖窗口边时不加，拖动要跟手。 */
  if (morph) document.body.classList.add('fs-swap');
  centerFrame();
  if (!lyrLockRAF) {
    const step = () => {
      lyrLockRAF = 0;
      if (!document.body.classList.contains('lyr-resize')) return;
      centerFrame();
      lyrLockRAF = requestAnimationFrame(step);
    };
    lyrLockRAF = requestAnimationFrame(step);
  }
  clearTimeout(lyrLockTimer);
  lyrLockTimer = setTimeout(unlockLyricMotion, hold);
}

function unlockLyricMotion() {
  document.body.classList.remove('lyr-resize');
  document.body.classList.remove('fs-swap');
  clearTimeout(lyrLockTimer);
  if (lyrLockRAF) { cancelAnimationFrame(lyrLockRAF); lyrLockRAF = 0; }
  centerFrame();
}

/* 逐字填充：算出「该填到第几个字、这个字填了几成」，只写变化的那几个 span。
 * 已完成 / 还没轮到的字只在字下标变化时批量刷一次，不每帧写几十个样式。 */
function paintChars(i, chIdx, frac) {
  const spans = S.lnChars[i];
  const chars = S.lyrics[i] && S.lyrics[i].chars;
  if (!spans || !chars || !chars.length) return;
  if (chIdx !== S.curCh) {
    for (let j = 0; j < spans.length; j++) {
      spans[j].style.setProperty('--p', (j < chIdx ? 100 : 0) + '%');
    }
    S.curCh = chIdx;
    S.curFrac = -1;
  }
  if (chIdx >= 0 && chIdx < spans.length) {
    const p = Math.round(frac * 1000) / 10;      // 0.1% 精度够用，省掉无谓重绘
    if (p !== S.curFrac) {
      S.curFrac = p;
      spans[chIdx].style.setProperty('--p', p + '%');
    }
  }
}

/* 空档期的「…」：把它当成一句来唱。
 * 从上一句最后一个字唱完起匀速填，到下一句开口前 GAP_LEAD 秒正好填满，
 * 再用 GAP_FADE 秒平滑收没 —— 不做放大缩小的脉冲，节奏完全由时间轴决定。
 * 透明度逐帧写、不交给 CSS transition：seek 之后要立刻对上，不能被过渡拖住。 */
function paintGap(at, t, from, to) {
  const node = S.lnNodes[at];
  const gap = node && node.querySelector('.gap');
  if (!gap) return;
  if (gap !== S.gapNode) {
    hideGap();                            // 换了一句：先把上一行的收掉
    S.gapNode = gap;
    gap.classList.add('ongap');           // 呼吸动画随空档开场，天然从最暗的相位起
  }
  const fillEnd = to - GAP_LEAD;
  const p = clamp((t - from) / Math.max(0.2, fillEnd - from), 0, 1);
  let op = clamp((t - from) / GAP_IN, 0, 1);          // 出现时淡入，别硬闪
  if (t > fillEnd) {
    const k = clamp((t - fillEnd) / GAP_FADE, 0, 1);
    op *= 1 - k * k * (3 - 2 * k);                    // smoothstep：收尾不硬切
  }
  const pp = Math.round(p * 1000) / 10;
  if (pp !== S.gapP) { S.gapP = pp; gap.style.setProperty('--p', pp + '%'); }
  const oo = Math.round(op * 100) / 100;
  if (oo !== S.gapOp) { S.gapOp = oo; gap.style.opacity = String(oo); }
}

function hideGap() {
  if (!S.gapNode) return;
  S.gapNode.classList.remove('ongap');   // 摘掉呼吸：隐藏的歌词不该继续跑动画
  S.gapNode.style.opacity = '0';
  S.gapNode.style.setProperty('--p', '0%');
  S.gapNode = null;
  S.gapP = -1;
  S.gapOp = -1;
}

/* t 由播放时钟传入，不再取 audio.currentTime —— 后者只有 ~4Hz，逐帧插值才顺滑 */
function updateLyric(t) {
  if (t == null) t = audio.currentTime;
  if (!S.lyrics.length || !S.lnNodes.length) return;
  const i = currentLineIndex(t);
  if (i !== S.lastLy) {
    const nodes = S.lnNodes;
    if (S.lastLy >= 0 && nodes[S.lastLy]) paintChars(S.lastLy, -2, 0);   // 上一句清空，回跳时重新填
    for (let k = 0; k < nodes.length; k++) nodes[k].classList.toggle('on', k === i);
    if (i >= 0) centerLine(i);
    S.lastLy = i;
    S.curCh = -2;
    S.curFrac = -1;
    if (i >= 0) centerAfterGrow(i);
    else clearTimeout(centerTimer);      // 间奏 / 开头没有当前句，别留一个迟到的校正
  }

  /* 先看是不是落在两句之间的大空档里：整段交给「…」，正文不再动 */
  const host = i >= 0 ? (S.lyrics[i].prevTimed ?? -1) : -1;
  if (host >= 0) {
    const line = S.lyrics[host];
    const chars = line.chars;
    const from = chars[chars.length - 1].t1;         // 上一句最后一个字唱完的时刻
    const to = line.nextT;                            // 下一句开口的时刻
    // 最后一句后面没有下一句了（nextT 是 Infinity），填满就停，不要挂「…」
    if (Number.isFinite(to) && to - from > GAP_MIN && t >= from && t < to) {
      paintChars(host, chars.length, 0);              // 这句先填满，别停在半个字上
      paintGap(host, t, from, to);
      return;
    }
  }
  hideGap();

  const at = i >= 0 ? i : 0;
  const line = S.lyrics[at];
  if (!line) return;
  const chars = line.chars;
  // 空行（只有 [mm:ss] 没有字）不参与填充：「…」只服务真正的空档
  if (!chars || !chars.length) return;

  let chIdx = -2;                        // -2 一个字还没唱；n 表示已唱完 n 个字
  let frac = 0;
  if (t >= chars[0].t0) {
    let k = 0;
    for (let j = 0; j < chars.length; j++) {            // 字是顺序的，扫一遍就够（一句最多几十字）
      if (t >= chars[j].t0) k = j; else break;
    }
    const span = chars[k].t1 - chars[k].t0;
    frac = span > 0 ? clamp((t - chars[k].t0) / span, 0, 1) : 1;
    chIdx = frac >= 1 ? k + 1 : k;
    if (chIdx >= chars.length) chIdx = chars.length;    // 整句唱完，保持填满
  }
  paintChars(at, chIdx, frac);
}

/* ------------------------------------------------------------------ 渲染 */
function setCoverEmpty(main, sub) {
  const t = $('#ceT'), d = $('#ceD');
  if (t) t.textContent = main;
  if (d) d.textContent = sub;
}

function durationText(t) {
  return t && t.duration ? fmt(t.duration) : '—';
}

function paintMeta() {
  const k = curTrack();
  const cover = $('#cover'), img = $('#coverImg');
  if (!k) {
    $('#npT').textContent = '未载入';
    $('#npA').textContent = '支持 MP3 / FLAC / WAV / M4A / OGG';
    $('#npF').textContent = '把文件拖进窗口，或按 Ctrl+O 导入';
    $('#btnPl').title = '播放列表';
    cover.classList.add('empty', 'onboard');
    cover.classList.remove('has-art');
    img.removeAttribute('src');
    setCoverEmpty('还没有音乐', '拖入文件，或点击导入');
    return;
  }
  cover.classList.remove('onboard');
  $('#npT').textContent = k.title || '未知曲目';
  $('#npA').textContent = [k.artist, k.album].filter(Boolean).join(' · ') || '未知艺人';

  if (isNet(k)) {
    const bits = [];
    if (k.codec) bits.push(k.codec);
    if (k.bitrate) bits.push(`${Math.round(k.bitrate / 1000)}kbps`);
    if (k.lossless) bits.push('无损');
    bits.push(k.duration ? fmt(k.duration) : '时长未知');
    $('#npF').textContent = (k.unavailable ? k.unavailable + ' · ' : '') + bits.join(' · ');
  } else if (k.error) {
    $('#npF').textContent = '元数据读取失败 · 可能仍可播放';
  } else {
    const bits = [];
    if (k.codec) bits.push(k.codec);
    if (k.sampleRate) bits.push(`${(k.sampleRate / 1000).toFixed(1).replace('.0', '')}kHz`);
    if (k.bitDepth) bits.push(`${k.bitDepth}bit`);
    bits.push(fmt(k.duration));
    $('#npF').textContent = bits.join(' · ');
  }

  // 左下角现在是播放列表入口：把原来那行「WAV 无损」的信息挪进按钮的 tooltip，
  // 音质实测仍可看右下角波形按钮里的面板
  $('#btnPl').title = '播放列表 · 当前 ' + (k.error
    ? '解析失败'
    : k.unavailable
      ? '不可播放'
      : k.lossless ? `${k.codec} 无损` : k.codec || (isNet(k) ? '网易云' : '音频'));

  const cov = getCover(k.path);
  if (cov) {
    if (img.getAttribute('src') !== cov) img.src = cov;
    cover.classList.add('has-art');
    cover.classList.remove('empty');
  } else {
    img.removeAttribute('src');
    cover.classList.remove('has-art');
    cover.classList.add('empty');
    if (isNet(k)) {
      // 四种情况给四种说法：库里没地址 / 已补到地址正在取 / 取失败 / 真没有
      const sub = !k.coverUrl
        ? (k.netId ? '封面地址缺失 · 联网后会自动补' : '网易云没有为该曲目提供封面')
        : k.coverError
          ? '封面加载失败 · 已用中性底色'
          : '正在加载封面…';
      setCoverEmpty('暂无封面', sub);
    } else {
      setCoverEmpty('暂无封面', k.error ? '元数据读取失败，封面未知' : '该文件没有内嵌封面，也没有同名图片');
    }
  }
  renderFmtPopover();
  renderMediaSession();
}

/* ---------------- 音质档位 ----------------
 * 与主进程 netease.js 的 QUALITY 一一对应；这里只是显示用的文案。
 * 「无损」在没有会员权限的账号上会被接口静默降级成 320k，所以档位只是「请求」，
 * 界面必须同时显示实际拿到的码率，否则用户会以为切成功了。 */
const QUALITY_LIST = [
  { k: 'standard', name: '标准', hint: '128 kbps · MP3' },
  { k: 'higher', name: '较高', hint: '192 kbps · MP3' },
  { k: 'exhigh', name: '极高', hint: '320 kbps · MP3' },
  { k: 'lossless', name: '无损', hint: 'FLAC · 需账号有权限' }
];
const QUALITY_NAME = QUALITY_LIST.reduce((m, q) => (m[q.k] = q.name, m), {});
const curQuality = () => (QUALITY_NAME[S.settings && S.settings.quality] ? S.settings.quality : 'exhigh');

function renderFmtPopover() {
  renderQualityList();
  const k = curTrack();
  const note = $('#fmtNote');
  if (!k) {
    $('#fmtList').innerHTML = '';
    if (note) note.textContent = '选一个档位，之后播放的网易云曲目按它解析；本地文件不受影响。';
    return;
  }

  const rows = [['来源', isNet(k) ? '网易云' : '本地文件']];
  if (isNet(k)) {
    rows.push(['请求音质', QUALITY_NAME[curQuality()]]);
    rows.push(['实际码率', k.bitrate ? `${Math.round(k.bitrate / 1000)} kbps` : '—']);
    rows.push(['编码', k.codec || '—']);
    rows.push(['是否无损', k.lossless ? '是' : '否']);
  } else {
    // 网易云接口不回采样率/位深，与其显示两行「—」，不如本地文件才列这两项
    rows.push(['编码', k.codec || '—']);
    rows.push(['采样率', k.sampleRate ? `${k.sampleRate} Hz` : '—']);
    rows.push(['位深', k.bitDepth ? `${k.bitDepth} bit` : '—']);
    rows.push(['码率', k.bitrate ? `${Math.round(k.bitrate / 1000)} kbps` : '—']);
    rows.push(['是否无损', k.lossless ? '是' : '否']);
  }
  rows.push(['时长', k.duration ? fmt(k.duration) : '未知']);
  rows.push(['歌词', S.lyricSrc || '无']);
  if (k.error) rows.push(['元数据', '解析失败']);
  if (k.unavailable) rows.push(['状态', k.unavailable]);

  $('#fmtList').innerHTML = rows
    .map(([a, b]) => `<div class="pop-row"><span>${esc(a)}</span><span>${esc(b)}</span></div>`)
    .join('');

  if (note) {
    note.textContent = !isNet(k)
      ? '本地文件按文件本身播放，音质档位只作用于网易云曲目。'
      : k.downgraded
        ? `账号没有「${QUALITY_NAME[curQuality()]}」权限，已按实际可用的 ${Math.round((k.bitrate || 0) / 1000)} kbps 播放。`
        : '显示的是接口实际返回的码率与格式，不是宣传参数。';
  }
}

function renderQualityList() {
  const on = curQuality();
  const box = $('#qualList');
  if (!box) return;
  box.innerHTML = QUALITY_LIST.map(q => `<button class="qopt${q.k === on ? ' on' : ''}" data-q="${q.k}">`
    + `<span class="qn">${q.name}</span><span class="qs">${q.hint}</span><span class="qk">✓</span></button>`).join('');
}

/**
 * 换档 = 换流：重新解析地址（主进程按新档位取）→ 重设 audio.src → 回到原进度。
 * 不重走 playIndex：那会把封面、歌词、主色全部重来一遍，界面闪一下，
 * 而且「暂停中换档」会被强行变成播放。
 */
let qualSeq = 0;
async function setQuality(q) {
  const next = QUALITY_NAME[q] ? q : 'exhigh';
  if (next === curQuality()) return;
  S.settings.quality = next;
  saveSettings();
  renderFmtPopover();

  const k = curTrack();
  if (!k || !isNet(k)) {
    toast(`音质：${QUALITY_NAME[next]}` + (k ? ' · 本地文件按原文件播放' : ''));
    return;
  }
  await applyQuality(k);
}

async function applyQuality(k) {
  const seq = ++qualSeq;                 // 连点两档时只认最后一次
  const stillCurrent = () => seq === qualSeq && curTrack() === k;
  const at = audio.currentTime || 0;
  const wasPlaying = !audio.paused && !audio.ended;
  const target = curQuality();

  let info;
  try { info = await window.api.neUrl(netIdOf(k), target); }
  catch (e) { info = { ok: false, error: { message: String((e && e.message) || e) } }; }
  if (!stillCurrent()) return;           // 期间切了歌/又换了档，这次结果作废

  if (!info || !info.ok) {
    // 解析失败就保持原流继续放，不写 audio.src，正在放的歌不中断
    toast('切换音质失败：' + ((info && info.error && info.error.message) || '未知原因'));
    return;
  }

  k.codec = info.codec || k.codec;
  k.bitrate = info.bitrate || k.bitrate;
  k.lossless = !!info.lossless;
  k.level = info.level;
  k.downgraded = !!info.downgraded;
  S.libDirty = true;
  paintMeta();
  renderFmtPopover();

  const url = await window.api.mediaUrl(k.path);
  if (!stillCurrent()) return;

  audio.pause();
  audio.src = url;
  audio.load();
  await new Promise(res => {
    const done = () => { audio.removeEventListener('loadedmetadata', done); res(); };
    audio.addEventListener('loadedmetadata', done);
    setTimeout(done, 2500);              // 元数据拿不到也不能把播放状态卡死
  });
  if (!stillCurrent()) return;

  if (at > 0) { try { audio.currentTime = Math.min(at, audio.duration || at); } catch {} }
  if (wasPlaying) { try { await audio.play(); } catch {} }
  paintMeta();

  toast(info.downgraded
    ? `已切到${QUALITY_NAME[target]} · 账号只能取到 ${Math.round((info.bitrate || 0) / 1000)} kbps`
    : `音质：${QUALITY_NAME[target]} · ${Math.round((info.bitrate || 0) / 1000)} kbps`);
}

const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const subOf = t => {
  const bits = [t.artist, t.album].filter(Boolean).join(' · ') || '未知艺人';
  return t.unavailable ? bits + ' · ' + t.unavailable : bits;
};

/* 本地 / 网易云 / 哔哩哔哩共用一套行模板：只差右上角的来源角标与封面来源 */
function itemHTML(t, i) {
  const tag = isNet(t)
    ? `<span class="tag">${t.vip ? 'VIP' : '云'}</span>`
    : isBil(t)
      /* 置顶 UP 的内容多一个 VV 标，看列表时能一眼认出是「优先展示」那一组 */
      ? `<span class="tag${t.pinned ? ' vv' : ''}">${t.pinned ? 'VV' : (t.vip ? 'UP' : 'B')}</span>`
      : '';
  const idx = i == null ? '' : ` data-i="${i}"`;
  /* 封面：本地走 trackCover（主进程读内嵌图/同目录图，缩到 96px 再回传），
   * 网易云走 neCover，哔哩哔哩走 bilCover（都按 URL 取小图）。没封面地址就不挂
   * data-art，直接留「首字磁贴」占位，不会去请求一个注定失败的地址。 */
  const art = isNet(t)
    ? (t.coverUrl ? ` data-art="ne" data-key="${esc(t.coverUrl)}"` : '')
    : isBil(t)
      ? (t.coverUrl ? ` data-art="bil" data-key="${esc(t.coverUrl)}"` : '')
      : (t.path ? ` data-art="file" data-key="${esc(t.path)}"` : '');
  const neKey = isNet(t) ? t.netId : '';
  const bilKey = isBil(t) ? bilBvidOf(t) : '';
  return `<div class="item"${idx} data-ne="${neKey}" data-bil="${esc(bilKey)}">
      <div class="th"${art}><span>${esc((t.title || '?').slice(0, 1))}</span></div>
      <div class="ii"><div class="n">${esc(t.title || '未知曲目')}${tag}</div>
      <div class="d">${esc(subOf(t))}</div></div>
      <div class="r"${i == null ? '' : ` data-dur="${i}"`}>${esc(durationText(t))}</div>
    </div>`;
}

const emptyRow = html => `<div class="empty-row">${html}</div>`;

/* ------------------------------------------------------------------ 列表缩略封面
 * 曲库可能上千首，不能在渲染时逐行发 IPC（那是上千次文件解析）。
 * 做法：先全部画成「首字磁贴」占位，再由 IntersectionObserver 只给进入视口
 * 的行取图，并发上限 4；结果按 key 缓存，滚动来回不重复请求。
 */
const thumbUrl = new Map();          // key -> data URL（只缓存成功的：失败不能写死）
const thumbMiss = new Map();         // key -> 失败时刻：只短暂记住失败，避免滚动时每帧重请求
const thumbRetry = new Set();        // 正在等自动重试的 key（每个 key 只挂一个定时器）
const THUMB_MISS_TTL = 5000;
const THUMB_RETRY_DELAY = 8000;      // 失败后自动补一次，用户不用手动刷新
const THUMB_CACHE_MAX = 320;
const thumbQ = [];
let thumbRun = 0;
let thumbIO = null;

function applyThumb(el, url) {
  if (!el.isConnected || !url) return;
  let img = el.querySelector('img');
  if (!img) {
    img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    el.appendChild(img);
  }
  img.onload = () => el.classList.add('art');
  img.src = url;
  if (img.complete) el.classList.add('art');     // 缓存命中的 data URL 不会触发 load
}

function thumbEnqueue(el) {
  const key = el.dataset.key;
  const kind = el.dataset.art;
  if (!key || !kind) return;
  const hit = thumbUrl.get(key);
  if (hit !== undefined) { applyThumb(el, hit); return; }
  // 刚刚失败过就先不重复打（失败原因通常是文件被占用 / 网络抖动，TTL 后自然重试）
  const miss = thumbMiss.get(key);
  if (miss && Date.now() - miss < THUMB_MISS_TTL) return;
  thumbQ.push([el, kind, key]);
}

async function fetchThumb(kind, key) {
  let r = null;
  try {
    r = kind === 'ne' ? await window.api.neCover(key, 96)
      : kind === 'bil' ? await window.api.bilCover(key, 160)
        : await window.api.trackCover(key);
  } catch { r = null; }
  const url = r && r.ok && r.dataUrl ? r.dataUrl : '';
  if (url) {
    thumbUrl.set(key, url);
    thumbMiss.delete(key);
  } else {
    thumbMiss.set(key, Date.now());     // 只记失败时间，不把「没封面」写死到会话结束
  }
  while (thumbUrl.size > THUMB_CACHE_MAX) thumbUrl.delete(thumbUrl.keys().next().value);
  return url;
}

function pumpThumbs() {
  while (thumbRun < 4 && thumbQ.length) {
    const [el, kind, key] = thumbQ.shift();
    if (!el.isConnected) continue;        // 行已经被重绘替换掉，不必请求
    thumbRun++;
    fetchThumb(kind, key)
      .then(url => {
        if (url) applyThumb(el, url);
        // 失败不留白也不摆烂：只要这行还在文档里，稍后自动补一次
        else if (el.isConnected && !thumbRetry.has(key)) {
          thumbRetry.add(key);
          setTimeout(() => {
            thumbRetry.delete(key);
            thumbMiss.delete(key);
            if (el.isConnected) { thumbQ.push([el, kind, key]); pumpThumbs(); }
          }, THUMB_RETRY_DELAY);
        }
      })
      .catch(() => {})
      .then(() => { thumbRun--; pumpThumbs(); });
  }
}

function fillThumbs(root) {
  if (thumbIO) thumbIO.disconnect();       // 上一批的行已经不在文档里了
  thumbMiss.clear();                       // 列表重画 = 用户想再看一次，之前失败的也重新试
  const rows = $$('.item .th[data-art]', root);
  if (!rows.length) return;
  thumbIO = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbIO.unobserve(e.target);
      thumbEnqueue(e.target);
    }
    pumpThumbs();
  }, { rootMargin: '160px 0px' });         // 提前一屏取，滚动时不会看到一片空磁贴
  for (const el of rows) thumbIO.observe(el);
}

/* 列表用事件委托 + 预计算下标：原来 items.map 里 indexOf 是 O(n²)，
 * 2000 首时单次渲染 120ms 以上，切歌/搜索都会卡一下。 */
/* QQ 音乐 / 酷狗 的曲库分段：两级视图（歌单 → 曲目），
 * 数据来自主进程 acc:playlists / acc:tracks（凭证在账号层，渲染层看不到 cookie）。 */
async function upEnsure(provider, force) {
  const st = S.up[provider] || (S.up[provider] = { status: 'idle', err: '', items: [], view: 'list', tracks: [], name: '', id: 0 });
  /* 卡在 loading 超过 20 秒就允许重来：上游偶尔会长时间不回应，
   * 不放行的话「选择歌单」会永远停在「正在读取…」。 */
  if (st.status === 'loading' && Date.now() - (st.at || 0) < 20000) return;
  if (!force && (st.status === 'ready' || st.status === 'error')) return;
  st.status = 'loading'; st.err = ''; st.at = Date.now();
  if (S.srcMode === provider) renderUp(provider);
  let r;
  try {
    /* 上游偶尔长时间不回应：给一次硬上限，宁可显示失败也别一直转圈。 */
    r = await Promise.race([
      window.api.accPlaylists(provider),
      new Promise(res => setTimeout(() => res({ ok: false, error: { message: '上游 30 秒没有回应，稍后重试' } }), 30000))
    ]);
  } catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }
  if (!r || !r.ok) {
    st.status = 'error';
    st.err = (r && r.error && r.error.message) || '歌单读取失败';
  } else {
    st.status = 'ready';
    st.items = r.items || [];
  }
  if (S.srcMode === provider) renderUp(provider);
  if (PL.view === 'pick') renderPl();
}

async function upOpen(provider, id, name) {
  const st = S.up[provider] || (S.up[provider] = {});
  st.view = 'tracks'; st.id = id; st.name = name || ''; st.tracks = []; st.trackErr = '';
  renderUp(provider);
  toast('正在读取「' + (name || '歌单') + '」…', 0);
  let r;
  try { r = await window.api.accTracks(provider, id); }
  catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }
  if (!r || !r.ok) {
    st.trackErr = (r && r.error && r.error.message) || '曲目读取失败';
    st.tracks = [];
  } else {
    /* 上游曲目只有裸 id（酷狗 hash / QQ songmid），列表里必须存成带前缀的 path，
     * 播放层才知道该走 kg: 还是 qq: —— 和「选择歌单」那条路保持一致。 */
    st.tracks = (r.items || []).map(t => ({
      ...t,
      path: provider === 'kugou' ? 'kg:' + t.id : (String(t.id).startsWith('qq:') ? t.id : 'qq:' + t.id)
    }));
  }
  if (S.srcMode === provider) renderUp(provider);
  if (r && r.ok) toast('「' + (name || '歌单') + '」共 ' + st.tracks.length + ' 首');
  else toast(st.trackErr || '曲目读取失败');
}

function upPlay(provider, idx) {
  const st = S.up[provider];
  if (!st || !st.tracks.length) return;
  const list = st.tracks.map(t => plToItem({ ...t, album: t.album || st.name }));
  S.settings.playlist = list;
  plSave();
  rebuildQueue('id');
  const want = st.tracks[idx] && st.tracks[idx].path;
  const qi = S.q.findIndex(x => x.id === want);
  playAt(qi >= 0 ? qi : 0);
  plSyncBadge();
}

function renderUp(provider) {
  const st = S.up[provider] || {};
  const list = $('#libList');
  const label = provider === 'kugou' ? '酷狗音乐' : 'QQ 音乐';
  if (st.status === 'loading') {
    list.innerHTML = emptyRow('正在读取' + label + '的歌单…（首次会慢几秒）');
    $('#libCount').textContent = '';
    list.onclick = null;
    /* 兜底：万一上一次请求既没成功也没报错，22 秒后自动重来一次 */
    setTimeout(() => {
      if (st.status === 'loading' && Date.now() - (st.at || 0) > 20000) upEnsure(provider, true);
    }, 22000);
    return;
  }
  if (st.status === 'error' || st.status === 'idle') {
    const msg = st.err || (label + '：还没有登录账号（设置 → 播放账号）');
    list.innerHTML = emptyRow(msg);
    $('#libCount').textContent = '';
    list.onclick = null;
    return;
  }
  if (st.view !== 'tracks') {
    const items = st.items || [];
    $('#libCount').textContent = items.length ? items.length + ' 个歌单' : '0 个歌单';
    list.innerHTML = items.length
      ? items.map(p => `<div class="item" data-pl="${esc(String(p.id))}" data-name="${esc(p.name || '')}">
          <div class="txt"><div class="ttl">${esc(p.name || '未命名歌单')}</div>
          <div class="sub">${esc((p.count || 0) + ' 首')}${p.cover ? '' : ''}</div></div>
          <div class="dur">›</div></div>`).join('')
      : emptyRow(label + '账号下还没有歌单');
    list.onclick = e => {
      const row = e.target.closest('[data-pl]');
      if (row) upOpen(provider, row.dataset.pl, row.dataset.name);
    };
    return;
  }
  const q = ($('#q').value || '').trim().toLowerCase();
  const rows = [];
  st.tracks.forEach((t, i) => {
    if (q) {
      const hay = [t.title, t.artist].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return;
    }
    rows.push(`<div class="item" data-up="${i}">
      <div class="num"><span class="idx">${i + 1}</span></div>
      <div class="txt"><div class="ttl">${esc(t.title || '')}</div>
      <div class="sub">${esc(t.artist || '')}</div></div>
      <div class="dur">${esc(fmt(Number(t.duration) || 0))}</div></div>`);
  });
  $('#libCount').textContent = st.trackErr ? st.trackErr : (rows.length ? rows.length + ' 首 · ' + (st.name || '') : '0 首');
  list.innerHTML = (st.trackErr ? emptyRow(st.trackErr) : (rows.join('') || emptyRow('这个歌单是空的')))
    + '<div class="item" data-upback="1"><div class="txt"><div class="ttl">← 返回歌单</div></div></div>';
  list.onclick = e => {
    if (e.target.closest('[data-upback]')) { st.view = 'list'; renderUp(provider); return; }
    const row = e.target.closest('[data-up]');
    if (row) upPlay(provider, Number(row.dataset.up));
  };
}

function renderLibrary() {
  if (S.srcMode === 'net') { renderNet(); return; }
  if (S.srcMode === 'bil') { renderBil(); return; }
  if (S.srcMode === 'qqapp' || S.srcMode === 'kugou') { renderUp(S.srcMode); return; }
  const q = ($('#q').value || '').trim().toLowerCase();
  const rows = [];
  for (let i = 0; i < S.tracks.length; i++) {
    const t = S.tracks[i];
    if (q) {
      const hay = [t.title, t.artist, t.album].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) continue;
    }
    rows.push(itemHTML(t, i));
  }
  const list = $('#libList');
  list.innerHTML = rows.length ? rows.join('') : emptyRow('曲库还是空的 · 拖入文件或点上方「导入」');
  fillThumbs(list);
  $('#libCount').textContent = q ? `${rows.length} / ${S.tracks.length} 首` : `${S.tracks.length} 首`;
  list.onclick = e => {
    const el = e.target.closest('.item');
    if (el) playIndex(Number(el.dataset.i));
  };
  markedEl = null;
  markCurrent();
}

let markedEl = null;
function markCurrent() {
  if (markedEl) markedEl.classList.remove('on');
  markedEl = null;
  const t = S.i >= 0 ? curTrack() : null;
  if (!t) { plSyncBadge(); return; }
  /* 曲库行按曲库下标定位（S.i 现在是队列下标，所以要先翻回曲库下标）；
   * 网易云的搜索/歌单列表没有下标，只能按曲目 id 找。 */
  const libIdx = S.tracks.indexOf(t);
  markedEl = (isNet(t) ? $(`#libList .item[data-ne="${t.netId}"]`) : null)
    || (isBil(t) ? $(`#libList .item[data-bil="${esc(bilBvidOf(t))}"]`) : null)
    || (libIdx >= 0 ? $(`#libList .item[data-i="${libIdx}"]`) : null);
  if (markedEl) markedEl.classList.add('on');
  if ($('#popPl').classList.contains('show') && PL.view === 'list') renderPlRows();
  plSyncBadge();
}
function updateRowDuration(t) {
  const i = S.tracks.indexOf(t);
  const el = $(`#libList .r[data-dur="${i}"]`);
  if (el) el.textContent = durationText(t);
}

/* ------------------------------------------------------------------ 播放列表
 * 结构：S.settings.playlist = [{ id, title, artist, duration }]
 *
 * id 复用全局唯一键（本地是绝对路径，网易云是 `ne:<id>`），和曲库去重、封面缓存
 * 用的是同一套键，所以同一首歌不会因为来源不同而出现两份。
 *
 * 列表只描述「播哪些、按什么顺序播」，不复制曲目对象：播放时按 id 回曲库定位下标；
 * 不在曲库里的网易云曲目按 id 重建一条，交给 playNet（它本来就会「加入曲库并播放」）。
 * 任何修改都立刻写回 settings.json，刷新后原样恢复。
 */
const PL_ROW_H = 46;      // 列表行固定高度，虚拟滚动按这个数算窗口
const PL_BUF = 6;         // 上下各多画几行，滚动时不至于出现白条

/* 面板自己的小状态：list 列表页 / pick 选歌单页 / add 挑歌页；
 * ask 是覆盖前的确认条（不弹 window.confirm，免得打断播放界面的手感）。 */
const PL = { view: 'list', ask: null, busy: false, sources: [], cands: [] };

const plItems = () => (Array.isArray(S.settings.playlist) ? S.settings.playlist : []);

function plToItem(t) {
  const it = {
    id: String((t && (t.path || t.id)) || ''),
    title: String((t && t.title) || '未知曲目').slice(0, 120),
    artist: String((t && t.artist) || '').slice(0, 80),
    duration: Number(t && t.duration) || 0
  };
  /* 上游曲目要带 albumMid：QQ 的封面地址是按「专辑 mid」拼的，丢了就只剩占位图 */
  if (t && t.albumMid) it.albumMid = String(t.albumMid);
  if (t && t.album) it.album = String(t.album).slice(0, 120);
  return it;
}

/* 手改过 settings.json 的人可以把这里写成任何东西：逐条校验、按 id 去重（不设上限） */
function plNormalize(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const id = String(x.id == null ? '' : x.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: String(x.title || '未知曲目').slice(0, 120),
      artist: String(x.artist || '').slice(0, 80),
      duration: Number(x.duration) || 0
    });
  }
  return out;
}

function plSave() {
  saveSettings();
  plSyncBadge();
}

/* 入口按钮上的角标 + 「当前曲目在列表里」的高亮 */
function plSyncBadge() {
  const n = plItems().length;
  const num = $('#plNum');
  if (num) num.textContent = n > 99 ? '99+' : String(n);
  const btn = $('#btnPl');
  if (btn) {
    const cur = curTrack();
    btn.classList.toggle('live', !!cur && plItems().some(x => x.id === cur.path));
  }
}

function renderPl() {
  plSyncBadge();
  const pop = $('#popPl');
  if (!pop.classList.contains('show')) return;

  const items = plItems();
  const cur = curTrack();
  const curId = cur ? cur.path : '';
  $('#plCount').textContent = items.length ? items.length + ' 首' : '空';
  $('#plClear').disabled = !items.length;

  const body = $('#plBody');
  /* 换视图前先把上一个视图留在 DOM 上的东西清掉，否则会串到新视图上：
   * - `onscroll` 只有列表视图用（它重画的是播放列表那套歌曲行）。留在选择/插入
   *   视图上，只要面板能滚动，滚一下就会把内容换回歌曲行——用户看到的就是
   *   「点了选择歌单、一滚又跳回播放列表，再点一下就开始放歌」。
   * - `#plAsk` 的确认条同理：从列表切到选择面板时不该还挂着上一步的确认。 */
  body.onscroll = null;
  if (PL.view === 'pick') { $('#plAsk').innerHTML = ''; return renderPlPick(body); }
  if (PL.view === 'add') { $('#plAsk').innerHTML = ''; return renderPlAdd(body); }

  $('#plAsk').innerHTML = PL.ask
    ? '<div class="pl-ask"><div>' + esc(PL.ask.text) + '</div><div class="row2">'
      + '<button class="ghost mini" data-pl="no">取消</button>'
      + '<button class="ghost mini" data-pl="yes">' + esc(PL.ask.ok) + '</button></div></div>'
    : '';

  if (!items.length) {
    body.innerHTML = '<div class="pl-empty">播放列表是空的'
      + '<small>「选择歌单」整单载入 · 「插入歌曲」逐首添加</small></div>';
  } else {
    renderPlRows();
    body.onscroll = renderPlRows;       // 只重画可视窗口，滚动本身不再产生 DOM
    scrollCurIntoView();
  }
  $('#plNote').textContent = '点条目播放 · ↑↓ 调顺序 · × 只从本列表移除，不改动源歌单';
}

/* 虚拟滚动：列表不设上限，几千上万首也只画可视窗口那几十行。
 * 行高固定 PL_ROW_H，上下用两个 spacer 撑出总高度，滚动条比例才正确。 */
function renderPlRows() {
  const body = $('#plBody');
  if (!body) return;
  const items = plItems();
  if (!items.length) return;
  const cur = curTrack();
  const curId = cur ? cur.path : '';
  const viewH = body.clientHeight || 300;
  const first = Math.max(0, Math.floor(body.scrollTop / PL_ROW_H) - PL_BUF);
  const last = Math.min(items.length, first + Math.ceil(viewH / PL_ROW_H) + PL_BUF * 2);

  const parts = ['<div class="pl-pad" style="height:' + (first * PL_ROW_H) + 'px"></div>'];
  for (let i = first; i < last; i++) {
    const x = items[i];
    const on = x.id === curId;
    parts.push('<div class="pl-row' + (on ? ' on' : '') + '" data-i="' + i + '" title="播放">'
      + '<div class="pl-main"><div class="pl-t">' + esc(x.title) + '</div>'
      + '<div class="pl-a">' + esc(x.artist || '未知艺人') + '</div></div>'
      + '<span class="pl-dur">' + (x.duration ? fmt(x.duration) : '—') + '</span>'
      + '<button class="pl-mv" data-mv="-1" title="上移">↑</button>'
      + '<button class="pl-mv" data-mv="1" title="下移">↓</button>'
      + '<button class="pl-x" data-del="' + esc(x.id) + '" title="从播放列表移除">✕</button></div>');
  }
  parts.push('<div class="pl-pad" style="height:' + Math.max(0, (items.length - last) * PL_ROW_H) + 'px"></div>');
  body.innerHTML = parts.join('');
}

function scrollCurIntoView() {
  const body = $('#plBody');
  const items = plItems();
  const cur = curTrack();
  if (!body || !cur) return;
  const at = items.findIndex(x => x.id === cur.path);
  if (at < 0) return;
  const top = at * PL_ROW_H;
  if (top < body.scrollTop || top + PL_ROW_H > body.scrollTop + body.clientHeight) {
    body.scrollTop = Math.max(0, top - Math.floor(body.clientHeight / 2) + PL_ROW_H / 2);
  }
}

/* ---- 可选歌单：本地曲库 / 当前打开的网易云歌单 / 我的歌单 ---- */
function plSources() {
  /* 列什么取决于「当前账号」（标题栏右上角头像）：
   * 切到酷狗/QQ 音乐时，把网易云歌单塞进来只会让人点进去报错，
   * 所以这里按 S.idn.current 过滤；本地曲库任何账号下都在。 */
  const out = [];
  const cur = (S.idn && S.idn.current) || '';
  const local = S.tracks.filter(t => !isNet(t));
  if (local.length) {
    out.push({ key: 'local', name: '本地曲库', sub: local.length + ' 首 · 本机文件', tracks: local });
  }
  if (!cur || cur === 'ne') {
    const coll = S.ne.coll;
    if (coll && coll.status === 'ready' && coll.tracks && coll.tracks.length) {
      out.push({
        key: 'coll', name: coll.name || '当前歌单',
        sub: coll.tracks.length + ' 首 · 网易云', tracks: coll.tracks
      });
    }
    const d = S.ne.home.data;
    const mine = d && d.mine && d.mine.list;
    if (Array.isArray(mine)) {
      for (const p of mine) {
        if (!p || !p.id) continue;
        out.push({
          key: 'ne', id: p.id, name: p.name || '网易云歌单',
          sub: (p.count || 0) + ' 首 · 网易云（打开时读取）'
        });
      }
    }
  }
  /* QQ 音乐 / 酷狗：上游歌单（upEnsure 预取），按当前账号所属平台列 */
  if ((cur === 'qqapp' || cur === 'kugou') && S.up[cur]) {
    const st = S.up[cur];
    const label = cur === 'qqapp' ? 'QQ 音乐' : '酷狗音乐';
    if (st.status === 'ready') {
      for (const p of st.items) {
        out.push({
          key: cur, kind: 'up', provider: cur, id: p.id, dirId: p.dirId || 0,
          name: p.name, sub: (p.count ? p.count + ' 首 · ' : '') + label + '（打开时读取）'
        });
      }
    } else if (st.status === 'error') {
      out.push({ key: cur, name: label + '：歌单读取失败', sub: st.err || '稍后重试', disabled: true });
    }
  }
  /* 哔哩哔哩收藏夹只读已有结果：不为一个下拉框去发网络请求，
   * 列表本身在曲库抽屉里刷新（bilEnsureFavs）。 */
  if (cur === 'bil') {
    const f = S.bil.favs;
    if (f && f.status === 'ready' && Array.isArray(f.items)) {
      for (const it of f.items) {
        if (!it || !it.id) continue;
        /* 收藏夹条目的字段是 name / sub（不是 title/count），与曲库抽屉里的行同源 */
        out.push({
          key: 'bil', kind: 'bil', id: it.id, name: it.name || '收藏夹',
          sub: (it.sub ? it.sub + ' · ' : '') + '哔哩哔哩（打开时读取）'
        });
      }
    }
  }
  return out;
}
function renderPlPick(body) {
  const src = plSources();
  PL.sources = src;
  const n = plItems().length;
  const back = '<div class="pl-back" data-view="list">‹ 返回列表</div>';
  $('#plNote').textContent = '选定歌单后先确认，再整体覆盖；不追加';
  const head = back + '<div class="pl-sec">选一个歌单 · 会整体覆盖当前列表（' + n + ' 首）</div>';
  if (PL.busy) {
    body.innerHTML = back + '<div class="pl-sec">正在读取歌单…</div>';
    return;
  }
  if (!src.length) {
    body.innerHTML = head + '<div class="pl-empty">还没有可用的歌单'
      + '<small>先在曲库导入文件，或登录网易云</small></div>';
    return;
  }
  body.innerHTML = head + src.map((s, i) =>
    '<div class="pl-row" data-src="' + i + '"><div class="pl-main">'
    + '<div class="pl-t">' + esc(s.name) + '</div>'
    + '<div class="pl-a">' + esc(s.sub) + '</div></div><span class="pl-plus">›</span></div>'
  ).join('');
}

/* ---- 挑歌：当前歌单 / 本地曲库 / 当前搜索结果 ---- */
function plCandidates() {
  const groups = [];
  const coll = S.ne.coll;
  if (coll && coll.status === 'ready' && coll.tracks && coll.tracks.length) {
    groups.push({ title: '当前歌单 · ' + (coll.name || '网易云'), tracks: coll.tracks.slice(0, 60) });
  }
  const local = S.tracks.filter(t => !isNet(t));
  if (local.length) {
    groups.push({ title: '本地曲库 · ' + local.length + ' 首', tracks: local.slice(0, 60) });
  }
  const q = ($('#q').value || '').trim().toLowerCase();
  const found = S.ne.view === 'search' ? S.ne.items : [];
  const hits = q
    ? found.filter(t => [t.title, t.artist, t.album].filter(Boolean).join(' ').toLowerCase().includes(q))
    : found;
  if (hits.length) {
    groups.push({ title: (q ? '搜索结果' : '网易云搜索') + ' · ' + hits.length + ' 首', tracks: hits.slice(0, 60) });
  }
  return groups;
}

function renderPlAdd(body) {
  const groups = plCandidates();
  PL.cands = [];
  const back = '<div class="pl-back" data-view="list">‹ 返回列表</div>';
  $('#plNote').textContent = '点一首追加到末尾；同一首不会重复加入';
  if (!groups.length) {
    body.innerHTML = back + '<div class="pl-sec">挑一首歌加入末尾</div>'
      + '<div class="pl-empty">没有可挑的歌<small>先在曲库导入文件，或在网易云搜索</small></div>';
    return;
  }
  const curIds = new Set(plItems().map(x => x.id));
  const parts = [back, '<div class="pl-sec">挑一首歌加入末尾 · 已在列表里的会标出来</div>'];
  for (const g of groups) {
    parts.push('<div class="pl-sec">' + esc(g.title) + '</div>');
    for (const t of g.tracks) {
      const item = plToItem(t);
      const dup = curIds.has(item.id);
      const idx = PL.cands.push(t) - 1;
      parts.push('<div class="pl-row" data-add="' + idx + '"><div class="pl-main">'
        + '<div class="pl-t">' + esc(item.title) + '</div>'
        + '<div class="pl-a">' + esc(item.artist || '未知艺人') + (dup ? ' · 已在列表' : '') + '</div></div>'
        + '<span class="pl-plus">+</span></div>');
    }
  }
  body.innerHTML = parts.join('');
}

/* ---- 选择：整单覆盖（先确认） ---- */
async function plSelectSource(src) {
  if (!src || PL.busy) return;
  let tracks = src.tracks;
  if (!tracks) {
    PL.busy = true;
    renderPl();
    try {
      /* 哔哩哔哩走收藏夹接口，网易云走歌单接口：两者的返回都是 { ok, tracks }，
       * 只有入口不同，所以在这里分一次叉，下面的覆盖逻辑完全复用。 */
      let r;
      if (src.kind === 'bil') r = await window.api.bilFavList(src.id, 1);
      else if (src.kind === 'up') r = await window.api.accTracks(src.provider, src.id, src.dirId);
      else r = await window.api.nePlaylist(src.id);
      if (!r || !r.ok) throw new Error((r && r.error && r.error.message) || '读取失败');
      /* 上游歌单给的是 { id, title, artist, duration }，没有 path：
       * 用 id 当 path，这样列表能落盘；取流是否支持由播放层决定（见下方提示）。 */
      tracks = src.kind === 'up'
        ? (r.items || []).map(t => ({
            title: t.title, artist: t.artist, duration: t.duration,
            /* 上游曲目在列表里用前缀 id 存，media:url 据此选协议：
             * 酷狗 kg:<32位hash>，QQ 音乐 qq:<songmid>。 */
            path: src.provider === 'kugou' ? 'kg:' + t.id : (String(t.id).startsWith('qq:') ? t.id : 'qq:' + t.id)
          }))
        : (r.tracks || []);
    } catch (e) {
      PL.busy = false;
      renderPl();
      toast('读取歌单失败：' + ((e && e.message) || e));
      return;
    }
    PL.busy = false;
  }
  const items = plNormalize((tracks || []).map(plToItem));
  if (!items.length) { toast('这个歌单里没有可用的曲目'); return; }
  const old = plItems().length;
  PL.ask = {
    text: '用「' + src.name + '」的 ' + items.length + ' 首覆盖播放列表？'
      + (old ? '当前 ' + old + ' 首会被清空，不追加。' : '当前列表是空的。'),
    ok: '覆盖',
    run: () => {
      const wasPlaying = !audio.paused;      // 记住导入前的播放状态，决定导入后要不要继续出声
      S.settings.playlist = items;           // 整体替换，不是追加
      plSave();
      const kept = rebuildQueue('id');       // true = 当前曲还在新列表里，位置已保住
      renderPl();
      if (!S.q.length) { stopPlayback(); toast('这个歌单没有可用曲目'); return; }
      if (kept) {
        /* 当前曲还在列表里：不碰音频，但要把它记成本轮已播 ——
         * 否则下一次「随机」还可能把它再抽回来，听起来就是「随机重复」。 */
        if (S.settings.playMode === 'shuffle' && curTrack()) {
          S.shufDone.add(curTrack().path);
          S.shufPool.delete(curTrack().path);
        }
      } else {
        /* 当前曲不在新列表里：播放头必须落到第一首。
         * 之前这里什么都不做，游标留在旧下标上，顺序播放就从新列表中间开始。 */
        void playAt(0, { autoplay: wasPlaying });
      }
      toast('已载入 ' + items.length + ' 首 · ' + src.name);
    }
  };
  PL.view = 'list';
  renderPl();
}

/* ---- 插入：追加到末尾，按 id 去重 ---- */
function plAppend(t) {
  const item = plToItem(t);
  if (!item.id) return;
  const list = plItems();
  if (list.some(x => x.id === item.id)) { toast('已在播放列表中：' + item.title); return; }
  list.push(item);                        // 追加到末尾；列表不设上限
  S.settings.playlist = list;
  plSave();
  rebuildQueue('id');
  renderPl();
  toast('已加入播放列表 · ' + item.title);
}

/* ---- 删除：只动本列表；删的正好是当前曲目就按顺序切下一首 ---- */
async function plRemove(id) {
  const list = plItems();
  const at = list.findIndex(x => x.id === id);
  if (at < 0) return;
  const cur = curTrack();
  const wasCurrent = !!cur && cur.path === id;
  list.splice(at, 1);                     // 只从列表里摘掉，曲库与源歌单都不动
  S.settings.playlist = list;
  plSave();
  rebuildQueue('id');
  if (!list.length) {
    stopPlayback();
    renderPl();
    toast('已移除，播放列表空了');
    return;
  }
  renderPl();
  if (!wasCurrent) return;
  /* 删的是正在放的那首：按顺序顶上来的下一首接着放；
   * 删的是最后一首时回退到新的末尾，不要突然跳回开头。 */
  const qi = Math.min(at, S.q.length - 1);
  await plPlay(qi);
}

/* 从队列下标播放；曲目不在曲库里时按 id 重建（网易云）或提示（本地文件） */
async function plPlay(qi) {
  const row = S.q[qi];
  if (!row) return;
  if (qTrack(qi)) { closePops(); return playAt(qi); }
  if (String(row.id).startsWith(NET_PREFIX)) {
    closePops();
    await playNet({
      source: 'netease', path: row.id,
      netId: Number(String(row.id).slice(NET_PREFIX.length)),
      title: row.item.title, artist: row.item.artist, duration: row.item.duration
    });
    return;
  }
  // 本地文件已经不在曲库（删了 / 挪走了）：先说一声，再按队列顺序往下继续。
  // 不能只 toast 就 return —— 点了没反应会让人以为界面卡死；这里的策略与
  // playAt 遇到失效行时一致（skipDead 往下找第一首能放的）。
  toast('这首不在曲库里了，已跳过：' + row.item.title);
  return playAt(qi);
}

/* 上移/下移：只改列表顺序，不动曲目对象；当前曲目靠 id 保位，播放不中断 */
function plMove(i, dir) {
  const list = plItems();
  const j = i + dir;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return;
  const [x] = list.splice(i, 1);
  list.splice(j, 0, x);
  S.settings.playlist = list;
  plSave();
  rebuildQueue('id');
  renderPl();
}

/* 列表空了 / 全部失效：停下来并把界面摆回「没有曲目」的样子，
 * 但不能只 pause —— src 还指着旧文件，点播放会又响起来。 */
function stopPlayback() {
  ++loadSeq;                              // 丢掉还在路上的加载
  audio.pause();
  try { audio.removeAttribute('src'); audio.load(); } catch {}
  S.playing = false;
  S.i = -1;
  S.lyrics = [];
  S.lyricSrc = '';
  renderLyrics();
  setLyrHint(null, null);
  paintMeta();
  markCurrent();
  syncPlayIcon();
  renderMediaSession();
  S.settings.playPos = null;
  saveSettings();
}

function plClearAsk() {
  const n = plItems().length;
  if (!n) return;
  PL.view = 'list';
  PL.ask = {
    text: '清空播放列表里的 ' + n + ' 首？（不改动源歌单，也不动曲库）',
    ok: '清空',
    run: () => {
      S.settings.playlist = [];
      plSave();
      rebuildQueue();
      stopPlayback();
      toast('播放列表已清空');
    }
  };
  renderPl();
}

function plBind() {
  const btn = $('#btnPl');
  btn.onclick = e => {
    e.stopPropagation();
    const pop = $('#popPl');
    if (pop.classList.contains('show')) { closePops(); return; }
    PL.view = 'list';
    PL.ask = null;
    pop._place = placePl;
    openPop(pop, btn);
    btn.classList.add('open');
    renderPl();
  };
  $('#plSelect').onclick = e => { e.stopPropagation(); PL.view = 'pick'; PL.ask = null; renderPl(); };
  $('#plInsert').onclick = e => { e.stopPropagation(); PL.view = 'add'; PL.ask = null; renderPl(); };
  $('#plClear').onclick = e => { e.stopPropagation(); plClearAsk(); };

  // 面板内统一委托：删除 / 确认条 / 选歌单 / 加歌 / 播放
  $('#popPl').addEventListener('click', e => {
    const t = e.target;
    const del = t.closest('[data-del]');
    if (del) { e.stopPropagation(); plRemove(del.dataset.del); return; }
    const mv = t.closest('[data-mv]');
    if (mv) {
      e.stopPropagation();
      const row = mv.closest('.pl-row[data-i]');
      if (row) plMove(Number(row.dataset.i), Number(mv.dataset.mv));
      return;
    }
    const ans = t.closest('[data-pl]');
    if (ans) {
      e.stopPropagation();
      const ask = PL.ask;
      PL.ask = null;
      if (ans.dataset.pl === 'yes' && ask) { ask.run(); renderPl(); }
      else renderPl();
      return;
    }
    const back = t.closest('[data-view]');
    if (back) { e.stopPropagation(); PL.view = back.dataset.view; PL.ask = null; renderPl(); return; }
    const sel = t.closest('[data-src]');
    if (sel) { e.stopPropagation(); plSelectSource(PL.sources[Number(sel.dataset.src)]); return; }
    const add = t.closest('[data-add]');
    if (add) { e.stopPropagation(); plAppend(PL.cands[Number(add.dataset.add)]); return; }
    const row = t.closest('.pl-row[data-i]');
    if (row && PL.view === 'list') plPlay(Number(row.dataset.i));
  });
}

/* ------------------------------------------------------------------ 网易云 */
/*
 * 抽屉里是「本地 / 网易云」两条音轨，共用一套列表与播放器：
 *   - 本地：搜索过滤已有曲库；
 *   - 网易云：搜索走在线接口，点一条 = 加入曲库并立即播放。
 * 搜索结果不落盘，只有点过的曲目才进 S.tracks（和本地文件一起持久化）。
 */
function setSource(mode) {
  S.srcMode = (mode === 'net' || mode === 'bil' || mode === 'qqapp' || mode === 'kugou') ? mode : 'local';
  const net = S.srcMode === 'net';
  const bilMode = S.srcMode === 'bil';
  const upMode = S.srcMode === 'qqapp' || S.srcMode === 'kugou';
  $$('#segSrc b').forEach(b => b.classList.toggle('on', b.dataset.s === S.srcMode));
  $('#localActions').style.display = net || bilMode || upMode ? 'none' : 'flex';
  $('#netActions').style.display = net ? 'flex' : 'none';
  $('#neNote').style.display = net ? 'block' : 'none';
  const bilNote = $('#bilNote');
  if (bilNote) bilNote.style.display = bilMode ? 'block' : 'none';
  if (!net) $('#neHome').classList.remove('show');
  if (!bilMode) $('#bilHome').classList.remove('show');
  const q = $('#q');
  q.value = '';
  q.placeholder = net ? '搜索网易云：曲名 / 艺人 / 专辑'
    : bilMode ? '搜索哔哩哔哩：视频标题 / UP 主'
      : upMode ? '在已读取的歌单里筛选曲目'
        : '搜索曲名 / 艺人 / 专辑';
  if (net) {
    updateNeNote();
    if (S.ne.view !== 'coll') S.ne.view = 'home';
    neEnsureHome();          // 首次进来才真的打接口，之后复用缓存
  }
  if (upMode) upEnsure(S.srcMode, false);
  if (bilMode) {
    S.bil.items = [];
    S.bil.err = '';
    S.bil.view = 'idle';
    bilFavsReset();
    updateBilNote().then(() => bilEnsureFavs());
  }
  renderLibrary();
  if (net || bilMode) setTimeout(() => q.focus(), 60);
}

/* 账号状态只在这里汇总成三个值（hasCookie / loggedIn / nick），
 * 文案全部由 paintNeNote 统一画，登录、过期、退出、刷新后都不会出现两套说法。 */
function paintNeNote() {
  const has = S.ne.hasCookie;
  const ok = S.ne.loggedIn;
  S.ne.loggedIn = ok;
  const el = $('#neNote');
  if (el) {
    el.textContent = ok
      ? `已登录${S.ne.nick ? ' · ' + S.ne.nick : ''} · 音源按账号权限解析；无权限的曲目会自动跳过`
      : has
        ? '登录已过期 · 点这里重新扫码，否则只能播放免费曲目'
        : '未登录 · 只能播放免费曲目，点这里扫码登录';
    el.title = ok ? '' : '点击打开设置扫码登录';
    el.classList.toggle('linked', !ok);
  }
  const ast = $('#neAuthState');
  if (ast) ast.textContent = ok ? (S.ne.nick || '已登录') : has ? '登录已过期' : '未登录';
}

async function updateNeNote() {
  let st = null;
  try { st = await window.api.neStatus(); } catch {}
  // 有凭证 ≠ 还有效：cookie 过期时接口返回 profile:null，这里区分「未登录 / 已过期 / 已登录」
  if (st) {
    S.ne.hasCookie = !!st.hasCookie;
    S.ne.loggedIn = !!st.loggedIn;
    S.ne.nick = st.nickname || S.ne.nick;
    if (st.uid) S.ne.uid = st.uid;
  }
  paintNeNote();
}

/* ---- 扫码登录 ----
 * 二维码的生成和轮询都在主进程，这里只负责展示与节流：
 *   801 等待扫码 → 802 已扫码待确认 → 803 成功；800 过期，必须重新取码。
 * 用 token 作废在途响应：面板关了/刷新了，晚到的回调不能再写状态，
 * 否则会出现「已经关掉的码又跳成已扫码」这种鬼影。
 */
const QR_POLL_MS = 2000;
let qrTimer = 0, qrToken = 0, qrFails = 0;

function qrStateSet(text, kind) {
  const el = $('#qrState');
  if (!el) return;
  el.textContent = text;
  el.className = 'qrstate' + (kind ? ' ' + kind : '');
}
function qrSetDead(dead, maskText) {
  const shot = $('#qrShot');
  if (shot && shot.parentElement) shot.parentElement.classList.toggle('dead', !!dead);
  const m = $('#qrMask');
  if (m && maskText != null) m.textContent = maskText;
}
function qrStop() {
  clearTimeout(qrTimer);
  qrTimer = 0;
  qrToken++;
  qrFails = 0;
}
function qrShown() {
  const w = $('#qrWrap');
  return !!w && w.classList.contains('show');
}
function qrHide() {
  qrStop();
  const w = $('#qrWrap');
  if (w) w.classList.remove('show');
}

async function qrStart() {
  qrStop();
  const token = qrToken;
  const w = $('#qrWrap');
  if (w) w.classList.add('show');
  qrSetDead(false);
  const shot = $('#qrShot');
  if (shot) shot.innerHTML = '';
  qrStateSet('正在获取二维码…');
  const btn = $('#btnQrRefresh');
  if (btn) btn.disabled = true;

  let r;
  try { r = await window.api.neQr(); }
  catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }
  if (token !== qrToken) return;          // 期间又刷新/收起过，这次结果作废
  if (btn) btn.disabled = false;

  if (!r || !r.ok) {
    qrSetDead(true, '获取失败');
    qrStateSet((r && r.error && r.error.message) || '二维码获取失败', 'err');
    return;
  }
  if (shot) shot.innerHTML = r.svg || '';  // 主进程本地拼的静态 SVG，不来自网络
  qrStateSet('请用手机扫码');
  qrTimer = setTimeout(() => qrPoll(token), 700);
}

async function qrPoll(token) {
  if (token !== qrToken) return;
  let r;
  try { r = await window.api.neQrPoll(); }
  catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }
  if (token !== qrToken) return;

  if (!r || !r.ok) {
    // 网络抖动不该把二维码判死：连续失败三次才停，避免一次超时就让用户重扫
    qrFails++;
    if (qrFails < 3) {
      qrStateSet('网络不稳，正在重试…', 'err');
      qrTimer = setTimeout(() => qrPoll(token), QR_POLL_MS * 2);
      return;
    }
    qrSetDead(true, '连接中断');
    qrStateSet((r && r.error && r.error.message) || '登录检查失败，请刷新二维码', 'err');
    return;
  }
  qrFails = 0;

  if (r.code === 803) {
    qrSetDead(false, '');
    qrStateSet('登录成功' + (r.nickname ? ' · ' + r.nickname : ''), 'ok');
    toast(r.warning || ('已登录网易云' + (r.nickname ? '：' + r.nickname : '')));
    // 先用 803 自带的信息落 UI，稍后再用账号接口校准：
    // 刚登录就立刻校验有竞态（cookie 生效有毫秒级延迟），不该让界面先闪一下「已过期」
    S.ne.loggedIn = true;
    S.ne.hasCookie = true;
    S.ne.nick = r.nickname || '';
    paintNeNote();
    // 登录成功后立刻把当前账号的歌单拉回来；上一个账号的歌单/打开的列表一并作废
    S.ne.view = 'home';
    S.ne.coll = null;
    S.ne.collSeq++;
    S.ne.items = [];
    neEnsureHome(true);
    setTimeout(updateNeNote, 1500);
    const t = qrToken;
    setTimeout(() => { if (qrToken === t) qrHide(); }, 1400);
    return;
  }
  if (r.code === 800) {
    qrSetDead(true, '二维码已过期');
    qrStateSet('二维码已过期，刷新后重新扫', 'err');
    return;
  }
  if (r.code === 802) qrStateSet('已扫码，请在手机上确认', 'ok');
  else qrStateSet('请用手机扫码');
  qrTimer = setTimeout(() => qrPoll(token), QR_POLL_MS);
}

let neTimer = 0;
async function neSearch() {
  const q = ($('#q').value || '').trim();
  const seq = ++S.ne.seq;
  if (!q) {
    // 清空搜索 = 回歌单首页，而不是留一块「未搜索」的空列表
    S.ne.items = [];
    S.ne.busy = false;
    S.ne.err = '';
    S.ne.view = 'home';
    neEnsureHome();
    renderNet();
    return;
  }
  S.ne.view = 'search';
  S.ne.busy = true;
  S.ne.err = '';
  renderNet();
  let r;
  try { r = await window.api.neSearch(q, 40); }
  catch (e) { r = { ok: false, error: { message: String(e && e.message || e) } }; }
  if (seq !== S.ne.seq) return;           // 输入太快，只认最后一次
  S.ne.busy = false;
  if (!r || !r.ok) {
    S.ne.items = [];
    S.ne.err = (r && r.error && r.error.message) || '搜索失败';
  } else {
    S.ne.items = r.tracks || [];
    S.ne.err = '';
  }
  renderNet();
}

/* ---- 网易云首页 ----
 * 登录成功后这里才有内容：当前账号自己创建的歌单 + 推荐歌单，
 * 上面再放「每日推荐 / 私人FM」两个入口。所有分支都先画骨架或提示，
 * 不让抽屉出现「空白一片但也没在加载」的状态。
 */
const ICON_SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.1"/><path d="M12 2.7v2.2M12 19.1v2.2M2.7 12h2.2M19.1 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/></svg>';
const ICON_FM = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.3"/><path d="M8.3 8.3a5.2 5.2 0 000 7.4M15.7 15.7a5.2 5.2 0 000-7.4M5.5 5.5a9.2 9.2 0 000 13M18.5 18.5a9.2 9.2 0 000-13"/></svg>';

const neBigNum = n => {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
};
const skeletonRows = n => Array.from({ length: n }, () => '<div class="sk"><i class="s1"></i><i class="s2"></i></div>').join('');
const neMsg = (html, extra = '') => `<div class="ne-msg">${html}</div>${extra}`;
const neLoginBox = '<div class="ne-act"><button class="ghost" data-act="login">扫码登录</button></div>';

function neRow(p, origin) {
  const sub = p.special === 'like'
    ? `我喜欢的音乐 · ${p.count} 首`
    : origin === 'picked'
      ? (p.playCount ? neBigNum(p.playCount) + ' 次播放' : (p.count || 0) + ' 首')
      : (p.count || 0) + ' 首';
  return `<div class="plrow" data-act="pl" data-id="${p.id}" data-origin="${origin}" data-name="${esc(p.name)}">
    <div class="pth" data-cover="${esc(p.coverUrl)}"><span>${esc((p.name || '歌').slice(0, 1))}</span></div>
    <div class="pi"><div class="pn">${esc(p.name)}</div><div class="pd">${esc(sub)}</div></div>
    <div class="pr">›</div>
  </div>`;
}

/* 封面是装饰：下不回来就留首字底色，不报错、不占位、不阻塞列表渲染。
 * 一次最多 4 个在飞，20 个歌单也不会同时压 20 个请求。 */
const coverQ = [];
let coverRun = 0;
function fillCovers(root) {
  for (const el of $$('.pth[data-cover]', root)) {
    const url = el.dataset.cover;
    el.removeAttribute('data-cover');       // 只试一次，重绘不会重复排队
    if (url) coverQ.push([el, url]);
  }
  pumpCovers();
}
function pumpCovers() {
  while (coverRun < 4 && coverQ.length) {
    const [el, url] = coverQ.shift();
    if (!el.isConnected) continue;          // 已经被重新渲染替换掉，白请求就别发了
    coverRun++;
    window.api.neCover(url)
      .then(r => {
        if (r && r.ok && r.dataUrl && el.isConnected) {
          el.style.backgroundImage = `url("${r.dataUrl}")`;
          el.classList.add('img');
        }
      })
      .catch(() => {})
      .then(() => { coverRun--; pumpCovers(); });
  }
}

async function neEnsureHome(force = false) {
  const h = S.ne.home;
  if (!force && (h.status === 'loading' || h.status === 'ready')) return;
  const seq = ++S.ne.homeSeq;
  S.ne.home = { status: 'loading', err: '', data: null };
  if (S.srcMode === 'net' && S.ne.view === 'home') renderNet();

  let r;
  try { r = await window.api.neHome(); }
  catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }
  if (seq !== S.ne.homeSeq) return;         // 期间又刷新/登录过，这次结果作废

  if (!r || !r.ok) {
    S.ne.home = { status: 'error', err: (r && r.error && r.error.message) || '加载失败', data: null };
  } else {
    S.ne.home = { status: 'ready', err: '', data: r };
    S.ne.hasCookie = !!r.hasCookie;
    S.ne.loggedIn = !!r.loggedIn;
    S.ne.uid = r.uid || 0;
    if (r.nickname) S.ne.nick = r.nickname;
    paintNeNote();
  }
  if (S.srcMode === 'net' && S.ne.view === 'home') renderNet();
}

/* 播放前补到 cid 之后，所有「以曲目 id 为键」的地方都要一起改：曲库索引、队列行、
 * 播放列表项、随机池。只改曲目对象的 path 是不够的 —— 播放列表里存的还是插入时的
 * bil:<bvid>:0，下一次点同一条会因为 id 对不上而被当成新曲目再插一遍。 */
function patchBilCid(qi, k, cid) {
  const n = Number(cid) || 0;
  if (!n || !k || n === Number(k.bilCid)) return;
  const oldPath = k.path;
  k.bilCid = n;
  k.path = 'bil:' + k.bilBvid + ':' + n;
  if (oldPath !== k.path && S.libIndex) {
    S.libIndex.delete(oldPath);
    S.libIndex.set(k.path, k);
  }
  const row = S.q[qi];
  if (row) { row.id = k.path; row.t = k; }
  const list = plItems();
  const at = list.findIndex(x => x.id === oldPath);
  if (at >= 0) { list[at] = plToItem(k); S.settings.playlist = list; plSave(); }
  if (S.shufPool) {
    if (S.shufPool.delete(oldPath)) S.shufPool.add(k.path);
    if (S.shufDone && S.shufDone.delete(oldPath)) S.shufDone.add(k.path);
  }
  S.libDirty = true;
}

/* ------------------------------------------------------------------ 哔哩哔哩 */
/*
 * 与网易云共用同一套「搜索 → 点一条 → 加入曲库并播放」的交互，差别只有两点：
 *   1. 没有歌单/推荐首页，进来就是一句「搜个标题或 UP 主」；
 *   2. 播放前要补 cid（搜索结果只给 bvid），这一步在 playAt 的 bil 分支里做。
 * 登录是可选的：不登录也能播公开稿件，只是收藏夹之类用不了 —— 所以未登录不拦搜索。
 */
function paintBilNote() {
  const el = $('#bilNote');
  if (!el) return;
  const st = S.bil.status;
  const ok = !!(st && st.loggedIn);
  const expired = !!(st && st.expired);
  el.textContent = expired
    ? '登录已失效 · 点这里重新扫码（收藏夹需要重新登录）'
    : (ok
      ? `已登录${st.nickname ? ' · ' + st.nickname : ''}${st.userId ? ' (uid ' + st.userId + ')' : ''} · 播放按账号权限取流`
      : '未登录 · 只能播放公开稿件，点这里扫码登录');
  el.classList.toggle('linked', !ok || expired);
  const ast = $('#bilAuthState');
  if (ast) ast.textContent = expired ? '登录已失效' : (ok ? (st.nickname || '已登录') : '未登录');
}

async function updateBilNote() {
  try {
    const r = await window.api.bilStatus();
    if (r && r.ok) S.bil.status = r.status;
  } catch { /* 网络异常不阻塞浏览：状态未知就按未登录显示 */ }
  paintBilNote();
}

/* ---------------- 哔哩哔哩收藏夹 ----------------
 * 未登录不是错误：给出「扫码登录」引导即可，搜索与播放不受影响。
 * 文件夹列表与条目都按登录态缓存，切回来不重复请求；点「刷新」才强制重取。
 */
function bilFavsReset() {
  S.bil.favs = { status: 'idle', err: '', items: [], seq: 0 };
  S.bil.fav = { id: '', title: '', page: 0, hasMore: false, items: [], busy: false, err: '' };
  if (S.bil.view === 'fav') S.bil.view = 'idle';
}

async function bilEnsureFavs(force) {
  const st = S.bil.status;
  if (!st || !st.loggedIn || st.expired) {
    bilFavsReset();
    if (S.srcMode === 'bil') renderBil();
    return;
  }
  const f = S.bil.favs;
  if (!force && (f.status === 'ready' || f.status === 'loading')) return;
  const seq = ++f.seq;
  f.status = 'loading';
  f.err = '';
  if (S.srcMode === 'bil' && S.bil.view !== 'fav') renderBil();

  let r;
  try { r = await window.api.bilFavs(); }
  catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }
  if (seq !== f.seq) return;

  if (!r || !r.ok) {
    const code = (r && r.error && r.error.code) || '';
    f.status = code === 'BIL_NOT_LOGIN' ? 'guest' : 'error';
    f.err = (r && r.error && r.error.message) || '收藏夹加载失败';
    if (code === 'BIL_NOT_LOGIN') {
      /* 上游说登录失效：把状态改成「失效」，界面才会给出重新扫码的入口 */
      S.bil.status = Object.assign({}, S.bil.status, { loggedIn: false, expired: true });
      paintBilNote();
    }
  } else {
    f.status = 'ready';
    f.items = r.items || [];
    f.err = '';
  }
  if (S.srcMode === 'bil' && S.bil.view !== 'fav') renderBil();
}

function bilFavRowHTML(f) {
  /* 封面先留首字磁贴，再由 bilPaintFavCovers() 异步换成真实缩略图：
   * 行是批量 render 出来的，同步等图会把整块面板卡住。 */
  return `<div class="plrow" data-bil-fav="${esc(f.id)}" data-bil-favname="${esc(f.name)}">
      <div class="pth${f.coverUrl ? ' img' : ''}"${f.coverUrl ? ` data-cover="${esc(f.coverUrl)}"` : ''}><span>${esc((f.name || '?').slice(0, 1))}</span></div>
      <div class="pi"><div class="pn">${esc(f.name)}</div>
        <div class="pd">${esc(f.sub || '')}</div></div>
      <span class="pr">›</span>
    </div>`;
}

/* 文件夹封面：与列表缩略图同一条路（bilCover 取 120px），失败就留着首字磁贴，
 * 不报错、不重试到死 —— 收藏夹的可用性不依赖封面。 */
function bilPaintFavCovers() {
  const els = $$('#bilHome .pth[data-cover]');
  for (const el of els) {
    const url = el.dataset.cover;
    if (!url || el.dataset.done) continue;
    el.dataset.done = '1';
    window.api.bilCover(url, 120).then(r => {
      if (r && r.ok && r.dataUrl && el.isConnected) {
        el.style.backgroundImage = 'url("' + r.dataUrl + '")';
        el.classList.add('img');
      }
    }).catch(() => { /* 没封面不影响点进收藏夹 */ });
  }
}

function bilFavsHTML() {
  const st = S.bil.status;
  const expired = !!(st && st.expired);
  const f = S.bil.favs;
  if (!st || !st.loggedIn || expired) {
    return `<div class="ne-msg">${expired ? '登录已失效，重新扫码后可看收藏夹。' : '登录后可看「我的收藏夹」；不登录也能搜索与播放公开稿件。'}
      <span class="lnk" data-bil-login="1">${expired ? '重新扫码' : '扫码登录'}</span></div>`;
  }
  if (f.status === 'loading') return `<div class="ne-msg">正在读取收藏夹…</div>`;
  if (f.status === 'error') {
    return `<div class="ne-msg">收藏夹加载失败：${esc(f.err || '未知原因')}
      <span class="lnk" data-bil-favretry="1">重试</span></div>`;
  }
  if (!f.items.length) {
    /* 「登录着但一个都没返回」几乎都是登录态没被接口认可，不是账号真的没有收藏夹：
     * 给重新扫码的出口，别让用户以为收藏夹丢了。 */
    return `<div class="ne-msg">接口没有返回任何收藏夹。这通常意味着当前登录态已失效。
      <span class="lnk" data-bil-login="1">重新扫码</span>
      <span class="lnk" data-bil-favretry="1">再试一次</span></div>`;
  }
  return `<div class="ne-sec">我的收藏夹 <em>${f.items.length} 个</em><button data-bil-favretry="1">刷新</button></div>`
    + f.items.map(bilFavRowHTML).join('');
}

function renderBilFavs() {
  const home = $('#bilHome');
  if (!home) return;
  home.innerHTML = bilFavsHTML();
  home.classList.add('show');
  bilPaintFavCovers();
}

async function bilOpenFav(id, title) {
  S.bil.view = 'fav';
  S.bil.fav = { id: String(id), title: String(title || ''), page: 0, hasMore: false, items: [], busy: true, err: '' };
  renderBil();
  await bilFavPage(1);
}

async function bilFavPage(page) {
  const fav = S.bil.fav;
  if (!fav.id) return;
  fav.busy = page === 1;
  if (page === 1) { fav.items = []; fav.err = ''; }
  renderBil();

  let r;
  try { r = await window.api.bilFavList(fav.id, page); }
  catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }

  fav.busy = false;
  if (!r || !r.ok) {
    const code = (r && r.error && r.error.code) || '';
    fav.err = (r && r.error && r.error.message) || '收藏夹内容加载失败';
    if (code === 'BIL_NOT_LOGIN') {
      S.bil.status = Object.assign({}, S.bil.status, { loggedIn: false, expired: true });
      paintBilNote();
    }
  } else {
    const seen = new Set(fav.items.map(t => bilBvidOf(t)));
    for (const t of (r.items || [])) {
      if (seen.has(bilBvidOf(t))) continue;      // 翻页时上游偶尔重复，按 bvid 去重
      seen.add(bilBvidOf(t));
      fav.items.push(t);
    }
    fav.page = page;
    fav.hasMore = !!r.hasMore;
    if (r.title && !fav.title) fav.title = r.title;
  }
  if (S.bil.view === 'fav') renderBil();
}

async function bilLoadMore() {
  const fav = S.bil.fav;
  if (!fav.id || fav.busy || !fav.hasMore) return;
  await bilFavPage(fav.page + 1);
}

async function bilSearch() {
  const q = ($('#q').value || '').trim();
  if (!q) {
    S.bil.items = [];
    S.bil.view = 'idle';
    S.bil.err = '';
    renderBil();
    return;
  }
  const seq = ++S.bil.seq;
  S.bil.busy = true;
  S.bil.err = '';
  S.bil.view = 'search';
  S.bil.fav.items = [];
  renderBil();

  let r;
  try { r = await window.api.bilSearch(q, 40); }
  catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }
  if (seq !== S.bil.seq) return;               // 又输入了新的关键词，这次结果作废

  S.bil.busy = false;
  if (!r || !r.ok) {
    S.bil.err = (r && r.error && r.error.message) || '搜索失败';
    S.bil.items = [];
    S.bil.view = 'error';
    S.bil.err = r && r.error && r.error.code === 'BIL_403'
      ? '被 B 站风控拦了（-403/-352），过一会儿再试'
      : S.bil.err;
    renderBil();
    return;
  }
  S.bil.items = r.tracks || [];
  S.bil.total = r.total || S.bil.items.length;
  S.bil.view = S.bil.items.length ? 'search' : 'idle';
  if (!S.bil.items.length) S.bil.err = '';
  renderBil();
}

function renderBil() {
  if (S.srcMode !== 'bil') return;
  const list = $('#libList');
  const count = $('#libCount');
  const home = $('#bilHome');
  const st = S.bil;

  /* 收藏夹条目视图：列表区画条目，顶部面板收起。 */
  if (st.view === 'fav') {
    if (home) home.classList.remove('show');
    const fav = st.fav;
    if (fav.busy && !fav.items.length) {
      list.innerHTML = emptyRow('正在读取「' + esc(fav.title || '收藏夹') + '」…');
      count.textContent = '哔哩哔哩 · 收藏夹';
      list.onclick = null;
      return;
    }
    if (fav.err && !fav.items.length) {
      list.innerHTML = emptyRow('收藏夹内容加载失败：' + esc(fav.err)
        + '<br><span class="lnk" data-bil-favback="1">返回收藏夹</span>'
        + ' · <span class="lnk" data-bil-favretry2="1">重试</span>');
      count.textContent = '哔哩哔哩 · 失败';
      list.onclick = e => {
        if (e.target.closest('[data-bil-favback]')) { S.bil.view = 'idle'; renderBil(); return; }
        if (e.target.closest('[data-bil-favretry2]')) bilFavPage(1);
      };
      return;
    }
    if (!fav.items.length) {
      list.innerHTML = emptyRow('这个收藏夹是空的。'
        + '<br><span class="lnk" data-bil-favback="1">返回收藏夹</span>');
      count.textContent = '哔哩哔哩 · 0 首';
      list.onclick = e => {
        if (e.target.closest('[data-bil-favback]')) { S.bil.view = 'idle'; renderBil(); }
      };
      return;
    }
    list.innerHTML = fav.items.map(t => itemHTML(t, null)).join('')
      + (fav.hasMore
        ? `<div class="empty-row"><span class="lnk" data-bil-more="1">${fav.busy ? '正在加载…' : '加载更多'}</span></div>`
        : '');
    fillThumbs(list);
    count.textContent = `${fav.title || '收藏夹'} · 已加载 ${fav.items.length} 首`
      + (fav.hasMore ? ' · 还有更多' : '');
    list.onclick = e => {
      const more = e.target.closest('[data-bil-more]');
      if (more) { bilLoadMore(); return; }
      const el = e.target.closest('.item');
      if (!el) return;
      const bvid = el.dataset.bil;
      const t = fav.items.find(x => bilBvidOf(x) === bvid);
      if (t) playBil(t);
    };
    markedEl = null;
    markCurrent();
    return;
  }

  /* 搜索态（有结果/加载中/失败）时收起首页面板 */
  if (st.view === 'search' || st.view === 'error' || st.busy) {
    if (home) home.classList.remove('show');
  } else {
    /* 空态：先画「我的收藏夹」，下面是搜索引导 */
    renderBilFavs();
  }

  if (st.busy) {
    list.innerHTML = emptyRow('正在搜索哔哩哔哩…');
    count.textContent = '哔哩哔哩';
    return;
  }
  if (st.view === 'error') {
    list.innerHTML = emptyRow('搜索失败：' + esc(st.err || '未知原因')
      + '<br>检查网络，或换个关键词再试。');
    count.textContent = '哔哩哔哩 · 失败';
    list.onclick = null;
    return;
  }
  if (!st.items.length) {
    list.innerHTML = emptyRow(
      '搜一个视频标题或 UP 主。<br>点结果会加入播放列表并开始播放（只取音轨，不下载视频）。'
    );
    count.textContent = '哔哩哔哩';
    list.onclick = null;
    return;
  }
  list.innerHTML = st.items.map(t => itemHTML(t, null)).join('');
  fillThumbs(list);
  const pinned = st.items.filter(t => t.pinned).length;
  count.textContent = `搜索到 ${st.items.length} 条` + (st.total > st.items.length ? ` / 共 ${st.total}` : '')
    + (pinned ? ` · 置顶 ${pinned} 条` : '')
    + ' · 点击播放并加入曲库';
  list.onclick = e => {
    const el = e.target.closest('.item');
    if (!el) return;
    const bvid = el.dataset.bil;
    const t = st.items.find(x => bilBvidOf(x) === bvid);
    if (t) playBil(t);
  };
  markedEl = null;
  markCurrent();
}

async function playBil(t) {
  if (!t) return;
  /* 搜索结果里没有 cid，点播放后 cid 会被补进曲目、path 跟着从 bil:BV…:0 变成
   * bil:BV…:<cid>。所以再点同一条时不能只看 path —— 先按 bvid 找回已有曲目，
   * 否则同一条视频会在播放列表里出现两次。 */
  const known = S.tracks.find(x => isBil(x) && bilBvidOf(x) === bilBvidOf(t));
  const fresh = !known;
  const i = known ? S.tracks.indexOf(known) : addTrack(t);
  if (i < 0) return;
  S.libDirty = true;
  if (fresh) toast(`已加入曲库 · ${t.title}`);
  persistLibrary();
  await playIndex(i);
}

/* ---------------- 哔哩哔哩登录 ----------------
 * 两条路：扫码（默认，不接触账号密码）与手工导入 Cookie（浏览器里已登录过的人
 * 直接复制一行就行）。两者最终都走同一个保存路径：bil:login / bil:qrPoll → 主进程。
 */
let bilQrTimer = 0;
let bilQrToken = 0;

function bilQrStop(hide) {
  clearTimeout(bilQrTimer);
  bilQrTimer = 0;
  bilQrToken++;
  if (hide) {
    const w = $('#bilQrWrap');
    if (w) w.classList.remove('show');
    const img = $('#bilQrShot');
    if (img) img.innerHTML = '';
    /* 关掉主进程里那个隐藏登录窗，不然它会一直挂着 */
    try { window.api.bilQrCancel(); } catch { /* 忽略 */ }
  }
}

function bilQrState(text, bad) {
  const el = $('#bilQrState');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('err', !!bad);
}

async function bilQrStart() {
  const wrap = $('#bilQrWrap');
  const shot = $('#bilQrShot');
  const box = $('#bilQrBox');
  if (!wrap || !shot) return;
  wrap.classList.add('show');
  box.classList.remove('dead');
  shot.innerHTML = '';
  bilQrState('正在获取二维码…');
  bilQrStop(false);

  let r;
  try { r = await window.api.bilQr(); }
  catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }
  if (!r || !r.ok) {
    box.classList.add('dead');
    bilQrState('获取二维码失败：' + ((r && r.error && r.error.message) || '未知原因')
      + ' · 可以改用下面的「导入 Cookie」', true);
    return;
  }
  /* 主进程会返回官方登录页里的二维码位图（data:image/png）；老版本回的是 svg，两种都认 */
  const qrBox = r.qr || r;
  if (qrBox.img) shot.innerHTML = '<div class="qrimg"><img alt="" src="' + qrBox.img + '"></div>';
  else shot.innerHTML = '<div class="qrimg">' + (qrBox.svg || '') + '</div>';
  bilQrState('请用哔哩哔哩手机客户端扫码');
  const token = ++bilQrToken;
  bilQrTimer = setTimeout(() => bilQrPoll(token), 1500);
}

async function bilQrPoll(token) {
  if (token !== bilQrToken) return;
  let r;
  try { r = await window.api.bilQrPoll(); }
  catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }
  if (token !== bilQrToken) return;

  if (!r || !r.ok) {
    const code = (r && r.error && r.error.code) || '';
    if (code === 'BIL_QR_GONE' || code === 'BIL_QR_EXPIRED') {
      bilQrStop(false);
      const box = $('#bilQrBox');
      if (box) box.classList.add('dead');
      bilQrState('二维码已失效（约 3 分钟）· 点「重新获取」', true);
      return;
    }
    bilQrState('轮询失败：' + ((r && r.error && r.error.message) || '未知原因'), true);
    bilQrTimer = setTimeout(() => bilQrPoll(token), 3000);
    return;
  }

  if (r.loggedIn) {
    bilQrStop(true);
    await updateBilNote();
    bilFavsReset();
    await bilEnsureFavs(true);
    toast(`已登录哔哩哔哩${r.nickname ? ' · ' + r.nickname : ''}${r.warning ? '（' + r.warning + '）' : ''}`);
    if (S.srcMode === 'bil') renderBil();
    return;
  }
  if (r.img) {
    const cur = $('#bilQrShot img');
    if (cur && cur.getAttribute('src') !== r.img) cur.setAttribute('src', r.img);
  }
  if (r.state === 'scanned') bilQrState('已扫码，请在手机上确认');
  else if (r.state === 'expired') {
    bilQrStop(false);
    const box = $('#bilQrBox');
    if (box) box.classList.add('dead');
    bilQrState('二维码已失效（约 3 分钟）· 点「重新获取」', true);
    return;
  } else bilQrState('请用哔哩哔哩手机客户端扫码');
  bilQrTimer = setTimeout(() => bilQrPoll(token), 2000);
}

async function bilSaveAuth() {
  const ta = $('#bilCookie');
  const msg = $('#bilMsg');
  const raw = (ta && ta.value || '').trim();
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.classList.toggle('err', !!bad); } };
  if (!raw) { say('先粘贴 Cookie', true); return; }
  const btn = $('#bilAuthSave');
  if (btn) btn.disabled = true;
  say('正在验证…');
  let r;
  try { r = await window.api.bilLogin(raw); }
  catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }
  if (btn) btn.disabled = false;

  if (!r || !r.ok) {
    const code = (r && r.error && r.error.code) || '';
    say(code === 'BIL_AUTH_NO_IDENTITY'
      ? '这份 Cookie 里没有 SESSDATA，可能复制的是未登录页面'
      : '保存失败：' + ((r && r.error && r.error.message) || '未知原因'), true);
    return;
  }
  if (ta) ta.value = '';
  S.bil.status = r.status;
  paintBilNote();
  bilFavsReset();
  bilEnsureFavs(true);
  closePops();
  const chk = r.check || {};
  const okVerify = !!chk.ok;
  toast(okVerify
    ? `已登录哔哩哔哩${chk.nickname ? ' · ' + chk.nickname : ''}`
    : 'Cookie 已保存，但这台机器上没能验证通过（可能是网络或 Cookie 已过期）');
  /* 面板已经关了，但这行字留着也有用：下次打开能立刻看出上次是「验过」还是「只存下」 */
  say(okVerify ? `已保存并验证${chk.nickname ? ' · ' + chk.nickname : ''}` : '已保存（未通过验证，检查网络或 Cookie 是否过期）', !okVerify);
  if (S.srcMode === 'bil') renderBil();
}

async function bilLogout() {
  try { await window.api.bilLogout(); } catch {}
  S.bil.status = { loggedIn: false };
  bilFavsReset();
  paintBilNote();
  toast('已退出哔哩哔哩');
  if (S.srcMode === 'bil') renderBil();
}

function renderNet() {
  if (S.srcMode !== 'net') return;
  // 顶部这块面板只在「首页 / 歌单详情」出现；搜索时让位给结果列表
  $('#neHome').classList.toggle('show', S.ne.view !== 'search');
  if (S.ne.view === 'coll' && S.ne.coll) return renderColl();
  if (S.ne.view === 'search') return renderSearch();
  return renderHome();
}

function renderSearch() {
  const list = $('#libList');
  const count = $('#libCount');
  if (S.ne.busy) {
    list.innerHTML = emptyRow('正在搜索…');
    count.textContent = '网易云';
    return;
  }
  if (S.ne.err) {
    list.innerHTML = emptyRow('搜索失败：' + esc(S.ne.err));
    count.textContent = '网易云';
    return;
  }
  if (!S.ne.items.length) {
    list.innerHTML = emptyRow(
      '没有找到匹配的曲目。<br>换个关键词，或清空搜索看你的歌单。'
    );
    count.textContent = '网易云 · 无结果';
    list.onclick = null;
    return;
  }
  list.innerHTML = S.ne.items.map(t => itemHTML(t, null)).join('');
  fillThumbs(list);
  count.textContent = `搜索到 ${S.ne.items.length} 条 · 点击播放并加入曲库`;
  list.onclick = e => {
    const el = e.target.closest('.item');
    if (!el) return;
    const t = S.ne.items.find(x => String(x.netId) === el.dataset.ne);
    if (t) playNet(t);
  };
  markedEl = null;
  markCurrent();
}

function renderHome() {
  const box = $('#neHome');
  const list = $('#libList');
  const cnt = $('#libCount');
  const h = S.ne.home;
  const d = h.data;
  const loading = h.status === 'loading' || h.status === 'idle';
  const guest = !!d && !d.loggedIn;
  const expired = guest && !!d.hasCookie;

  list.innerHTML = '';          // 首页不使用下面的曲目列表，清掉搜索/歌单残留
  list.onclick = null;

  // 整页失败（账号接口都没通）：只留一条可读原因 + 重试，不要半截界面
  if (h.status === 'error') {
    box.innerHTML = neMsg('歌单加载失败：' + esc(h.err), '<div class="ne-act"><button class="ghost" data-act="refresh">重试</button></div>');
    cnt.textContent = '网易云';
    return;
  }

  const parts = [];

  // 1) 两个推荐入口：卡片常驻，未登录只是不可点
  parts.push('<div class="ne-sec"><span>推荐</span><em>' + (guest ? '登录后可用' : '') + '</em></div>');
  parts.push('<div class="ne-recs">'
    + '<div class="rec' + (guest ? ' off' : '') + '" data-act="daily">'
    + '<div class="ri">' + ICON_SUN + '</div><div class="rt">每日推荐</div>'
    + '<div class="rd">' + (guest ? '扫码登录后每天更新' : '按你的口味生成 · 每天更新') + '</div></div>'
    + '<div class="rec' + (guest ? ' off' : '') + '" data-act="fm">'
    + '<div class="ri">' + ICON_FM + '</div><div class="rt">私人FM</div>'
    + '<div class="rd">' + (guest ? '扫码登录后可用' : '无限流 · 每次加载一批') + '</div></div>'
    + '</div>');

  // 2) 推荐歌单：公开接口，未登录也能看，所以它单独成败
  const picked = d && d.picked && d.picked.list;
  parts.push('<div class="ne-sec"><span>推荐歌单</span>' + (picked && picked.length ? '<em>' + picked.length + ' 个</em>' : '') + '</div>');
  if (loading) parts.push(skeletonRows(2));
  else if (picked && picked.length) parts.push(picked.map(p => neRow(p, 'picked')).join(''));
  else if (d && d.pickedError) parts.push(neMsg('推荐歌单加载失败：' + esc(d.pickedError.message)));
  else if (d) parts.push(neMsg('暂时没有推荐歌单。'));

  // 3) 我创建的歌单
  const mineList = d && d.mine && d.mine.list;
  parts.push('<div class="ne-sec"><span>我创建的歌单</span>'
    + (mineList ? '<em>' + mineList.length + ' 个</em>' : '')
    + '<button data-act="refresh">刷新</button></div>');

  if (loading) {
    parts.push(skeletonRows(3));
  } else if (guest) {
    parts.push(neMsg(
      expired
        ? '登录已过期，重新扫码后加载你的歌单。'
        : '未登录。扫码后显示这个账号下你创建的歌单、每日推荐和私人FM。',
      neLoginBox
    ));
  } else if (d.mineError) {
    const e = d.mineError;
    const auth = e.code === 'NE_LOGIN_REQUIRED';
    parts.push(neMsg(
      auth ? '登录已过期，重新扫码后加载你的歌单。' : '你的歌单加载失败：' + esc(e.message),
      auth ? neLoginBox : '<div class="ne-act"><button class="ghost" data-act="refresh">重试</button></div>'
    ));
  } else if (mineList && mineList.length) {
    parts.push(mineList.map(p => neRow(p, p.special === 'like' ? 'like' : 'mine')).join(''));
    if (d.mine.subscribed) parts.push('<div class="ne-foot">已隐藏 ' + d.mine.subscribed + ' 个收藏的歌单 · 这里只列你自己创建的</div>');
  } else {
    parts.push(neMsg('这个账号还没有创建歌单，可以在网易云 App 里新建后再刷新。'));
  }

  box.innerHTML = parts.join('');
  cnt.textContent = mineList ? mineList.length + ' 个歌单' : '网易云';
  fillCovers(box);
}

function renderColl() {
  const c = S.ne.coll;
  const box = $('#neHome');
  const list = $('#libList');
  const cnt = $('#libCount');

  box.innerHTML = '<button class="ne-back" data-act="back">'
    + '<svg viewBox="0 0 16 16"><path d="M9.6 3.4L5 8l4.6 4.6"/></svg>返回歌单</button>'
    + '<div class="ne-head"><div class="ne-title"><b>' + esc(c.name) + '</b><small>' + esc(c.sub || '') + '</small></div>'
    + (c.kind === 'fm' ? '<button class="ne-mini" data-act="fm">换一批</button>' : '')
    + '</div>';

  if (c.status === 'loading') {
    list.innerHTML = emptyRow('正在读取…');
    list.onclick = null;
    cnt.textContent = '网易云';
    return;
  }
  if (c.status === 'error') {
    const auth = c.err && c.err.code === 'NE_LOGIN_REQUIRED';
    list.innerHTML = emptyRow(auth
      ? '登录已过期，重新扫码后再试。' + neLoginBox
      : '读取失败：' + esc((c.err && c.err.message) || '未知原因') + '<br>返回后重新打开，或稍后再试。');
    list.onclick = null;
    cnt.textContent = '网易云';
    return;
  }
  if (!c.tracks.length) {
    list.innerHTML = emptyRow(c.kind === 'fm' ? '私人FM 这次没有返回曲目，点「换一批」再试。' : '这个歌单是空的。');
    list.onclick = null;
    cnt.textContent = '网易云';
    return;
  }

  list.innerHTML = c.tracks.map(t => itemHTML(t, null)).join('');
  fillThumbs(list);
  cnt.textContent = '点击播放并加入曲库';    // 数量已经在标题下写了，这里不再重复
  list.onclick = e => {
    const el = e.target.closest('.item');
    if (!el) return;
    const t = c.tracks.find(x => String(x.netId) === el.dataset.ne);
    if (t) playNet(t);
  };
  markedEl = null;
  markCurrent();
}

const NE_ORIGIN = { like: '我喜欢的音乐', picked: '推荐歌单', mine: '我创建的歌单' };

async function neOpenColl(kind, id, name, origin) {
  const seq = ++S.ne.collSeq;
  S.ne.view = 'coll';
  S.ne.coll = {
    kind, id,
    name: name || (kind === 'daily' ? '每日推荐' : kind === 'fm' ? '私人FM' : '歌单'),
    sub: kind === 'playlist' ? (NE_ORIGIN[origin] || '歌单') : '',
    status: 'loading', err: null, tracks: []
  };
  renderNet();

  let r;
  try {
    if (kind === 'daily') r = await window.api.neDaily();
    else if (kind === 'fm') r = await window.api.neFm(8);
    else r = await window.api.nePlaylist(id);
  } catch (e) { r = { ok: false, error: { code: 'NE_ERROR', message: String((e && e.message) || e) } }; }
  if (seq !== S.ne.collSeq) return;          // 期间返回/又开了别的，旧结果丢掉

  if (!r || !r.ok) {
    S.ne.coll.status = 'error';
    S.ne.coll.err = (r && r.error) || { code: 'NE_ERROR', message: '读取失败' };
    if (S.ne.coll.err.code === 'NE_LOGIN_REQUIRED') {
      // 登录失效：顺手把首页也标成过期，否则用户会以为只是这个歌单坏了
      S.ne.loggedIn = false;
      paintNeNote();
      S.ne.home = { status: 'idle', err: '', data: null };
      neEnsureHome(true);
    }
    renderNet();
    return;
  }

  const tracks = r.tracks || [];
  S.ne.coll.tracks = tracks;
  S.ne.coll.status = 'ready';
  if (kind === 'playlist') {
    S.ne.coll.name = r.name || S.ne.coll.name;
    S.ne.coll.id = r.id || id;
    S.ne.coll.sub = `${r.count || tracks.length} 首 · ${NE_ORIGIN[origin] || '歌单'}`;
  } else if (kind === 'daily') {
    S.ne.coll.sub = `${tracks.length} 首 · ${r.day || '今天'}`;
  } else {
    S.ne.coll.sub = `${tracks.length} 首 · 每次换一批`;
  }
  renderNet();
}

/* 抽屉里所有带 data-act 的元素都从这里派发（首页与列表容器是兄弟节点，
 * 必须在共同父级上委托，否则歌单详情里的按钮会收不到点击）。 */
function onNeAction(e) {
  const el = e.target.closest('[data-act]');
  if (!el || !$('#dLib').contains(el)) return;
  const act = el.dataset.act;

  if (act === 'login') { neGotoLogin(); return; }
  if (act === 'refresh') { neEnsureHome(true); return; }
  if (act === 'back') {
    S.ne.collSeq++;
    S.ne.coll = null;
    S.ne.view = 'home';
    neEnsureHome();
    renderNet();
    return;
  }
  if (act === 'daily' || act === 'fm') {
    const d = S.ne.home.data;
    if (!d) { neEnsureHome(true); return; }            // 还没拿到数据（或刚好失败）
    if (!d.loggedIn) {
      toast('扫码登录后才能用' + (act === 'daily' ? '每日推荐' : '私人FM'));
      neGotoLogin();
      return;
    }
    neOpenColl(act, 0, act === 'daily' ? '每日推荐' : '私人FM', '');
    return;
  }
  if (act === 'pl') {
    const id = Number(el.dataset.id);
    if (!id) return;
    neOpenColl('playlist', id, el.dataset.name || '', el.dataset.origin || 'mine');
  }
}

function neGotoLogin() {
  openDrawer($('#dSet'));
  if (!qrShown()) setTimeout(qrStart, 80);
}

/** 加入曲库（去重），返回下标；不排序，保持用户点选/歌单的原始顺序 */
function addTrack(t) {
  if (!t || !t.path) return -1;
  const i = S.tracks.findIndex(x => x.path === t.path);
  if (i >= 0) return i;
  S.tracks.push(t);
  S.libIndex.set(t.path, t);        // 队列靠这张表解析曲目，新加的必须立刻可用
  return S.tracks.length - 1;
}

async function playNet(t) {
  const fresh = !S.tracks.some(x => x.path === t.path);
  const i = addTrack(t);
  if (i < 0) return;
  S.libDirty = true;
  if (S.srcMode === 'local') renderLibrary();
  persistLibrary();
  if (fresh) toast(`已加入曲库 · ${t.title}`);
  await playIndex(i);
}

async function openNeLink() {
  const el = $('#neLink');
  const v = (el.value || '').trim();
  if (!v) { toast('先粘贴链接或 ID'); return; }

  el.disabled = true;
  let r;
  try { r = await window.api.neLink(v); }
  catch (e) { r = { ok: false, error: { message: String(e && e.message || e) } }; }
  if (!r || !r.ok) {
    el.disabled = false;
    toast('链接解析失败：' + ((r && r.error && r.error.message) || '未知原因'));
    return;
  }
  if (!r.link) {
    el.disabled = false;
    toast('没认出链接 · 支持歌曲 / 歌单 / 专辑');
    return;
  }

  if (r.link.kind === 'song') {
    let d;
    try { d = await window.api.neSongs([r.link.id]); }
    catch (e) { d = { ok: false, error: { message: String(e && e.message || e) } }; }
    el.disabled = false;
    if (!d || !d.ok) { toast('读取失败：' + ((d && d.error && d.error.message) || '')); return; }
    if (!d.tracks || !d.tracks.length) { toast('没找到这首歌（可能已下架）'); return; }
    el.value = '';
    await playNet(d.tracks[0]);
    return;
  }

  toast(r.link.kind === 'playlist' ? '正在读取歌单…' : '正在读取专辑…', 0);
  let d;
  try {
    d = r.link.kind === 'playlist'
      ? await window.api.nePlaylist(r.link.id)
      : await window.api.neAlbum(r.link.id);
  } catch (e) { d = { ok: false, error: { message: String(e && e.message || e) } }; }
  el.disabled = false;
  if (!d || !d.ok) { toast('读取失败：' + ((d && d.error && d.error.message) || '')); return; }
  if (!d.tracks || !d.tracks.length) { toast('这个' + (r.link.kind === 'playlist' ? '歌单' : '专辑') + '是空的'); return; }

  el.value = '';
  const n = mergeTracks(d.tracks, { sort: false, silent: true });
  setSource('local');       // 导入后直接看曲库，比自己再切一次顺
  toast(`${r.link.kind === 'playlist' ? '歌单' : '专辑'}「${d.name}」· 共 ${d.count || d.tracks.length} 首${n ? `，新增 ${n} 首` : '，已全部在曲库中'}`, 3200);
}

function renderMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const k = curTrack();
  if (!k) return;
  try {
    const cov = getCover(k.path);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: k.title || '', artist: k.artist || '', album: k.album || '',
      artwork: cov ? [{ src: cov, type: 'image/jpeg' }] : []   // 不谎报尺寸，交给系统自己读
    });
  } catch {}
}

/* ------------------------------------------------------------------ 播放 */
/*
 * 每次切歌递增一个序号。playIndex 里每一步 await 之后都校验序号，
 * 被后来的请求取代就静默退出 —— 否则旧请求的 play() 会以 AbortError 拒绝，
 * 被当成"无法播放"弹出来（连点下一首时必现）。
 */
let loadSeq = 0;
let errStreak = 0;    // 连续解码失败计数：坏文件跳过去，连续 3 次才停

function setLyrHint(k, ly) {
  const el = $('#lyrEmpty');
  if (!el) return;
  const note = (ly && ly.note) || '';
  el.textContent = note || (isNet(k) ? '该曲目暂无歌词' : '暂无歌词 · 同目录放置同名 .lrc 即可');
}

/* 「开始播放」同样要有上限。
 *
 * 上游卡住时 audio.play() 的 Promise 既不 resolve 也不 reject —— 媒体元素只发了
 * loadstart + stalled，不会派发 error —— playIndex 就永远停在 await 上：
 * 封面停在「正在加载封面…」、进度条不走，也就是「界面卡在加载态」。
 * 给它一个上限，超时按「加载失败」处理，走和 media error 一样的「跳过并提示」。 */
const PLAY_TIMEOUT = 15000;

function playGuarded(ms = PLAY_TIMEOUT) {
  const p = audio.play();
  p.catch(() => {});          // 超时之后它仍可能 reject（被 pause 打断），先挂个空处理
  let timer = 0;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => {
      const e = new Error('play timeout');
      e.name = 'TimeoutError';   // 和真错误区分开，调用方据此走「跳过」而不是「换格式」
      rej(e);
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/* 播放队列第 qi 项。opts = { seekTo, autoplay }。
 * 队列行可能没有曲目对象（列表里的歌已从曲库删掉），这种行直接跳过，
 * 不打断正在播的音频 —— 见 skipDead()。 */
async function playAt(qi, opts) {
  if (qi < 0 || qi >= S.q.length) return;
  const k = qTrack(qi);
  if (!k) return skipDead(qi, opts);
  const seq = ++loadSeq;
  const net = isNet(k);
  const bilT = isBil(k);
  const autoplay = !opts || opts.autoplay !== false;

  /* 网易云：先在「不改任何状态」的前提下确认地址可用。
   * 早先的写法是先 S.i = i 再预检，遇到不可播放的曲目就会出现
   * 「音频还在放上一首、状态栏已经指向新歌」的错位。现在失败时
   * 当前曲目与播放状态原样保留，只弹一条提示（必要时自动跳下一首）。 */
  let info = null;
  if (net) {
    try { info = await window.api.neUrl(netIdOf(k), curQuality()); }
    catch (e) { info = { ok: false, error: { code: 'NE_NET', message: String((e && e.message) || e) } }; }
    if (seq !== loadSeq) return;

    if (!info || !info.ok) {
      const code = (info && info.error && info.error.code) || '';
      const reason = code === 'NE_UNAVAILABLE'
        ? (k.fee === 1 || k.fee === 4 ? '需会员' : '无版权')
        : code === 'NE_TIMEOUT' ? '网络超时' : '暂时无法播放';
      k.unavailable = reason;
      if (S.settings.playMode === 'shuffle') markShufFail(k.path);
      toast(`无法播放：${k.title}（${reason}）`);
      if (S.q.length > 1 && errStreak < 3) {
        errStreak++;
        const ni = stepIndex(1, qi);
        if (ni >= 0) playAt(ni);
      } else if (S.i === qi) {
        paintMeta();          // 只有本来就停在这首上，才需要刷新它的状态显示
      }
      return;
    }
    k.unavailable = '';
  } else if (bilT) {
    /* 哔哩哔哩：搜索阶段只有 bvid，cid 要在这里补。
     * 补齐后立刻把 path 改成 bil:<bvid>:<cid>，下面 mediaUrl 才能拼出正确地址。 */
    try { info = await window.api.bilUrl(k.bilBvid, k.bilCid); }
    catch (e) { info = { ok: false, error: { code: 'BIL_NET', message: String((e && e.message) || e) } }; }
    if (seq !== loadSeq) return;

    if (!info || !info.ok) {
      const code = (info && info.error && info.error.code) || '';
      const reason = code === 'BIL_NO_AUDIO' ? '没有可用音轨'
        : code === 'BIL_403' ? '接口被风控'
          : code === 'BIL_TIMEOUT' ? '网络超时' : '暂时无法播放';
      k.unavailable = reason;
      if (S.settings.playMode === 'shuffle') markShufFail(k.path);
      toast(`无法播放：${k.title}（${reason}）`);
      if (S.q.length > 1 && errStreak < 3) {
        errStreak++;
        const ni = stepIndex(1, qi);
        if (ni >= 0) playAt(ni);
      } else if (S.i === qi) {
        paintMeta();
      }
      return;
    }
    if (info.cid) patchBilCid(qi, k, info.cid);
    k.unavailable = '';
  }

  S.i = qi;
  // 随机模式下，「手点」或自动续播落到的那首也算本轮已播：
  // 否则本轮洗牌里还能再抽到它，听感就是「随机又切回刚才那首」。
  if (S.settings.playMode === 'shuffle') {
    S.shufDone.add(k.path);
    S.shufPool.delete(k.path);
  }

  S.lyrics = [];
  S.lyricSrc = '';
  renderLyrics();
  setLyrHint(k, null);
  paintMeta();
  markCurrent();

  if (net || bilT) {
    if (info.codec) k.codec = info.codec;
    if (info.bitrate) k.bitrate = info.bitrate;
    if (typeof info.lossless === 'boolean') k.lossless = info.lossless;
    k.level = info.level || '';
    k.downgraded = !!info.downgraded;
    S.libDirty = true;
    paintMeta();
  }

  const url = await window.api.mediaUrl(k.path);
  if (seq !== loadSeq) return;

  audio.src = url;
  audio.load();
  audio.volume = S.settings.volume;
  audio.muted = !!S.settings.muted;
  if (!autoplay) {
    /* 恢复上次进度：只把播放头摆好，不出声。seek 必须等元数据到位，
     * 否则 currentTime 会被浏览器丢掉（duration 还是 NaN）。 */
    S.playing = false;
    syncPlayIcon();
    const seekTo = opts && Number(opts.seekTo);
    if (Number.isFinite(seekTo) && seekTo > 0) {
      const apply = () => {
        try { audio.currentTime = Math.min(seekTo, Math.max(0, (audio.duration || 0) - 0.5)); } catch {}
        syncClock();
        updateLyric();
      };
      if (audio.readyState >= 1) apply();
      else audio.addEventListener('loadedmetadata', apply, { once: true });
    }
  } else try {
    await playGuarded();
    if (seq !== loadSeq) return;
  } catch (e) {
    if (seq !== loadSeq || e.name === 'AbortError') return;   // 被自己人打断，不是错误
    if (e.name === 'TimeoutError') {
      /* 卡住了：先停下这次加载（下面的 src 变更也会中止它），再按「跳过并提示」处理。
       * 不这么做的话就一直停在「正在加载封面…」，用户只能重启软件。 */
      audio.pause();
      toast(`加载超时，已跳过：${k.title || '该曲目'}`);
      if (S.q.length > 1 && errStreak < 3) {
        errStreak++;
        const ni = stepIndex(1, qi);
        if (ni >= 0) return playAt(ni);
      }
      setCoverEmpty('暂无封面', '加载超时 · 换个音质或稍后重试');
      paintMeta();
      return;
    }
    toast('无法播放：' + (k.title || '该曲目')
      + (net ? '（网易云加载失败）' : `（${k.codec || '未知格式'} 可能不被支持）`));
  }

  // 封面 + 主色（每步都要确认自己还是"当前"的那次请求）
  try {
    let art = null;
    if (net || bilT) {
      art = await loadArt(k);
    } else if (/^(kg|qq):/.test(String(k.path || ''))) {
      /* 上游曲目没有本地文件，别去问 trackDetail（它会回「元数据读取失败」，
       * 界面就顶着一行红字）。封面与码率一起从上游拿。 */
      try {
        const m = await window.api.accMeta(k.path, k.albumMid);
        if (m && m.ok) {
          art = m.cover || null;
          if (m.codec) k.codec = m.codec;
          if (m.bitrate) { k.bitrate = m.bitrate; S.libDirty = true; }
        }
      } catch {}
    } else {
      const detail = await window.api.trackDetail(k.path);
      if (seq !== loadSeq) return;
      k.error = detail.error;
      if (detail.duration && detail.duration !== k.duration) {
        k.duration = detail.duration;
        S.libDirty = true;
        updateRowDuration(k);
      }
      art = detail.cover || null;
    }
    if (seq !== loadSeq) return;

    /* 上游曲目（kg: / qq:）没有「详情」接口，封面单独问一次上游；
     * 歌词不在这里处理 —— track:lyric 已经按同样前缀路由。 */
    if (!art && /^(kg|qq):/.test(String(k.path || ''))) {
      try {
        const meta = await window.api.accMeta(k.path, k.albumMid);
        if (meta && meta.ok && meta.cover) art = meta.cover;
      } catch { /* 封面拿不到就用兜底 */ }
    }
    if (seq !== loadSeq) return;
    if (art) {
      setCover(k.path, art);
      const c = await accentFrom(art);
      if (seq !== loadSeq) return;
      setAccent(c || NEUTRAL);
    } else {
      setAccent(NEUTRAL);
    }
    if (S.i === qi && seq === loadSeq) paintMeta();
    renderMediaSession();
  } catch {}

  // 歌词
  try {
    const ly = await window.api.trackLyric(k.path);
    if (seq !== loadSeq) return;
    S.lyrics = buildLyrics(ly);
    S.lyricSrc = ly.source || '';
    setLyrHint(k, ly);
    renderLyrics();
    if (S.lyrics.length) setTimeout(() => { if (seq === loadSeq) centerLine(0); }, 60);
    renderFmtPopover();
    const qt = new URLSearchParams(location.search).get('t');
    if (qt) setTimeout(() => { audio.currentTime = Number(qt); updateLyric(); }, 400);
  } catch {}

  if (seq !== loadSeq) return;
  applyTheme();
}

function syncPlayIcon() {
  $('#icPlay').style.display = S.playing ? 'none' : 'block';
  $('#icPause').style.display = S.playing ? 'block' : 'none';
}

function togglePlay() {
  if (!S.q.length) { toast(S.settings.playlist.length ? '播放列表里的歌都不在曲库了' : '播放列表是空的 · 先去「选择歌单」或「插入歌曲」'); return; }
  if (S.i < 0) { playAt(0); return; }
  if (S.playing) { audio.pause(); return; }
  if (audio.ended) audio.currentTime = 0;
  audio.play().catch(e => {
    if (e.name !== 'AbortError') toast('无法播放：' + ((curTrack() && curTrack().codec) || '未知格式'));
  });
}

/* ---------------------------------------------------------------- 索引推进
 * 所有「下一首 / 上一首 / 播完自动续」都从这里取下标，避免三处各写一套导致行为打架。
 * 返回 -1 = 没有下一首（顺序模式到末尾、随机池空、历史栈空）。
 */
const MODES = ['seq', 'one', 'shuffle'];
const MODE_META = {
  seq: { name: '顺序播放', icon: 'icSeq' },
  one: { name: '单曲循环', icon: 'icOne' },
  shuffle: { name: '随机播放', icon: 'icShuffle' }
};

function stepIndex(dir = 1, from = S.i) {
  const n = S.q.length;
  if (!n) return -1;
  const mode = S.settings.playMode;
  if (mode === 'shuffle') return dir < 0 ? shufBack() : shufNext();
  if (from < 0) return dir > 0 ? 0 : n - 1;   // 还没开始播：向下取第一首，向上取最后一首
  const ni = from + dir;
  if (ni < 0 || ni >= n) return -1;           // 顺序模式不回绕：到末尾就停，由用户决定
  return ni;
}

/* 队列行指向一首曲库里没有的歌时（本地文件删了 / 挪走了）：
 * 随机模式必须继续「随机」找下一首，不能按列表顺序往后扫 —— 顺序扫描会反复落到
 * 同一批可播的邻居上，听感就是「在两三首之间来回跳」。顺序模式才按列表往下找，
 * 最多绕一圈；都找不到就停下并说明，不要静默卡住。 */
async function skipDead(qi, opts) {
  const n = S.q.length;
  if (S.settings.playMode === 'shuffle') {
    for (let i = 0; i < n; i++) {
      const ni = shufNext();
      if (ni < 0) break;
      if (qTrack(ni)) return playAt(ni, opts);
    }
  }
  for (let step = 1; step <= n; step++) {
    const cand = (qi + step) % n;
    if (cand === qi) break;
    if (qTrack(cand)) return playAt(cand, opts);
  }
  toast('播放列表里的歌都不在曲库里了 · 重新导入或换个歌单');
  S.playing = false;
  syncPlayIcon();
  paintMeta();
}

/* 曲库行的「播放」：不在列表里就插到当前曲之后，再跳过去播；已在列表就直接跳。
 * 名字沿用 playIndex（参数是曲库下标），探针与网易云入口都从这里进。 */
async function playIndex(libIdx) { return playLibRow(libIdx); }

async function playLibRow(libIdx) {
  const t = S.tracks[libIdx];
  if (!t) return;
  const at = S.q.findIndex(x => x.id === t.path);
  if (at >= 0) return playAt(at);
  const qi = plInsertAfterCurrent(t);
  if (qi >= 0) return playAt(qi);
}

/* 把一首歌插到当前曲之后（列表空则放第一首），返回它在队列里的下标。
 * 已在列表里就不重复插，直接返回已有位置。 */
function plInsertAfterCurrent(t) {
  const item = plToItem(t);
  const list = plItems();
  const at0 = list.findIndex(x => x.id === item.id);
  if (at0 < 0) {
    const at = S.i >= 0 && S.i < list.length ? S.i + 1 : list.length;
    list.splice(at, 0, item);
    S.settings.playlist = list;
    plSave();
    rebuildQueue('id');
  }
  return S.q.findIndex(x => x.id === item.id);
}

function next() {
  const i = stepIndex(1);
  if (i >= 0) playAt(i);
  else if (S.settings.playMode === 'seq' && S.q.length) toast('已经是最后一首');
}
function prev() {
  if (!S.q.length) { toast('播放列表是空的'); return; }
  if (S.i >= 0 && audio.currentTime > 3) { audio.currentTime = 0; return; }
  const i = stepIndex(-1);
  if (i >= 0) playAt(i);
  else if (S.settings.playMode === 'seq') toast('已经是第一首');
}

/* 播放模式：三态一键循环 seq → one → shuffle → seq。
 * 切模式只改偏好，不碰 audio.src / 不 seek / 不动 S.i，所以不会打断播放。 */
function cycleMode() {
  const at = MODES.indexOf(S.settings.playMode);
  S.settings.playMode = MODES[(at + 1) % MODES.length];
  syncModeBtn();
  toast(MODE_META[S.settings.playMode].name);
  saveSettings();
}

function syncModeBtn() {
  if (!MODES.includes(S.settings.playMode)) S.settings.playMode = 'seq';
  const meta = MODE_META[S.settings.playMode];
  for (const m of MODES) {
    const el = $('#' + MODE_META[m].icon);
    if (el) el.style.display = m === S.settings.playMode ? 'block' : 'none';
  }
  const btn = $('#btnMode');
  if (btn) {
    btn.classList.toggle('on', S.settings.playMode !== 'seq');
    btn.classList.toggle('off', S.settings.playMode === 'seq');
    btn.title = meta.name + ' (R)';
    btn.setAttribute('aria-label', meta.name);
  }
  const row = $('#setMode');
  if (row) row.textContent = meta.name;
}

/* 播放位置：只记「哪首 + 到哪秒」，5 秒节流，暂停和关窗时补一次。 */
let posClock = 0;
function persistPos(force) {
  const k = curTrack();
  if (!k) { S.settings.playPos = null; return; }
  const now = performance.now();
  if (!force && now - posClock < 5000) return;
  posClock = now;
  S.settings.playPos = { id: k.path, t: audio.currentTime || 0 };
  saveSettings();
}

/* 旧配置只有 shuffle + repeat 两个开关，换成单一 playMode。
 * 优先级：显式 playMode > 开着随机 > 单曲循环 > 顺序。
 * repeat:'all'（列表循环）落到 seq —— 新模型里顺序播到末尾就停，这是有意的行为变化。 */
function migratePlayMode(saved) {
  const has = key => Object.prototype.hasOwnProperty.call(saved, key);
  if (saved.playMode && MODES.includes(saved.playMode)) return saved.playMode;
  if (has('shuffle') && saved.shuffle === true) return 'shuffle';
  if (has('repeat') && saved.repeat === 'one') return 'one';
  return 'seq';
}

/* 启动时把播放头摆到上次的位置，但不出声：自动播放会跟用户的预期打架，
 * 也容易和系统媒体控件抢焦点。 */
function restorePos() {
  if (!S.q.length) { S.i = -1; return; }
  const pos = S.settings.playPos;
  let qi = pos && pos.id ? S.q.findIndex(x => x.id === pos.id) : -1;
  const seekTo = qi >= 0 ? (Number(pos.t) || 0) : 0;
  if (qi < 0) qi = 0;
  return playAt(qi, { autoplay: false, seekTo });
}

/* 读不到设置（磁盘只读 / IPC 异常）时的兜底：界面必须能开，不能因为一份配置白屏 */
const FALLBACK_SETTINGS = {
  theme: 'auto', volume: 0.78, sinkId: '', muted: false,
  lat: 31.2304, lon: 121.4737, city: '上海', globalKeys: true, quality: 'exhigh',
  lyricTrans: true, playlist: [], playMode: 'seq', playPos: null
};

function seek(delta) {
  const d = audio.duration;
  // 没有曲目时 duration 是 NaN：clamp(…, 0, NaN) 还是 NaN，写进 currentTime 会抛
  // InvalidStateError，方向键就变成「按一下就报错」。
  if (!Number.isFinite(d) || d <= 0) return;
  const t = audio.currentTime || 0;
  audio.currentTime = clamp(t + delta, 0, d);
}

/* ------------------------------------------------------------------ 输出设备 */
async function loadDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    S.devices = all.filter(d => d.kind === 'audiooutput');
  } catch { S.devices = []; }
  const list = $('#devList');
  if (!S.devices.length) {
    list.innerHTML = '<div class="pop-row"><span>未发现输出设备</span></div>';
  } else {
    list.innerHTML = S.devices.map((d, i) =>
      `<div class="pop-row" data-id="${esc(d.deviceId)}"><span>${esc(d.label || '输出设备 ' + (i + 1))}</span><span>${d.deviceId === (S.settings.sinkId || '') ? '✓' : ''}</span></div>`
    ).join('');
    $$('#devList .pop-row').forEach(el => {
      el.onclick = async () => {
        const id = el.dataset.id;
        try {
          await audio.setSinkId(id || '');
          S.settings.sinkId = id;
          saveSettings();
          $('#setDev').textContent = el.firstChild.textContent;
          toast('已切换到 ' + el.firstChild.textContent);
          loadDevices();
          closePops();
        } catch (e) { toast('切换失败：' + e.message); }
      };
    });
  }
  $('#devNote').textContent = S.devices.length
    ? '设备列表与切换由 Chromium 的 setSinkId 完成，是真实路由；采样率与独占模式无法在网页层查询或控制。'
    : '系统未暴露输出设备。';
  const cur = S.devices.find(d => d.deviceId === S.settings.sinkId);
  $('#setDev').textContent = cur ? cur.label : '系统默认';
}

/* ------------------------------------------------------------------ 弹层 */
function closePops() {
  $$('.pop').forEach(p => {
    p.classList.remove('show');
    if (popRO) popRO.unobserve(p);
  });
  // 播放列表入口的高亮与内部页签跟着一起复位：下次打开总是从列表页开始
  const btn = $('#btnPl');
  if (btn) btn.classList.remove('open');
  PL.view = 'list';
  PL.ask = null;
}

/* 弹层尺寸不是常量：字体加载完成后文字会变宽，内容超高又多出一条滚动条。
 * 只在打开那一刻算一次位置，就会出现「右边贴着窗口」或者「底部出屏」。
 * 所以用 ResizeObserver 盯住面板本身，尺寸一变就重新贴边。 */
let popRO = null;

function placePop(pop) {
  const anchor = pop._anchor;
  if (!anchor || !pop.classList.contains('show')) return;
  if (typeof pop._place === 'function') { pop._place(pop, anchor); return; }   // 自定义贴边（播放列表）
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  /* 用 clientWidth/Height 而不是 innerWidth/Height：后者含页面纵向滚动条的宽度，
   * 面板会正好压在滚动条下面（最右边 12px 被吃掉，看着像被窗口切掉了）。 */
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const left = clamp(r.left + r.width / 2 - w / 2, 12, Math.max(12, vw - w - 12));

  let top = r.top - h - 10;
  if (top < 70) top = r.bottom + 10;          // 上面放不下就翻到下方
  // 面板比窗口还高时，上面两步都会把 top 推到屏幕外；这里再夹一次，
  // 配合 .pop 的 max-height + overflow，窗口再小也能完整看到面板内容。
  top = clamp(top, 12, Math.max(12, vh - h - 12));

  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

/* 播放列表的贴边规则和其它弹层不同：左对齐到入口按钮，底边压在整个控制栏之上，
 * 这样面板再长也不会盖住播放键与进度条（歌词区是临时被盖一下，点条目就关）。 */
function placePl(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const ctrl = $('.ctrl');
  const footTop = (ctrl ? ctrl.getBoundingClientRect().top : r.top) - 12;
  pop.style.left = clamp(r.left, 12, Math.max(12, vw - w - 12)) + 'px';
  pop.style.top = clamp(footTop - h, 12, Math.max(12, vh - h - 12)) + 'px';
}

function openPop(pop, anchor) {
  const wasOpen = pop.classList.contains('show');
  closePops();
  if (wasOpen) return;
  pop.classList.add('show');
  pop._anchor = anchor;
  placePop(pop);                              // 先摆一次，再交给 ResizeObserver 兜后续尺寸变化
  if (!popRO) {
    /* 回调里直接改 left/top 会触发下一轮布局，Chromium 会报
     * 「ResizeObserver loop completed with undelivered notifications」——
     * 挪到下一帧改就绕开了这个自反馈。 */
    popRO = new ResizeObserver(list => {
      for (const e of list) {
        const p = e.target;
        if (p._raf) continue;
        p._raf = requestAnimationFrame(() => { p._raf = 0; placePop(p); });
      }
    });
  }
  popRO.observe(pop);
}
function closeDrawers() {
  $$('.drawer').forEach(d => d.classList.remove('show'));
  $('#scrim').classList.remove('show');
  qrStop();                       // 抽屉一关就不再轮询，别让请求在后台空转
}
function openDrawer(el) {
  closeDrawers();
  el.classList.add('show');
  $('#scrim').classList.add('show');
  if (el.id === 'dLib') {
    renderLibrary();
    if (S.srcMode === 'net') neEnsureHome();     // 抽屉一开就先把歌单准备好，别等看到空白再加载
    setTimeout(() => $('#q').focus(), 120);
  }
  // 设置重新打开时，如果二维码面板还开着就换一张新码：旧 key 很可能已经过期
  else if (el.id === 'dSet') {
    if (qrShown()) setTimeout(qrStart, 60);
    /* 重启后是「先恢复凭证、后补验」：这一段回来时设置面板往往已经画过了，
     * 所以打开面板就再取一次状态，否则会一直显示上一次的「未登录」。 */
    updateBilNote();
    if (S.srcMode === 'bil') bilEnsureFavs();
    /* 播放账号（QQ 音乐 App / 酷狗）：面板是懒挂载的，第一次打开设置才建卡片 */
    if (window.AccountPanel) window.AccountPanel.mount($('#accCards'));
  }
}

/* ------------------------------------------------------------------ 设置 */
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.api.setSettings(S.settings), 200);
}
/* 关窗口时把防抖窗口里还没落盘的那一笔补上 */
function flushSettings() {
  clearTimeout(saveTimer);
  try { window.api.setSettingsSync(S.settings); } catch {}
  if (S.libDirty) {
    S.libDirty = false;
    try { window.api.setLibrarySync(S.tracks.map(stripHeavy)); } catch {}
  }
}

async function registerGlobalKeys() {
  const list = [
    { accel: 'Control+Alt+P', id: 'toggle' },
    { accel: 'Control+Alt+Left', id: 'prev' },
    { accel: 'Control+Alt+Right', id: 'next' },
    { accel: 'Control+Alt+Up', id: 'volUp' },
    { accel: 'Control+Alt+Down', id: 'volDown' }
  ];
  if (!S.settings.globalKeys) { await window.api.clearKeys(); $('#keyState').textContent = '已关闭'; return; }
  const res = await window.api.registerKeys(list);
  const bad = res.filter(r => !r.ok);
  const el = $('#keyState');
  if (bad.length) {
    el.textContent = `${bad.length} 个键位冲突`;
    el.style.color = '#c68a12';
    toast('快捷键冲突：' + bad.map(b => b.accel.replace('Control', 'Ctrl')).join('、'));
  } else {
    el.textContent = '已注册';
    el.style.color = '';
  }
}

/* ------------------------------------------------------------------ 导入 */
const stripHeavy = t => {
  // cover 是 base64 大对象；coverError / unavailable 是本次会话的临时状态，
  // 下次启动应当重新判定，写进磁盘只会让「需会员」这类结论一直挂在那里
  const { cover, coverError, unavailable, ...rest } = t;
  return rest;
};
const persistLibrary = () => window.api.setLibrary(S.tracks.map(stripHeavy));

/**
 * 合并到曲库。
 * opt.sort=false 用于歌单/专辑：导入顺序本身就是信息，按标题重排会把
 * 「第 1 首」变成随机位置。本地文件导入保持原有的按标题排序。
 */
function mergeTracks(scanned, opt = {}) {
  const sort = opt.sort !== false;
  const known = new Set(S.tracks.map(t => t.path));
  let added = 0;
  for (const t of scanned) {
    if (!t || !t.path || known.has(t.path)) continue;
    known.add(t.path);
    delete t.cover;                 // 扫描结果不带封面，这里再兜一次底
    S.tracks.push(t);
    added++;
  }
  // 曲库变了：重建 path→track 表，并把队列里还没解析出来的行补上。
  // 注意 S.i 是队列下标、不是曲库下标，排序前后都不用动它。
  if (added) {
    rebuildLibIndex();
    for (const row of S.q) if (!row.t) row.t = S.libIndex.get(row.id) || null;
    if (sort) S.tracks.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'));
  }
  renderLibrary();
  persistLibrary();
  if (!opt.silent) toast(added ? `已导入 ${added} 首` : '没有新的音频文件');
  if (S.i < 0 && S.tracks.length) playIndex(0);
  return added;
}

/* 扫描期间的进度气泡（终态文案由调用方覆盖） */
let scanTick = { done: 0, total: 0 };
let scanToastActive = false;
let scanning = false;              // 同时只允许一个扫描（主进程也不支持并发）
function scanToastShow() {
  const el = $('#toast');
  clearTimeout(toast._t);
  scanToastActive = true;
  el.classList.add('show', 'act');
  el.textContent = scanTick.total
    ? `正在读取 ${scanTick.done}/${scanTick.total} · 点此停止`
    : '正在扫描曲库…';
}
function scanToastHide() {
  scanToastActive = false;
  $('#toast').classList.remove('act');
}

async function scanPaths(files, dirs) {
  // 主进程同一时间只跑一个扫描：并发调用会直接返回空数组，
  // 上层就会把「正在扫描」误报成「没有新文件」。这里先拦住。
  if (scanning) { toast('正在扫描，请稍候'); return null; }
  scanning = true;
  scanTick = { done: 0, total: 0 };
  scanToastShow();
  let list = null;
  try { list = await window.api.scan(files, dirs); } catch { list = null; }
  finally { scanning = false; scanToastHide(); }
  if (list === null) { toast('扫描失败，请重试'); return null; }
  return list || [];
}

async function addPaths(paths) {
  paths = (paths || []).filter(Boolean);
  if (!paths.length) { toast('没有可导入的音频文件'); return; }
  const list = await scanPaths(paths, []);
  if (!list) return;                    // 正在扫描 / 扫描失败：提示已经给过，不要再叠一句「没有新文件」
  mergeTracks(list);
}

/* ------------------------------------------------------- 播放时钟与逐帧渲染 */
/*
 * audio.currentTime 的更新粒度很粗（约 4Hz），用它直接驱动进度条和歌词，
 * 一秒只跳 4 次，看起来就是卡顿。这里用 performance.now 在两次锚点之间插值，
 * 偏离真实播放时间超过 0.3s 再由真实值拉回，既顺滑又不会累积漂移。
 */
const clock = { base: 0, wall: 0, stalled: false };
function syncClock() {
  clock.base = audio.currentTime || 0;
  clock.wall = performance.now();
}
function clockNow(now) {
  if (audio.paused || audio.seeking || clock.stalled) return audio.currentTime || 0;
  const real = audio.currentTime || 0;
  const guess = clock.base + (now - clock.wall) / 1000;
  if (Math.abs(guess - real) > 0.3) { clock.base = real; clock.wall = now; return real; }
  return guess;
}

/* 进度条与旋钮都只写 transform：width/left 每帧都会触发布局，
 * 而且原来 .fill 上那条 .12s 过渡会让填充永远比歌词慢约 120ms。 */
let rafId = 0, prevPct = -1, prevSec = -1, trackW = 0;
const elFill = () => $('#fill');
const elKnob = () => $('#knob');
function measureScrub() { const el = $('#scrub'); trackW = el ? el.clientWidth : 0; }

function frame(now) {
  rafId = requestAnimationFrame(frame);
  const t = clockNow(now);
  const d = audio.duration || 0;
  if (d) {
    const p = Math.min(1, t / d);
    if (prevPct < 0 || Math.abs(p - prevPct) >= 0.0004) {   // 0.04% ≈ 半像素，够细但不浪费
      prevPct = p;
      if (!trackW) measureScrub();
      elFill().style.transform = 'scaleX(' + p.toFixed(4) + ')';
      elKnob().style.transform = 'translate3d(' + (p * trackW - 5).toFixed(1) + 'px,0,0)';
    }
  }
  if (!S.seekDrag) {
    const sec = Math.floor(t);
    if (sec !== prevSec) { prevSec = sec; $('#bub').textContent = fmt(t); }
  }
  updateLyric(t);
}

/* ------------------------------------------------------------------ 全屏 */
let isFs = false, fsTimer = 0;

function applyFs(on) {
  isFs = !!on;
  document.body.classList.toggle('fs', isFs);
  $('.app').classList.toggle('fs', isFs);
  $('#wFs').title = isFs ? '退出全屏 (F11)' : '全屏 (F11)';
  if (isFs) pokeFsHint();
  else { $('#fsExit').classList.remove('show'); clearTimeout(fsTimer); }
  // 封面与字号都随视口变了：先把歌词的过渡锁住并逐帧居中，等窗口尺寸稳定
  // 再交还过渡。锁得比尺寸变化久一点（520ms），避免最后一帧 resize 落在解锁之后。
  // 第二个参数 true：这次是「换版」而不是拖动窗口，允许一次短促的推近 + 淡入。
  lockLyricMotion(520, true);
}

function pokeFsHint() {
  const el = $('#fsExit');
  if (!el) return;
  el.classList.add('show');
  clearTimeout(fsTimer);
  fsTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

async function setFullscreen(on) {
  try {
    const state = await window.api.winFullscreen(on);
    applyFs(state);        // 以主进程回报的状态为准，连点也不会错位
  } catch { /* 窗口已销毁时忽略 */ }
}
function toggleFullscreen() { setFullscreen(!isFs); }

/* ------------------------------------------------------------------ 事件 */
function bind() {
  // 窗口
  $('#wMin').onclick = () => window.api.winMin();
  $('#wMax').onclick = () => window.api.winMax();
  $('#wClose').onclick = () => window.api.winClose();
  $('#drag').ondblclick = () => window.api.winMax();
  $('#wFs').onclick = () => toggleFullscreen();
  $('#fsExit').onclick = () => setFullscreen(false);
  // 鼠标一动就浮出「退出全屏」，静置 2.2 秒后自动淡出，不长期占画面
  window.addEventListener('mousemove', () => { if (isFs) pokeFsHint(); });

  // 抽屉
  $('#btnLib').onclick = () => openDrawer($('#dLib'));
  $('#btnSet').onclick = () => openDrawer($('#dSet'));
  $$('[data-close]').forEach(b => b.onclick = closeDrawers);
  $('#scrim').onclick = closeDrawers;

  $('#btnAddFiles').onclick = async () => {
    const f = await window.api.pickFiles();
    closeDrawers();
    addPaths(f);
  };
  $('#btnAddFolder').onclick = async () => {
    const d = await window.api.pickFolder();
    closeDrawers();
    if (!d.length) return;
    const list = await scanPaths([], d);
    if (list) mergeTracks(list);
  };
  /* 每敲一个字符就重绘整个列表，在几千首时输入法会掉字；这里加一层防抖。
   * 网易云走网络，防抖拉长到 380ms，避免每个字符都打一次接口。 */
  let qTimer = 0;
  $('#q').oninput = () => {
    clearTimeout(qTimer);
    if (S.srcMode === 'net') {
      const v = ($('#q').value || '').trim();
      // 一有输入就切到搜索结果，清空则回歌单首页：两种状态互斥，不会叠在一起
      S.ne.view = v ? 'search' : 'home';
      if (!v) {
        S.ne.seq++;
        S.ne.items = [];
        S.ne.busy = false;
        S.ne.err = '';
        renderNet();
        return;
      }
      qTimer = setTimeout(neSearch, 380);
    } else if (S.srcMode === 'bil') {
      const v = ($('#q').value || '').trim();
      if (!v) {
        S.bil.seq++;
        S.bil.items = [];
        S.bil.busy = false;
        S.bil.err = '';
        S.bil.view = 'idle';
        renderBil();
        return;
      }
      qTimer = setTimeout(bilSearch, 380);   // B 站接口有频控，比本地列表等得更久
    } else {
      qTimer = setTimeout(renderLibrary, 110);
    }
  };
  $('#q').onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(qTimer);
    if (S.srcMode === 'net') neSearch();
    else if (S.srcMode === 'bil') bilSearch();
    else renderLibrary();
  };

  // 抽屉里所有 data-act（扫码登录 / 刷新 / 进歌单 / 返回）统一委托到抽屉根节点
  $('#dLib').onclick = onNeAction;

  // 音源切换 / 链接导入
  $$('#segSrc b').forEach(b => {
    b.onclick = () => setSource(b.dataset.s);
  });
  $('#btnNeOpen').onclick = openNeLink;
  $('#neLink').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); openNeLink(); } };

  // 扫描进度 / 点击气泡取消
  if (window.api.onScanProgress) window.api.onScanProgress(p => { scanTick = p || scanTick; if (scanToastActive) scanToastShow(); });
  $('#toast').onclick = () => {
    if (!scanToastActive) return;
    window.api.cancelScan();
    $('#toast').textContent = '正在停止…';
  };

  // 播放控制
  $('#btnPlay').onclick = togglePlay;
  $('#btnNext').onclick = next;
  $('#btnPrev').onclick = prev;

  $('#btnMode').onclick = cycleMode;

  // 弹层
  $('#btnVol').onclick = e => { e.stopPropagation(); openPop($('#popVol'), $('#btnVol')); };
  $('#btnFmt').onclick = e => {
    e.stopPropagation();
    renderFmtPopover();                       // 每次打开都按当前曲目重画，避免旧数据
    openPop($('#popFmt'), $('#btnFmt'));
  };
  // 档位整行可点：切换要真的换流（见 setQuality），不是只改一行字
  $('#qualList').onclick = e => {
    const b = e.target.closest('.qopt');
    if (!b) return;
    e.stopPropagation();                      // 别让弹层的手势监听把面板关掉
    setQuality(b.dataset.q);
  };
  $('#btnDev').onclick = e => { e.stopPropagation(); loadDevices(); openPop($('#popDev'), $('#btnDev')); };
  document.addEventListener('click', e => { if (!e.target.closest('.pop')) closePops(); });

  $('#volRange').oninput = e => {
    S.settings.volume = Number(e.target.value) / 100;
    audio.volume = S.settings.volume;
    S.settings.muted = false;
    audio.muted = false;
    $('#muteMark').classList.remove('on');
    saveSettings();
  };
  $('#muteRow').onclick = () => {
    S.settings.muted = !S.settings.muted;
    audio.muted = S.settings.muted;
    $('#muteMark').classList.toggle('on', S.settings.muted);
    saveSettings();
  };

  // 进度条
  const scrub = $('#scrub');
  let bubW = 0;
  const seekTo = e => {
    const r = scrub.getBoundingClientRect();
    const p = clamp((e.clientX - r.left) / r.width, 0, 1);
    if (audio.duration) audio.currentTime = p * audio.duration;
  };
  const moveBub = e => {
    const r = scrub.getBoundingClientRect();
    const p = clamp((e.clientX - r.left) / r.width, 0, 1);
    const half = (bubW || 0) / 2;
    const x = clamp(p * r.width, half + 2, r.width - half - 2);
    $('#bub').style.left = x + 'px';
    $('#bub').textContent = fmt((audio.duration || 0) * p);
  };
  /* 拖拽态用 .scrubbing 而不是 .drag——.drag 是标题栏拖拽区的样式
     （flex:1 / height:100% / -webkit-app-region:drag），一旦撞上就会
     把进度条从 18px 撑成弹性高度，整个页脚下移。 */
  const endDrag = () => {
    if (!S.seekDrag && !scrub.classList.contains('scrubbing')) return;
    S.seekDrag = false;
    scrub.classList.remove('scrubbing');
  };
  scrub.onpointerdown = e => {
    if (!audio.duration) return;
    S.seekDrag = true;
    bubW = $('#bub').offsetWidth;
    scrub.classList.add('scrubbing');
    try { scrub.setPointerCapture(e.pointerId); } catch {}
    moveBub(e);
    seekTo(e);
  };
  scrub.onpointermove = e => {
    moveBub(e);
    if (S.seekDrag) seekTo(e);
  };
  scrub.onpointerup = endDrag;
  scrub.onpointercancel = endDrag;          // 拖拽被系统打断（Alt+Tab / UAC）时也要复位
  scrub.onlostpointercapture = endDrag;
  /* 指针移到进度条外松开、或窗口失焦时，scrub 上收不到 pointerup，
     拖拽态会一直卡着（时间气泡不再跟随）。补一层全局兜底。 */
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', endDrag);

  // 音频事件：只作为平滑时钟的锚点，不再逐事件驱动界面刷新。
  // 注意不要把 timeupdate 也塞进来——它只有 4Hz，每来一次就把锚点重置到
  // 它那一步的值，插值刚追上又被拽回去，反而会产生周期性的回跳。
  ['loadedmetadata', 'play', 'pause', 'seeking', 'seeked', 'ratechange', 'ended']
    .forEach(ev => audio.addEventListener(ev, syncClock));
  audio.addEventListener('play', () => { S.playing = true; syncPlayIcon(); });
  audio.addEventListener('pause', () => { S.playing = false; syncPlayIcon(); });
  audio.addEventListener('waiting', () => { clock.stalled = true; });
  audio.addEventListener('playing', () => {
    clock.stalled = false;
    errStreak = 0;
    const k = curTrack();
    if (k) S.shufFail.delete(k.path);      // 这轮放出来了，把失败记录清掉
    syncClock();
  });
  /* 播完自动续：单曲循环重播当前；其余交给 stepIndex（顺序到末尾就停，随机一直有下一首） */
  audio.addEventListener('ended', () => {
    if (S.settings.playMode === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    const ni = stepIndex(1);
    if (ni >= 0) { playAt(ni); return; }
    S.playing = false;
    syncPlayIcon();
    persistPos(true);
  });
  audio.addEventListener('timeupdate', () => persistPos(false));
  audio.addEventListener('pause', () => persistPos(true));
  /* 坏文件不能把整条播放链掐断：跳过去继续放，连续失败 3 次才停 */
  audio.addEventListener('error', () => {
    if (!audio.src) return;
    const k = curTrack();
    const name = (k && k.title) || '该曲目';
    if (isNet(k)) k.unavailable = '加载失败';
    if (k && S.settings.playMode === 'shuffle') markShufFail(k.path);   // 连着坏两次就先别抽它
    if (S.q.length > 1 && errStreak < 3) {
      errStreak++;
      toast(isNet(k) ? `跳过：${name}（网易云加载失败）` : `跳过无法播放的曲目：${name}`);
      next();
    } else {
      errStreak = 0;
      S.playing = false; syncPlayIcon();
      toast(isNet(k)
        ? `无法播放：${name}（网易云加载失败）`
        : `无法播放：${name}（${(k && k.codec) || '未知格式'}）`);
    }
    if (k && S.i >= 0) paintMeta();
  });

  // 键盘
  document.addEventListener('keydown', e => {
    const tag = e.target && e.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      || (e.target && e.target.isContentEditable);
    if (typing) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    // 长按空格会变成高频播放/暂停抖动；方向键保留连按快进
    if (e.repeat && e.code !== 'ArrowRight' && e.code !== 'ArrowLeft') return;
    if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); return; }
    if (e.key === 'Escape') {
      if (isFs) { setFullscreen(false); return; }   // 全屏下 Esc 先退全屏，再谈关抽屉
      closeDrawers(); closePops(); return;
    }
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowRight') seek(5);
    else if (e.code === 'ArrowLeft') seek(-5);
    else if (e.code === 'KeyL') $('.app').classList.toggle('no-lyr');
    else if (e.code === 'KeyR') cycleMode();
    else if (e.ctrlKey && e.code === 'KeyO') { e.preventDefault(); $('#btnAddFiles').click(); }
  });

  // 拖放
  const hint = document.createElement('div');
  hint.className = 'drop-hint';
  hint.textContent = '松手导入音频文件 / 文件夹';
  document.body.appendChild(hint);
  let dragDepth = 0;
  const resetDrag = () => { dragDepth = 0; hint.classList.remove('show'); };
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; hint.classList.add('show'); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('dragleave', e => {
    // relatedTarget 为空 = 直接离开了窗口（拖到桌面上松手），必须整体复位
    if (!e.relatedTarget) { resetDrag(); return; }
    if (--dragDepth <= 0) resetDrag();
  });
  window.addEventListener('dragend', resetDrag);
  window.addEventListener('blur', resetDrag);
  window.addEventListener('drop', e => {
    e.preventDefault();
    resetDrag();
    const paths = [...(e.dataTransfer ? e.dataTransfer.files : [])].map(f => window.api.pathOf(f)).filter(Boolean);
    addPaths(paths);
  });

  // 设置项
  $$('#segTheme b').forEach(b => b.onclick = () => {
    S.settings.theme = b.dataset.t;
    applyTheme(); saveSettings();
  });
  const geo = $('#inGeo');
  geo.onchange = commitGeo;
  geo.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); geo.blur(); } };
  $('#swKeys').classList.toggle('on', !!S.settings.globalKeys);
  $('#swKeys').onclick = () => {
    S.settings.globalKeys = !S.settings.globalKeys;
    $('#swKeys').classList.toggle('on', S.settings.globalKeys);
    registerGlobalKeys(); saveSettings();
  };
  /* 歌词翻译：即时生效 —— 只切 body 上的一个类，不动音频、不重发歌词请求。
   * 行高会跟着变，所以顺手把当前句重新居中一次。 */
  $('#swTr').onclick = () => {
    S.settings.lyricTrans = !S.settings.lyricTrans;
    $('#swTr').classList.toggle('on', S.settings.lyricTrans);
    applyTransVisibility(); saveSettings();
  };

  // 网易云：扫码登录。二维码由主进程生成，这里只管开关与状态文案
  $('#btnNeQr').onclick = () => {
    if (qrShown()) qrHide(); else qrStart();
  };
  $('#btnQrRefresh').onclick = () => qrStart();
  $('#qrShot').onclick = () => { if ($('#qrWrap').querySelector('.qrbox.dead')) qrStart(); };
  $('#btnNeLogout').onclick = async () => {
    qrHide();
    try { await window.api.neLogout(); } catch {}
    // 退出必须把上一个账号留下的东西全部丢掉：歌单、头像、打开着的列表
    S.ne.loggedIn = false;
    S.ne.hasCookie = false;
    S.ne.nick = '';
    S.ne.uid = 0;
    S.ne.items = [];
    S.ne.view = 'home';
    S.ne.coll = null;
    S.ne.collSeq++;
    S.ne.home = { status: 'idle', err: '', data: null };
    await updateNeNote();
    neEnsureHome(true);      // 重新拿一次：未登录时仍要显示公开的推荐歌单
    toast('已退出网易云');
  };
  // 列表上方的未登录提示直接跳到扫码，少一步「先找到设置」
  $('#neNote').onclick = () => {
    if (S.ne.loggedIn) return;
    openDrawer($('#dSet'));
    if (!qrShown()) setTimeout(qrStart, 80);   // 否则 openDrawer 里已经换过码了
  };

  // 哔哩哔哩：扫码 / 导入 Cookie / 退出
  $('#btnBilQr').onclick = () => {
    const w = $('#bilQrWrap');
    if (w && w.classList.contains('show')) { bilQrStop(true); return; }
    bilQrStart();
  };
  $('#btnBilQrRetry').onclick = () => bilQrStart();
  $('#btnBilQrCookie').onclick = e => {
    e.stopPropagation();                    // 别让全局「点弹层外面就关」把刚开的面板关掉
    bilQrStop(true);
    openPop($('#popBilAuth'), $('#btnBilCookie'));
  };
  $('#btnBilCookie').onclick = e => {
    e.stopPropagation();
    openPop($('#popBilAuth'), e.currentTarget);
  };
  $('#btnBilLogout').onclick = () => { bilQrStop(true); bilLogout(); };
  $('#bilAuthSave').onclick = () => bilSaveAuth();
  $('#bilAuthCancel').onclick = () => closePops();
  $('#bilCookie').onkeydown = e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); bilSaveAuth(); }
  };
  // 收藏夹面板：文件夹行 / 重试 / 登录引导，都是事件委托
  const bilHome = $('#bilHome');
  if (bilHome) {
    bilHome.onclick = e => {
      if (e.target.closest('[data-bil-login]')) { $('#bilNote').onclick(); return; }
      if (e.target.closest('[data-bil-favretry]')) { bilEnsureFavs(true); return; }
      const row = e.target.closest('[data-bil-fav]');
      if (row) bilOpenFav(row.dataset.bilFav, row.dataset.bilFavname);
    };
  }

  // 曲库里那句「点这里扫码登录」也走同一条路：先开设置抽屉，再开扫码面板
  $('#bilNote').onclick = () => {
    const st = S.bil.status;
    if (st && st.loggedIn) return;
    openDrawer($('#dSet'));
    setTimeout(() => {
      const w = $('#bilQrWrap');
      if (w && !w.classList.contains('show')) bilQrStart();
    }, 80);
  };

  window.addEventListener('resize', () => {
    measureScrub();
    // 尺寸每变一次就重新锁一轮（逐帧居中、关掉字号与位移过渡）：
    // 连续 resize（拖动窗口边、系统全屏动画）也不会让歌词在中间态里抖
    lockLyricMotion();
  });
  window.addEventListener('beforeunload', flushSettings);

  window.api.onGlobalKey(id => {
    if (id === 'toggle') togglePlay();
    else if (id === 'prev') prev();
    else if (id === 'next') next();
    else if (id === 'volUp') stepVolume(0.02);
    else if (id === 'volDown') stepVolume(-0.02);
  });
  window.api.onWinState(s => {
    if (typeof s.fullscreen === 'boolean') applyFs(s.fullscreen);
    if (typeof s.maximized === 'boolean') $('#wMax').title = s.maximized ? '还原' : '最大化';
  });

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => { if (!S.playing) togglePlay(); });
    ms.setActionHandler('pause', () => { if (S.playing) togglePlay(); });
    ms.setActionHandler('nexttrack', next);
    ms.setActionHandler('previoustrack', prev);
    ms.setActionHandler('seekto', d => {
      if (typeof d.seekTime === 'number' && Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = clamp(d.seekTime, 0, audio.duration);
      }
    });
    ms.setActionHandler('seekbackward', d => seek(-(d.seekOffset || 10)));
    ms.setActionHandler('seekforward', d => seek(d.seekOffset || 10));
  }
}

function stepVolume(delta) {
  S.settings.volume = clamp(S.settings.volume + delta, 0, 1);
  audio.volume = S.settings.volume;
  $('#volRange').value = Math.round(S.settings.volume * 100);
  saveSettings();
}

function syncToggles() {
  syncModeBtn();
  $('#swTr').classList.toggle('on', S.settings.lyricTrans !== false);
}

/* 翻译的显隐只用一个 body 类：切的时候不重建歌词节点、不碰 audio，
 * 关掉后行高变化会让列表偏离中轴，顺手重新居中一次。 */
function applyTransVisibility() {
  document.body.classList.toggle('no-tr', S.settings.lyricTrans === false);
  if (S.lastLy >= 0) centerLine(S.lastLy);
}

/* ------------------------------------------------------------------ 当前账号 */
/* 标题栏右上角的头像就是「现在用谁在听歌」：
 *   - 右键（或点击）展开下拉，四个音源各自的登录账号一览；
 *   - 点一条 → 主进程写 identity.json 并（QQ/酷狗）真正 switchTo；
 *   - 切完刷新歌单来源：网易云重拉首页、哔哩哔哩重置收藏夹、QQ/酷狗清缓存；
 *   - 播放列表的「选择歌单」按 S.idn.current 过滤，见 plSources()。
 * 身份只存 id 与昵称，凭证仍在主进程各自的安全存储里。
 */
const IDN = { open: false };

function idnRow(id) {
  return (S.idn.providers || []).find(x => x.id === id) || null;
}

function idnActiveAccount() {
  const row = idnRow(S.idn.current);
  if (!row) return null;
  const list = row.accounts || [];
  return list.find(a => a.id === (row.activeId || '')) || list[0] || null;
}

function idnPaint() {
  const btn = $('#btnIdn');
  const box = $('#idnAva');
  const now = $('#idnNow');
  if (!btn || !box) return;
  const row = idnRow(S.idn.current);
  const a = idnActiveAccount();
  const label = row ? row.label : '';
  btn.title = '当前账号：' + (a ? a.name + '（' + label + '）' : '未登录')
    + '\n右键切换音源账号';
  btn.classList.toggle('on', !!a);
  const ch = a ? String(a.name || '?').trim().charAt(0) : '';
  if (a && a.avatarUrl) {
    box.innerHTML = '<img alt="" src="' + esc(a.avatarUrl) + '">';
    /* 头像 URL 可能是别人的 CDN，过期/防盗链都正常发生：
     * 加载失败就回落到首字母，别留一个破图标。 */
    const im = box.querySelector('img');
    if (im) im.onerror = () => { box.textContent = ch || '·'; };
  } else {
    box.textContent = ch || '·';
  }
  if (now) now.textContent = a ? (a.name + ' · ' + label) : '未登录（点设置里的播放账号登录）';
}

function idnRenderList() {
  const box = $('#idnList');
  if (!box) return;
  const rows = [];
  for (const p of (S.idn.providers || [])) {
    const accs = p.accounts || [];
    const cur = p.id === S.idn.current;
    rows.push('<div class="idn-sec' + (cur ? ' on' : '') + '">' + esc(p.label)
      + '<small>' + (accs.length ? accs.length + ' 个账号' : (p.error ? '读取失败' : '未登录')) + '</small></div>');
    if (!accs.length) {
      rows.push('<div class="idn-empty">在「设置 → 播放账号」里扫码登录</div>');
      continue;
    }
    for (const a of accs) {
      const on = cur && (a.id === (p.activeId || '') || (!p.activeId && accs[0] === a));
      rows.push('<button class="idn-item' + (on ? ' on' : '') + '" data-p="' + esc(p.id)
        + '" data-a="' + esc(a.id) + '">'
        + '<span class="idn-ico" data-ch="' + esc(String(a.name || '?').trim().charAt(0) || '·') + '">'
        + (a.avatarUrl ? '<img alt="" src="' + esc(a.avatarUrl) + '">'
          : esc(String(a.name || '?').trim().charAt(0) || '·')) + '</span>'
        + '<span class="idn-meta"><b>' + esc(a.name) + '</b><small>' + esc(a.sub || '') + '</small></span>'
        + (on ? '<span class="idn-tick">当前</span>' : '') + '</button>');
    }
  }
  box.innerHTML = rows.join('') || '<div class="idn-empty">还没有任何账号</div>';
  box.querySelectorAll('.idn-ico img').forEach(im => {
    im.onerror = () => { im.parentNode.textContent = im.parentNode.dataset.ch || '·'; };
  });
  box.querySelectorAll('.idn-item').forEach(b => {
    b.onclick = () => idnSwitch(b.dataset.p, b.dataset.a);
  });
}

function idnPlace() {
  const pop = $('#idnPop');
  const btn = $('#btnIdn');
  if (!pop || !btn) return;
  const r = btn.getBoundingClientRect();
  pop.style.top = Math.round(r.bottom + 6) + 'px';
  pop.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
}

function idnOpen(on) {
  const pop = $('#idnPop');
  if (!pop) return;
  IDN.open = !!on;
  pop.hidden = !IDN.open;
  if (IDN.open) { idnPlace(); idnLoad(true); }
}

function idnHide() { if (IDN.open) idnOpen(false); }

async function idnLoad(force) {
  try {
    const r = await window.api.idnGet();
    if (!r || !r.ok) throw new Error((r && r.error && r.error.message) || '读取失败');
    S.idn.current = r.current || '';
    S.idn.providers = r.providers || [];
  } catch (e) {
    if (force) toast('账号信息读取失败：' + ((e && e.message) || e));
    S.idn.providers = S.idn.providers || [];
  }
  idnPaint();
  if (IDN.open) idnRenderList();
}

/* 切过去之后，各音源要做的事不一样：
 *   网易云 → 重拉「我创建的歌单」，否则列表还是上一个人的；
 *   哔哩哔哩 → 清掉收藏夹缓存，下一次读会按新账号拉；
 *   QQ / 酷狗 → 清封面与取流缓存（歌单接口待接上游，如实提示）。 */
async function idnSwitch(provider, accountId) {
  idnHide();
  const row = idnRow(provider);
  const label = row ? row.label : provider;
  let r;
  try { r = await window.api.idnSet(provider, accountId); }
  catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }
  if (!r || !r.ok) {
    toast('切换失败：' + ((r && r.error && r.error.message) || '未知原因'), 3200);
    return;
  }
  if (r.snapshot) { S.idn.current = r.snapshot.current || provider; S.idn.providers = r.snapshot.providers || []; }
  idnPaint();
  thumbUrl.clear();
  try { await window.api.accInvalidate(provider); } catch {}

  if (provider === 'ne') {
    S.ne.home = { status: 'idle', err: '', data: null };
    S.ne.coll = null;
    neEnsureHome();
  } else if (provider === 'bil') {
    /* 先把登录态取回来再拉收藏夹：S.bil.status 还没就绪时
     * bilEnsureFavs 会直接按「未登录」返回，收藏夹就永远空着。 */
    await updateBilNote();
    bilFavsReset();
    bilEnsureFavs(true);
  }
  else if (provider === 'qqapp' || provider === 'kugou') {
    upEnsure(provider, true);
  }
  if (PL.view === 'pick') renderPl(); else if ($('#dLib').classList.contains('show')) renderLibrary();
  toast('已切换到 ' + label + (accountId ? '' : '（未登录）'), 2400);
}

function idnInit() {
  const btn = $('#btnIdn');
  if (!btn || !window.api.idnGet) return;
  btn.onclick = (e) => { e.stopPropagation(); idnOpen(!IDN.open); };
  btn.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); idnOpen(true); };
  document.addEventListener('click', (e) => {
    if (!IDN.open) return;
    if (e.target.closest('#idnPop') || e.target.closest('#btnIdn')) return;
    idnHide();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') idnHide(); });
  window.addEventListener('resize', () => { if (IDN.open) idnPlace(); });
  window.api.onIdnChanged ? window.api.onIdnChanged((snap) => {
    if (!snap) return;
    S.idn.current = snap.current || '';
    S.idn.providers = snap.providers || [];
    idnPaint();
    if (IDN.open) idnRenderList();
  }) : null;
  idnLoad(false);
  /* 当前账号是 QQ 音乐 / 酷狗时先预取歌单：等用户打开「选择歌单」再请求，
   * 那一下会看到空列表。失败也不打断启动（面板里会显示原因）。 */
  setTimeout(() => {
    const cur = S.idn.current;
    if (cur === 'qqapp' || cur === 'kugou') upEnsure(cur, false);
  }, 1200);
}

/* ------------------------------------------------------------------ 启动 */
(async function init() {
  if (!window.api) {                       // preload 没加载起来时不要抛一堆看不懂的错
    document.body.innerHTML = '<div style="padding:40px;font-size:14px">预加载脚本未加载，请重新安装应用。</div>';
    return;
  }
  // 配置读不出来也要能开：坏文件已在主进程改名留档，这里退到默认值继续跑
  try { S.settings = await window.api.getSettings(); } catch { S.settings = null; }
  const saved = (S.settings && typeof S.settings === 'object') ? S.settings : {};
  // 有没有显式存过 playlist：没有（= 这个功能上线前的老配置）就在曲库加载后用曲库播一次种
  const hadPlaylist = Object.prototype.hasOwnProperty.call(saved, 'playlist');
  if (!S.settings || typeof S.settings !== 'object') S.settings = { ...FALLBACK_SETTINGS };
  S.settings = { ...FALLBACK_SETTINGS, ...S.settings };
  // 手改过 settings.json 的人什么都能写出来：只保留类型/范围可信的值，
  // 否则 audio.volume 超范围会直接抛 IndexSizeError。
  S.settings.volume = clamp(Number(S.settings.volume), 0, 1);
  if (!Number.isFinite(S.settings.volume)) S.settings.volume = 0.78;
  S.settings.playMode = migratePlayMode(saved);
  if (!S.settings.playPos || typeof S.settings.playPos !== 'object') S.settings.playPos = null;
  if (typeof S.settings.lyricTrans !== 'boolean') S.settings.lyricTrans = true;
  S.settings.playlist = plNormalize(S.settings.playlist);
  if (!['auto', 'dark', 'light'].includes(S.settings.theme)) S.settings.theme = 'auto';
  S.settings.lat = Number.isFinite(Number(S.settings.lat)) ? clamp(Number(S.settings.lat), -89.9, 89.9) : 31.2304;
  S.settings.lon = Number.isFinite(Number(S.settings.lon)) ? clamp(Number(S.settings.lon), -180, 180) : 121.4737;

  audio.volume = S.settings.volume;
  audio.muted = !!S.settings.muted;
  $('#volRange').value = Math.round(S.settings.volume * 100);
  $('#muteMark').classList.toggle('on', !!S.settings.muted);
  $('#inGeo').value = `${S.settings.lat}, ${S.settings.lon}`;

  bind();
  plBind();                             // 播放列表入口（原音质标签位置）
  syncToggles();
  plSyncBadge();
  applyTransVisibility();               // 先按上次的选择定好译文显隐，再画歌词
  setSource('local');
  // 上次扫过码的话，开机就把歌单在后台取回来：等用户点开「网易云」时已经是现成的
  updateNeNote().then(() => { if (S.ne.loggedIn) neEnsureHome(); }).catch(() => {});
  setAccent(NEUTRAL, false);
  applyTheme();
  measureScrub();
  paintMeta();
  renderLyrics();
  // 只有「曲库是空的」时候封面才是导入入口；有歌但没封面时点它不该弹文件框
  $('#cover').onclick = () => { if ($('#cover').classList.contains('onboard')) $('#btnAddFiles').click(); };

  syncClock();
  rafId = requestAnimationFrame(frame);      // 进度条与歌词都走这一条逐帧循环
  window.api.isFullscreen().then(applyFs).catch(() => {});

  try { S.tracks = ((await window.api.getLibrary()) || []).map(stripHeavy); }
  catch { S.tracks = []; }
  rebuildLibIndex();
  /* 老配置里没有 playlist（这个版本之前没有这个功能）：用曲库播一次种，
   * 免得升级后一开就是空列表、什么都播不了。用户清空过列表（存了 []）就不再播种。 */
  if (!hadPlaylist && S.tracks.length) {
    S.settings.playlist = S.tracks.map(plToItem);
    plSave();
  }
  rebuildQueue();
  renderLibrary();
  plSyncBadge();
  renderPl();
  restorePos();                          // 摆好播放头但不自动出声
  healNetCovers();                       // 补齐老数据里缺失的网易云封面（后台跑，不挡启动）

  loadDevices();
  idnInit();
  registerGlobalKeys();
  const op = new URLSearchParams(location.search).get('open');
  if (op === 'lib') openDrawer($('#dLib'));
  else if (op === 'set') openDrawer($('#dSet'));
  setInterval(() => { if (S.settings.theme === 'auto') applyTheme(); }, 60000);
})().catch(e => {
  // 任何初始化异常都别留一块白屏：至少给一句人话
  try { toast('初始化失败：' + ((e && e.message) || e), 6000); } catch {}
  console.error('init failed', e);
});
