'use strict';
/*
 * 探针（一次性）：酷狗「曲库三类列表 + 扫码登录」端点摸底
 * ------------------------------------------------------------------
 * 目的：在动渲染层之前，先确认哪些端点在不带签名的情况下真的能返回数据，
 * 以及返回体的形状（字段名），据此决定适配层怎么归一化、哪些能力要显式降级。
 *
 * 用法：node tools/probe-kg-home.js [--cookie "kg_mid=...; token=..."]
 * 输出：每个候选端点的 status / 耗时 / 关键字段 / 失败原因，最后打印汇总建议。
 */
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');

const UA_M = 'Mozilla/5.0 (Linux; Android 11; MI 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0 Mobile Safari/537.36';
const DIV = 'kg_mid=' + crypto.randomBytes(16).toString('hex') + '; kg_dfid=' + crypto.randomBytes(16).toString('hex');

const args = process.argv.slice(2);
const argOf = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
};
const COOKIE = argOf('--cookie') || DIV;

function get(url, { cookie = COOKIE, ua = UA_M, timeout = 12000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: Object.assign({ 'accept': 'application/json, text/plain, */*', 'user-agent': ua, 'cookie': cookie, 'referer': 'https://m.kugou.com/' }, headers)
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > 4 * 1024 * 1024) { req.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, ms: Date.now() - t0, body, size });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('KG_TIMEOUT')));
    req.on('error', e => reject(e));
  });
}

const short = s => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, 140);

async function tryJson(name, url, pick) {
  try {
    const r = await get(url);
    let j = null;
    try { j = JSON.parse(r.body); } catch { /* 非 JSON */ }
    if (!j) {
      console.log(`- ${name}: HTTP ${r.status} ${r.ms}ms · 非 JSON · ${short(r.body)}`);
      return { name, ok: false, status: r.status, ms: r.ms, note: 'non-json' };
    }
    const info = pick(j) || {};
    const ok = !!info.ok;
    console.log(`- ${name}: HTTP ${r.status} ${r.ms}ms · ${ok ? 'OK' : 'FAIL'} ` +
      JSON.stringify(Object.assign({ code: j.error_code || j.status || j.errcode || j.code }, info)));
    return { name, ok, status: r.status, ms: r.ms, json: j, info };
  } catch (e) {
    console.log(`- ${name}: 请求异常 ${short(e && e.message || e)}`);
    return { name, ok: false, error: String(e && e.message || e) };
  }
}

const count = (arr) => (Array.isArray(arr) ? arr.length : 0);

