'use strict';
/**
 * 探针：Windows 任务栏缩略图工具栏（上一首 / 播放暂停 / 下一首）
 * ---------------------------------------------------------------------------
 * 验证：
 *   1. 启动即注册 3 个始终可点的按钮（上一首 / 播放 / 下一首），不带 disabled，
 *      图标非空且为 32×32；空列表点击不报错；
 *   2. 载入 3 首曲目进入播放列表后，缩略图提示同步曲目名；
 *   3. 窗口最小化到后台后：
 *      - 通过缩略图按钮 click 触发 播放 → 下一首；
 *      - 通过真实 Win32 WM_COMMAND (THBN_CLICKED=0x1800) 兜底触发 上一首 → 暂停；
 *      - 验证播放状态、图标/提示词（播放 ↔ 暂停）实时同步，且不还原最小化窗口；
 *   4. thumbar.log 正常记录事件；
 *   5. 渲染层无 JS 报错。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-thumbar-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'library.json'), '[]');
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark',
  volume: 0.2,
  playMode: 'seq',
  playlist: []
}));

const mediaDir = path.join(tmp, 'media');
fs.mkdirSync(mediaDir, { recursive: true });
const demoWav = path.join(root, 'demo', 'demo.wav');
const wavs = ['tb-01.wav', 'tb-02.wav', 'tb-03.wav'].map(name => {
  const dst = path.join(mediaDir, name);
  fs.copyFileSync(demoWav, dst);
  return dst;
});

const logPath = path.join(root, 'demo', 'probe-thumbar.log');
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

function postThbnClicked(w, btnId) {
  const hwndBuf = w.getNativeWindowHandle();
  const hwnd = hwndBuf.length === 8 ? Number(hwndBuf.readBigUInt64LE(0)) : hwndBuf.readUInt32LE(0);
  const py = `import ctypes; ctypes.windll.user32.PostMessageW(${hwnd}, 0x0111, (0x1800 << 16) | ${btnId}, 0)`;
  return new Promise(resolve => {
    const c = spawn('python', ['-c', py], { stdio: 'ignore' });
    c.on('exit', resolve);
  });
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
  await waitFor(() => !!win.__thumbar && win.__thumbar.calls > 0, 6000);

  log('=== 1. 空队列初始化（按钮始终可点，不带 disabled） ===');
  const tb0 = win.__thumbar;
  log('  ', JSON.stringify({
    applied: tb0.applied,
    calls: tb0.calls,
    dark: tb0.dark,
    playing: tb0.playing,
    buttons: tb0.buttons.map(b => ({ tooltip: b.tooltip, flags: b.flags, iconSize: b.iconSize, iconEmpty: b.iconEmpty }))
  }));
  ok('已调用 setThumbarButtons 注册工具栏', tb0.calls > 0, 'calls=' + tb0.calls + ' applied=' + tb0.applied);
  ok('按钮数量为 3', tb0.buttons.length === 3, String(tb0.buttons.length));
  ok('按钮顺序为 上一首 / 播放 / 下一首',
    tb0.buttons.map(b => b.tooltip).join('/') === '上一首/播放/下一首',
    tb0.buttons.map(b => b.tooltip).join('/'));
  ok('三个图标均有效且为 32×32',
    tb0.buttons.every(b => !b.iconEmpty && b.iconSize.width === 32 && b.iconSize.height === 32));
  ok('三个按钮均未设置 disabled',
    tb0.buttons.every(b => !b.flags.includes('disabled')));

  // 空队列点播放应安全提示而不报错
  tb0.buttons[1].click();
  await sleep(250);
  const emptyToast = await js(`document.querySelector('#toast')?.textContent || ''`);
  ok('空队列点击播放给出可读提示', emptyToast.includes('播放列表是空的'), emptyToast);

  log('\n=== 2. 载入 3 首曲目到播放列表 ===');
  const qLen = await js(`(async () => {
    const files = ${JSON.stringify(wavs)};
    const scanned = await window.api.scan(files, []);
    S.tracks = scanned.map((t, idx) => ({ ...t, title: 'T0' + (idx + 1), artist: '探针歌手' }));
    rebuildLibIndex();
    S.settings.playlist = S.tracks.map(plToItem);
    rebuildQueue();
    await playAt(0, { autoplay: false });
    return S.q.length;
  })()`);
  await waitFor(() => win.__thumbar && win.__thumbar.title === 'T01', 6000);
  const tb1 = win.__thumbar;
  ok('播放列表已载入 3 首', qLen === 3, String(qLen));
  ok('未播放时中间按钮为「播放」', tb1.buttons[1].tooltip === '播放', tb1.buttons[1].tooltip);
  ok('缩略图提示同步当前曲目名', tb1.title === 'T01', tb1.title);

  log('\n=== 3. 最小化到后台：click 与 Win32 WM_COMMAND 控播 ===');
  win.minimize();
  await waitFor(() => win.isMinimized(), 4000);
  await sleep(300);
  ok('窗口已最小化到后台', win.isMinimized() === true);

  // 3a. 点击「播放」
  win.__thumbar.buttons[1].click();
  await waitFor(() => win.__thumbar.playing === true, 6000);
  await sleep(600);
  const stPlay = await js(`({ playing: S.playing, paused: audio.paused, i: S.i, ct: Number(audio.currentTime.toFixed(2)) })`);
  log('  after play:', JSON.stringify(stPlay));
  ok('后台点击「播放」成功出声', stPlay.playing === true && stPlay.paused === false && stPlay.ct > 0, JSON.stringify(stPlay));
  ok('播放中中间按钮切换为「暂停」', win.__thumbar.buttons[1].tooltip === '暂停', win.__thumbar.buttons[1].tooltip);
  ok('点击控播不抢占还原最小化窗口', win.isMinimized() === true);

  // 3b. 点击「下一首」
  win.__thumbar.buttons[2].click();
  await waitFor(() => js(`S.i === 1 && S.playing === true`), 6000);
  await sleep(350);
  const stNext = await js(`({ playing: S.playing, paused: audio.paused, i: S.i, title: curTrack() && curTrack().title })`);
  log('  after next:', JSON.stringify(stNext));
  ok('后台点击「下一首」切到第 2 首并继续播放', stNext.i === 1 && stNext.playing === true && !stNext.paused, JSON.stringify(stNext));
  ok('切歌后中间按钮仍为「暂停」', win.__thumbar.buttons[1].tooltip === '暂停');
  ok('切歌后缩略图提示更新为 T02', win.__thumbar.title === 'T02', win.__thumbar.title);

  // 3c. 通过真实 Win32 WM_COMMAND (THBN_CLICKED + 40001) 触发「上一首」
  await js(`audio.currentTime = 0.2; 0`);
  await postThbnClicked(win, 40001);
  await waitFor(() => js(`S.i === 0 && S.playing === true`), 6000);
  await sleep(350);
  const stPrev = await js(`({ playing: S.playing, paused: audio.paused, i: S.i, title: curTrack() && curTrack().title })`);
  log('  after wm_command prev:', JSON.stringify(stPrev));
  ok('WM_COMMAND(THBN_CLICKED) 触发「上一首」切回第 1 首', stPrev.i === 0 && stPrev.playing === true && !stPrev.paused, JSON.stringify(stPrev));
  ok('切回后缩略图提示更新为 T01', win.__thumbar.title === 'T01', win.__thumbar.title);

  // 3d. 通过真实 Win32 WM_COMMAND (THBN_CLICKED + 40002) 触发「暂停」
  await postThbnClicked(win, 40002);
  await waitFor(() => win.__thumbar.playing === false, 6000);
  const stPause = await js(`({ playing: S.playing, paused: audio.paused, i: S.i })`);
  log('  after wm_command pause:', JSON.stringify(stPause));
  ok('WM_COMMAND(THBN_CLICKED) 触发「暂停」成功暂停', stPause.playing === false && stPause.paused === true);
  ok('暂停后中间按钮切回「播放」', win.__thumbar.buttons[1].tooltip === '播放', win.__thumbar.buttons[1].tooltip);

  log('\n=== 4. 诊断日志与渲染层报错 ===');
  const tbLog = fs.existsSync(path.join(tmp, 'thumbar.log')) ? fs.readFileSync(path.join(tmp, 'thumbar.log'), 'utf8') : '';
  ok('thumbar.log 已记录 apply 与 wm_command 事件', tbLog.includes('"apply"') && tbLog.includes('"wm_command"'));
  ok('渲染层无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  log('\n----------------------------------------');
  log(`通过 ${pass} 项，失败 ${fail} 项`);
  app.exit(fail ? 1 : 0);
})().catch(e => {
  log('FAIL ' + (e && e.stack || e));
  app.exit(1);
});
