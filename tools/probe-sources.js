#!/usr/bin/env node
'use strict';
/*
 * 第三方音源可行性探针（独立脚本，不依赖应用代码，不改动播放器）
 * ---------------------------------------------------------------
 * 目的：在动手改应用之前，先把「QQ 音乐 / 酷狗」的公开接口摸清楚，量四组数据：
 *   ① 免登录时，搜索 20 首热门歌能取到几条直链、给到什么档位；
 *   ② 拿到直链后，它还能活多久（vkey / 防盗链有有效期，决定代理层要不要每次重解析）；
 *   ③ CDN 是否完整支持 Range（应用里 neaudio 代理靠 206 + content-range 才能拖进度）；
 *   ④ 请求签名/设备指纹的依赖度（去掉签名字段会不会直接被拒）。
 *
 * 只测免费可得的资源；不实现任何「会员空链」绕行，也不保存 cookie/账号信息。
 *
 * 实测要点（2026-11-19，Windows / Node 24）：
 *   · 酷狗：搜索（`mobiles.kugou.com/api/v3/search/song`）免登录可用，结果里
 *     `pay_type` 决定能不能放（0 = 免费，3 = 付费）。免费曲用移动端
 *     `m.kugou.com/app/i/getSongInfo.php?cmd=playInfo` 直接拿到 128k mp3 直链，
 *     不需要算签名；`trackercdn` v1（md5(hash+"kgcloud")）/ v2（md5(hash+"kgcloudv2")）
 *     也能取到。付费曲三条路都返回「需要付费」。
 *   · QQ：musicu 搜索时常返回 `code 2001`（缺 `sign`），`vkey.GetVkeyServer` 免登录
 *     返回 `code 10006` / purl 为空 —— 取链需要 sign + 登录态 + 匹配的 guid。
 *     唯一稳定可用的是 `smartbox_new.fcg`（搜索联想），拿得到 songmid 但取不到链接。
 *
 * 用法：
 *   node tools/probe-sources.js                 # 两家都测，TTL 采样 5 次（每分钟一次）
 *   node tools/probe-sources.js --only qq       # 只测 QQ
 *   node tools/probe-sources.js --only kg --ttl 10
 *   node tools/probe-sources.js --query 五月天 --max 10
 *   node tools/probe-sources.js --no-ttl        # 跳过存活时间测试（快）
 *   node tools/probe-sources.js --only kg --fallback-query 晴天
 *                                               # 主查询没免费曲时换用的词（默认「晴天」）
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ---------------- 命令行 ---------------- */

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const ONLY = String(arg('only', 'all'));
const QUERY = String(arg('query', '周杰伦'));
const MAX = Math.max(1, Math.min(20, Number(arg('max', 20)) || 20));
const TTL_SAMPLES = Math.max(1, Math.min(30, Number(arg('ttl', 5)) || 5));
const DO_TTL = !arg('no-ttl', false);
const OUT = path.join(__dirname, '..', '.tmp', 'source-feasibility.json');

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const report = { startedAt: new Date().toISOString(), query: QUERY, max: MAX, ttlSamples: TTL_SAMPLES, providers: {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = n => crypto.randomBytes(n).toString('hex');
const digits = n => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');

function say(tag, obj) {
  const line = obj === undefined ? '' : ' ' + JSON.stringify(obj);
  console.log(`[${tag}]${line}`);
}
function section(t) {
  console.log(`\n=== ${t} ===`);
}

/* ---------------- HTTP ---------------- */

async function req(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('TIMEOUT')), opts.timeout || 15000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return { res, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

async function json(url, opts = {}) {
  const { res, ms } = await req(url, opts);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON：留着原文给上层判断 */ }
  return { status: res.status, headers: res.headers, body, text, ms };
}

function bodyHint(r) {
  const t = (r.text || '').replace(/\s+/g, ' ').slice(0, 160);
  return { status: r.status, kind: r.body ? 'json' : 'text', text: t };
}

/* ---------------- Range 能力 ---------------- */

/* head 请求拿不到可靠的长度信息，直接 GET 一小段；两种写法都要 206 才算完整支持。 */
async function probeRange(url) {
  const out = { first: null, suffix: null, full: null };
  try {
    const a = await req(url, { headers: { Range: 'bytes=0-1023', 'User-Agent': UA_DESKTOP } });
    out.first = {
      status: a.res.status, ms: a.ms,
      contentRange: a.res.headers.get('content-range'),
      length: a.res.headers.get('content-length'),
      acceptRanges: a.res.headers.get('accept-ranges'),
      type: a.res.headers.get('content-type')
    };
    await a.res.arrayBuffer().catch(() => {});
  } catch (e) { out.first = { error: String(e.message || e) }; }

  try {
    const b = await req(url, { headers: { Range: 'bytes=-1024', 'User-Agent': UA_DESKTOP } });
    out.suffix = {
      status: b.res.status, contentRange: b.res.headers.get('content-range'),
      length: b.res.headers.get('content-length')
    };
    await b.res.arrayBuffer().catch(() => {});
  } catch (e) { out.suffix = { error: String(e.message || e) }; }

  /* 不带 Range 时是否也给 200 + content-length（判断 CDN 是分片还是整段） */
  try {
    const c = await req(url, { headers: { 'User-Agent': UA_DESKTOP } });
    out.full = { status: c.res.status, length: c.res.headers.get('content-length') };
    c.res.body?.cancel().catch(() => {});
  } catch (e) { out.full = { error: String(e.message || e) }; }
  return out;
}

/* ---------------- 存活时间 ---------------- */

/* 每分钟请求 1KB，记录每次的状态码；首次非 2xx 即视为过期。
 * 只取 1KB，几乎不产生流量，也不会因为「整首下载」被当成异常行为。 */
async function probeTtl(url, samples) {
  const rows = [];
  for (let i = 0; i < samples; i++) {
    if (i > 0) await sleep(60_000);
    try {
      const r = await req(url, { headers: { Range: 'bytes=0-1023', 'User-Agent': UA_DESKTOP } });
      rows.push({ at: i, status: r.res.status, ms: r.ms });
      await r.res.arrayBuffer().catch(() => {});
      if (r.res.status !== 206 && r.res.status !== 200) break;
    } catch (e) {
      rows.push({ at: i, error: String(e.message || e) });
      break;
    }
  }
  const alive = rows.filter(r => r.status === 206 || r.status === 200).length;
  return { rows, aliveMinutes: Math.max(0, alive - 1) };
}

/* ---------------- QQ 音乐 ---------------- */

const QQ_GUID = digits(10);

function qqComm(extra = {}) {
  return { ct: '19', cv: '1859', uin: '0', format: 'json', ...extra };
}

async function qqSearch() {
  const payload = {
    comm: qqComm(),
    req_1: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { num_per_page: MAX, page_num: 1, query: QUERY, search_type: 0 }
    }
  };
  const r = await json('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA_DESKTOP,
      Referer: 'https://y.qq.com/',
      Origin: 'https://y.qq.com'
    },
    body: JSON.stringify(payload)
  });
  if (!r.body) return { ok: false, hint: bodyHint(r) };
  const list = r.body?.req_1?.data?.body?.song?.list || [];
  const songs = list.map(s => ({
    mid: s.mid || s.songmid,
    id: s.id,
    name: s.name || s.title,
    singer: (s.singer || []).map(x => x.name).join(' / '),
    album: s.album?.name || '',
    albumMid: s.album?.mid || '',
    /* 搜索结果里的 file 字段常带各档大小，可以作为「官方认为这首有哪些档」的参考 */
    sizes: s.file ? {
      m4a: s.file.size_128m4a, mp3_128: s.file.size_128mp3,
      mp3_320: s.file.size_320mp3, flac: s.file.size_flac
    } : null
  }));
  return { ok: songs.length > 0, code: r.body?.req_1?.code, songs, hint: songs.length ? null : bodyHint(r) };
}

