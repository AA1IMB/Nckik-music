'use strict';
/**
 * 探针：v0.9.9 P2 桌面生态、迷你模式、桌面歌词、睡眠定时、省电低动效与 WOFF2 字体
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const pkgVer = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.9.9');

process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-p2-'));
const mediaDir = path.join(tmp, 'media');
fs.mkdirSync(mediaDir, { recursive: true });

function makeWav(file, secs = 10) {
  const sr = 8000, ch = 1, bps = 16;
  const dataLen = sr * secs * ch * (bps / 8);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * ch * (bps / 8), 28);
  buf.writeUInt16LE(ch * (bps / 8), 32);
  buf.writeUInt16LE(bps, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  fs.writeFileSync(file, buf);
}
const wav1 = path.join(mediaDir, 'p2-one.wav');
const wav2 = path.join(mediaDir, 'p2-two.wav');
makeWav(wav1, 10);
makeWav(wav2, 10);
fs.writeFileSync(path.join(mediaDir, 'p2-one.lrc'), [
  '[00:00.50]桌面歌词同步测试第一句',
  '[00:04.00]迷你模式进度验证第二句'
].join('\n'));

app.setPath('userData', tmp);
const tracks = [
  { path: wav1, title: 'P2 Song One', artist: 'Artist A', album: 'P2', duration: 10, codec: 'WAV' },
  { path: wav2, title: 'P2 Song Two', artist: 'Artist B', album: 'P2', duration: 10, codec: 'WAV' }
];
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(tracks));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark',
  volume: 0.4,
  muted: true,
  playMode: 'seq',
  autoCheckUpdate: false,
  playlist: tracks.map(t => ({ id: t.path, title: t.title, artist: t.artist, duration: t.duration }))
}));

const logPath = path.join(root, 'demo', 'probe-p2.log');
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
  if (!win) win = w;
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
  await sleep(600);

  log('=== 1. WOFF2 苹方字体与版本号 ===');
  const fontOk = await waitFor(() => js(`document.fonts.check('16px "PingFang"')`), 6000);
  const woff2Exists = fs.existsSync(path.join(root, 'assets', 'fonts', 'PingFangSC-Medium.woff2'));
  const verTxt = await js(`document.querySelector('#verNum')?.textContent`);
  ok('PingFangSC-Medium.woff2 存在且字体正常加载', woff2Exists && fontOk);
  ok('版本号显示与 package.json 一致', verTxt === 'v' + pkgVer, String(verTxt));

  log('\n=== 2. 系统托盘与关闭到托盘行为 ===');
  const trayInfo = await js(`window.api.trayInfo()`);
  log('  trayInfo:', JSON.stringify(trayInfo));
  ok('系统托盘已初始化且默认关闭行为为 exit', trayInfo && trayInfo.ready === true && trayInfo.closeAction === 'exit');

  await js(`openDrawer(document.querySelector('#dSet')); document.querySelector('#segClose b[data-c="tray"]').click(); 0`);
  await waitFor(async () => {
    const info = await js(`window.api.trayInfo()`);
    return info && info.closeAction === 'tray';
  }, 3000);
  await sleep(100);
  const stTray = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
  ok('切换关闭到托盘后落盘 closeAction=tray', stTray.closeAction === 'tray');

  win.close();
  await sleep(250);
  const hiddenNotDestroyed = !win.isDestroyed() && !win.isVisible();
  ok('关闭到托盘模式下触发关闭只隐藏窗口而不退出进程', hiddenNotDestroyed);
  win.showInactive();
  await sleep(200);
  await js(`document.querySelector('#segClose b[data-c="exit"]').click(); closeDrawers(); 0`);
  await sleep(250);

  log('\n=== 3. 任务栏播放进度条 ===');
  await js(`playAt(0, { autoplay: true }); 0`);
  await waitFor(() => js(`!audio.paused && audio.readyState >= 2`), 5000);
  await sleep(300);
  await js(`P2.syncTaskbarProgress(3.0, true); 0`);
  await sleep(120);
  const tbPlay = win.__taskbarProgress;
  ok('播放中任务栏进度条为 normal 且进度有效', tbPlay && tbPlay.mode === 'normal' && tbPlay.progress > 0, JSON.stringify(tbPlay));

  await js(`togglePlay(); 0`);
  await sleep(150);
  const tbPause = win.__taskbarProgress;
  ok('暂停后任务栏进度条切换为 paused', tbPause && tbPause.mode === 'paused', JSON.stringify(tbPause));

  await js(`openDrawer(document.querySelector('#dSet')); document.querySelector('#swTaskbarProg').click(); 0`);
  await sleep(250);
  const tbOff = win.__taskbarProgress;
  ok('关闭任务栏播放进度开关后立即清除进度条 (mode=none)', tbOff && tbOff.mode === 'none', JSON.stringify(tbOff));
  await js(`document.querySelector('#swTaskbarProg').click(); closeDrawers(); 0`);
  await sleep(150);

  log('\n=== 4. 紧凑迷你模式（Mini Player） ===');
  await js(`document.querySelector('#btnMini').click(); 0`);
  await waitFor(() => js(`document.body.classList.contains('mini')`), 4000);
  await sleep(150);
  const miniBounds = win.getBounds();
  const miniAot = win.isAlwaysOnTop();
  const miniDom = await js(`({
    t: document.querySelector('#miniT')?.textContent,
    shellVis: getComputedStyle(document.querySelector('#miniShell')).display !== 'none'
  })`);
  log('  mini:', JSON.stringify({ miniBounds, miniAot, miniDom }));
  ok('进入迷你模式：窗口缩至紧凑尺寸且置顶', miniBounds.width <= 420 && miniBounds.height <= 140 && miniAot === true);
  ok('迷你模式显示当前曲目名与精简浮窗', miniDom.shellVis === true && miniDom.t === 'P2 Song One');

  await js(`document.querySelector('#miniExpand').click(); 0`);
  await waitFor(() => js(`!document.body.classList.contains('mini')`), 4000);
  await sleep(150);
  const normBounds = win.getBounds();
  ok('退出迷你模式后还原主窗口尺寸并取消置顶', normBounds.width >= 860 && normBounds.height >= 560 && win.isAlwaysOnTop() === false);

  log('\n=== 5. 桌面悬浮歌词独立窗口 + 穿透锁定（仅在设置内控制） ===');
  const mainClean = await js(`({ hasBtnDlyr: !!document.querySelector('#btnDlyr'), hasBtnSleep: !!document.querySelector('#btnSleep'), rightBtns: document.querySelectorAll('.side.r .cb').length })`);
  ok('主界面已移除桌面歌词与睡眠定时按键（底栏右侧保持 3 个按键）', !mainClean.hasBtnDlyr && !mainClean.hasBtnSleep && mainClean.rightBtns === 3, JSON.stringify(mainClean));

  await js(`openDrawer(document.querySelector('#dSet')); document.querySelector('#swDlyr').click(); 0`);
  await waitFor(() => BrowserWindow.getAllWindows().length === 2, 5000);
  const dwin = BrowserWindow.getAllWindows().find(w => w !== win);
  await waitFor(() => !!dwin && !dwin.webContents.isLoading(), 5000);
  await sleep(350);
  await js(`audio.currentTime = 1.6; syncClock(); renderFrameOnce(); P2.syncPlay(); 0`);
  await sleep(200);
  const dlyrDom = await dwin.webContents.executeJavaScript(`({
    line: document.getElementById('line')?.textContent,
    p: document.getElementById('line')?.style.getPropertyValue('--p')
  })`, true);
  log('  dlyrDom:', JSON.stringify(dlyrDom));
  ok('设置页开启桌面歌词后独立窗口同步当前歌词与进度', dlyrDom.line.includes('桌面歌词同步测试第一句') && parseFloat(dlyrDom.p || '0') > 0);

  await js(`document.querySelector('#swDlyrLock').click(); 0`);
  await sleep(200);
  const lockSt = await js(`window.api.dlyrGet()`);
  const dlyrLockedCls = await dwin.webContents.executeJavaScript(`document.body.classList.contains('locked')`, true);
  ok('锁定桌面歌词穿透状态同步到独立窗口', lockSt.locked === true && dlyrLockedCls === true);

  await js(`document.querySelector('#swDlyr').click(); 0`);
  await waitFor(() => BrowserWindow.getAllWindows().length === 1, 5000);
  ok('设置页关闭桌面歌词后无窗口残留', BrowserWindow.getAllWindows().length === 1);

  log('\n=== 6. 睡眠定时（设置页芯片选择 & 播完当前曲停止） ===');
  await js(`document.querySelector('#sleepChips .sleep-chip[data-sleep="15"]').click(); 0`);
  await sleep(120);
  const sl15 = await js(`({
    on: document.querySelector('#sleepChips .sleep-chip[data-sleep="15"]')?.classList.contains('on'),
    txt: document.querySelector('#setSleep')?.textContent
  })`);
  ok('设置页选择 15 分钟睡眠定时后状态与芯片高亮正确', sl15.on === true && sl15.txt.includes('剩余'));

  await js(`document.querySelector('#sleepChips .sleep-chip[data-sleep="track"]').click(); closeDrawers(); playAt(0, { autoplay: true }); 0`);
  await waitFor(() => js(`!audio.paused`), 4000);
  await js(`audio.dispatchEvent(new Event('ended')); 0`);
  await sleep(200);
  const afterTrackEnd = await js(`({ i: S.i, playing: S.playing, sleepMode: P2.state.sleepMode })`);
  log('  sleep track end:', JSON.stringify(afterTrackEnd));
  ok('「播完当前曲停止」触发 ended 后停在当前曲不自动切下一首', afterTrackEnd.i === 0 && afterTrackEnd.playing === false && afterTrackEnd.sleepMode === 'off');

  log('\n=== 7. 省电 / 低动效模式与零报错 ===');
  await js(`openDrawer(document.querySelector('#dSet')); document.querySelector('#swLowMotion').click(); 0`);
  await sleep(250);
  const lowSt = await js(`({
    cls: document.body.classList.contains('low-motion'),
    lnFilter: getComputedStyle(document.querySelector('#lnInner .ln:not(.on)') || document.body).filter
  })`);
  const stLow = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
  log('  lowMotion:', JSON.stringify(lowSt));
  ok('开启省电低动效模式后去掉非当前句 blur 滤镜并持久化', lowSt.cls === true && lowSt.lnFilter === 'none' && stLow.lowMotion === true);
  ok('主窗与桌面歌词渲染层无任何 JS 报错', errors.length === 0, errors.join(' | '));

  log(`\n----------------------------------------\n通过 ${pass} 项，失败 ${fail} 项`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  log('PROBE CRASH:', (e && e.stack) || e);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(2);
});
