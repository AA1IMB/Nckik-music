'use strict';
/* 截图：哔哩哔哩标签页（搜索结果 + 正在播放） */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-bilshot-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'library.json'), '[]');
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ theme: 'dark', volume: 0, muted: true, globalKeys: false, playMode: 'seq', playlist: [] }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let win = null;
app.on('browser-window-created', (_e, w) => { if (!win) win = w; });
const js = c => win.webContents.executeJavaScript(c, true);

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(150);
  await sleep(800);
  win.setSize(1100, 700);
  await js(`(() => {
    const s = document.createElement('style');
    s.textContent = '*{transition:none!important;animation-duration:0s!important}';
    document.head.appendChild(s);
  })()`);

  await js("$('#btnLib').click()");
  await sleep(300);
  await js("$('#segSrc b[data-s=\"bil\"]').click()");
  await sleep(300);
  await js("(() => { const q = $('#q'); q.value = '晴天'; q.dispatchEvent(new Event('input')); })()");
  for (let i = 0; i < 100; i++) {
    if (await js("document.querySelectorAll('#libList .item').length > 3")) break;
    await sleep(200);
  }
  await sleep(1200);
  let img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-bil-search.png'), img.toPNG());

  await js("document.querySelector('#libList .item').click()");
  for (let i = 0; i < 60; i++) {
    const s = await js("({ paused: audio.paused, ct: audio.currentTime, rs: audio.readyState })");
    if (!s.paused && s.ct > 0.4 && s.rs >= 3) break;
    await sleep(250);
  }
  await sleep(1500);
  await js("$('#dLib .x').click()");
  await sleep(400);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-bil-play.png'), img.toPNG());

  console.log('shot ok', JSON.stringify(await js("({ i: S.i, src: audio.src, ct: audio.currentTime, cover: (document.querySelector('#coverImg')||{}).src ? 'yes' : 'no' })")));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(0);
})().catch(e => { console.error('SHOT CRASH', e); app.exit(2); });
