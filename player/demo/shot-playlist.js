'use strict';
/**
 * 截图：左下角播放列表面板（不属于项目代码）
 * 四张：列表页 / 选歌单页 / 挑歌页 / 空状态。窗口 1100×700，与真实使用一致。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-plshot-'));
app.setPath('userData', tmp);

const media = path.join(tmp, 'media');
fs.mkdirSync(media, { recursive: true });
const srcWav = path.join(root, 'demo', 'demo.wav');
const srcPng = path.join(root, 'demo', 'demo.png');
const st = fs.statSync(srcWav);
const titles = ['夜航西飞', '长梦不醒', '雨落之前', '玻璃海', '光的背面', '旧城漫步', '无声电影',
  '沙丘', '回声', '黑白键', '南方以南', '第三封信', '缓慢的夜', '海岸线'];
const tracks = titles.map((title, i) => {
  const name = `pl-${String(i + 1).padStart(2, '0')}.wav`;
  fs.copyFileSync(srcWav, path.join(media, name));
  // 同名封面：没有封面时主色退成中性灰，面板与歌词区会显得很「素」
  fs.copyFileSync(srcPng, path.join(media, `pl-${String(i + 1).padStart(2, '0')}.png`));
  return {
    path: path.join(media, name), title, artist: i % 3 === 0 ? '栗先达' : '陈鸿宇', album: '示例专辑',
    duration: 42 + i * 7, codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true,
    hasCover: true, hasLyric: false, mtime: st.mtimeMs, size: st.size, addedAt: Date.now()
  };
});

const playlist = tracks.slice(0, 9).map(t => ({
  id: t.path, title: t.title, artist: t.artist, duration: t.duration
}));

fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(tracks, null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0.4, muted: true, globalKeys: false, playlist
}));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let win = null;
app.on('browser-window-created', (_e, w) => { win = w; });
const js = code => win.webContents.executeJavaScript(code, true);

function waitForWin() {
  return new Promise(res => {
    const t = setInterval(() => {
      if (win && !win.webContents.isLoading()) { clearInterval(t); res(); }
    }, 80);
  });
}
async function shot(name) {
  await sleep(420);
  const png = (await win.webContents.capturePage()).toPNG();
  const p = path.join(root, 'demo', name);
  fs.writeFileSync(p, png);
  console.log(name, png.length + 'B');
}

(async () => {
  require(path.join(root, 'main.js'));
  await waitForWin();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (await js('S.tracks.length')) break;
    await sleep(120);
  }
  await sleep(1500);
  win.showInactive();

  // 起播第一首：让列表页能看到「正在播放」那一行的高亮
  await js(`(() => {
    const r = document.querySelector('#libList .item[data-i="0"]');
    if (r) r.click();
  })()`);
  await sleep(1200);

  // 列表页（当前播放的曲目在列表里会高亮）
  await js(`document.querySelector('#btnPl').click()`);
  await shot('shot-pl-list.png');

  // 选歌单页
  await js(`document.querySelector('#plSelect').click()`);
  await shot('shot-pl-pick.png');

  // 挑歌页
  await js(`document.querySelector('#plInsert').click()`);
  await shot('shot-pl-add.png');

  // 空状态
  await js(`(() => { S.settings.playlist = []; plSave(); closePops(); document.querySelector('#btnPl').click(); })()`);
  await shot('shot-pl-empty.png');

  // 三种播放模式的按钮：只截底部中间那一小块，放大看图标
  await js(`(() => { closePops(); })()`);
  await sleep(200);
  const M = [['seq', '顺序播放'], ['one', '单曲循环'], ['shuffle', '随机播放']];
  for (const [mode, ] of M) {
    await js(`(() => { S.settings.playMode = '${mode}'; syncModeBtn(); })()`);
    await sleep(260);
    const r = await js(`(() => {
      const b = document.querySelector('#btnMode').getBoundingClientRect();
      return { x: Math.round(b.left - 18), y: Math.round(b.top - 12),
               width: Math.round(b.width + 36), height: Math.round(b.height + 24) };
    })()`);
    await sleep(120);
    const img = await win.webContents.capturePage(r);
    const p = path.join(root, 'demo', `shot-mode-${mode}.png`);
    fs.writeFileSync(p, img.toPNG());
    console.log(`shot-mode-${mode}.png`, img.toPNG().length + 'B');
  }
  // 复位成顺序播放，避免影响下一张图
  await js(`(() => { S.settings.playMode = 'seq'; syncModeBtn(); })()`);

  console.log('done');
  setTimeout(() => app.quit(), 200);
})().catch(e => {
  console.log('SHOT CRASH ' + ((e && e.stack) || e));
  setTimeout(() => app.quit(), 200);
});