(async () => {
  console.log('=== 一、扫码登录端点（无签名）===');
  const qrTargets = [
    ['qrcode a1018p3', 'https://login-user.kugou.com/v1/qrcode?appid=1018&plat=3&qrcode_txt=&srcappid=2919&clientver=2000&clienttime=' + Date.now()],
    ['qrcode a1001p2', 'https://login-user.kugou.com/v1/qrcode?appid=1001&plat=2&srcappid=2919&clientver=2000&clienttime=' + Date.now()],
    ['qrcode a1005p4', 'https://login-user.kugou.com/v1/qrcode?appid=1005&plat=4&srcappid=2919&clientver=2000&clienttime=' + Date.now()],
    ['qrcode a1018p3 web', 'https://login-user.kugou.com/v1/qrcode?appid=1018&plat=3&srcappid=2919&clientver=2000&clienttime=' + Date.now()]
  ];
  for (const [n, u] of qrTargets) {
    await tryJson(n, u, j => ({ keys: Object.keys(j).slice(0, 8), qrcode: short(j.qrcode || j.data && j.data.qrcode), key: short(j.qrcode_key || j.key), err: short(j.error) }));
  }

  console.log('\n=== 二、每日推荐 ===');
  const daily = [
    ['everyday/recommend', 'https://mobiles.kugou.com/api/v3/everyday/recommend?format=json&page=1&pagesize=20&plat=0&version=8000'],
    ['everyday/recommend v2', 'https://mobiles.kugou.com/api/v3/everyday/recommend?format=json&page=1&pagesize=20&plat=0&version=8000&withsong=1'],
    ['m.kugou everyday', 'https://m.kugou.com/plist/index&json=true']
  ];
  for (const [n, u] of daily) {
    await tryJson(n, u, j => {
      const d = j.data || j;
      const arr = d.info || d.list || d.songs || d.data || [];
      return { ok: count(arr) > 0 || (d && Object.keys(d).length > 0), n: count(arr), keys: Object.keys(d).slice(0, 8) };
    });
  }

  console.log('\n=== 三、推荐歌单 ===');
  const recs = [
    ['personalized/recommend', 'https://mobiles.kugou.com/api/v3/personalized/recommend?format=json&page=1&pagesize=20&plat=0&version=8000'],
    ['plist/index', 'https://m.kugou.com/plist/index&json=true'],
    ['plist/list/1', 'https://m.kugou.com/plist/list/1?json=true'],
    ['toplist', 'https://mobiles.kugou.com/api/v3/rank/list?format=json&page=1&pagesize=20&plat=0&version=8000']
  ];
  for (const [n, u] of recs) {
    await tryJson(n, u, j => {
      const d = j.data || j.plist || j;
      const arr = d.list || d.info || d.recommand || d.recommend || [];
      return { ok: count(arr) > 0, n: count(arr), keys: Object.keys(d).slice(0, 8) };
    });
  }

  console.log('\n=== 四、个人创建的歌单（需登录 cookie）===');
  const mine = [
    ['user/playlist', 'https://mobiles.kugou.com/api/v3/user/playlist?format=json&page=1&pagesize=20&plat=0&version=8000'],
    ['plist/list (me)', 'https://m.kugou.com/plist/list/0?json=true'],
    ['user/playlist v2', 'https://mobiles.kugou.com/api/v3/user/playlist?format=json&page=1&pagesize=20&plat=1&version=9108&appid=1005']
  ];
  for (const [n, u] of mine) {
    await tryJson(n, u, j => {
      const d = j.data || j;
      const arr = d.info || d.list || [];
      return { ok: count(arr) > 0, n: count(arr), keys: Object.keys(d).slice(0, 8), err: short(j.error || d.error) };
    });
  }

  console.log('\n=== 五、歌单详情（用于「点开推荐歌单」）===');
  const detail = [
    ['plist/list/438291', 'https://m.kugou.com/plist/list/438291?json=true'],
    ['playlist/detail', 'https://mobiles.kugou.com/api/v3/special/song?format=json&specialid=438291&page=1&pagesize=30&plat=0&version=8000']
  ];
  for (const [n, u] of detail) {
    await tryJson(n, u, j => {
      const d = j.data || j;
      const arr = j.songs || d.songs || d.info || [];
      return { ok: count(arr) > 0, n: count(arr), keys: Object.keys(d).slice(0, 8) };
    });
  }

  console.log('\n=== 六、会员曲取链复核（确认鉴权字段生效位置）===');
  const vipHash = '1f7e7659b9fff4fb6f71562a61bbc25f';
  for (const [n, u] of [
    ['playInfo 无身份', 'https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=' + vipHash],
    ['playInfo + cookie', 'https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=' + vipHash + '&album_id='],
    ['trackercdn v2', 'https://trackercdn.kugou.com/i/v2/?hash=' + vipHash + '&key=' + crypto.createHash('md5').update(vipHash + 'kgcloudv2').digest('hex') + '&br=hq&appid=1005&pid=2&version=9108&cmd=25&behavior=play']
  ]) {
    await tryJson(n, u, j => ({ ok: !!(j.url || j.play_url), status: j.status, err: short(j.error || j.error_msg), pay: j.pay_type, priv: j.privilege }));
  }
})().catch(e => { console.error('CRASH', (e && e.stack) || e); process.exit(1); });
