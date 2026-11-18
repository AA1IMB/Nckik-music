'use strict';
/**
 * 探针：扫码登录的交互边界（不属于项目代码）
 *  1) 关抽屉要停轮询（不能在后台空转）
 *  2) 重开抽屉要自动换码（旧 key 大概率过期）
 *  3) 连点刷新不能叠出多条轮询链
 *  4) 再点「扫码登录」应收起面板
 *  5) 亮色主题下的观感 + 全程无渲染层异常
 */
const { app, safeStorage } = require('electron');   // eslint-disable-line no-unused-vars
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
// 探针必须隔离：绝不把本机旧配置搬进测试环境
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-qr2-'));
app.setPath('userData', tmp);
// 迁移守卫：main.js 会把旧数据目录搬进空 userData，这里先占位阻止它
fs.writeFileSync(path.join(tmp, 'library.json'), '[]'); // migrate-guard

const logPath = path.join(root, 'demo', 'probe-login2.log');
fs.writeFileSync(logPath, '');
const log = (...a) => fs.appendFileSync(logPath, a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');

const ne = require(path.join(root, 'netease.js'));
let polls = 0;
ne.qrPoll = async () => { polls++; return { code: 801, message: '等待扫码' }; };

let win = null;
const errors = [];
app.on('browser-window-created', (_e, w) => {
  win = w;
  w.webContents.on('console-message', (_ev, lvl, msg) => {
    if (lvl >= 2 && !/Autofill|DevTools/.test(msg)) errors.push(msg);
  });
});
require(path.join(root, 'main.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = code => win.webContents.executeJavaScript(code, true);
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(120); }
  return false;
}
async function shot(name) {
  for (let i = 0; i < 6; i++) {
    const png = (await win.webContents.capturePage()).toPNG();
    if (png.length > 1000) { fs.writeFileSync(path.join(root, 'screenshots', name), png); return; }
    await sleep(350);
  }
}
const st = () => js(`(() => {
  const q = s => document.querySelector(s);
  const box = q('#qrShot') && q('#qrShot').parentElement;
  return {
    wrap: !!q('#qrWrap') && q('#qrWrap').classList.contains('show'),
    drawer: q('#dSet').classList.contains('show'),
    svg: !!q('#qrShot svg'),
    state: q('#qrState') ? q('#qrState').textContent : '',
    dead: !!box && box.classList.contains('dead')
  };
})()`);

(async () => {
  await app.whenReady();
  for (let i = 0; i < 100 && !win; i++) await sleep(50);
  win.showInactive();
  await sleep(1300);
  await js(`(() => { const s = document.createElement('style'); s.textContent='*{transition:none!important;animation:none!important}'; document.head.appendChild(s); })()`);

  /* 1) 打开设置 → 扫码 */
  await js(`document.querySelector('#btnSet').click()`);
  await sleep(400);
  await js(`document.querySelector('#btnNeQr').click()`);
  await waitFor(async () => (await st()).svg, 12000);
  await sleep(2200);
  const c1 = polls;
  log('[1] 取码完成，轮询次数 =', c1, '|', JSON.stringify(await st()));

  /* 2) 点遮罩关抽屉 → 轮询必须停 */
  await js(`document.querySelector('#scrim').click()`);
  await sleep(400);
  const c2 = polls;
  await sleep(6000);
  log('[2] 关抽屉后 6s：轮询次数', c2, '→', polls, '| 是否停止 =', polls === c2, '|', JSON.stringify(await st()));

  /* 3) 重开设置 → 自动换码，轮询恢复 */
  await js(`document.querySelector('#btnSet').click()`);
  const resumed = await waitFor(async () => polls > c2, 12000);
  log('[3] 重开抽屉轮询恢复 =', resumed, '| 次数 =', polls, '|', JSON.stringify(await st()));

  /* 4) 连点刷新 3 次 → 不应叠出多条链 */
  await js(`(() => { const b = document.querySelector('#btnQrRefresh'); b.click(); b.click(); b.click(); })()`);
  await sleep(500);
  const c3 = polls;
  await sleep(4200);           // 正常应约 2 次（每 2s 一次）
  log('[4] 连点刷新后 4.2s 轮询增量 =', polls - c3, '（正常 ≤3，叠加会 >=6）', '|', JSON.stringify(await st()));

  /* 5) 再点「扫码登录」应收起面板 */
  await js(`document.querySelector('#btnNeQr').click()`);
  await sleep(300);
  log('[5] 再点按钮 →', JSON.stringify(await st()));

  /* 6) 亮色主题截图 */
  await js(`(() => { document.querySelector('#btnNeQr').click(); return 1; })()`);
  await waitFor(async () => (await st()).svg, 12000);
  await js(`(() => { document.body.dataset.theme='light'; const el=document.querySelector('#qrWrap'); if(el) el.scrollIntoView({block:'center'}); })()`);
  await sleep(700);
  await shot('16-qr-light.png');
  log('[6] 亮色截图完成');

  log('[7] 渲染层异常 =', errors.length ? errors : '无');
  app.exit(0);
})().catch(e => { log('FAIL', (e && e.stack) || String(e)); app.exit(1); });
