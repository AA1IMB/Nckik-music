'use strict';
/* ---------------- 上游歌单：QQ 音乐 / 酷狗 ----------------
 * 只做「读自己的歌单」：列表 + 歌单内的歌。
 *   - QQ 音乐走官方 musicu 协议（与 qqapp 登录同一条通道），
 *     鉴权用登录换来的 musickey，comm 里带 tmeLoginType: 2；
 *   - 酷狗走 m.kugou.com 的公开 plist 接口，鉴权用登录落盘的 token/userid。
 * 不做签名算法、不碰写操作；拿不到就抛带 code 的错误，界面给明确提示。
 */

const UA = 'QQMusic 14090008(android 12)';
const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

function qqComm(uid, musickey) {
  return {
    ct: 11, cv: 14090008, v: 14090008, chid: '10003505', tmeAppID: 'qqmusic',
    tmeLoginType: 2, qq: String(uid || ''), authst: String(musickey || '')
  };
}

async function musicu(comm, module, method, param) {
  const body = { comm, req_0: { module, method, param } };
  const r = await fetch(MUSICU, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw fail('E_UPSTREAM_HTTP', `QQ 音乐接口返回 ${r.status}`);
  const j = await r.json();
  const code = (j.req_0 && j.req_0.code) || j.code || 0;
  if (code !== 0) {
    const msg = (j.req_0 && j.req_0.message) || j.message || '';
    throw fail(code === 1000 || code === 104400 ? 'E_AUTH_REQUIRED' : 'E_UPSTREAM_CODE',
      `QQ 音乐接口返回 ${code}${msg ? '：' + msg : ''}`);
  }
  return (j.req_0 && j.req_0.data) || {};
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* 曲目 id → 专辑 mid 的缓存：老播放列表里没有 albumMid 时据此反查 */
const ALBUM_CACHE = new Map();
function rememberAlbum(items) {
  for (const it of items || []) {
    if (it && it.albumMid) ALBUM_CACHE.set(String(it.id), String(it.albumMid));
  }
}
function albumMidOf(id) {
  return ALBUM_CACHE.get(String(id)) || '';
}

/* 歌单列表：自建清单（GetPlaylistByUin）。收藏的歌单需要 encryptUin，本版本不接。 */
async function qqPlaylists(cred) {
  const uid = cred.uin || cred.musicid || '';
  const musickey = cred.musickey || '';
  if (!uid || !musickey) throw fail('E_AUTH_REQUIRED', 'QQ 音乐还没有登录');
  const data = await musicu(qqComm(uid, musickey), 'music.musicasset.PlaylistBaseRead', 'GetPlaylistByUin', { uin: String(uid) });
  const list = Array.isArray(data.v_playlist) ? data.v_playlist : [];
  return list
    .filter(p => p && (p.dirType === undefined || p.dirType === 0))
    .map(p => ({
      id: String(p.tid || p.dirId || ''),
      dirId: Number(p.dirId || 0),
      /* QQ 的字段名和别处不一样：dirName / songNum / picUrl（大写 N） */
      name: String(p.dirName || p.name || p.dissname || p.title || '歌单'),
      count: Number(p.songNum || p.songnum || p.song_count || 0),
      cover: String(p.picUrl || p.bigpicUrl || p.cover || p.logo || '')
    }))
    .filter(p => p.id);
}

async function qqPlaylistTracks(cred, id, dirId) {
  const __items = await qqPlaylistTracksInner(cred, id, dirId);
  rememberAlbum(__items);
  return __items;
}

async function qqPlaylistTracksInner(cred, id, dirId) {
  const uid = cred.uin || cred.musicid || '';
  const musickey = cred.musickey || '';
  if (!uid || !musickey) throw fail('E_AUTH_REQUIRED', 'QQ 音乐还没有登录');
  const data = await musicu(qqComm(uid, musickey), 'music.srfDissInfo.DissInfo', 'CgiGetDiss', {
    disstid: Number(id) || 0, dirid: Number(dirId) || 0,
    song_begin: 0, song_num: 100, userinfo: true, orderlist: true
  });
  const songs = Array.isArray(data.songlist) ? data.songlist : [];
  return songs.map(s => {
    const singers = Array.isArray(s.singer) ? s.singer.map(x => x && x.name).filter(Boolean).join('/') : '';
    return {
      id: 'qq:' + String(s.mid || s.songmid || s.id || ''),
      title: String(s.name || s.title || s.songname || '未知曲目'),
      artist: singers || String(s.singername || ''),
      duration: Number(s.interval || s.duration || 0),
      albumMid: String((s.album && s.album.mid) || '')
    };
  }).filter(t => t.id !== 'qq:');
}

/* 酷狗：uid 来自登录 cookie；歌单列表与详情都在 m.kugou.com。 */
const KG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function kgGet(cookie, url) {
  const r = await fetch(url, { headers: { Cookie: cookie, 'User-Agent': KG_UA, Referer: 'https://www.kugou.com/' } });
  if (!r.ok) throw fail('E_UPSTREAM_HTTP', `酷狗接口返回 ${r.status}`);
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { throw fail('E_UPSTREAM_BAD_JSON', '酷狗接口没有返回 JSON（可能被风控）'); }
}

const KG_MUA = 'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

async function kgGetText(cookie, url) {
  /* 详情页是移动版页面：桌面 UA 会拿到另一个模板（没有内嵌 JSON），
   * 必须用移动 UA + m.kugou.com 的 Referer 才和浏览器里看到的一致。 */
  const r = await fetch(url, { headers: { Cookie: cookie, 'User-Agent': KG_MUA, Referer: 'https://m.kugou.com/' } });
  if (!r.ok) throw fail('E_UPSTREAM_HTTP', `酷狗接口返回 ${r.status}`);
  return await r.text();
}

async function kgPlaylists(cred) {
  const cookie = cred.cookie || '';
  const uid = cred.userid || cred.KugooID || '';
  if (!cookie || !uid) throw fail('E_AUTH_REQUIRED', '酷狗音乐还没有登录');
  /* 接口每页最多给 30 个，超过就得翻页；只取第一页会出现「有些歌单看不到」 */
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= 10; page++) {
    const j = await kgGet(cookie, `https://m.kugou.com/plist/index?json=true&uid=${encodeURIComponent(uid)}&page=${page}&pagesize=100`);
    const arr = (j.plist && j.plist.list && j.plist.list.info) || [];
    if (!arr.length) break;
    let added = 0;
    for (const p of arr) {
      const id = String(p.specialid || '');
      if (!id || seen.has(id)) continue;
      seen.add(id); added++;
      out.push({
        id,
        name: String(p.specialname || p.listname || '歌单'),
        count: Number(p.songcount || 0),
        cover: String(p.imgurl || '').replace('{size}', '240')
      });
    }
    if (!added) break;
  }
  return out;
}

/* 歌单曲目：m.kugou.com 的 plist 详情并不直接给「干净的歌曲数组」——
 * 每页返回 30 个歌单卡片，每张卡片里带 3 首 songs[]；把多页的 songs[] 摊平、
 * 按 hash 去重就能拿到整张歌单（page1 得 89 首、page2 累到 178 首，已覆盖 156 首的歌单）。
 */
/* 从 m.kugou.com 的歌单详情页里抠出内嵌 JSON：
 * 页面是 HTML 外壳 + 一段 `{...,"list":{"list":{"total":156,"info":[...]}}}`
 * 没有可用的 JSON 接口（/plist/index?specialid= 会忽略参数、永远返回首页那批卡片，
 * 这正是「导入任何歌单都导入同一个」的根因）。 */
function sliceBracket(text, from, open, close) {
  let depth = 0, inStr = false, esc = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (!depth) return text.slice(from, i + 1); }
  }
  return '';
}

