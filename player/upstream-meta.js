'use strict';
/* ---------------- 上游曲目的封面与歌词 ----------------
 * 曲目本身只有 id（kg:<hash> / qq:<songmid>），封面和歌词要单独问上游：
 *   - 酷狗：playInfo 里带 album_img（128/240 尺寸占位符），歌词用 krc.php?cmd=100&hash=
 *   - QQ ：musicu 的 music.musichallSong.PlayLyricInfo / GetPlayLyricInfo
 * 只读、不签名；拿不到就回空，播放不受影响。
 */

const KG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const QQ_UA = 'QQMusic 14090008(android 12)';
const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

const cache = new Map();
const TTL = 10 * 60 * 1000;

function get(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  return null;
}
function put(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

/* ---- 歌词解析：LRC -> [{t, text}]，与渲染层既有格式保持一致 ---- */
function parseLrc(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = /^\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const t = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0);
    const body = (m[4] || '').trim();
    if (!body) continue;
    out.push({ t: Math.round(t * 100) / 100, text: body });
  }
  return out.sort((a, b) => a.t - b.t);
}

/* ---------------- 酷狗 ---------------- */

/* 封面统一转成 data URL：
 * 酷狗给的是 http:// 地址，渲染层 CSP 只放行 https/data，直接塞会被拦掉
 * （现象就是「有封面对象但画面空白」）。顺手也绕开防盗链。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
async function coverDataUrl(url, referer) {
  if (!url) return '';
  const abs = String(url).replace(/^http:\/\//i, 'https://');
  try {
    const r = await fetch(abs, { headers: { 'User-Agent': UA, Referer: referer || 'https://www.kugou.com/' } });
    if (!r.ok) return abs;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 3 * 1024 * 1024) return abs;
    const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch {
    return abs;
  }
}

async function kgMeta(hash, durationSec) {
  const h = String(hash || '').toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(h)) return { cover: '', lyric: [] };
  const key = 'kg:' + h;
  const hit = get(key);
  if (hit) return hit;

  let cover = '';
  let durSec = Number(durationSec || 0) || 0;
  try {
    const r = await fetch(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${h}`, {
      headers: { 'User-Agent': KG_UA, Referer: 'https://www.kugou.com/' }
    });
    const j = await r.json();
    cover = String(j.album_img || j.imgUrl || '').replace('{size}', '400');
    if (!durSec) durSec = Number(j.timeLength || j.timeLengthMs / 1000 || 0) || 0;
    if (!cover && j.albumid) cover = `https://imge.kugou.com/stdmusic/400/${j.albumid}.jpg`;
  } catch { /* 封面拿不到就算了 */ }

  let lyric = [];
  try {
    /* timelength 必填：不带时长时接口返回空字符串，这是酷狗歌词「拿不到」的主因 */
    const ms = Math.max(0, Math.round(durSec * 1000));
    const r = await fetch(`https://m.kugou.com/app/i/krc.php?cmd=100&hash=${h}&timelength=${ms}`, {
      headers: { 'User-Agent': KG_UA, Referer: 'https://www.kugou.com/' }
    });
    const text = await r.text();
    lyric = parseLrc(text);
  } catch { /* 歌词同理 */ }

  return put(key, { cover, lyric });
}

/* ---------------- QQ 音乐 ---------------- */
async function qqMeta(mid, cred, albumMid) {
  const m = String(mid || '').trim();
  if (!/^[0-9A-Za-z]{8,24}$/.test(m)) return { cover: '', lyric: [] };
  const key = 'qq:' + m + (albumMid ? '|' + albumMid : '');
  const hit = get(key);
  if (hit) return hit;

  /* 封面：QQ 官方图床按「专辑 mid」拼，歌曲 mid 拼不出来。
   * 正常情况 album mid 由歌单曲目列表带下来；但从「播放列表」播旧条目时没有这个字段，
   * 这时用单曲信息接口按 songmid 反查一次（一次请求，结果进缓存）。 */
  let am = String(albumMid || '');
  if (!am) {
    try {
      const u = 'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=' + encodeURIComponent(m)
        + '&format=json&platform=yqq&outCharset=utf-8&pcachetime=' + Date.now();
      const r = await fetch(u, {
        headers: { 'User-Agent': QQ_UA, Referer: 'https://y.qq.com/portal/player.html' }
      });
      const j = await r.json();
      const d = (j && j.data && j.data[0]) || null;
      am = String((d && d.album && d.album.mid) || '');
    } catch { /* 查不到就退回占位图 */ }
  }
  let cover = am
    ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + am + '.jpg'
    : '';

  /* 歌词走「旧版歌词接口」，和 folia 用的是同一条：
   *   /lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=…&format=json&outCharset=utf-8
   * 返回的 lyric 是 **base64 的 UTF-8 文本**，不是 URL 编码；
   * musicu 的 PlayLyricInfo 在这里静默回空，别再用它。 */
  let lyric = [];
  try {
    const u = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + encodeURIComponent(m)
      + '&format=json&outCharset=utf-8&nobase64=0&g_tk=5381&pcachetime=' + Date.now();
    const r = await fetch(u, {
      headers: {
        'User-Agent': QQ_UA,
        Referer: 'https://y.qq.com/portal/player.html',
        Accept: '*/*'
      }
    });
    let text = await r.text();
    /* 有些出口会回 JSONP（MusicJsonCallback({...})），先剥壳 */
    const m2 = /^[^(]*\((.*)\)\s*;?\s*$/s.exec(text);
    if (m2) text = m2[1];
    const j = JSON.parse(text);
    const raw = String(j.lyric || '');
    if (raw) lyric = parseLrc(Buffer.from(raw, 'base64').toString('utf8'));
  } catch { /* 歌词拿不到就留空，界面会明确写「没有提供歌词」 */ }

  put(key, { cover, lyric });
  return { cover, lyric };
}

function decodeURIComponentSafe(s) {
  /* QQ 的歌词是 URL 编码的（%5B00%3A12...），个别内容可能带裸 % ，解不开就原样用 */
  try { return decodeURIComponent(s); } catch { return s; }
}

module.exports = {
  coverDataUrl, kgMeta, qqMeta, parseLrc };
