'use strict';
/* 截图：统一曲库首页（网易云/酷狗）+ 设置页酷狗登录组。只用于人工核对，不参与断言。 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-shot-src-'));
app.setPath('userData', tmp);

const wav = path.join(tmp, 'shot-a.wav');
fs.copyFileSync(path.join(root, 'demo', 'demo.wav'), wav);
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify([{
  path: wav, title: '样本', artist: '探针', album: '曲库首页', duration: 42,
  codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true
}], null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false, playMode: 'seq', playlist: []
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let win = null;
app.on('browser-window-created', (_e, w) => { win = w; });
const js = c => win.webContents.executeJavaScript(c, true);

async function shotAt(name) {
  await sleep(600);
  for (let i = 0; i < 8; i++) {
    const png = (await win.webContents.capturePage()).toPNG();
    if (png.length > 8000) {
      fs.writeFileSync(path.join(root, 'demo', name), png);
      console.log('shot ' + name + ' ' + png.length + 'B');
      return;
    }
    await sleep(300);
  }
  console.log('shot FAILED ' + name);
}

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  for (let i = 0; i < 200 && !(await js('S.tracks !== undefined')); i++) await sleep(100);
  await js("(() => { const s = document.createElement('style');" +
    "s.textContent = '*{transition:none!important;animation-duration:0s!important}';" +
    "document.head.appendChild(s); })()");
  win.setSize(1100, 700);
  await sleep(300);

  await js("document.querySelector('#btnLib').click()");
  await sleep(400);
  await js("(() => { const b = document.querySelector('#segSrc [data-s=\"net\"]'); if (b) b.click(); })()");
  await sleep(4000);
  await shotAt('shot-src-netease.png');

  await js("(() => { const b = document.querySelector('#segSrc [data-s=\"kg\"]'); if (b) b.click(); })()");
  await sleep(4500);
  await shotAt('shot-src-kugou.png');

  await js("document.querySelector('#btnSet').click()");
  await sleep(600);
  await js("(() => { const b = document.querySelector('#btnKgQr'); if (b) b.click(); })()");
  await sleep(2500);
  await js("(() => { const g = document.querySelector('#dSet .dr-body'); const w = document.querySelector('#kgQrWrap');" +
    "if (g && w) g.scrollTop = Math.max(0, w.getBoundingClientRect().top - g.getBoundingClientRect().top - 120); })()");
  await sleep(500);
  await shotAt('shot-src-kg-login.png');

  app.exit(0);
})().catch(e => { console.error('SHOT CRASH', e); app.exit(2); });
