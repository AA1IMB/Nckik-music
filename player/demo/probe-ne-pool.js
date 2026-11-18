'use strict';
/**
 * 探针：验证「被放弃的响应体占着 CDN 连接」这个假设（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 现象：协议处理里 net.fetch 在第 9 次切歌之后开始要 20~35 秒才拿到响应头，
 * 而同样一次 fetch 在干净进程里只要 17ms。怀疑上一个响应体被媒体元素中止后，
 * 上游连接没有被释放（Chromium 对同一 host 的 HTTP/1.1 连接数有上限），
 * 新请求就排队等老连接超时。
 *
 * 做法：同一个直链连续发 10 次请求，每次只读第一块就丢掉（不 cancel），
 * 再量一次「完整的」请求。如果耗时从毫秒级掉到几十秒，假设成立。
 */
const { app, net } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-pool-'));
app.setPath('userData', tmp);

const logPath = path.join(root, 'demo', 'probe-ne-pool.log');
fs.writeFileSync(logPath, '');
const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
  try { console.log(line); } catch {}
};
const ne = require(path.join(root, 'netease.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const race = (p, ms) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('TIMEOUT_' + ms)), ms))]);

async function timedFetch(url, label, { readBody = true } = {}) {
  const t = Date.now();
  const res = await race(net.fetch(url, { headers: { Range: 'bytes=0-' } }), 60000);
  const head = Date.now() - t;
  let bodyMs = 0, bytes = 0;
  if (readBody) {
    const tb = Date.now();
    const buf = await race(res.arrayBuffer(), 60000);
    bodyMs = Date.now() - tb;
    bytes = buf.byteLength;
  }
  log(`  ${label}: 头 ${head}ms  body ${bodyMs}ms  ${bytes} 字节  status=${res.status}`);
  return head;
}

app.whenReady().then(async () => {
  const info = await ne.songUrl(28481104);
  const url = info.url;
  log('直链 host=' + new URL(url).host + '  size=' + info.size);
  log('');

  log('=== 基线：完整读取 3 次 ===');
  for (let i = 1; i <= 3; i++) await timedFetch(url, 'baseline #' + i);
  log('');

  /* 模拟「媒体元素中止」：拿到响应头和第一块数据后直接丢掉，不 cancel。
   * 项目的协议处理把 res.body 原样交给 Electron，中止时没有人调 cancel，
   * 上游连接就停在半空。这里保持引用防止 GC 掩盖问题。 */
  const keep = [];
  log('=== 漏 10 个未读完的响应体（模拟中止播放） ===');
  for (let i = 1; i <= 10; i++) {
    const t = Date.now();
    const res = await race(net.fetch(url, { headers: { Range: 'bytes=0-' } }), 60000);
    const reader = res.body.getReader();
    const first = await race(reader.read(), 30000);
    keep.push({ res, reader, first });
    log(`  漏 #${i}: 头 ${Date.now() - t}ms，读到 ${first && first.value ? first.value.length : 0} 字节后丢弃`);
  }
  log('');

  log('=== 漏完之后再量一次完整请求 ===');
  const slow = await timedFetch(url, 'after-leak');
  log('');
  log(slow > 5000
    ? `结论：连接被占满，干净进程 17ms 的请求现在要 ${slow}ms —— 假设成立`
    : `结论：仍然是 ${slow}ms，连接没被占住 —— 假设不成立，得换方向`);
  app.quit();
}).catch(e => { log('CRASH ' + ((e && e.stack) || e)); app.quit(); });
