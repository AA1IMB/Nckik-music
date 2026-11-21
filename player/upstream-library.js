'use strict';
/* ---------------- 上游歌单：QQ 音乐 / 酷狗 ----------------
 * 只做「读自己的歌单」：列表 + 歌单内的歌。
 *   - QQ 音乐走官方 musicu 协议（与 qqapp 登录同一条通道），
 *     鉴权用登录换来的 musickey，comm 里带 tmeLoginType: 2；
 *   - 酷狗走 m.kugou.com 的公开 plist 接口，鉴权用登录落盘的 token/userid。
 * 不做签名算法、不碰写操作；拿不到就抛带 code 的错误，界面给明确提示。
 */

const UA = 'QQMusic 14090008(android 12)';
const crypto = require('crypto');
/* 酷狗 Android 端签名（只用于「查自己的会员权益/取自己的直链」，不写任何东西）：
 *   signature = md5(salt + 按 key 排序的 k=v 串 + salt)
 *   key       = md5(hash + salt2 + appid + mid + userid)
 * 两个盐值来自客户端协议常量，非本项目自定义。 */
const KG_SIGN_SALT = 'OIlwieks28dk2k092lksi2UIkp';
const KG_KEY_SALT = '57ae12eb6890223e355ccfcb74edf70d';
const KG_APPID = '1005';
/* 登录页用的是 appid 1014；会员权益按 appid 归属，必要时可用 1014 再问一次 */

function md5(str) { return crypto.createHash('md5').update(String(str)).digest('hex'); }

function kgSign(params) {
  const str = Object.keys(params).map((k) => k + '=' + params[k]).sort().join('');
  return md5(KG_SIGN_SALT + str + KG_SIGN_SALT);
}

function kgCookieField(cookie, name) {
  const m = new RegExp('(?:^|; )' + name + '=([^;]*)').exec(String(cookie || ''));
  return m ? m[1] : '';
}

/* 向 trackercdn 问一次「这首我能不能播、能播到哪一档」：
 * 返回 { ok, url, privStatus, code, raw }；只读，不发写请求。 */
async function kgPrivilege(cred, hash, albumAudioId, quality, appidIn) {
  const h = String(hash || '').toLowerCase();
  const cookie = String((cred && cred.cookie) || '');
  const mid = kgCookieField(cookie, 'mid') || kgCookieField(cookie, 'kg_mid');
  const dfid = kgCookieField(cookie, 'dfid') || kgCookieField(cookie, 'kg_dfid');
  const userid = String((cred && cred.userid) || kgCookieField(cookie, 'userid') || '');
  const token = kgCookieField(cookie, 'token');
  if (!userid || !token) throw fail('E_AUTH_REQUIRED', '酷狗音乐还没有登录');
  const appid = String(appidIn || KG_APPID);
  const params = {
    album_id: '0', area_code: '1', hash: h, ssa_flag: 'is_fromtrack',
    version: '11430', page_id: '151369488', quality: String(quality || '128'),
    album_audio_id: String(albumAudioId || '0'), behavior: 'play', pid: '2', cmd: '26',
    pidversion: '3001', IsFreePart: '0', ppage_id: '463467626,350369493,788954147',
    cdnBackup: '1', module: '', clientver: '11430', dfid, mid, uuid: '-', appid,
    clienttime: String(Math.floor(Date.now() / 1000)), userid, token
  };
  params.key = md5(h + KG_KEY_SALT + appid + mid + userid);
  params.signature = kgSign(params);
  const r = await fetch('https://trackercdn.kugou.com/v5/url?' + new URLSearchParams(params).toString(), {
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36', 'x-router': 'trackercdn.kugou.com', dfid, mid, clienttime: params.clienttime }
  });
  let j = null;
  try { j = await r.json(); } catch { /* 下面按失败处理 */ }
  /* 响应里的 url / backupUrl 是「字符串数组」（个别版本是对象数组），两种都接 */
  const pick = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return '';
    const x = arr[0];
    return String((x && typeof x === 'object' ? (x.url || x.backupUrl || '') : x) || '');
  };
  const first = pick(j && j.url) || pick(j && j.backupUrl);
  return {
    ok: !!first,
    url: first,
    privStatus: Number((j && j.priv_status) || 0),
    code: Number((j && j.error_code) || 0),
    raw: j
  };
}
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
  /* 以前这里写死 song_num:100、只取首页，于是任何超过 100 首的歌单都被截断。
   * CgiGetDiss 其实支持 song_begin/song_num 分页，并且回 total_song_num：
   * 按 100 一页翻到底，和网易云一样「导入多少就有多少」。 */
  const PAGE = 100;
  const MAX_PAGES = 200;              /* 兜底：最多 2 万首，防止上游 total 异常时死循环 */
  const collected = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await musicu(qqComm(uid, musickey), 'music.srfDissInfo.DissInfo', 'CgiGetDiss', {
      disstid: Number(id) || 0, dirid: Number(dirId) || 0,
      song_begin: page * PAGE, song_num: PAGE, userinfo: true, orderlist: true
    });
    const got = Array.isArray(data.songlist) ? data.songlist : [];
    total = Number(data.total_song_num || data.total || 0) || total;
    for (const x of got) collected.push(x);
    if (!got.length || got.length < PAGE || (total && collected.length >= total)) break;
  }
  const songs = collected;
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