function qqFileNames(mid) {
  return [
    { label: 'm4a 128k', file: `C400${mid}${mid}.m4a` },
    { label: 'mp3 128k', file: `M500${mid}${mid}.mp3` },
    { label: 'mp3 320k', file: `M800${mid}${mid}.mp3` },
    { label: 'flac', file: `F000${mid}${mid}.flac` }
  ];
}

async function qqUrls(mids) {
  const files = [];
  for (const m of mids) for (const f of qqFileNames(m)) files.push({ mid: m, ...f });
  const payload = {
    comm: qqComm({ ct: '24', cv: '0' }),
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid: QQ_GUID,
        songmid: files.map(f => f.mid),
        songtype: files.map(() => 0),
        uin: '0',
        loginflag: 1,
        platform: '20',
        filename: files.map(f => f.file)
      }
    }
  };
  const r = await json('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA_DESKTOP,
      Referer: 'https://y.qq.com/',
      Origin: 'https://y.qq.com'
    },
    body: JSON.stringify(payload)
  });
  if (!r.body) return { ok: false, hint: bodyHint(r), files: [], sip: [] };
  const data = r.body?.req_0?.data || {};
  const info = data.midurlinfo || [];
  const sip = (data.sip || []).filter(Boolean);
  const rows = files.map((f, i) => ({
    mid: f.mid, label: f.label,
    purl: info[i]?.purl || '',
    vkey: !!info[i]?.vkey,
    result: info[i]?.result,
    filename: info[i]?.filename || f.file
  }));
  return { ok: true, sip, files: rows, code: r.body?.req_0?.code, errType: data.errtype, msg: data.msg };
}

