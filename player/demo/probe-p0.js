'use strict';
/**
 * 探针：P0 效率与体验优化验收（v0.9.7）
 * ---------------------------------------------------------------------------
 * 验证：
 *   1. rAF 按播放态启停：空载 / 暂停态 rafId === 0（不空转），播放态 rafId > 0，
 *      再次暂停后 rafId === 0；暂停状态下手动 seek 仍立即刷新进度条、时间与歌词；
 *   2. 异步写盘 + playpos.json 独立落盘：播放期周期性 persistPos(false) 只写 playpos.json、
 *      不重写整份 settings.json；暂停 / force 时同步落盘两处，重启能从 playpos.json 恢复最新进度；
 *   3. 歌词切行 O(1)：任意时刻仅有一行带 .on，且回跳/前跳准确切换；
 *   4. 进度条常驻起止时间（#tCur / #tDur）：载入曲目后显示总时长，播放/seek 后实时推进，
 *      清空停止后复位 0:00，最小窗口 860×560 无溢出；
 *   5. app:version 在开发/探针脚本直跑下返回 package.json 版本（不再返回 Electron 版本号）。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const pkgVer = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);

process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-p0-'));
app.setPath('userData', tmp);

const mediaDir = path.join(tmp, 'media');
fs.mkdirSync(mediaDir, { recursive: true });
const wav = path.join(mediaDir, 'p0-01.wav');
const lrc = path.join(mediaDir, 'p0-01.lrc');
fs.copyFileSync(path.join(root, 'demo', 'demo.wav'), wav);
fs.writeFileSync(lrc, '[00:00.00]第一句歌词\n[00:02.00]第二句歌词\n[00:05.00]第三句歌词\n');

const tracks = [{ path: wav, title: 'P0测试曲', artist: '探针', album: 'P0', duration: 42, codec: 'WAV' }];
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(tracks));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false,
  autoCheckUpdate: false,
  playMode: 'seq',
  playlist: [{ id: wav, title: 'P0测试曲', artist: '探针', duration: 42 }]
}, null, 2));

const logPath = path.join(root, 'demo', 'probe-p0.log');
fs.writeFileSync(logPath, '');
const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
  try { console.log(line); } catch {}
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

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
    if (lvl >= 2 && !/Autofill|DevTools/.test(msg)) errors.push(msg);
  });
});

(async () => {
  require(path.join(root, 'main.js'));
  const js = code => win.webContents.executeJavaScript(code, true);
  await waitFor(() => !!win && !win.webContents.isLoading());
  win.showInactive();
  await waitFor(() => win.isVisible(), 6000);
  await waitFor(() => js(`S.q.length === 1 && document.querySelector('#verNum')?.textContent === ${JSON.stringify('v' + pkgVer)}`), 6000);
  await sleep(400);

  log('=== 1. app:version 一致性 ===');
  const verTxt = await js(`document.querySelector('#verNum')?.textContent`);
  const verApi = await js(`window.api.appVersion()`);
  ok('app:version 返回 package.json 版本', verApi === pkgVer && verTxt === 'v' + pkgVer, `${verApi} / ${verTxt}`);

  log('\n=== 2. rAF 按播放态启停 + 暂停态 seek 立即刷新 ===');
  const idleRaf = await js(`rafId`);
  ok('启动静止（暂停）时 rAF 不空转', idleRaf === 0, 'rafId=' + idleRaf);

  // 暂停态 seek：进度条、常驻时间与歌词都必须立刻更新
  await js(`audio.currentTime = 3.2; 0`);
  await sleep(250);
  const pausedSeek = await js(`({
    rafId,
    tCur: document.querySelector('#tCur')?.textContent,
    tDur: document.querySelector('#tDur')?.textContent,
    onIdx: [...document.querySelectorAll('.ln.on')].map(n => Number(n.dataset.i))
  })`);
  log('  pausedSeek:', JSON.stringify(pausedSeek));
  ok('暂停态 seek 后 rAF 仍保持停止', pausedSeek.rafId === 0);
  ok('暂停态 seek 立即刷新常驻当前时间与总时长', pausedSeek.tCur === '0:03' && pausedSeek.tDur !== '0:00', JSON.stringify(pausedSeek));
  ok('暂停态 seek 立即高亮唯一对应歌词行（O(1)）', JSON.stringify(pausedSeek.onIdx) === '[1]', JSON.stringify(pausedSeek.onIdx));

  // 开始播放：rAF 启动
  await js(`togglePlay(); 0`);
  await waitFor(() => js(`S.playing === true && rafId > 0`), 5000);
  const playRaf = await js(`rafId`);
  ok('播放启动后 rAF 运行中', playRaf > 0, 'rafId=' + playRaf);

  // 切到第 3 句再回跳第 1 句，校验 O(1) 切行不会残留多余 .on
  await js(`audio.currentTime = 6.0; 0`);
  await sleep(250);
  const on3 = await js(`[...document.querySelectorAll('.ln.on')].map(n => Number(n.dataset.i))`);
  await js(`audio.currentTime = 0.5; 0`);
  await sleep(250);
  const on1 = await js(`[...document.querySelectorAll('.ln.on')].map(n => Number(n.dataset.i))`);
  ok('切行与回跳均只保留唯一高亮行', JSON.stringify(on3) === '[2]' && JSON.stringify(on1) === '[0]', `${JSON.stringify(on3)} -> ${JSON.stringify(on1)}`);

  log('\n=== 3. 周期进度只写 playpos.json，不重写 settings.json ===');
  const setPath = path.join(tmp, 'settings.json');
  const posPath = path.join(tmp, 'playpos.json');
  const mtimeBefore = fs.statSync(setPath).mtimeMs;
  await sleep(120);
  await js(`audio.currentTime = 14.5; posClock = 0; persistPos(false); 0`);
  await waitFor(() => fs.existsSync(posPath), 4000);
  await sleep(300);
  const mtimeAfterPeriodic = fs.statSync(setPath).mtimeMs;
  const posDisk = JSON.parse(fs.readFileSync(posPath, 'utf8'));
  log('  playpos.json:', JSON.stringify(posDisk), 'settings mtime unchanged:', mtimeAfterPeriodic === mtimeBefore);
  ok('周期进度已写入 playpos.json', !!posDisk && posDisk.id === wav && posDisk.t >= 14);
  ok('周期进度没有重写整份 settings.json', mtimeAfterPeriodic === mtimeBefore);

  // 暂停：停止 rAF 并把进度同步落进 settings.json
  await js(`togglePlay(); 0`);
  await waitFor(() => js(`S.playing === false && rafId === 0`), 5000);
  await sleep(450);
  const setDisk = JSON.parse(fs.readFileSync(setPath, 'utf8'));
  ok('暂停后 rAF 立即停止', (await js(`rafId`)) === 0);
  ok('暂停时同步落盘 settings.json 的 playPos', !!setDisk.playPos && setDisk.playPos.id === wav && setDisk.playPos.t >= 14);

  // 模拟进程异常退出后磁盘上 playpos.json 比 settings.json 更新：验证 settings:get 优先合并 playpos.json
  fs.writeFileSync(posPath, JSON.stringify({ id: wav, t: 22, at: Date.now() + 10000 }));
  const mergedSet = await js(`window.api.getSettings()`);
  ok('settings:get 优先合并更新的 playpos.json 进度', !!mergedSet.playPos && mergedSet.playPos.id === wav && Math.round(mergedSet.playPos.t) === 22,
    JSON.stringify(mergedSet.playPos && { t: mergedSet.playPos.t }));

  // 验证真实 reload 后恢复进度（不触发旧页面覆写：先同步 S.settings.playPos 与 playpos.json 一致）
  await js(`S.settings.playPos = { id: ${JSON.stringify(wav)}, t: 22, at: Date.now() + 10000 }; 0`);
  win.webContents.reload();
  await waitFor(() => js(`S.q.length === 1 && audio.currentTime >= 20`), 6000);
  const restoredT = await js(`Math.round(audio.currentTime)`);
  ok('reload 后恢复到最新进度（~22s）', restoredT >= 21 && restoredT <= 23, 'ct=' + restoredT);

  log('\n=== 4. 最小窗口 860×560 布局无溢出 & 停止复位 ===');
  win.setSize(860, 560);
  await sleep(250);
  const ov = await js(`({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight
  })`);
  ok('860×560 下新增常驻时间无溢出', ov.sw <= ov.cw && ov.sh <= ov.ch, JSON.stringify(ov));

  await js(`stopPlayback(); 0`);
  await sleep(200);
  const resetSt = await js(`({
    rafId,
    tCur: document.querySelector('#tCur')?.textContent,
    tDur: document.querySelector('#tDur')?.textContent
  })`);
  ok('停止清空后常驻时间复位为 0:00 且 rAF 停止', resetSt.rafId === 0 && resetSt.tCur === '0:00' && resetSt.tDur === '0:00', JSON.stringify(resetSt));

  log('\n=== 5. 渲染层报错 ===');
  ok('渲染层无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  log('\n----------------------------------------');
  log(`通过 ${pass} 项，失败 ${fail} 项`);
  app.exit(fail ? 1 : 0);
})().catch(e => {
  log('FAIL ' + (e && e.stack || e));
  app.exit(1);
});
