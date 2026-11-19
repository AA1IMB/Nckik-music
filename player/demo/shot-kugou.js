'use strict';
/**
 * 截图：酷狗免费曲的搜索列表与播放界面
 * ---------------------------------------------------------------------------
 * 两张图都用真实接口：第一张是「酷狗」标签下的搜索结果，第二张点开一首免费曲
 * 等封面与歌词就位后截整窗。抓到文件就退出，方便人工复核观感。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-kgshot-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'library.json'), '[]');
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false, playMode: 'seq', playlist: []
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let win = null;
app.on('browser-window-created', (_e, w) => { win = w; });
const js = c => win.webContents.executeJavaScript(c, true);

async function shot(file) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, file), img.toPNG());
  console.log('  shot', file, img.getSize().width + 'x' + img.getSize().height);
}

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  for (let i = 0; i < 200 && !(await js('S.tracks !== undefined')); i++) await sleep(100);

  await js(`document.querySelector('#btnLib').click()`);
  await sleep(400);
  await js(`document.querySelector('#segSrc [data-s="kg"]').click()`);
  await sleep(600);
  await js(`(() => { const q = $('#q'); q.value = '晴天'; q.dispatchEvent(new Event('input')); })()`);
  for (let i = 0; i < 80 && (await js('S.kg.items.length')) === 0; i++) await sleep(300);
  await sleep(900);
  await shot('shot-kg-search.png');

  const hash = await js(`(S.kg.items.find(t => !t.vip) || {}).kgHash || ''`);
  if (hash) {
    await js(`(() => { const el = document.querySelector('#libList .item[data-kg="' + ${JSON.stringify(hash)} + '"]'); if (el) el.click(); })()`);
    for (let i = 0; i < 120; i++) {
      const ok = await js(`(() => !audio.paused && audio.currentTime > 1.2 && S.lyrics.length > 0)()`);
      if (ok) break;
      await sleep(300);
    }
    await js(`document.querySelector('#dLib [data-close]').click()`);
    await sleep(700);
    await shot('shot-kg-play.png');
  }
  app.exit(0);
})().catch(e => { console.error('SHOT CRASH', e && e.stack || e); app.exit(2); });
setTimeout(() => { console.error('SHOT TIMEOUT'); app.exit(3); }, 180000);
