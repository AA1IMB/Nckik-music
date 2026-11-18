'use strict';
/**
 * 探针：手动切歌卡在加载态（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 复现路径：启动 → 播放一段时间 → 手动切歌 → 界面停在加载态。
 * 目的是定位「卡住」卡在哪个 await / 哪个 audio 事件上，而不是靠肉眼猜测。
 *
 * 做法：
 *   1. 隔离 userData，预置 4 首本地曲目（demo.wav 的副本，互不干扰）；
 *   2. 在渲染层给 audio 挂一条完整的事件时间线（loadstart…playing…waiting…error）；
 *   3. 用「真实点击 .item」走和用户一样的路径切歌，并给每次都加超时；
 *   4. 记录每次 playIndex 是否返回、返回耗时、以及卡住时的 readyState/networkState/src。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-switch-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'library.json'), '[]');

const logPath = path.join(root, 'demo', 'probe-switch.log');
fs.writeFileSync(logPath, '');
const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
  try { console.log(line); } catch {}
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

/* ---------- 造 4 首互不相同的曲目 ---------- */
const srcWav = path.join(root, 'demo', 'demo.wav');
const tracks = ['A', 'B', 'C', 'D'].map((n, i) => {
  const p = path.join(tmp, `switch-${n}.wav`);
  fs.copyFileSync(srcWav, p);
  return {
    path: p, title: `切歌测试 ${n}`, artist: '本地生成', album: '探针',
    duration: 42, codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 705600, lossless: true
  };
});
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(tracks, null, 2));

let win = null;
const errors = [];
app.on('browser-window-created', (_e, w) => {
  win = w;
  w.webContents.on('console-message', (_ev, lvl, msg) => {
    if (lvl >= 2 && !/Autofill|DevTools|Electron Security/.test(msg)) errors.push(msg);
  });
});

const js = code => win.webContents.executeJavaScript(code, true);

/* 渲染层状态快照 */
const snapSrc = `(() => ({
  i: S.i, seq: loadSeq, playing: !!S.playing, paused: audio.paused, ended: audio.ended,
  rs: audio.readyState, ns: audio.networkState,
  dur: Number.isFinite(audio.duration) ? +audio.duration.toFixed(1) : null,
  ct: +((audio.currentTime || 0).toFixed(2)),
  src: String(audio.src || '').slice(-28),
  err: audio.error ? audio.error.code : null,
  title: (document.querySelector('#npT') || {}).textContent || '',
  ceT: (document.querySelector('#ceT') || {}).textContent || '',
  ceD: (document.querySelector('#ceD') || {}).textContent || '',
  toast: (document.querySelector('#toast') || {}).textContent || '',
  ev: (window.__ev || []).slice(-10)
}))()`;
const snap = () => js(snapSrc);

/* 给播放器挂事件时间线 */
const instrument = () => js(`(() => {
  window.__ev = [];
  const mark = n => () => window.__ev.push(n + '@' + Math.round(performance.now()));
  ['loadstart','progress','suspend','abort','error','emptied','stalled','loadedmetadata',
   'loadeddata','canplay','canplaythrough','playing','waiting','seeking','seeked','pause','ended']
    .forEach(n => audio.addEventListener(n, mark(n)));
  return true;
})()`);

/* 走真实点击路径切歌，并给一个超时：算得出「playIndex 到底返不返回」 */
async function clickSwitch(idx, timeoutMs = 9000) {
  const t0 = Date.now();
  const p = js(`(() => { const el = document.querySelector('#libList .item[data-i="${idx}"]'); if (!el) return 'NO_ROW'; el.click(); return 'CLICKED'; })()`);
  const clicked = await p;
  if (clicked !== 'CLICKED') return { clicked, done: false, ms: 0 };
  // playIndex 是 async 但它没被 click 返回，只能等状态收敛：等到「是新曲目且真的在出声」
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await snap();
    if (last.i === idx && !last.paused && last.rs >= 3 && last.ct > 0) {
      return { clicked, done: true, ms: Date.now() - t0, snap: last };
    }
    await sleep(120);
  }
  return { clicked, done: false, ms: Date.now() - t0, snap: last };
}