async function kgPlaylistPage(cookie, id, page) {
  /* 只有 mobilecdn 的 v3 接口给你「整张歌单 + 正确的 total」：
   *   - m.kugou.com/plist/index?specialid= 会忽略参数，永远返回首页那批卡片（旧 bug 根因）
   *   - m.kugou.com/plist/list/<id> 只内嵌前 10 首，且 page 参数无效
   * 这个接口必须用 http（https 证书在 Node 里握手失败）。 */
  const url = 'http://mobilecdn.kugou.com/api/v3/special/song'
    + `?specialid=${encodeURIComponent(id)}&page=${page}&pagesize=100&plat=0&version=8000`;
  const r = await fetch(url, { headers: { Cookie: cookie, 'User-Agent': KG_UA } });
  if (!r.ok) throw fail('E_UPSTREAM_HTTP', `酷狗接口返回 ${r.status}`);
  let j = null;
  try { j = await r.json(); } catch { throw fail('E_UPSTREAM_BAD_JSON', '酷狗歌单接口没有返回 JSON'); }
  const d = (j && j.data) || {};
  return { total: Number(d.total || 0), songs: Array.isArray(d.info) ? d.info : [] };
}

async function kgPlaylistTracks(cred, id) {
  const cookie = cred.cookie || '';
  if (!cookie) throw fail('E_AUTH_REQUIRED', '酷狗音乐还没有登录');
  const seen = new Set();
  const out = [];
  let total = 0;
  for (let page = 1; page <= 10; page++) {
    const r = await kgPlaylistPage(cookie, id, page);
    if (!total) total = r.total;
    if (!r.songs.length) break;
    let added = 0;
    for (const s of r.songs) {
      const hash = String(s.hash || '').toUpperCase();
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      added++;
      const name = String(s.filename || s.songname || '');
      out.push({
        id: hash,
        title: s.songname ? String(s.songname) : name.replace(/^.*?\s-\s/, ''),
        artist: String(s.singername || s.author_name || (name.includes(' - ') ? name.split(' - ')[0] : '')),
        duration: Number(s.duration || s.timelength || 0),
        /* privilege: 8 = 免费可播，>=10 = 需要付费/会员（实测 10 取链必回 E_NO_COPYRIGHT）。
         * pay_type 在这份接口里恒为 3，不能拿它判断，否则整张歌单都被标成 VIP。 */
        vip: Number(s.privilege || 0) > 8
      });
    }
    if (!added) break;
    if (total && out.length >= total) break;
  }
  return total ? out.slice(0, total) : out;
}

