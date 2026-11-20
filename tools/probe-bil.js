'use strict';
/* 哔哩哔哩音源可行性探针（只读，不改播放器）。
 *
 *   node tools/probe-bil.js                    # 全流程：nav → 搜索 → 取流 → Range
 *   node tools/probe-bil.js --query 周杰伦 --max 10
 *   node tools/probe-bil.js --bvid BV1xx...    # 跳过搜索，直接验单个视频
 *
 * 为什么单独写一个脚本：这一步要验证的是「上游接口现在还能不能用」，
 * 与播放器代码无关；把结果写成 JSON，后面写设计方案时可直接引用。
 * 报告默认落在 .tmp/bil-report.json，控制台只打结论行。
 */
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const API = 'https://api.bilibili.com';
const REFERER = 'https://www.bilibili.com/';

/* WBI 混表：B 站把 imgKey+subKey 按这张表重排成 32 位的 mixinKey，
 * 再用它给查询串算 md5。表是固定的，key 每 20 分钟轮换一次。 */
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

const argOf = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};

function req(url, { headers = {}, timeout = 12000, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const rq = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': UA, Referer: REFERER, Origin: 'https://www.bilibili.com', ...headers },
      timeout
    }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
    });
    rq.on('timeout', () => rq.destroy(new Error('timeout')));
    rq.on('error', reject);
    rq.end();
  });
}

async function getJSON(url, opts) {
  const r = await req(url, opts);
  const text = r.body.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch (e) { throw new Error('不是 JSON（HTTP ' + r.status + '）：' + text.slice(0, 120)); }
  return { status: r.status, json, headers: r.headers };
}

let wbiCache = null;
function mixinKeyOf(imgUrl, subUrl) {
  const pick = u => String(u || '').split('/').pop().replace(/\.(png|jpg|jpeg|webp)$/i, '');
  const raw = pick(imgUrl) + pick(subUrl);
  return MIXIN_TAB.slice(0, 32).map(n => raw[n] || '').join('');
}

async function wbiKeys() {
  if (wbiCache && Date.now() - wbiCache.at < 20 * 60 * 1000) return wbiCache;
  const { json } = await getJSON(API + '/x/web-interface/nav');
  const d = (json && json.data) || {};
  const img = d.wbi_img || {};
  if (!img.img_url || !img.sub_url) throw new Error('nav 里没有 wbi_img（code=' + (json && json.code) + '）');
  wbiCache = { key: mixinKeyOf(img.img_url, img.sub_url), at: Date.now(), isLogin: !!d.isLogin, uname: d.uname || '' };
  return wbiCache;
}

function signParams(params, key) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    clean[k] = String(v).replace(/[!'()*]/g, '');
  }
  const qs = Object.keys(clean).sort().map(k => encodeURIComponent(k) + '=' + encodeURIComponent(clean[k])).join('&');
  const wts = Math.floor(Date.now() / 1000);
  const w_rid = crypto.createHash('md5').update(qs + '&wts=' + wts + key).digest('hex');
  return qs + '&wts=' + wts + '&w_rid=' + w_rid;
}

async function signedGet(pathname, params) {
  const { key } = await wbiKeys();
  return getJSON(API + pathname + '?' + signParams(params, key));
}

const mmss = s => {
  const n = Number(s) || 0;
  return Math.floor(n / 60) + ':' + String(Math.floor(n % 60)).padStart(2, '0');
};