/* 凭据有两种形态：老版把 userid 放在顶层，新版（App 扫码）放在 extra 里、
 * cookie 串里也有 token/userid/mid/dfid。这里统一读出来，避免各调用点各写一套。 */
function kgCredFields(cred) {
  const c = cred || {};
  const ex = c.extra || {};
  const cookie = String(c.cookie || '');
  const fromCookie = name => {
    const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(cookie);
    return m ? m[1] : '';
  };
  return {
    cookie,
    uid: String(c.userid || ex.userid || fromCookie('userid') || ''),
    token: String(c.token || ex.token || fromCookie('token') || ''),
    mid: String(c.mid || ex.mid || fromCookie('mid') || ''),
    dfid: String(c.dfid || ex.dfid || fromCookie('dfid') || '')
  };
}

/* 「我创建的歌单」走 cloudlist 的 v7/get_all_list（App 协议，需要 android 签名）。
 * 老的 m.kugou.com/plist/index?uid= 会忽略 uid，返回公共歌单索引 —— 这就是
 * 「登录了却看不到自己歌单」的原因。 */
const KG_APP_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';
const KG_ANDROID_SALT = 'OIlwieks28dk2k092lksi2UIkp';

function kgAppSign(params, data) {
  const raw = Object.keys(params).sort()
    .map(k => `${k}=${typeof params[k] === 'object' ? JSON.stringify(params[k]) : params[k]}`)
    .join('');
  return md5(KG_ANDROID_SALT + raw + (data || '') + KG_ANDROID_SALT);
}

async function kgMyPlaylistsOnce(f, appid, clientver) {
  const clienttime = Math.floor(Date.now() / 1000);
  const body = { userid: Number(f.uid), token: f.token, total_ver: 979, type: 2, page: 1, pagesize: 100 };
  const data = JSON.stringify(body);
  const params = {
    dfid: f.dfid || '-', mid: f.mid, uuid: '-', appid, clientver, clienttime,
    token: f.token, userid: Number(f.uid), plat: 1, total_ver: 979, type: 2, page: 1, pagesize: 100
  };
  params.signature = kgAppSign(params, data);
  const r = await fetch('https://gateway.kugou.com/v7/get_all_list?' + new URLSearchParams(params), {
    method: 'POST',
    headers: {
      'User-Agent': KG_APP_UA, 'x-router': 'cloudlist.service.kugou.com',
      dfid: params.dfid, mid: params.mid, clienttime: String(clienttime),
      'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
      Cookie: `token=${f.token}; userid=${f.uid}`, 'Content-Type': 'application/json'
    },
    body: data
  });
  if (!r.ok) throw fail('E_UPSTREAM_HTTP', `酷狗歌单列表返回 ${r.status}`);
  const j = await r.json();
  if (j && j.error_code) {
    const err = fail('E_UPSTREAM_CODE', `酷狗歌单列表失败（${j.error_code}）`);
    err.code2 = j.error_code;
    throw err;
  }
  const arr = (j && j.data && (j.data.info || j.data.list)) || [];
  return arr.map(p => ({
    id: String(p.list_create_listid || p.listid || p.specialid || ''),
    name: String(p.name || p.list_name || p.specialname || '歌单'),
    count: Number(p.m_count || p.song_count || p.songcount || p.per_num || 0),
    cover: ''
  })).filter(p => p.id);
}