/* 设备指纹依赖测试：换一个空 guid，看 purl 是否还回得来。 */
async function qqGuidTest(mids) {
  const files = [];
  for (const m of mids.slice(0, 1)) for (const f of qqFileNames(m)) files.push({ mid: m, ...f });
  const call = guid => json('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA_DESKTOP, Referer: 'https://y.qq.com/' },
    body: JSON.stringify({
      comm: qqComm({ ct: '24', cv: '0' }),
      req_0: {
        module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
        param: {
          guid, songmid: files.map(f => f.mid), songtype: files.map(() => 0),
          uin: '0', loginflag: 1, platform: '20', filename: files.map(f => f.file)
        }
      }
    })
  });
  const good = await call(QQ_GUID);
  await sleep(300);
  const empty = await call('');
  const purls = r => (r.body?.req_0?.data?.midurlinfo || []).filter(x => x.purl).length;
  return {
    withGuid: { ok: purls(good), code: good.body?.req_0?.code },
    emptyGuid: { ok: purls(empty), code: empty.body?.req_0?.code, errType: empty.body?.req_0?.data?.errtype }
  };
}

/* smartbox 是 QQ 少数不校验 sign 的接口，只用来说明「搜索这一层还有入口」。 */
async function qqSmartbox(key) {
  const url = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?' + new URLSearchParams({
    key, format: 'json', inCharset: 'utf8', outCharset: 'utf-8'
  });
  const r = await json(url, { headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://y.qq.com/' } });
  const list = r.body?.data?.song?.itemlist || [];
  return {
    ok: list.length > 0, count: list.length,
    sample: list.slice(0, 3).map(s => ({ mid: s.mid, name: s.name, singer: s.singer })),
    hint: list.length ? null : bodyHint(r)
  };
}

/* 取链是 QQ 的真正门槛：同一首歌换三套 comm（不同终端形态）看是否给 purl。 */
async function qqVkeyProbe(mid) {
  const names = qqFileNames(mid);
  const variants = [
    { label: 'web', comm: { ct: '24', cv: '0', uin: '0', format: 'json' } },
    { label: 'app', comm: { ct: '24', cv: '0', uin: '0', format: 'json', tmeAppID: 'qqmusic' } },
    { label: 'desktop', comm: { ct: '19', cv: '1859', uin: '0', format: 'json', tmeAppID: 'qqmusic', nettype: 'NET', os_ver: 'Windows 10' } }
  ];
  const rows = [];
  for (const v of variants) {
    const r = await json('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: { 'User-Agent': UA_DESKTOP, 'Content-Type': 'application/json', Referer: 'https://y.qq.com/' },
      body: JSON.stringify({
        comm: v.comm,
        req_0: {
          module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
          param: { guid: QQ_GUID, songmid: names.map(() => mid), songtype: names.map(() => 0),
            uin: '0', loginflag: 1, platform: '20', filename: names }
        }
      })
    });
    const d = r.body?.req_0?.data || {};
    rows.push({
      label: v.label, http: r.status, code: r.body?.req_0?.code,
      purls: (d.midurlinfo || []).filter(x => x.purl).length,
      errType: d.errtype, msg: d.msg || r.body?.req_1?.msg || ''
    });
    await sleep(300);
  }
  return rows;
}

