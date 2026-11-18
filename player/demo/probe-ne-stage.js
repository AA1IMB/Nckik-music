'use strict';
/**
 * 探针：把 neaudio 的两级拆开量（不属于项目代码）
 * ---------------------------------------------------------------------------
 * probe-switch-ne.js 里两首曲子卡住，特征是 media 元素只有 loadstart+stalled，
 * 既没有 loadedmetadata 也没有 error —— 说明「协议请求一直没回来」。
 * 协议处理只有两级：ne.songUrl(id) 解析直链、net.fetch(直链) 拉数据。
 * 这里分别计时，看哪一级挂住，并对比「能放的曲子」。
 */
const { app, net, safeStorage } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const realData = path.join(app.getPath('appData'), 'NckiksMusic');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-ne-'));
app.setPath('userData', tmp);
const authSrc = path.join(realData, 'ne-auth.bin');
if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, path.join(tmp, 'ne-auth.bin'));

const logPath = path.join(root, 'demo', 'probe-ne-stage.log');
fs.writeFileSync(logPath, '');
const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
  try { console.log(line); } catch {}
};

const ne = require(path.join(root, 'netease.js'));
const CAP = ms => new Promise((_, rj) => setTimeout(() => rj(new Error('PROBE_TIMEOUT_' + ms)), ms));
const race = (p, ms) => Promise.race([p, CAP(ms)]);

async function stage(id, label) {
  log(`--- ${id} ${label}`);
  /* 1. 解析直链 */
  let info = null, t = Date.now();
  try {
    info = await race(ne.songUrl(id), 40000);
  } catch (e) {
    log(`  songUrl ✗ ${Date.now() - t}ms  ${e.code || ''} ${e.message}`);
    return;
  }
  log(`  songUrl ✓ ${Date.now() - t}ms  br=${info.br} level=${info.level} size=${info.size} expi=${info.expi}`);
  log(`  url=${String(info.url).slice(0, 120)}`);

  /* 2. 拉数据（带 Range，和 media 元素一样） */
  for (const [name, headers] of [['Range 0-2047', { Range: 'bytes=0-2047' }], ['无 Range', {}]]) {
    t = Date.now();
    let res;
    try {
      res = await race(net.fetch(info.url, { headers }), 20000);
    } catch (e) {
      log(`  net.fetch(${name}) ✗ ${Date.now() - t}ms  ${e.message}`);
      continue;
    }
    const head = Date.now() - t;
    log(`  net.fetch(${name}) ✓ 头 ${head}ms  status=${res.status} ct=${res.headers.get('content-type')} cl=${res.headers.get('content-length')} cr=${res.headers.get('content-range')}`);
    /* 3. 读 body：协议处理是直接把 res.body 交出去的，body 不来媒体元素就一直 waiting */
    t = Date.now();
    try {
      const buf = await race(res.arrayBuffer(), 20000);
      log(`  body ✓ ${Date.now() - t}ms  ${buf.byteLength} 字节  head=${[...new Uint8Array(buf).slice(0, 8)].map(b => b.toString(16)).join(' ')}`);
    } catch (e) {
      log(`  body ✗ ${Date.now() - t}ms  ${e.message}`);
    }
  }
}

app.whenReady().then(async () => {
  let cookieOk = false;
  try {
    if (safeStorage.isEncryptionAvailable() && fs.existsSync(path.join(tmp, 'ne-auth.bin'))) {
      ne.setCookie(safeStorage.decryptString(fs.readFileSync(path.join(tmp, 'ne-auth.bin'))));
      cookieOk = true;
    }
  } catch (e) { log('解密凭证失败：' + e.message); }
  log('hasCookie=' + ne.hasCookie() + ' (解密成功=' + cookieOk + ')');
  log('');

  /* 能放的对照 + 卡住的两首 + 之前快速连点挂住的那首 */
  await stage(28481104, '娱乐天空（探针里能放）');
  await stage(2707652860, '半句再见（探针里卡住）');
  await stage(5231510, '没那么简单（探针里卡住）');
  await stage(2020981543, '陈江河·苏江水（快速连点后挂住）');
  await stage(2124977797, '雨燕（重复切时卡住）');

  log('');
  log('done');
  app.quit();
}).catch(e => { log('CRASH ' + ((e && e.stack) || e)); app.quit(); });
