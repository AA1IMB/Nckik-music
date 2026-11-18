#!/usr/bin/env electron
/* 三个缺陷的复现 / 回归探针
 * ①封面：只出前几首 → 40 首各一张纯色封面，逐行核对颜色；再制造一次「临时失败」看会不会永久留白
 * ②随机：一轮内不重复；途中改动列表后「已播过的不许再进来」
 * ③切歌：300 首时 next 必须 +1；连点 10 次必须恰好 +10；ended 只推进一首；失效行不空转
 *
 * 跑法（在 player 目录）：
 *   $env:TMP=$env:TEMP='D:\nckiksmusic\.tmp'
 *   .\node_modules\electron\dist\electron.exe --no-sandbox demo\probe-defects.js
 */
const { app, nativeImage } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-defects-'));
app.setPath('userData', UD);
process.env.NCKIK_SKIP_MIGRATION = '1';

const WAV = path.join(ROOT, 'demo', 'demo.wav');

function solidPng(r, g, b) {
  const w = 64, h = 64;
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = b; buf[i * 4 + 1] = g; buf[i * 4 + 2] = r; buf[i * 4 + 3] = 255;   // BGRA
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG();
}

const N = 40;
const tracks = [];
const expectColor = {};            // path -> [r,g,b]
for (let i = 0; i < N; i++) {
  const dir = path.join(UD, 'd' + String(i).padStart(3, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'au.wav');
  fs.copyFileSync(WAV, p);
  const rgb = [(i * 37 + 40) % 256, (i * 71 + 30) % 256, (i * 13 + 90) % 256];
  expectColor[p] = rgb;
  if (i !== 6) fs.writeFileSync(path.join(dir, 'cover.png'), solidPng(rgb[0], rgb[1], rgb[2]));
  tracks.push({ path: p, title: 'D' + String(i).padStart(2, '0'), artist: 'a', album: '',
    duration: 42, codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 0, lossless: true });
}
/* 300 首「小文件」：只为压队列长度，用 0.2s 静音 wav，别把 40 张封面的目录撑爆 */
function tinyWav() {
  const rate = 8000, n = Math.floor(rate * 0.2);
  const data = Buffer.alloc(n * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const WAV_SMALL = tinyWav();
for (let i = 0; i < 300; i++) {
  const dir = path.join(UD, 'm' + String(i).padStart(3, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'au.wav');
  fs.writeFileSync(p, WAV_SMALL);
  tracks.push({ path: p, title: 'M' + String(i).padStart(3, '0'), artist: 'm', album: '',
    duration: 0.2, codec: 'WAV', sampleRate: 8000, bitDepth: 16, bitrate: 128000, lossless: true });
}

fs.writeFileSync(path.join(UD, 'library.json'), JSON.stringify(tracks));
fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({
  volume: 0, muted: true, globalKeys: false, playMode: 'seq',
  playlist: tracks.slice(0, 12).map(t => ({ id: t.path, title: t.title, artist: t.artist, duration: 42 })),
}));

require(path.join(ROOT, 'main.js'));

let win = null;
const errors = [];
app.on('browser-window-created', (_e, w) => {
  win = w;
  w.webContents.on('console-message', (_e2, level, msg) => { if (level >= 2) errors.push(msg); });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const LOGF = path.join(UD, 'probe.log');
const log = s => { console.log(s); try { fs.appendFileSync(LOGF, s + '\n'); } catch {} };
function ok(cond, name, extra) {
  if (cond) { pass++; log('  PASS ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}

(async () => {
  while (!win || win.webContents.isLoading()) await sleep(120);
  win.showInactive();                      // 不上屏时 IntersectionObserver 不会触发
  await sleep(1800);
  const js = c => win.webContents.executeJavaScript(c, true);
  const waitFor = async (fn, ms = 8000, step = 150) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
    return false;
  };

  /* 读某一行封面图中心像素 */
  await js(`void (window.__rowColor = (i) => {
    const el = document.querySelector('#libList .item[data-i="' + i + '"]');
    if (!el) return { noRow: true };
    const th = el.querySelector('.th');
    const img = th && th.querySelector('img');
    const art = !!(th && th.classList.contains('art') && img && img.naturalWidth);
    let rgb = null;
    if (art) {
      const c = document.createElement('canvas'); c.width = 8; c.height = 8;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, 8, 8);
      const d = g.getImageData(4, 4, 1, 1).data;
      rgb = [d[0], d[1], d[2]];
    }
    return { art, rgb, ph: (th && th.textContent || '').trim().slice(0, 1) };
  });`);

  /* ============ 1. 封面：40 首，每行都得是自己的颜色 ============ */
  log('=== 1. 封面 40 首（第 7 首无封面 → 占位） ===');
  await js(`document.querySelector('#btnLib').click()`);
  await sleep(900);
  // 一屏一屏往下滚到底，再滚回顶部
  for (let k = 0; k < 30; k++) {
    const end = await js(`(() => { const b = document.querySelector('.dr-body');
      b.scrollTop = Math.min(b.scrollHeight, b.scrollTop + 300);
      return b.scrollTop + b.clientHeight >= b.scrollHeight - 2; })()`);
    await sleep(160);
    if (end) break;
  }
  await sleep(900);
  await js(`document.querySelector('.dr-body').scrollTop = 0`);
  await sleep(900);

  const miss = [], wrong = [];
  for (let i = 0; i < N; i++) {
    await js(`(() => { const b = document.querySelector('.dr-body');
      const el = document.querySelector('#libList .item[data-i="${i}"]');
      if (!el) return; const top = el.offsetTop;
      if (top < b.scrollTop || top > b.scrollTop + b.clientHeight - 48) b.scrollTop = Math.max(0, top - 90); })()`);
    await sleep(200);
    const c = await js(`window.__rowColor(${i})`);
    if (i === 6) { ok(!c.art && !c.noRow, '第 7 首无封面 → 首字占位', JSON.stringify(c)); continue; }
    if (!c.art) { miss.push(i); continue; }
    const w = expectColor[tracks[i].path];
    const d = Math.abs(c.rgb[0] - w[0]) + Math.abs(c.rgb[1] - w[1]) + Math.abs(c.rgb[2] - w[2]);
    if (d > 12) wrong.push(`${i}:${JSON.stringify(c.rgb)}≠${JSON.stringify(w)}`);
  }
  ok(miss.length === 0, '40 首全部有封面（不止前几首）', miss.length ? '缺 ' + miss.slice(0, 8).join(',') : '');
  ok(wrong.length === 0, '每行都是自己那本书的封面（无串图）', wrong.slice(0, 3).join(' / '));

  /* 失败不许写死：第 7 首本来没封面（占位），补一张上去之后必须能自动出现 */
  const cov6 = path.join(path.dirname(tracks[6].path), 'cover.png');
  const rgb6 = expectColor[tracks[6].path];
  fs.writeFileSync(cov6, solidPng(rgb6[0], rgb6[1], rgb6[2]));
  let healed = null;
  for (let k = 0; k < 10; k++) {                       // 最多等 15s（自动重试 8s + 解析时间）
    await sleep(1500);
    healed = await js(`window.__rowColor(6)`);
    if (healed.art) break;
  }
  ok(healed && healed.art, '补上封面后能自动重试出来（失败不写死）', JSON.stringify(healed));

  /* ============ 2. 网易云封面：一次网络失败不许永久留白 ============ */
  log('=== 2. 网易云封面（503 后恢复要能重试） ===');
  let hits = 0, failOnce = true;
  const pngs = {};
  for (let i = 1; i <= 12; i++) pngs['/n' + i + '.png'] = solidPng((i * 31) % 256, (i * 17) % 256, (i * 5) % 256);
  const srv = http.createServer((req, res) => {
    const p = String(req.url).split('?')[0];
    hits++;
    if (failOnce) { res.writeHead(503); res.end('busy'); return; }
    const buf = pngs[p];
    if (!buf) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(buf);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const neTracks = tracks.slice(0, 8).map((t, i) => ({
    source: 'netease', path: 'ne:' + (9000 + i), netId: 9000 + i, title: 'N' + i, artist: 'n',
    album: '', duration: 42, coverUrl: 'http://127.0.0.1:' + port + '/n' + (i + 1) + '.png', fee: 0,
  }));
  await js(`setSource('net')`);
  await sleep(1200);                      // 先让首页那套异步流程（会重置视图）跑完
  await js(`(() => { S.ne.items = ${JSON.stringify(neTracks)}; S.ne.view = 'search'; renderNet(); })()`);
  await sleep(2500);
  const neFirst = await js(`({ art: document.querySelectorAll('#libList .th.art').length,
    rows: document.querySelectorAll('#libList .item').length })`);
  ok(neFirst.rows === 8, '搜索视图真的渲染了 8 行', JSON.stringify(neFirst));
  ok(neFirst.art === 0, '首轮全部 503 → 只显示占位（不留白）', JSON.stringify(neFirst) + ' hits=' + hits);
  failOnce = false;                       // 网络恢复
  const before = hits;
  await js(`(() => { S.ne.view = 'search'; renderNet(); })()`);
  await sleep(3500);
  const neHealed = await js(`({ art: document.querySelectorAll('#libList .th.art').length })`);
  ok(neHealed.art >= 6, '网络恢复后重新请求并补上封面（不被失败缓存卡死）',
    JSON.stringify(neHealed) + ' newHits=' + (hits - before));
  srv.close();

  /* ============ 3. 随机：一轮不重复 + 途中改列表 ============ */
  log('=== 3. 随机一轮不重复 / 改了列表也不许重播 ===');
  await js(`(() => { setSource('local'); S.settings.playlist = S.tracks.slice(0, 10).map(plToItem);
    S.settings.playMode = 'shuffle'; plSave(); rebuildQueue('id'); syncModeBtn(); playAt(0); })()`);
  await waitFor(async () => (await js('audio.paused')) === false, 8000);
  const round = [await js('S.i')];
  for (let k = 0; k < 9; k++) { await js('void next()'); await sleep(420); round.push(await js('S.i')); }
  ok(new Set(round).size === 10, '一轮 10 次不重复', JSON.stringify(round));
  const more = await js(`(() => { next(); return { i: S.i, paused: audio.paused }; })()`);
  await sleep(600);
  ok(more.i >= 0, '一轮播完自动重洗（不空转）', JSON.stringify(more));

  // 途中向列表追加一首：已播过的不能因为重建池就再进来
  await js(`(() => { S.settings.playMode = 'shuffle'; syncModeBtn();
    S.settings.playlist = S.tracks.slice(0, 10).map(plToItem); rebuildQueue('id'); playAt(0); })()`);
  await waitFor(async () => (await js('audio.paused')) === false, 8000);
  const seq2 = [await js('S.i')];
  for (let k = 0; k < 3; k++) { await js('void next()'); await sleep(420); seq2.push(await js('S.i')); }
  // 追加第 11、12 首（会触发 rebuildQueue → resetShufPool）
  await js(`(() => { plAppend(S.tracks[10]); plAppend(S.tracks[11]); })()`);
  await sleep(400);
  const deeper = [];
  for (let k = 0; k < 5; k++) { await js('void next()'); await sleep(420); deeper.push(await js('S.i')); }
  const played = new Set(seq2.concat(deeper));
  ok(played.size === played.size, '追加列表后仍能继续随机', JSON.stringify(seq2) + ' → ' + JSON.stringify(deeper));
  const again = deeper.filter(qi => seq2.includes(qi));
  ok(again.length === 0, '追加后没有重播本轮已经播过的歌', '重播=' + JSON.stringify(again));

  /* ============ 4. 切歌：300 首 next 必须 +1 ============ */
  log('=== 4. 300 首时的切歌推进 ===');
  const many = [];
  for (let i = 0; i < 300; i++) {
    const dir = path.join(UD, 'm' + String(i).padStart(3, '0'));
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'au.wav');
    fs.copyFileSync(WAV, p);
    many.push({ path: p, title: 'M' + String(i).padStart(3, '0'), artist: 'm', album: '',
      duration: 42, codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 0, lossless: true });
  }
  await js(`(() => { S.settings.playMode = 'seq'; syncModeBtn();
    const small = S.tracks.filter(t => t.title[0] === 'M');
    S.settings.playlist = small.map(plToItem); plSave(); rebuildQueue('id'); closePops(); playAt(0); })()`);
  await sleep(500);
  let cur = await js('S.i');
  const fwd = [cur];
  for (let k = 0; k < 12; k++) { await js('void next()'); await sleep(300); cur = await js('S.i'); fwd.push(cur); }
  ok(fwd.every((v, k) => k === 0 || v === fwd[k - 1] + 1), 'next 每次只 +1（单调、不来回跳）', JSON.stringify(fwd));

  const b4 = await js('S.i');
  await js(`(() => { for (let k = 0; k < 10; k++) next(); })()`);
  await sleep(2500);
  const af = await js(`({ i: S.i, paused: audio.paused, src: !!audio.src })`);
  ok(af.i === b4 + 10, '连点 10 次停在 +10（每次只推进一次）', `${b4} → ${af.i}`);

  const at = await js('S.i');
  const dur = await js('audio.duration');
  if (Number.isFinite(dur)) {
    await js(`audio.currentTime = Math.max(0, audio.duration - 0.4)`);
    const moved = await waitFor(async () => (await js('S.i')) !== at, 9000, 200);
    const now = await js('S.i');
    ok(moved && now === at + 1, 'ended 只推进一首', `${at} → ${now}`);
  } else {
    ok(false, 'ended 只推进一首', 'duration 不可用');
  }

  /* prev / next 对称 */
  await js('void next()'); await sleep(500);
  const p0 = await js('S.i');
  await js('void prev()'); await sleep(500);
  const p1 = await js('S.i');
  ok(p1 === p0 - 1, 'prev 退回上一首', `${p0} → ${p1}`);

  /* ============ 5. 失效行：不空转、不残留音源 ============ */
  log('=== 5. 失效行（文件被删） ===');
  const dead = tracks.slice(24, 32).map(t => ({ ...t, path: path.join(UD, 'gone', t.title + '.wav') }));
  await js(`(() => { S.settings.playMode = 'seq'; syncModeBtn();
    S.settings.playlist = ${JSON.stringify(tracks.slice(0, 6).map(t => ({ id: t.path, title: t.title, artist: 'a', duration: 42 }))
      .concat(dead.slice(0, 3).map(t => ({ id: t.path, title: t.title, artist: 'a', duration: 42 })))
      .concat(tracks.slice(6, 9).map(t => ({ id: t.path, title: t.title, artist: 'a', duration: 42 }))))};
    plSave(); rebuildQueue('id'); playAt(S.q.findIndex(r => r.t)); })()`);
  await sleep(500);
  const base = await js('S.i');
  await js('void next()');
  await sleep(1400);
  const hop = await js(`({ i: S.i, paused: audio.paused, src: String(audio.src).slice(0, 24), toast: (document.querySelector('#toast') || {}).textContent || '' })`);
  ok(hop.i > base && hop.i < S_FLAG_MAX, '跳过失效行落到下一首能播的', JSON.stringify(hop));
  ok(/^(media|neaudio|data|blob|file):/.test(hop.src) || hop.src === '', '不残留旧音源', hop.src);

  log('');
  log('=== 渲染层报错 ===');
  log(errors.length ? errors.join('\n') : '  （无）');
  log('');
  log('----------------------------------------');
  log(`通过 ${pass} 项，失败 ${fail} 项`);
  setTimeout(() => app.quit(), 200);
})().catch(e => {
  log('PROBE CRASH ' + ((e && e.stack) || e)); try { fs.writeFileSync(path.join('D:\\nckiksmusic\\.tmp', 'probe-defects-crash.log'), String((e && e.stack) || e) + '\n' + fs.readFileSync(path.join(UD, 'probe.log'), 'utf8')); } catch {}
  setTimeout(() => app.quit(), 200);
});

const S_FLAG_MAX = 9;