async function runQQ() {
  section('QQ 音乐');
  const out = { guid: QQ_GUID };
  const search = await qqSearch();
  out.search = { ok: search.ok, code: search.code, count: search.songs?.length || 0, hint: search.hint };
  if (!search.ok) {
    /* 搜索被拒（2001 = 缺 sign）时不要就此收工：还要证明「取链这一层也过不去」。 */
    await sleep(300);
    out.smartbox = await qqSmartbox(QUERY);
    if (out.smartbox.sample?.[0]?.mid) {
      await sleep(300);
      out.vkey = await qqVkeyProbe(out.smartbox.sample[0].mid);
      say('qq.vkey', out.vkey);
    }
    say('qq.search', out.search);
    say('qq.smartbox', { ok: out.smartbox.ok, count: out.smartbox.count, sample: out.smartbox.sample });
    report.providers.qq = out;
    return out;
  }
  for (const s of (search.songs || []).slice(0, 3)) {
    say('qq.song', { mid: s.mid, name: s.name, singer: s.singer, sizes: s.sizes });
  }
  await sleep(400);

  const mids = search.songs.map(s => s.mid).filter(Boolean);
  const urls = await qqUrls(mids);
  out.urls = { ok: urls.ok, sip: urls.sip, code: urls.code, errType: urls.errType, msg: urls.msg };
  say('qq.urls', out.urls);
  if (!urls.ok) {
    say('qq.urls', out.urls);
    report.providers.qq = out;
    return out;
  }

  const playable = new Map();   // mid -> 最优档（purl 非空）
  const rank = { 'flac': 4, 'mp3 320k': 3, 'm4a 128k': 2, 'mp3 128k': 1 };
  for (const f of urls.files) {
    if (!f.purl) continue;
    const cur = playable.get(f.mid);
    if (!cur || rank[f.label] > rank[cur.label]) playable.set(f.mid, f);
  }
  const byLabel = {};
  for (const f of urls.files) byLabel[f.label] = (byLabel[f.label] || 0) + (f.purl ? 1 : 0);
  const sample = playable.values().next().value || null;
  out.resolve = {
    requested: mids.length,
    playable: playable.size,
    rate: mids.length ? +(playable.size / mids.length).toFixed(2) : 0,
    byLabel,
    sample: sample ? { mid: sample.mid, label: sample.label, filename: sample.filename } : null,
    sampleVkey: sample ? sample.vkey : null
  };
  say('qq.resolve', out.resolve);

  if (sample) {
    const full = (urls.sip[0] || '') + sample.purl;
    out.sampleUrl = { scheme: full.slice(0, full.indexOf('//') + 2), hasPurl: true };
    await sleep(300);
    out.range = await probeRange(full);
    say('qq.range', {
      first: out.range.first?.status, suffix: out.range.suffix?.status,
      contentRange: out.range.first?.contentRange, acceptRanges: out.range.first?.acceptRanges,
      type: out.range.first?.type
    });
    if (DO_TTL) {
      out.ttl = await probeTtl(full, TTL_SAMPLES);
      say('qq.ttl', { aliveMinutes: out.ttl.aliveMinutes, rows: out.ttl.rows });
    }
    await sleep(300);
    out.guidTest = await qqGuidTest(mids);
    say('qq.device', out.guidTest);
  }
  report.providers.qq = out;
  return out;
}

/* ---------------- 酷狗 ---------------- */

const KG_MID = hex(16);
const KG_DFID = hex(16);

const kgCookie = `kg_mid=${KG_MID}; kg_dfid=${KG_DFID}; kg_dfid_collect=d41d8cd98f00b204e9800998ecf8427e`;

