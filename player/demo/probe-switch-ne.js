'use strict';
/**
 * 探针：切歌卡加载态 —— 网易云真实曲库路径（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 上一个探针（probe-switch.js）用本地 WAV，15/15 全过，说明本地 media:// 路径没问题。
 * 用户真实曲库是 16 首网易云 + 1 首本地，所以这里复制真实账号/曲库来测 neaudio:// 路径。
 *
 * 关键埋点（用于精确定位卡在哪个 await）：
 *   - 包一层 HTMLMediaElement.prototype.play，记录每次 play() 何时返回/被拒/一直 pending；
 *   - 记录 audio 的完整事件时间线；
 *   - 每次切歌给 15s 超时，卡住时打印 readyState/networkState/src/事件尾部。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const realData = path.join(app.getPath('appData'), 'NckiksMusic');
process.env.NCKIK_SKIP_MIGRATION = '1';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-swne-'));
app.setPath('userData', tmp);
for (const f of ['library.json', 'settings.json', 'ne-auth.bin']) {
  const s = path.join(realData, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(tmp, f));
}

const logPath = path.join(root, 'demo', 'probe-switch-ne.log');
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

let win = null;
const errors = [];
app.on('browser-window-created', (_e, w) => {
  win = w;
  w.webContents.on('console-message', (_ev, lvl, msg) => {
    if (lvl >= 2 && !/Autofill|DevTools|Electron Security|快捷键冲突/.test(msg)) errors.push(msg);
  });
});
const js = code => win.webContents.executeJavaScript(code, true);

const snapSrc = `(() => ({
  i: S.i, seq: loadSeq, playing: !!S.playing, paused: audio.paused,
  rs: audio.readyState, ns: audio.networkState,
  ct: +((audio.currentTime || 0).toFixed(2)),
  src: String(audio.src || '').slice(0, 34),
  err: audio.error ? audio.error.code : null,
  net: !!S.ne.loggedIn,
  title: (document.querySelector('#npT') || {}).textContent || '',
  ceT: (document.querySelector('#ceT') || {}).textContent || '',
  ceD: (document.querySelector('#ceD') || {}).textContent || '',
  toast: (document.querySelector('#toast') || {}).textContent || '',
  play: window.__play || null,
  ev: (window.__ev || []).slice(-8)
}))()`;
const snap = () => js(snapSrc);

const instrument = () => js(`(() => {
  window.__ev = [];
  window.__plays = [];
  const mark = n => () => window.__ev.push(n + '@' + Math.round(performance.now()));
  ['loadstart','progress','suspend','abort','error','emptied','stalled','loadedmetadata',
   'loadeddata','canplay','canplaythrough','playing','waiting','seeking','seeked','pause','ended']
    .forEach(n => audio.addEventListener(n, mark(n)));
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const t0 = Math.round(performance.now());
    const rec = { t0, at: window.__ev.length, state: 'pending', src: String(this.src || '').slice(-24) };
    window.__plays.push(rec);
    window.__play = rec;
    const p = orig.call(this);
    p.then(() => { rec.state = 'resolved'; rec.ms = Math.round(performance.now()) - t0; })
     .catch(e => { rec.state = 'rejected:' + (e && e.name); rec.ms = Math.round(performance.now()) - t0; });
    return p;
  };
  return true;
})()`);

/* 点击曲库第 idx 行，等到「真的在出声」。
 * 修复后允许出现「提示后跳到下一首」的收尾 —— 那也算没卡住。 */
async function clickSwitch(idx, timeoutMs = 15000) {
  const t0 = Date.now();
  const r = await js(`(() => { const el = document.querySelector('#libList .item[data-i="${idx}"]'); if (!el) return 'NO_ROW'; el.click(); return 'CLICKED'; })()`);
  if (r !== 'CLICKED') return { done: false, why: r, ms: 0, snap: await snap() };
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await snap();
    if (last.i === idx && !last.paused && last.ct > 0.05) return { done: true, ms: Date.now() - t0, snap: last };
    const skipped = last.i !== idx && !last.paused && last.ct > 0.05 && /跳过|超时|无法播放/.test(last.toast);
    if (skipped) return { done: true, skipped: true, ms: Date.now() - t0, snap: last };
    await sleep(150);
  }
  return { done: false, why: 'timeout', ms: Date.now() - t0, snap: last };
}

