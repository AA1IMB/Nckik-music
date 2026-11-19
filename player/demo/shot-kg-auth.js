'use strict';
/*
 * 截图：酷狗登录入口
 * ---------------------------------------------------------------
 * 两张：
 *   shot-kg-auth-panel.png  —— 曲库「酷狗」页 + 未登录账号条 + 导入 Cookie 面板
 *   shot-kg-auth-done.png   —— 导入后（合成凭证，仅用于展示已登录态的样子；
 *                              userid 是假的，不是真账号）
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-shot-kgauth-'));
fs.mkdirSync(tmp, { recursive: true });
process.env.NCKIK_SKIP_MIGRATION = '1';
app.setPath('userData', tmp);

const demo = path.join(root, 'demo');
fs.writeFileSync(path.join(tmp, 'library.json'), '[]');
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false, playMode: 'seq', playlist: []
}, null, 2));

require(path.join(root, 'main.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = code => win.webContents.executeJavaScript(code);
let win = null;

const FAKE_COOKIE = `kg_mid=${'b'.repeat(32)}; kg_dfid=${'c'.repeat(32)}; token=${'probe-token-' + 'a'.repeat(24)}; userid=424242`;

(async () => {
  while (!win || win.webContents.isLoading()) {
    if (!win) win = BrowserWindow.getAllWindows()[0] || null;
    await sleep(150);
  }
  await sleep(1200);
  win.setContentSize(1100, 700);

  await js(`(() => { const b = document.querySelector('#btnLib'); if (b) b.click(); })()`);
  await sleep(400);
  await js(`(() => { const b = document.querySelector('#segSrc [data-s="kg"]'); if (b) b.click(); })()`);
  await sleep(700);
  await js(`(() => { const b = document.querySelector('#kgLoginBtn'); if (b) b.click(); })()`);
  await sleep(600);

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(demo, 'shot-kg-auth-panel.png'), img.toPNG());
  console.log('shot-kg-auth-panel.png ok');

  await js(`(() => { $('#kgCookie').value = ${JSON.stringify(FAKE_COOKIE)}; $('#kgAuthSave').click(); })()`);
  await sleep(2500);
  const img2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(demo, 'shot-kg-auth-done.png'), img2.toPNG());
  console.log('shot-kg-auth-done.png ok');

  app.exit(0);
})().catch(e => { console.error('SHOT CRASH', (e && e.stack) || e); app.exit(2); });
setTimeout(() => { console.error('SHOT TIMEOUT'); app.exit(3); }, 120000);