async function kgSearch(query = QUERY) {
  const url = 'https://mobiles.kugou.com/api/v3/search/song?' + new URLSearchParams({
    format: 'json', keyword: query, page: '1', pagesize: String(MAX),
    showtype: '1', version: '8000', plat: '0', tag: '1', sver: '2'
  });
  const r = await json(url, {
    headers: { 'User-Agent': UA_MOBILE, Cookie: kgCookie, Referer: 'https://m.kugou.com/' }
  });
  if (!r.body) return { ok: false, hint: bodyHint(r) };
  const info = r.body?.data?.info || [];
  /* pay_type 才是「能不能免费播」的判据：0 = 免费，3 = 付费（privilege 10）。
   * 搜索结果里同一首歌常有多个 hash（不同清晰度/不同授权），必须挑免费那条，
   * 否则会拿到「需要付费」的空直链，误判成「接口不通」。 */
  const songs = info.map(s => ({
    hash: s.hash, albumId: s.album_id, audioId: s.audio_id, albumAudioId: s.album_audio_id,
    name: s.songname, singer: s.singername, duration: s.duration, filesize: s.filesize,
    bitrate: s.bitrate, privilege: s.privilege, payType: s.pay_type, price: s.price
  }));
  return { ok: songs.length > 0, code: r.body?.errcode ?? r.body?.status, songs, hint: songs.length ? null : bodyHint(r), raw: r.body?.data?.total };
}

function kgKey(hash, salt) {
  return crypto.createHash('md5').update(hash + salt).digest('hex');
}

/* v2 取链：key = md5(hash + 固定盐)。不同盐对应不同批次，逐个试。 */
async function kgUrlV2(hash, br) {
  const salts = ['kgcloudv2', 'kugou'];
  const tried = [];
  for (const salt of salts) {
    const url = 'https://trackercdn.kugou.com/i/v2/?' + new URLSearchParams({
      key: kgKey(hash, salt), hash, br, appid: '1005', pid: '2', cmd: '25', behavior: 'play'
    });
    const r = await json(url, { headers: { 'User-Agent': UA_MOBILE } });
    const b = r.body || {};
    tried.push({ salt, status: r.status, code: b.status, err: b.error || b.errMsg || '' });
    const u = Array.isArray(b.url) ? b.url[0] : b.url;
    if (u) {
      return {
        ok: true, salt, url: u, bitrate: b.bitRate, ext: b.extName,
        size: b.fileSize, backup: Array.isArray(b.backupUrl) ? b.backupUrl[0] : b.backupUrl, tried
      };
    }
    await sleep(300);
  }
  return { ok: false, tried };
}

/* 移动端 playInfo：只要 hash，不需要签名，免费曲直接返 play URL。
 * 付费曲返回 status 0 / error "需要付费"，这也正是它的可用判据。 */
async function kgUrlPlayInfo(hash) {
  const url = 'https://m.kugou.com/app/i/getSongInfo.php?' + new URLSearchParams({ cmd: 'playInfo', hash });
  const r = await json(url, {
    headers: { 'User-Agent': UA_MOBILE, Cookie: kgCookie, Referer: 'https://m.kugou.com/' }
  });
  const b = r.body || {};
  const u = b.url || '';
  return {
    ok: !!u && b.status === 1, url: u, status: b.status, err: b.error || '',
    bitrate: b.bitRate, ext: b.extName, size: b.fileSize, privilege: b.privilege, payType: b.pay_type
  };
}

/* 老 v1 取链：key = md5(hash + 'kgcloud')，同样不需要签名。 */
async function kgUrlV1(hash) {
  const url = 'https://trackercdn.kugou.com/i/?' + new URLSearchParams({
    cmd: '4', hash, key: kgKey(hash, 'kgcloud'), pid: '1', forceDown: '0', vip: '1'
  });
  const r = await json(url, { headers: { 'User-Agent': UA_MOBILE, Referer: 'https://m.kugou.com/' } });
  const b = r.body || {};
  const u = Array.isArray(b.url) ? b.url[0] : b.url;
  return {
    ok: !!u || b.status === 1, url: u || '', status: b.status,
    err: b.error || b.errMsg || '', bitrate: b.bitRate, ext: b.extName, size: b.fileSize
  };
}

