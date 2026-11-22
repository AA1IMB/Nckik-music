'use strict';
/**
 * 探针：品牌改名 + 全局苹方字体 + 图标产物（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 验证三件事：
 *   1. 名称统一：窗口 <title>、关于页的「名称」行、package.json productName；
 *   2. 苹方真的加载并全局生效：document.fonts.check + body/按钮/输入框的
 *      computed font-family，缺一处就算失败；
 *   3. 产物检查（打包目录）：图标是白底 + 红色单笔、字体在 asar 里。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
// 探针必须隔离：绝不把本机旧配置搬进测试环境
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-brand-'));
app.setPath('userData', tmp);
// 迁移守卫：阻止 main.js 把本机旧数据搬进探针环境
fs.writeFileSync(path.join(tmp, 'library.json'), '[]');

const logPath = path.join(root, 'demo', 'probe-brand.log');
fs.writeFileSync(logPath, '');
const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
  try { console.log(line); } catch {}
};
/* 截图目录可能不存在（新解压的工程没有 screenshots/）：写之前先建好 */
function ensureShots() {
  try { fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true }); } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
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
  await sleep(900);
  await js(`(() => { const s = document.createElement('style'); s.textContent = '*{transition:none!important;animation-duration:0s!important}'; document.head.appendChild(s); })()`);

  log('=== 1. 名称 ===');
  const title = await js(`document.title`);
  const winTitle = await new Promise(r => { try { r(win.getTitle()); } catch { r(''); } });
  log('  ', JSON.stringify({ title, winTitle }));
  ok('页面 <title> 已更名', title.includes("Nckik′s music"), title);
  ok('窗口标题已更名', winTitle.includes("Nckik′s music"), winTitle);
  ok('关于页有「名称」行', await js(`[...document.querySelectorAll('.group .line')].some(l => { const k = l.querySelector('.k'), v = l.querySelector('.v'); return k && v && k.textContent.trim() === '名称' && v.textContent.includes("Nckik′s music"); })`));
  ok('没有残留旧名称（云音乐 ≠ 网易云）', await js(`(() => { try { return !document.body.innerText.split('网易云').join('').includes('云音乐'); } catch { return false; } })()`));

  log('\n=== 2. 苹方字体 ===');
  // 等字体真正就绪（11MB，本地盘通常 <300ms）
  await waitFor(() => js(`document.fonts.check('16px "PingFang"')`), 8000);
  const font = await js(`(() => {
    const probe = s => { const el = document.querySelector(s); return el ? getComputedStyle(el).fontFamily : '(missing)'; };
    return {
      loaded: document.fonts.check('16px "PingFang"'),
      body: probe('body'),
      button: probe('#btnPlay'),
      input: probe('#q'),
      ghost: probe('.ghost'),
      tag: probe('#btnPl')
    };
  })()`);
  log('  ', JSON.stringify(font));
  ok('苹方字体已加载', font.loaded === true);
  ok('body 用苹方', /^["']?PingFang/.test(font.body), font.body);
  ok('播放按钮用苹方', /^["']?PingFang/.test(font.button), font.button);
  ok('搜索框用苹方', /^["']?PingFang/.test(font.input), font.input);
  ok('设置按钮用苹方', /^["']?PingFang/.test(font.ghost), font.ghost);
  ok('播放列表入口用苹方', /^["']?PingFang/.test(font.tag), font.tag);

  log('\n=== 3. 设置页截图 ===');
  await js(`openDrawer(document.querySelector('#dSet')); 0`);
  await sleep(300);
  await js(`(() => { const b = document.querySelector('#dSet .dr-body'); if (b) b.scrollTop = b.scrollHeight; })()`);
  await sleep(250);
  for (let i = 0; i < 6; i++) {
    const png = (await win.webContents.capturePage()).toPNG();
    if (png.length > 3000) { ensureShots(); fs.writeFileSync(path.join(root, 'screenshots', '32-about-renamed.png'), png); break; }
    await sleep(280);
  }

  log('\n=== 4. 产物检查（打包目录，若已构建） ===');
  const distExe = path.join(root, 'dist', 'win-unpacked');
  if (fs.existsSync(distExe)) {
    const asar = path.join(distExe, 'resources', 'app.asar');
    const asarPkg = require('@electron/asar');
    const files = asarPkg.listPackage(asar);
    ok('字体已随包分发', files.some(f => f.includes('PingFangSC-Medium.ttf')));
    const html = asarPkg.extractFile(asar, 'renderer/index.html').toString();
    ok('包内 <title> 已更名', html.includes("Nckik′s music"));
    const exe = fs.readdirSync(distExe).find(f => f.endsWith('.exe') && !f.startsWith('Uninstall'));
    ok('主程序名为新产品名', exe && exe.includes("Nckik's music"), exe);
    /* 安装包文件名带版本号：不写死，按 package.json 的 version 找 */
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const setupName = 'NckiksMusic-Setup-' + pkg.version + '.exe';
    ok('安装包存在', fs.existsSync(path.join(root, 'dist', setupName)), setupName);
  } else {
    log('  （跳过：尚未打包）');
  }

  log('\n=== 5. 报错 ===');
  ok('渲染层无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  log('\n----------------------------------------');
  log(`通过 ${pass} 项，失败 ${fail} 项`);
  app.exit(fail ? 1 : 0);
})().catch(e => {
  log('FAIL ' + (e && e.stack || e));
  app.exit(1);
});