async function main() {
  const out = { at: new Date().toISOString(), steps: {} };
  const query = argOf('query', '周杰伦');
  const max = Number(argOf('max', 8)) || 8;

  // 1) nav：拿到 WBI key 与登录态
  const keys = await wbiKeys();
  out.steps.nav = { ok: true, isLogin: keys.isLogin, uname: keys.uname, mixinKeyLen: keys.key.length, mixed: keys.key.slice(0, 6) + '…' };

  // 2) 搜索（不带签名先试一次，确认「必须签名」这个前提仍然成立）
  const rawUrl = API + '/x/web-interface/wbi/search/type?search_type=video&keyword=' + encodeURIComponent(query) + '&order=click&page=1';
  const raw = await getJSON(rawUrl);
  out.steps.searchUnsigned = { code: raw.json.code, message: raw.json.message || '' };

  const s = await signedGet('/x/web-interface/wbi/search/type', { search_type: 'video', keyword: query, order: 'click', page: 1 });
  const items = ((s.json.data && s.json.data.result) || []).filter(x => x.bvid).slice(0, max);
  out.steps.searchSigned = {
    code: s.json.code,
    message: s.json.message || '',
    total: s.json.data && s.json.data.numResults,
    count: items.length,
    top: items.slice(0, 3).map(v => ({ bvid: v.bvid, title: v.title, author: v.author, play: v.play, dur: v.duration }))
  };
  if (!items.length) return finish(out);

  // 3) 详情：拿 cid（playurl 必须要）
  const first = items[0];
  const v = await getJSON(API + '/x/web-interface/view?bvid=' + first.bvid);
  const vd = v.json.data || {};
  const page0 = (vd.pages || [])[0] || {};
  out.steps.view = {
    code: v.json.code, bvid: first.bvid, title: vd.title, cid: page0.cid,
    pages: (vd.pages || []).length, duration: vd.duration, owner: (vd.owner && vd.owner.name) || ''
  };
  if (!page0.cid) return finish(out);

  // 4) 取流：同样先确认「不带签名会被拒」
  const pRaw = await getJSON(API + '/x/player/wbi/playurl?bvid=' + first.bvid + '&cid=' + page0.cid + '&fnval=16&fnver=0&fourk=1');
  out.steps.playUrlUnsigned = { code: pRaw.json.code, message: pRaw.json.message || '' };

  const p = await signedGet('/x/player/wbi/playurl', { bvid: first.bvid, cid: page0.cid, fnval: 16, fnver: 0, fourk: 1 });
  const pd = (p.json && p.json.data) || {};
  const dash = pd.dash || {};
  const audios = (dash.audio || []).map(a => ({
    id: a.id, codecs: a.codecs, mime: a.mime_type, bandwidth: a.bandwidth,
    kbps: Math.round((a.bandwidth || 0) / 1000),
    hasBackup: (a.backup_url || a.backupUrl || []).length
  })).sort((x, y) => y.bandwidth - x.bandwidth);
  out.steps.playUrl = {
    code: p.json.code, message: p.json.message || '',
    dashDuration: dash.duration, audioTracks: audios, durlCount: (pd.durl || []).length
  };
  if (!audios.length) return finish(out);

  // 5) 音频地址能不能真拉：带 Referer 取前 1KB
  const best = (dash.audio || []).slice().sort((x, y) => y.bandwidth - x.bandwidth)[0];
  const url = best.base_url || best.baseUrl;
  const head = await req(url, { headers: { Range: 'bytes=0-1023' } });
  out.steps.range = {
    status: head.status, bytes: head.body.length,
    contentType: head.headers['content-type'] || '',
    contentRange: head.headers['content-range'] || '',
    acceptRanges: head.headers['accept-ranges'] || ''
  };
  const noRef = await req(url, { headers: { Range: 'bytes=0-1023', Referer: '', Origin: '' } });
  out.steps.rangeNoReferer = { status: noRef.status, bytes: noRef.body.length };

  // 6) 收藏夹（没有登录态时应回 -101，而不是 JSON 解析失败）
  const f = await getJSON(API + '/x/v3/fav/folder/created/list-all?up_mid=1');
  out.steps.favNoAuth = { code: f.json.code, message: f.json.message || '' };

  finish(out);
}

function finish(out) {
  const dir = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bil-report.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');

  const s = out.steps;
  const line = (k, v) => console.log(k.padEnd(18), v);
  line('nav', 'isLogin=' + s.nav.isLogin + ' mixinKey=' + s.nav.mixinKeyLen + ' 位');
  if (s.searchUnsigned) line('搜索(无签名)', 'code=' + s.searchUnsigned.code + ' ' + s.searchUnsigned.message);
  if (s.searchSigned) line('搜索(签名)', 'code=' + s.searchSigned.code + ' 命中=' + s.searchSigned.count + '/' + s.searchSigned.total);
  if (s.view) line('详情', s.view.title + ' · cid=' + s.view.cid + ' · ' + mmss(s.view.duration));
  if (s.playUrlUnsigned) line('取流(无签名)', 'code=' + s.playUrlUnsigned.code);
  if (s.playUrl) line('取流(签名)', 'code=' + s.playUrl.code + ' 音轨=' + s.playUrl.audioTracks.map(a => a.id + '/' + a.kbps + 'k').join(' '));
  if (s.range) line('Range', s.range.status + ' ' + s.range.bytes + 'B ' + s.range.contentType + ' ' + s.range.contentRange);
  if (s.rangeNoReferer) line('Range(无Referer)', s.rangeNoReferer.status + ' ' + s.rangeNoReferer.bytes + 'B');
  if (s.favNoAuth) line('收藏夹(未登录)', 'code=' + s.favNoAuth.code + ' ' + s.favNoAuth.message);
  console.log('报告', file);
}

main().catch(e => { console.error('PROBE CRASH:', e && e.message); process.exit(1); });
