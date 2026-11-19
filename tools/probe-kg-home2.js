'use strict';
/*
 * 探针（一次性）：把上面「可能可用」的端点真实返回体打出来，确认字段名与可点开的详情接口。
 * 只读、不改任何东西。
 */
const https = require('node:https');
const crypto = require('node:crypto');

const UA_M = 'Mozilla/5.0 (Linux; Android 11; MI 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0 Mobile Safari/537.36';
const COOKIE = 'kg_mid=' + crypto.randomBytes(16).toString('hex') + '; kg_dfid=' + crypto.randomBytes(16).toString('hex');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': UA_M, cookie: COOKIE, accept: 'application/json, text/plain, */*', referer: 'https://m.kugou.com/' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve({ redirect: res.headers.location, status: res.statusCode });
        return;
      }
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    req.setTimeout(12000, () => req.destroy(new Error('KG_TIMEOUT')));
    req.on('error', reject);
  });
}

const j = s => { try { return JSON.parse(s); } catch { return null; } };
const slim = (o, n = 12) => JSON.stringify(o, (k, v) => (typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v), 0).slice(0, 1400) + `  …(${n})`;

(async () => {
  console.log('=== A. m.kugou.com/plist/index&json=true ===');
  {
    const r = await get('https://m.kugou.com/plist/index&json=true');
    const d = j(r.body);
    const p = d && d.plist;
    console.log('top keys:', d && Object.keys(d).slice(0, 12));
    console.log('plist keys:', p && Object.keys(p));
    if (p) {
      for (const k of Object.keys(p).slice(0, 6)) {
        const v = p[k];
        console.log(`  ${k}: ${Array.isArray(v) ? 'array(' + v.length + ')' : typeof v} ${Array.isArray(v) && v[0] ? slim(v[0], 1) : ''}`);
      }
    }
  }

  console.log('\n=== B. rank/list（排行榜）===');
  {
    const r = await get('https://mobiles.kugou.com/api/v3/rank/list?format=json&page=1&pagesize=6&plat=0&version=8000');
    const d = j(r.body);
    const info = d && d.data && d.data.info;
    console.log('total:', d && d.data && d.data.total, 'n:', Array.isArray(info) ? info.length : 0);
    if (Array.isArray(info) && info[0]) {
      console.log('item keys:', Object.keys(info[0]));
      console.log('item[0]:', slim({
        rankid: info[0].rankid, rankname: info[0].rankname, imgurl: info[0].imgurl,
        imgurl_replace: info[0].imgurl_replace, update_frequency: info[0].update_frequency,
        songcount: info[0].songcount, intro: info[0].intro
      }, 1));
    }
  }

  console.log('\n=== C. rank/song（榜单里的歌）===');
  for (const rankid of [8888, 6666, 23784]) {
    const r = await get(`https://mobiles.kugou.com/api/v3/rank/song?format=json&rankid=${rankid}&page=1&pagesize=3&plat=0&version=8000`);
    const d = j(r.body);
    const info = d && d.data && d.data.info;
    const one = Array.isArray(info) && info[0];
    console.log(`rank ${rankid}: status=${d && d.status} n=${Array.isArray(info) ? info.length : 0} ` +
      (one ? 'hash=' + String(one.hash).slice(0, 10) + ' name=' + String(one.songname || one.filename).slice(0, 20) + ' keys=' + Object.keys(one).slice(0, 10).join(',') : ''));
  }

  console.log('\n=== D. plist/index 里的歌单详情（跟 301）===');
  for (const u of ['https://m.kugou.com/plist/list/1?json=true', 'https://m.kugou.com/plist/list/1?json=true&page=1']) {
    const r = await get(u);
    console.log(u, '→', r.redirect || ('HTTP ' + r.status + ' ' + String(r.body).slice(0, 80)));
  }

  console.log('\n=== E. 歌单详情候选 ===');
  for (const u of [
    'https://mobiles.kugou.com/api/v3/special/song?format=json&specialid=438291&page=1&pagesize=3&plat=0&version=8000&area_code=1',
    'https://mobiles.kugou.com/api/v3/plist/song?format=json&listid=438291&page=1&pagesize=3&plat=0&version=8000',
    'https://m.kugou.com/plist/list/438291?json=true&page=1'
  ]) {
    const r = await get(u);
    if (r.redirect) { console.log(u, '→ redirect', r.redirect); continue; }
    const d = j(r.body);
    console.log(u.slice(28), '→', r.status, d ? JSON.stringify({ status: d.status, err: d.error, keys: Object.keys(d).slice(0, 8) }) : String(r.body).slice(0, 80));
  }

  console.log('\n=== F. 用户歌单（带假 token 看错误是否变）===');
  for (const u of [
    'https://mobiles.kugou.com/api/v3/user/playlist?format=json&page=1&pagesize=3&plat=0&version=8000&userid=424242&token=fake',
    'https://m.kugou.com/?json=true'
  ]) {
    const r = await get(u);
    console.log(u.slice(8, 60), '→', r.status, String(r.body).slice(0, 100).replace(/\s+/g, ' '));
  }
})().catch(e => { console.error('CRASH', (e && e.stack) || e); process.exit(1); });
