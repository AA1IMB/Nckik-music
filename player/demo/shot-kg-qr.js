'use strict';
/* 截图：设置页酷狗扫码面板（真二维码） */
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-qr-shot-'));
app.setPath('userData', tmp);

const root = path.join(__dirname, '..');
const wav = path.join(tmp, 'q.wav');
const png = path.join(tmp, 'q.png');
fs.copyFileSync(path.join(root, 'demo', 'demo.wav'), wav);
fs.copyFileSync(path.join(root, 'demo', 'demo.png'), png);
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify([{
  path: wav, title: '样本', artist: '探针', album: '', duration: 42,
  codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true
}], null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false, playMode: 'seq', playlist: []
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let win = null;
app.on('browser-window-created', (_e, w) => { if (!w.getParentWindow()) win = win || w; });
const js = c => win.webContents.executeJavaScript(c, true);

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  for (let i = 0; i < 200 && !(await js('S.tracks !== undefined')); i++) await sleep(100);
  win.setSize(1100, 700);
  await js(`(() => { const s = document.createElement('style'); s.textContent = '*{transition:none!important;animation-duration:0s!important}'; document.head.appendChild(s); })()`);
  await sleep(500);

  await js("$('#btnSet').click()");
  await sleep(700);
  await js("$('#btnKgQr').click()");
  for (let i = 0; i < 100; i++) {
    const ok = await js("(() => { const i = document.querySelector('#kgQrShot img'); return !!i && (i.getAttribute('src')||'').indexOf('data:image') === 0; })()");
    if (ok) break;
    await sleep(250);
  }
  await sleep(400);
  /* 酷狗那组在设置页下方：先滚到二维码再截，否则截图只有外观与快捷键 */
  await js("(() => { const w = document.querySelector('#kgQrWrap'); const body = document.querySelector('#dSet .dr-body'); if (w && body) body.scrollTop = Math.max(0, w.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 140); })()");
  await sleep(600);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-kg-qr.png'), img.toPNG());
  const info = await js("(() => { const i = document.querySelector('#kgQrShot img'); const r = i ? i.getBoundingClientRect() : null; return { has: !!i, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0, state: $('#kgQrState').textContent.trim() }; })()");
  console.log('shot', JSON.stringify(info));
  app.exit(0);
})().catch(e => { console.error('CRASH', e); app.exit(2); });