/* 账号是不是 VIP：不做「猜 cookie」这种事，直接拿一首需要权限的歌去取链，
 * 能取到直链就说明这个账号有权限（换号/过期都会自然失效，且只花一次请求）。 */
let __kgVipCache = { at: 0, val: null };
async function kgVip(cred) {
  const now = Date.now();
  if (__kgVipCache.val && now - __kgVipCache.at < 10 * 60 * 1000) return __kgVipCache.val;
  const cookie = cred.cookie || '';
  const uid = cred.userid || cred.KugooID || '';
  if (!cookie || !uid) return { vip: false, reason: 'E_AUTH_REQUIRED', message: '酷狗音乐还没有登录' };
  let probe = null;
  try {
    const pls = await kgPlaylists(cred);
    const withSongs = pls.find(p => p.count > 0);
    if (withSongs) {
      const page = await kgPlaylistPage(cookie, withSongs.id, 1);
      probe = page.songs.find(s => Number(s.privilege || 0) > 8) || null;
    }
  } catch { /* 拿不到样本就退化成「未知」 */ }
  if (!probe) {
    const val = { vip: false, reason: 'E_NO_SAMPLE', message: '没有找到需要权限的样本来判断' };
    __kgVipCache = { at: now, val };
    return val;
  }
  const hash = String(probe.hash || '').toUpperCase();
  try {
    await kgResolveLazy()(hash);
    const val = { vip: true, reason: '', hash: hash.slice(0, 8), privilege: Number(probe.privilege || 0) };
    __kgVipCache = { at: now, val };
    return val;
  } catch (e) {
    const val = { vip: false, reason: String((e && e.code) || 'E_UPSTREAM'), hash: hash.slice(0, 8), privilege: Number(probe.privilege || 0), message: String((e && e.message) || '') };
    __kgVipCache = { at: now, val };
    return val;
  }
}
/* 取流器在 stream-resolve.js：这里延迟 require，避免两个模块互相 require 成环 */
function kgResolveLazy() {
  return require('./stream-resolve.js').kgResolve;
}

module.exports = {
  kgVip, albumMidOf, qqPlaylists, qqPlaylistTracks, kgPlaylists, kgPlaylistTracks };
