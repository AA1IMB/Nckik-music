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
async function qqMeta(mid, cred) {
  const m = String(mid || '').trim();
  if (!/^[0-9A-Za-z]{8,24}$/.test(m)) return { cover: '', lyric: [] };
  const key = 'qq:' + m;
  const hit = get(key);
  if (hit) return hit;

  const comm = {
    ct: 11, cv: 14090008, v: 14090008, chid: '10003505', tmeAppID: 'qqmusic',
    tmeLoginType: 2, qq: String(cred && cred.uin || ''), authst: String(cred && cred.musickey || '')
  };

  let cover = '';
  let lyric = [];
  try {
    const body = {
      comm,
      req_0: {
        module: 'music.musichallSong.PlayLyricInfo', method: 'GetPlayLyricInfo',
        param: { songMID: m, songID: 0, format: 'lrc', type: 1, ct: 11, cv: 14090008 }
      }
    };
    const r = await fetch(MUSICU, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': QQ_UA, Referer: 'https://y.qq.com/' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    const data = (j.req_0 && j.req_0.data) || {};
    const raw = String(data.lyric || '');
    if (raw) lyric = parseLrc(decodeURIComponentSafe(raw));
  } catch { /* 歌词拿不到就算了 */ }

  put(key, { cover, lyric });
  return { cover, lyric };
}

function decodeURIComponentSafe(s) {
  /* QQ 的歌词是 URL 编码的（%5B00%3A12...），个别内容可能带裸 % ，解不开就原样用 */
  try { return decodeURIComponent(s); } catch { return s; }
}

module.exports = { kgMeta, qqMeta, parseLrc };