(async () => {
  require(path.join(root, 'main.js'));
  await waitForWin();
  await waitFor(async () => (await js('S.tracks.length')) === 4, 8000);
  await instrument();
  await sleep(1200);

  /* ---------- 1. 启动后的初始播放 ---------- */
  log('=== 1. 启动播放 ===');
  let s = await snap();
  log('  ' + JSON.stringify(s));
  const started = await waitFor(async () => { const x = await snap(); return !x.paused && x.ct > 0; }, 6000);
  ok('启动后能自动播放', started, JSON.stringify(await snap()));
  ok('标题是第 1 首', (await snap()).i === 0 && (await snap()).title === '切歌测试 A');

  /* ---------- 2. 播一会儿，让解码器/网络栈进入稳态 ---------- */
  log('=== 2. 连续播放 6 秒 ===');
  const c0 = (await snap()).ct;
  await sleep(6000);
  const after = await snap();
  ok('播放中进度在推进', after.ct > c0 + 3, `ct ${c0} → ${after.ct}`);

  /* ---------- 3. 刚打开软件立刻切歌（用户说这时是好的） ---------- */
  log('=== 3. 早期切歌 0 → 1 ===');
  let r = await clickSwitch(1, 9000);
  log('  ' + JSON.stringify(r.snap));
  ok('早期切歌能完成', r.done, `${r.ms}ms`);

  /* ---------- 4. 「播放一段时间」后再切（复现路径） ---------- */
  log('=== 4. 播放 15 秒后切歌 1 → 2 ===');
  await sleep(15000);
  log('  切之前：' + JSON.stringify(await snap()));
  r = await clickSwitch(2, 12000);
  log('  切之后：' + JSON.stringify(r.snap));
  ok('播放一段时间后切歌能完成', r.done, `${r.ms}ms`);

  /* ---------- 5. 连续切歌 2 → 3 → 0 → 1 ---------- */
  log('=== 5. 连续切歌 ===');
  for (const idx of [3, 0, 1]) {
    const rr = await clickSwitch(idx, 12000);
    ok(`切到第 ${idx + 1} 首`, rr.done, `${rr.ms}ms  rs=${rr.snap && rr.snap.rs} ns=${rr.snap && rr.snap.ns}`);
    if (!rr.done) log('  卡住快照：' + JSON.stringify(rr.snap));
    await sleep(1500);
  }

  /* ---------- 6. 快速连点 ---------- */
  log('=== 6. 快速连点（120ms 间隔） ===');
  for (const idx of [2, 0, 3, 1, 2]) {
    await js(`document.querySelector('#libList .item[data-i="${idx}"]').click()`);
    await sleep(120);
  }
  const settled = await waitFor(async () => {
    const x = await snap();
    return x.i === 2 && !x.paused && x.ct > 0;
  }, 12000);
  s = await snap();
  log('  收敛后：' + JSON.stringify(s));
  ok('快速连点后收敛到最后一次点击的那首', settled, `i=${s.i} paused=${s.paused} rs=${s.rs}`);
  ok('快速连点后没有残留错误', s.err === null && !/无法播放/.test(s.toast), `err=${s.err} toast=${s.toast}`);

  /* ---------- 7. 切歌后暂停 / 续播 ---------- */
  log('=== 7. 切歌后暂停与续播 ===');
  const rp = await clickSwitch(0, 12000);
  ok('暂停前切歌成功', rp.done, `${rp.ms}ms`);
  await sleep(1200);
  await js('audio.pause()');
  await sleep(600);
  const paused = await snap();
  ok('能暂停', paused.paused === true && paused.playing === false, `paused=${paused.paused}`);
  const cp = paused.ct;
  await sleep(900);
  ok('暂停后进度不再走', Math.abs((await snap()).ct - cp) < 0.2, `ct ${cp} → ${(await snap()).ct}`);
  await js('audio.play()');
  const resumed = await waitFor(async () => { const x = await snap(); return !x.paused && x.ct > cp + 0.3; }, 6000);
  ok('续播能继续', resumed, JSON.stringify(await snap()));

  /* ---------- 8. 长播（模拟「播放一段时间」的长尾） ---------- */
  log('=== 8. 快进到 35s 继续播放，再切歌 ===');
  await js('audio.currentTime = 35');
  await sleep(4000);
  const tail = await snap();
  log('  ' + JSON.stringify(tail));
  const r8 = await clickSwitch(3, 12000);
  ok('尾部切歌能完成', r8.done, `${r8.ms}ms`);
  if (!r8.done) log('  卡住快照：' + JSON.stringify(r8.snap));

  /* ---------- 汇总 ---------- */
  log('');
  log('=== 渲染层报错 ===');
  log(errors.length ? errors.join('\n') : '  （无）');
  log('');
  log('----------------------------------------');
  log(`通过 ${pass} 项，失败 ${fail} 项`);
  setTimeout(() => app.quit(), 200);
})().catch(e => {
  log('PROBE CRASH ' + ((e && e.stack) || e));
  setTimeout(() => app.quit(), 200);
});

function waitForWin() {
  return new Promise(res => {
    const t = setInterval(() => {
      if (win && !win.webContents.isLoading()) { clearInterval(t); win.showInactive(); res(); }
    }, 80);
  });
}
async function waitFor(fn, ms = 8000, step = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}
