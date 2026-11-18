'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const audio = new Audio();
audio.preload = 'auto';

const S = {
  tracks: [],
  i: -1,
  playing: false,
  lyrics: [],
  lyIdx: -1,
  lyricSrc: '',
  accent: '#5b5b66',
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
  srcMode: 'local',                 // 曲库抽屉的两条音轨：local / net
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
  }
};

/* ------------------------------------------------------------------ 音源 */
/*
 * 网易云曲目的 path 是 `ne:<id>`，与本地路径共用同一个唯一键空间：
 * 去重、封面缓存、排序后重定位、写盘全都沿用原有逻辑，不需要到处加 source 分支。
 */
const NET_PREFIX = 'ne:';
const isNet = k => !!k && k.source === 'netease';
const netIdOf = k => (isNet(k) ? Number(k.netId || String(k.path).slice(NET_PREFIX.length)) : 0);

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
  if (!isNet(k)) return null;

  if (!k.coverUrl) { k.coverError = ''; return null; }   // 数据源就是没给封面，不是加载失败
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
  return out.filter((l, i) => i === 0 || l.t !== out[i - 1].t);
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

/* 歌词入口：有逐字数据就用逐字，否则按行时间摊到字 */
function buildLyrics(ly) {
  if (!ly) return [];
  const y = parseYRC(ly.yrc);
  if (y.length) return linkLines(y);
  return linkLines(assignChars(parseLRC(ly.text)));
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
      d.appendChild(cf);
      S.lnChars.push(spans);
    } else {
      d.textContent = l.text;          // 兜底：没有任何字级数据时按整行
      S.lnChars.push(null);
    }
    /* 空档里的「…」：它不是装饰，而是「这一句还没唱完」的延续 ——
     * 挂在本句末尾，跟着时间轴匀速填满、再渐隐，细节见 paintGap()。 */
    const gap = document.createElement('span');
    gap.className = 'gap';
    gap.textContent = '…';
    d.appendChild(gap);
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
  const k = S.tracks[S.i];
  const cover = $('#cover'), img = $('#coverImg');
  if (!k) {
    $('#npT').textContent = '未载入';
    $('#npA').textContent = '支持 MP3 / FLAC / WAV / M4A / OGG';
    $('#npF').textContent = '把文件拖进窗口，或按 Ctrl+O 导入';
    $('#fmtTag').textContent = '—';
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

  $('#fmtTag').textContent = k.error
    ? '解析失败'
    : k.unavailable
      ? '不可播放'
      : k.lossless ? `${k.codec} 无损` : k.codec || (isNet(k) ? '网易云' : '音频');

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
      // 三种情况给三种说法：没给图 / 正在取 / 取失败。混成一句会让用户以为网络坏了
      const sub = !k.coverUrl
        ? '网易云没有为该曲目提供封面'
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
  const k = S.tracks[S.i];
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

  const k = S.tracks[S.i];
  if (!k || !isNet(k)) {
    toast(`音质：${QUALITY_NAME[next]}` + (k ? ' · 本地文件按原文件播放' : ''));
    return;
  }
  await applyQuality(k);
}