(async () => {
  require(path.join(root, 'main.js'));
  await waitForWin();
  await waitFor(async () => (await js('S.tracks.length')) > 0, 8000);
  await instrument();
  await sleep(1500);

  /* ---------- 0. 环境：登录态 + 网络 ---------- */
  log('=== 0. 环境 ===');
  let s = await snap();
  log('  登录态=' + s.net + '  曲目数=' + (await js('S.tracks.length')));
  const netOk = await js(`fetch('https://music.163.com/api/version').then(r => r.ok).catch(e => 'ERR:' + e.message)`);
  log('  music.163.com 可达=' + netOk);
  ok('账号已登录（能测真实网易云播放）', s.net === true);

  /* ---------- 1. 启动播放 ---------- */
  log('=== 1. 启动后初始状态 ===');
  log('  ' + JSON.stringify(s));
  const started = await waitFor(async () => { const x = await snap(); return !x.paused && x.ct > 0; }, 12000);
  ok('启动后开始播放', started, JSON.stringify(await snap()));

  /* ---------- 2. 逐首手动切歌（真实曲库） ---------- */
  log('=== 2. 逐首手动切歌 ===');
  const n = await js('S.tracks.length');
  const stuck = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) await sleep(2000);           // 让每首播一会儿，模拟真实使用
    const r = await clickSwitch(i, 15000);
    const sn = r.snap || {};
    const line = `#${i + 1} 「${sn.title || '?'}」 ${r.done ? 'OK ' + r.ms + 'ms' : 'STUCK ' + r.why}` +
      ` play=${JSON.stringify(sn.play)} rs=${sn.rs} ns=${sn.ns} err=${sn.err} toast=${sn.toast}`;
    log('  ' + line);
    if (!r.done) {
      stuck.push(i);
      log('    卡住快照：' + JSON.stringify(sn));
    }
    ok(`切到第 ${i + 1} 首`, r.done, `${r.ms}ms`);
  }

  /* ---------- 3. 重复切同一首（缓存命中路径） ---------- */
  log('=== 3. 同一首反复切 3 次 ===');
  for (let k = 0; k < 3; k++) {
    const r = await clickSwitch(1, 15000);
    ok(`第 ${k + 1} 次切到第 2 首`, r.done, `${r.ms}ms`);
    if (!r.done) log('    ' + JSON.stringify(r.snap));
    await sleep(1200);
  }

  /* ---------- 4. 网易云 ←→ 本地 交叉切 ---------- */
  log('=== 4. 网易云 ↔ 本地交叉切歌 ===');
  const localIdx = await js('S.tracks.findIndex(t => !/^ne:/.test(t.path))');
  if (localIdx >= 0) {
    for (const idx of [localIdx, 2, localIdx, 3]) {
      const r = await clickSwitch(idx, 15000);
      ok(`交叉切到第 ${idx + 1} 首`, r.done, `${r.ms}ms`);
      if (!r.done) log('    ' + JSON.stringify(r.snap));
      await sleep(1500);
    }
  } else {
    log('  （曲库里没有本地曲目，跳过）');
  }

  /* ---------- 5. 快速连点 5 首 ---------- */
  log('=== 5. 快速连点 ===');
  for (const idx of [4, 6, 2, 8, 5]) {
    if (idx < n) await js(`document.querySelector('#libList .item[data-i="${idx}"]').click()`);
    await sleep(150);
  }
  const settled = await waitFor(async () => { const x = await snap(); return !x.paused && x.ct > 0.05; }, 20000);
  s = await snap();
  log('  收敛：' + JSON.stringify(s));
  ok('快速连点后能出声', settled, `i=${s.i} play=${JSON.stringify(s.play)}`);
  ok('快速连点后没有死锁在 pending 的 play()', !s.play || s.play.state !== 'pending', JSON.stringify(s.play));

  /* ---------- 6. 长播 40 分钟级之外的稳态：连续播 60 秒再切 ---------- */
  log('=== 6. 连续播放 60 秒后再切 ===');
  await sleep(60000);
  s = await snap();
  log('  切之前：' + JSON.stringify(s));
  ok('60 秒后仍在播放', !s.paused && s.ct > 30, `ct=${s.ct}`);
  const r6 = await clickSwitch(7, 20000);
  ok('长播后切歌能完成', r6.done, `${r6.ms}ms`);
  if (!r6.done) log('  卡住快照：' + JSON.stringify(r6.snap));

  /* ---------- 汇总 ---------- */
  const plays = await js('JSON.stringify(window.__plays.slice(-12))');
  log('');
  log('=== 最近的 play() 记录 ===');
  log('  ' + plays);
  log('=== 渲染层报错 ===');
  log(errors.length ? errors.join('\n') : '  （无）');
  log('');
  log('----------------------------------------');
  log(`通过 ${pass} 项，失败 ${fail} 项；卡住 ${stuck.length} 次`);
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
async function waitFor(fn, ms = 8000, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}