/* 网页播放页接口：要 cookie，且能给到 320k / 无损。 */
async function kgUrlPlay(hash, albumId) {
  const url = 'https://wwwapi.kugou.com/yy/index.php?' + new URLSearchParams({
    r: 'play/getdata', hash, dfid: KG_DFID, mid: KG_MID, platid: '4',
    album_id: String(albumId || ''), _: String(Date.now())
  });
  const r = await json(url, {
    headers: { 'User-Agent': UA_DESKTOP, Cookie: kgCookie, Referer: 'https://www.kugou.com/' }
  });
  const d = r.body?.data || {};
  return {
    ok: !!d.play_url, errCode: r.body?.err_code ?? r.body?.errcode,
    url: d.play_url || '', bitrate: d.bitrate, ext: d.extname || d.file_ext,
    size: d.filesize, backup: d.backup_url || '', audioName: d.audio_name
  };
}

async function runKG() {
  section('酷狗音乐');
  const out = { mid: KG_MID, dfid: KG_DFID };
  const search = await kgSearch();
  out.search = { ok: search.ok, count: search.songs?.length || 0, code: search.code, total: search.raw, hint: search.hint };
  say('kg.search', out.search);
  if (!search.ok) { report.providers.kg = out; return out; }

  /* 先按 pay_type 挑免费曲；同一首歌可能多条（不同清晰度），只留免费的 */
  let list = search.songs || [];
  let free = list.filter(s => Number(s.payType) === 0);
  const paid = list.filter(s => Number(s.payType) !== 0);

  /* 「周杰伦」这类搜索结果可能一条免费曲都没有（全站 VIP），这时换一个
   * 已知有免费版本的词再搜一次：目的是验证「免费曲能不能取链」，
   * 不是在猜用户想听什么。 */
  let fallbackQuery = '';
  if (!free.length) {
    fallbackQuery = arg('fallback-query', '晴天');
    say('kg.fallback', { reason: '搜索结果里没有 pay_type=0 的曲目', query: fallbackQuery });
    const second = await kgSearch(fallbackQuery);
    if (second.ok) {
      list = second.songs || [];
      free = list.filter(s => Number(s.payType) === 0);
      out.fallback = { query: fallbackQuery, count: list.length, free: free.length };
    }
  }

  out.pick = { total: list.length, free: free.length, paid: list.length - free.length,
    sampleFree: free.slice(0, 3).map(s => s.name + ' · ' + s.hash.slice(0, 8) + ' · ' + s.bitrate + 'k') };
  say('kg.pick', out.pick);

  const candidates = (free.length ? free : list).slice(0, 3);
  out.candidates = [];
  let sampleUrl = '';
  for (const c of candidates) {
    await sleep(300);
    const info = await kgUrlPlayInfo(c.hash);
    const v1 = info.url ? { skipped: true } : await kgUrlV1(c.hash);
    const v2 = info.url || v1.url ? { skipped: true } : await kgUrlV2(c.hash, 'sq');
    out.candidates.push({
      name: c.name, hash: c.hash.slice(0, 10), payType: c.payType, bitrate: c.bitrate,
      playInfo: { ok: info.ok, status: info.status, err: info.err, bitrate: info.bitrate, ext: info.ext, size: info.size },
      v1: v1.skipped ? 'skip' : { ok: v1.ok, status: v1.status, err: v1.err },
      v2: v2.skipped ? 'skip' : { ok: v2.ok, code: v2.tried?.[0]?.code, err: v2.tried?.[0]?.err }
    });
    say('kg.candidate', out.candidates[out.candidates.length - 1]);
    if (!sampleUrl) sampleUrl = info.url || v1.url || (v2.ok ? v2.url : '');
  }

  /* 付费曲对照：说明「取链失败」是授权差异，不是接口不通 */
  if (paid.length) {
    await sleep(300);
    const p = await kgUrlPlayInfo(paid[0].hash);
    out.paidControl = { name: paid[0].name, payType: paid[0].payType,
      status: p.status, err: p.err, url: p.url ? 'yes' : 'no' };
    say('kg.paid', out.paidControl);
  }

  /* 签名依赖：故意用错盐 */
  const signHash = (free[0] || list[0]).hash;
  const bad = await json('https://trackercdn.kugou.com/i/v2/?' + new URLSearchParams({
    key: kgKey(signHash, 'wrong-salt'), hash: signHash, br: 'hq', appid: '1005', pid: '2', cmd: '25', behavior: 'play'
  }), { headers: { 'User-Agent': UA_MOBILE } });
  out.signTest = { wrongKeyStatus: bad.body?.status, wrongKeyErr: bad.body?.error || bad.body?.errMsg || '' };
  say('kg.sign', out.signTest);

  if (sampleUrl) {
    out.sampleUrl = { scheme: sampleUrl.slice(0, sampleUrl.indexOf('//') + 2), path: sampleUrl.replace(/^https?:\/\/[^/]+/, '').slice(0, 60) };
    await sleep(300);
    out.range = await probeRange(sampleUrl);
    say('kg.range', {
      first: out.range.first?.status, suffix: out.range.suffix?.status,
      contentRange: out.range.first?.contentRange, acceptRanges: out.range.first?.acceptRanges,
      type: out.range.first?.contentType
    });
    if (DO_TTL) {
      out.ttl = await probeTtl(sampleUrl, TTL_SAMPLES);
      say('kg.ttl', { aliveMinutes: out.ttl.aliveMinutes, rows: out.ttl.rows });
    }
  } else {
    say('kg.resolve', { ok: false, note: '候选曲目全部取不到直链' });
  }
  report.providers.kg = out;
  return out;
}