async function applyQuality(k) {
  const seq = ++qualSeq;                 // 连点两档时只认最后一次
  const stillCurrent = () => seq === qualSeq && S.tracks[S.i] === k;
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

/* 本地与网易云共用一套行模板：只差右上角的来源角标和封面来源 */
function itemHTML(t, i) {
  const tag = isNet(t) ? `<span class="tag">${t.vip ? 'VIP' : '云'}</span>` : '';
  const idx = i == null ? '' : ` data-i="${i}"`;
  /* 封面：本地走 trackCover（主进程读内嵌图/同目录图，缩到 96px 再回传），
   * 网易云走 neCover（同样按 96px 取）。没给封面地址就不挂 data-art，
   * 直接留「首字磁贴」占位，不会去请求一个注定失败的地址。 */
  const art = isNet(t)
    ? (t.coverUrl ? ` data-art="ne" data-key="${esc(t.coverUrl)}"` : '')
    : (t.path ? ` data-art="file" data-key="${esc(t.path)}"` : '');
  return `<div class="item"${idx} data-ne="${isNet(t) ? t.netId : ''}">
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
const thumbUrl = new Map();          // key -> data URL / ''（确认没有封面）
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
  thumbQ.push([el, kind, key]);
}

async function fetchThumb(kind, key) {
  let r = null;
  try {
    r = kind === 'ne' ? await window.api.neCover(key, 96) : await window.api.trackCover(key);
  } catch { r = null; }
  const url = r && r.ok && r.dataUrl ? r.dataUrl : '';
  thumbUrl.set(key, url);
  while (thumbUrl.size > THUMB_CACHE_MAX) thumbUrl.delete(thumbUrl.keys().next().value);
  return url;
}

function pumpThumbs() {
  while (thumbRun < 4 && thumbQ.length) {
    const [el, kind, key] = thumbQ.shift();
    if (!el.isConnected) continue;        // 行已经被重绘替换掉，不必请求
    thumbRun++;
    fetchThumb(kind, key)
      .then(url => { if (url) applyThumb(el, url); })
      .catch(() => {})
      .then(() => { thumbRun--; pumpThumbs(); });
  }
}

function fillThumbs(root) {
  if (thumbIO) thumbIO.disconnect();       // 上一批的行已经不在文档里了
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
function renderLibrary() {
  if (S.srcMode === 'net') { renderNet(); return; }
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
  if (S.i < 0) return;
  const t = S.tracks[S.i];
  // 本地列表按曲库下标定位；网易云的搜索/歌单列表没有下标，只能按曲目 id 找
  markedEl = (t && isNet(t) ? $(`#libList .item[data-ne="${t.netId}"]`) : null)
    || $(`#libList .item[data-i="${S.i}"]`);
  if (markedEl) markedEl.classList.add('on');
}
function updateRowDuration(i) {
  const el = $(`#libList .r[data-dur="${i}"]`);
  if (el) el.textContent = durationText(S.tracks[i]);
}

/* ------------------------------------------------------------------ 网易云 */
/*
 * 抽屉里是「本地 / 网易云」两条音轨，共用一套列表与播放器：
 *   - 本地：搜索过滤已有曲库；
 *   - 网易云：搜索走在线接口，点一条 = 加入曲库并立即播放。
 * 搜索结果不落盘，只有点过的曲目才进 S.tracks（和本地文件一起持久化）。
 */
function setSource(mode) {
  S.srcMode = mode === 'net' ? 'net' : 'local';
  const net = S.srcMode === 'net';
  $$('#segSrc b').forEach(b => b.classList.toggle('on', b.dataset.s === S.srcMode));
  $('#localActions').style.display = net ? 'none' : 'flex';
  $('#netActions').style.display = net ? 'flex' : 'none';
  $('#neNote').style.display = net ? 'block' : 'none';
  if (!net) $('#neHome').classList.remove('show');
  const q = $('#q');
  q.value = '';
  q.placeholder = net ? '搜索网易云：曲名 / 艺人 / 专辑' : '搜索曲名 / 艺人 / 专辑';
  if (net) {
    updateNeNote();
    if (S.ne.view !== 'coll') S.ne.view = 'home';
    neEnsureHome();          // 首次进来才真的打接口，之后复用缓存
  }
  renderLibrary();
  if (net) setTimeout(() => q.focus(), 60);
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
  const k = S.tracks[S.i];
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

async function playIndex(i) {
  if (i < 0 || i >= S.tracks.length) return;
  const seq = ++loadSeq;
  const k = S.tracks[i];
  const net = isNet(k);

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
      toast(`无法播放：${k.title}（${reason}）`);
      if (S.tracks.length > 1 && errStreak < 3) {
        errStreak++;
        const ni = nextIndex(1, i);
        if (ni >= 0) playIndex(ni);
      } else if (S.i === i) {
        paintMeta();          // 只有本来就停在这首上，才需要刷新它的状态显示
      }
      return;
    }
    k.unavailable = '';
  }

  S.i = i;

  S.lyrics = [];
  S.lyricSrc = '';
  renderLyrics();
  setLyrHint(k, null);
  paintMeta();
  markCurrent();

  if (net) {
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
  try {
    await playGuarded();
    if (seq !== loadSeq) return;
  } catch (e) {
    if (seq !== loadSeq || e.name === 'AbortError') return;   // 被自己人打断，不是错误
    if (e.name === 'TimeoutError') {
      /* 卡住了：先停下这次加载（下面的 src 变更也会中止它），再按「跳过并提示」处理。
       * 不这么做的话就一直停在「正在加载封面…」，用户只能重启软件。 */
      audio.pause();
      toast(`加载超时，已跳过：${k.title || '该曲目'}`);
      if (S.tracks.length > 1 && errStreak < 3) {
        errStreak++;
        const ni = nextIndex(1, i);
        if (ni >= 0) return playIndex(ni);
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
    if (net) {
      art = await loadArt(k);
    } else {
      const detail = await window.api.trackDetail(k.path);
      if (seq !== loadSeq) return;
      k.error = detail.error;
      if (detail.duration && detail.duration !== k.duration) {
        k.duration = detail.duration;
        S.libDirty = true;
        updateRowDuration(i);
      }
      art = detail.cover || null;
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
    if (S.i === i) paintMeta();
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
  if (!S.tracks.length) { toast('先导入一些音乐'); return; }
  if (S.i < 0) { playIndex(0); return; }
  if (S.playing) { audio.pause(); return; }
  if (audio.ended) audio.currentTime = 0;
  audio.play().catch(e => {
    if (e.name !== 'AbortError') toast('无法播放：' + (S.tracks[S.i] && S.tracks[S.i].codec || '未知格式'));
  });
}

/* 随机模式下记住走过的顺序，"上一首"才是真的上一首，而不是又抽一次。
 * from 可以显式指定基准下标：切歌前先做可用性预检时，S.i 还没更新。 */
function nextIndex(dir = 1, from = S.i) {
  const n = S.tracks.length;
  if (!n) return -1;
  if (S.settings.shuffle) {
    if (dir < 0) {
      while (S.hist.length) {
        const p = S.hist.pop();
        if (p !== from && p >= 0 && p < n) return p;
      }
    }
    let r = from;
    while (n > 1 && r === from) r = Math.floor(Math.random() * n);
    if (from >= 0 && from < n) { S.hist.push(from); if (S.hist.length > 200) S.hist.shift(); }
    return r;
  }
  const base = from >= 0 ? from : -dir;      // from = -1 时，下一首从 0 开始
  return (base + dir + n) % n;
}

function next() { const i = nextIndex(1); if (i >= 0) playIndex(i); }
function prev() {
  if (!S.tracks.length) { toast('先导入一些音乐'); return; }
  if (S.i >= 0 && audio.currentTime > 3) { audio.currentTime = 0; return; }
  const i = nextIndex(-1); if (i >= 0) playIndex(i);
}
/* 读不到设置（磁盘只读 / IPC 异常）时的兜底：界面必须能开，不能因为一份配置白屏 */
const FALLBACK_SETTINGS = {
  theme: 'auto', volume: 0.78, shuffle: false, repeat: 'off', sinkId: '', muted: false,
  lat: 31.2304, lon: 121.4737, city: '上海', globalKeys: true, quality: 'exhigh'
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
}

/* 弹层尺寸不是常量：字体加载完成后文字会变宽，内容超高又多出一条滚动条。
 * 只在打开那一刻算一次位置，就会出现「右边贴着窗口」或者「底部出屏」。
 * 所以用 ResizeObserver 盯住面板本身，尺寸一变就重新贴边。 */
let popRO = null;

function placePop(pop) {
  const anchor = pop._anchor;
  if (!anchor || !pop.classList.contains('show')) return;
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
  else if (el.id === 'dSet' && qrShown()) setTimeout(qrStart, 60);
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
  // 排序会打乱下标，先记住当前曲目路径，排完再按路径复位，
  // 否则"边听边导入"会让 S.i 指向另一首，后续切歌全错位。
  const curPath = S.tracks[S.i] && S.tracks[S.i].path;
  const known = new Set(S.tracks.map(t => t.path));
  let added = 0;
  for (const t of scanned) {
    if (!t || !t.path || known.has(t.path)) continue;
    known.add(t.path);
    delete t.cover;                 // 扫描结果不带封面，这里再兜一次底
    S.tracks.push(t);
    added++;
  }
  if (added && sort) {
    S.tracks.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'));
    if (curPath) {
      const ni = S.tracks.findIndex(t => t.path === curPath);
      if (ni >= 0) S.i = ni;
    }
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
  // 封面尺寸与字号都变了，歌词的居中位移要重算；字号有 0.4s 过渡，过渡结束再补一次
  if (S.lastLy >= 0) {
    requestAnimationFrame(() => centerLine(S.lastLy));
    setTimeout(() => { if (S.lastLy >= 0) centerLine(S.lastLy); }, 460);
  }
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
    } else {
      qTimer = setTimeout(renderLibrary, 110);
    }
  };
  $('#q').onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(qTimer);
    if (S.srcMode === 'net') neSearch(); else renderLibrary();
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

  $('#btnShuffle').onclick = () => {
    S.settings.shuffle = !S.settings.shuffle;
    S.hist.length = 0;
    syncToggles(); saveSettings();
  };
  $('#btnRepeat').onclick = () => {
    const order = ['off', 'all', 'one'];
    S.settings.repeat = order[(order.indexOf(S.settings.repeat) + 1) % 3];
    syncToggles(); saveSettings();
    toast(S.settings.repeat === 'off' ? '循环关闭' : S.settings.repeat === 'all' ? '列表循环' : '单曲循环');
  };

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
  audio.addEventListener('playing', () => { clock.stalled = false; errStreak = 0; syncClock(); });
  audio.addEventListener('ended', () => {
    if (S.settings.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    if (S.settings.repeat === 'off' && !S.settings.shuffle && S.i === S.tracks.length - 1) {
      S.playing = false; syncPlayIcon(); return;
    }
    next();
  });
  /* 坏文件不能把整条播放链掐断：跳过去继续放，连续失败 3 次才停 */
  audio.addEventListener('error', () => {
    if (!audio.src) return;
    const k = S.tracks[S.i];
    const name = (k && k.title) || '该曲目';
    if (isNet(k)) k.unavailable = '加载失败';
    if (S.tracks.length > 1 && errStreak < 3) {
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
    else if (e.code === 'KeyS') $('#btnShuffle').click();
    else if (e.code === 'KeyR') $('#btnRepeat').click();
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

  let rsTimer = 0;
  window.addEventListener('resize', () => {
    measureScrub();
    if (S.lastLy < 0) return;
    requestAnimationFrame(() => { if (S.lastLy >= 0) centerLine(S.lastLy); });
    // 全屏下字号按 vw/vh 取，改尺寸时字号有 0.4s 过渡，过渡结束再对齐一次，
    // 否则行高还在变，居中的位移会差几像素
    clearTimeout(rsTimer);
    rsTimer = setTimeout(() => { if (S.lastLy >= 0) centerLine(S.lastLy); }, 480);
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
  $('#btnShuffle').classList.toggle('on', S.settings.shuffle);
  $('#btnShuffle').classList.toggle('off', !S.settings.shuffle);
  const r = S.settings.repeat;
  const btn = $('#btnRepeat');
  btn.classList.toggle('on', r !== 'off');
  btn.classList.toggle('off', r === 'off');
  const txt = r === 'off' ? '关闭' : r === 'all' ? '列表循环' : '单曲循环';
  $('#setRepeat').textContent = txt;
  $('#setShuffle').textContent = S.settings.shuffle ? '开启' : '关闭';
}

/* ------------------------------------------------------------------ 启动 */
(async function init() {
  if (!window.api) {                       // preload 没加载起来时不要抛一堆看不懂的错
    document.body.innerHTML = '<div style="padding:40px;font-size:14px">预加载脚本未加载，请重新安装应用。</div>';
    return;
  }
  // 配置读不出来也要能开：坏文件已在主进程改名留档，这里退到默认值继续跑
  try { S.settings = await window.api.getSettings(); } catch { S.settings = null; }
  if (!S.settings || typeof S.settings !== 'object') S.settings = { ...FALLBACK_SETTINGS };
  S.settings = { ...FALLBACK_SETTINGS, ...S.settings };
  // 手改过 settings.json 的人什么都能写出来：只保留类型/范围可信的值，
  // 否则 audio.volume 超范围会直接抛 IndexSizeError。
  S.settings.volume = clamp(Number(S.settings.volume), 0, 1);
  if (!Number.isFinite(S.settings.volume)) S.settings.volume = 0.78;
  if (!['off', 'all', 'one'].includes(S.settings.repeat)) S.settings.repeat = 'off';
  if (!['auto', 'dark', 'light'].includes(S.settings.theme)) S.settings.theme = 'auto';
  S.settings.lat = Number.isFinite(Number(S.settings.lat)) ? clamp(Number(S.settings.lat), -89.9, 89.9) : 31.2304;
  S.settings.lon = Number.isFinite(Number(S.settings.lon)) ? clamp(Number(S.settings.lon), -180, 180) : 121.4737;

  audio.volume = S.settings.volume;
  audio.muted = !!S.settings.muted;
  $('#volRange').value = Math.round(S.settings.volume * 100);
  $('#muteMark').classList.toggle('on', !!S.settings.muted);
  $('#inGeo').value = `${S.settings.lat}, ${S.settings.lon}`;

  bind();
  syncToggles();
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
  renderLibrary();
  if (S.tracks.length) playIndex(0);

  loadDevices();
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