/* 「我创建的歌单」：cloudlist v7/get_all_list 只认 App 客户端（appid 1005）体系的 token。
 * 我们自己的扫码登录发的是 appid 1001 的 token，所以这里按 appid 逐个试，
 * 哪个通就用哪个；全不通再回落到公共索引（至少不是空白）。 */
const KG_CLOUD_CANDIDATES = [[1005, 20489], [1001, 20489], [1001, 20489], [1005, 11430]];

async function kgMyPlaylists(f) {
  let lastErr = null;
  for (const [appid, clientver] of KG_CLOUD_CANDIDATES) {
    try {
      const list = await kgMyPlaylistsOnce(f, appid, clientver);
      if (list.length) return list;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return [];
}

async function kgPlaylists(cred) {
  const f = kgCredFields(cred);
  if (!f.cookie || !f.uid) throw fail('E_AUTH_REQUIRED', '酷狗音乐还没有登录');
  /* 先问「我创建的歌单」；接口不可用（老版本账号/风控）才回落到公共索引，保证不至于全空 */
  try {
    const mine = await kgMyPlaylists(f);
    if (mine.length) return mine;
  } catch (e) {
    if (!e || e.code === 'E_AUTH_REQUIRED') throw e;
    /* 我创建的歌单失败时静默回落，但要在主进程日志里留痕，方便排查 */
    console.log('[up] 我创建的歌单读取失败：', (e && e.code) || '', (e && e.message) || '');
  }
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= 10; page++) {
    const j = await kgGet(f.cookie, `https://m.kugou.com/plist/index?json=true&uid=${encodeURIComponent(f.uid)}&page=${page}&pagesize=100`);
    const arr = (j.plist && j.plist.list && j.plist.list.info) || [];
    if (!arr.length) break;
    let added = 0;
    for (const p of arr) {
      const id = String(p.specialid || '');
      if (!id || seen.has(id)) continue;
      seen.add(id); added++;
      out.push({ id, name: String(p.specialname || p.listname || '歌单'), count: Number(p.songcount || 0), cover: '' });
    }
    if (!added) break;
  }
  return out;
}

/* 搜索：酷狗走 mobilecdn（免签）；QQ 走 musicu 的 Lite 搜索，返回体把各类型放在 body 里 */
async function kgSearch(cred, keyword, page) {
  const f = kgCredFields(cred);
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const q = new URLSearchParams({
    keyword: kw, page: String(page || 1), pagesize: '30', plat: '0', version: '8000', showtype: '1'
  });
  const r = await fetch('http://mobilecdn.kugou.com/api/v3/search/song?' + q, {
    headers: { 'User-Agent': KG_MUA, Cookie: f.cookie || '' }
  });
  if (!r.ok) throw fail('E_UPSTREAM_HTTP', `酷狗搜索返回 ${r.status}`);
  const j = await r.json();
  const arr = (j && j.data && j.data.info) || [];
  return arr.map(s => {
    const name = String(s.filename || s.songname || '');
    const cut = name.indexOf(' - ');
    return {
      id: 'kg:' + String(s.hash || '').toUpperCase(),
      title: cut > 0 ? name.slice(cut + 3) : name,
      artist: cut > 0 ? name.slice(0, cut) : String(s.singername || ''),
      duration: Number(s.duration || 0),
      vip: Number(s.privilege || 0) > 8
    };
  }).filter(x => x.id.length > 3);
}

/* QQ 音乐搜索：走「精简版客户端」的 comm（tmeAppID=qqmusiclight）。
 * 2026-11 实测：
 *  - 带 App 的 comm（cv 14090008 / tmeAppID qqmusic）搜出去 code 0 但 item_song 恒空；
 *  - 精简版 comm + search_type **7** 才有结果（0 会回 2001，folia 的注释也记了这点）；
 *  - 它是按 IP/会话限流的：短时间连发几十次会转成 2001，稍等即可恢复，所以要给清楚的文案；
 *  - 条目字段：mid / title / singer[].name / interval（秒）/ album.mid / pay.pay_play（1=会员曲）。
 */
async function qqSearch(cred, keyword, page) {
  const c = (cred && (cred.extra || cred)) || {};
  const uin = String(c.musicid || c.uin || c.qq || '');
  const key = String(c.musickey || '');
  const logged = !!(uin && key);
  const comm = {
    ct: 11, cv: '1003006', v: '1003006', tmeAppID: 'qqmusiclight',
    nettype: 'NETWORK_WIFI', udid: '0',
    uid: uin || '0', tmeLoginType: logged ? 2 : -1
  };
  const headers = {
    'User-Agent': 'okhttp/3.14.9',
    Cookie: logged ? `uin=${uin}; qm_keyst=${key}` : 'tmeLoginType=-1'
  };
  const param = {
    search_id: String(Date.now()) + String(Math.floor(Math.random() * 1000)),
    remoteplace: 'search.android.keyboard', query: String(keyword || ''),
    search_type: 7, num_per_page: 30, page_num: Number(page) || 1,
    highlight: 0, nqc_flag: 0, page_id: 1, grp: 1
  };
  const body = {
    comm,
    req_0: { module: 'music.search.SearchCgiService', method: 'DoSearchForQQMusicLite', param }
  };
  const r = await fetch(MUSICU, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!r.ok) throw fail('E_UPSTREAM_HTTP', `QQ 音乐搜索返回 ${r.status}`);
  const j = await r.json();
  const r0 = (j && j.req_0) || {};
  if (r0.code === 2001) throw fail('E_UPSTREAM_CODE', 'QQ 音乐搜索被限流（2001），等一两分钟再试');
  if (r0.code !== 0) throw fail('E_UPSTREAM_CODE', `QQ 音乐搜索失败（${r0.code}）`);
  const arr = (((r0.data || {}).body || {}).item_song) || [];
  if (!arr.length) throw fail('E_UPSTREAM_UNAVAILABLE', 'QQ 音乐没有返回结果（换个关键词或稍后再试）');
  return arr.map(s => ({
    id: 'qq:' + String(s.mid || ''),
    title: String(s.title || s.name || ''),
    artist: (s.singer || []).map(x => x.name).filter(Boolean).join('/'),
    duration: Number(s.interval || 0),
    albumMid: String((s.album && s.album.mid) || ''),
    vip: !!(s.pay && Number(s.pay.pay_play) === 1)
  })).filter(x => x.id.length > 3);
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
/* 判断「当前登录的账号在服务端有没有会员权益」：
 * 旧实现拿免费取流去试，失败就说「免费账号」——那是错的（免费链路永远不认会员权益）。
 * 现在直接向 trackercdn 问权限：priv_status>0 或拿到直链 = 有权益。 */
async function kgVip(cred) {
  cred = cred || {};
  const now = Date.now();
  if (__kgVipCache.val && now - __kgVipCache.at < 10 * 60 * 1000) return __kgVipCache.val;
  const cookie = (cred && cred.cookie) || '';
  const uid = (cred && (cred.userid || cred.KugooID)) || kgCookieField(cookie, 'userid');
  if (!cookie || !uid) return { vip: null, reason: 'E_AUTH_REQUIRED', message: '酷狗音乐还没有登录' };
  let probe = null;
  try {
    const pls = await kgPlaylists(cred);
    const withSongs = pls.find((p) => p.count > 0);
    if (withSongs) {
      const page = await kgPlaylistPage(cookie, withSongs.id, 1);
      probe = page.songs.find((s) => Number(s.privilege || 0) > 8) || null;
    }
  } catch { /* 没有样本就退化成未知 */ }
  if (!probe) {
    const val = { vip: null, reason: 'E_NO_SAMPLE', message: '没有找到需要权限的样本来判断' };
    __kgVipCache = { at: now, val };
    return val;
  }
  const hash = String(probe.hash || '');
  try {
    const pr = await kgPrivilege(cred, hash, probe.albumAudioId || probe.album_audio_id, '128');
    const val = pr.ok || pr.privStatus > 0
      ? { vip: true, reason: '', hash: hash.slice(0, 8), privilege: Number(probe.privilege || 0) }
      : { vip: false, reason: 'E_NO_VIP_PRIVILEGE', code: pr.code, privStatus: pr.privStatus, hash: hash.slice(0, 8) };
    __kgVipCache = { at: now, val };
    return val;
  } catch (e) {
    const val = { vip: null, reason: String((e && e.code) || 'E_UPSTREAM'), message: String((e && e.message) || '') };
    __kgVipCache = { at: now, val };
    return val;
  }
}
/* 取流器在 stream-resolve.js：这里延迟 require，避免两个模块互相 require 成环 */
function kgResolveLazy() {
  return require('./stream-resolve.js').kgResolve;
}

module.exports = {
  kgVip, kgPrivilege, albumMidOf, qqPlaylists, qqPlaylistTracks, kgPlaylists, kgPlaylistTracks,
  kgSearch, qqSearch };