/* ---------------- 汇总 ---------------- */

function verdict(p) {
  if (!p) return '未执行';
  if (!p.search?.ok) {
    /* QQ 的 musicu 搜索在没有 sign 时返回 code 2001，是接口层面的拒绝，
     * 和「网络不通 / 被风控」不是一回事，结论要分开写。 */
    return p.search?.code === 2001 ? '搜索接口拒绝（缺 sign 签名参数）' : '搜索接口不可用（网络或参数问题）';
  }
  if (p.resolve && p.resolve.playable === 0) {
    const why = p.urls?.msg ? `（vkey: ${p.urls.msg}）` : '';
    return `搜索可用，取链 0 条${why} —— 免登录拿不到 purl，需要 sign/登录态`;
  }
  const fetched = (p.candidates || []).filter(c => c.playInfo?.ok).length;
  const tried = (p.candidates || []).length;
  const rangeOk = p.range?.first?.status === 206 && p.range?.suffix?.status === 206;
  const alive = p.ttl?.aliveMinutes;
  const parts = [];
  if (fetched) parts.push(`免登录取到直链 ${fetched}/${tried} 首（免费曲）`);
  else if (p.resolve?.playable) parts.push(`取到直链 ${p.resolve.playable} 首`);
  else parts.push('免登录取不到直链');
  if (p.paidControl) parts.push(`付费曲对照：${p.paidControl.err || 'status ' + p.paidControl.status}`);
  if (p.range) parts.push(`Range ${rangeOk ? '完整' : '不完整'}`);
  if (Number.isFinite(alive)) parts.push(`存活 ≥${alive} 分钟`);
  return parts.join(' · ');
}

(async () => {
  console.log(`音源可行性探针  查询「${QUERY}」  每家取 ${MAX} 首  TTL 采样 ${DO_TTL ? TTL_SAMPLES : 0} 次`);
  const t0 = Date.now();
  try {
    if (ONLY === 'all' || ONLY === 'qq') await runQQ();
  } catch (e) { say('qq.crash', { error: String(e.message || e) }); }
  try {
    if (ONLY === 'all' || ONLY === 'kg') await runKG();
  } catch (e) { say('kg.crash', { error: String(e.message || e) }); }

  section('结论');
  if (report.providers.qq) say('QQ', { verdict: verdict(report.providers.qq) });
  if (report.providers.kg) say('酷狗', { verdict: verdict(report.providers.kg) });

  report.finishedAt = new Date().toISOString();
  report.elapsedSec = Math.round((Date.now() - t0) / 1000);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n报告已写入 ${OUT}（用时 ${report.elapsedSec}s）`);
})().catch(e => {
  console.error('PROBE CRASH', e);
  process.exit(2);
});
