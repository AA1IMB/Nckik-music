'use strict';
/**
 * 探针：扫码登录全链路（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 覆盖：
 *  0) 预置一个过期凭证 → 启动后应显示「登录已过期」而不是「未登录」
 *  1) 真实取码（POST unikey）→ 二维码渲染成一整块 SVG，并用 jsQR 反解回原文校验可扫性
 *  2) 801 等待扫码 / 802 已扫码待确认 / 800 过期 三态文案与遮罩
 *  3) 803 成功 → toast、自动收起、加密落盘、文件里无明文
 *  4) 退出登录 → 凭证文件删除、状态回「未登录」
 * 轮询结果用打桩模拟（真实扫码无法自动化），取码与落盘走真实代码。
 */
const { app, BrowserWindow, safeStorage } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
// 探针必须隔离：绝不把本机旧配置搬进测试环境
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-qr-'));
app.setPath('userData', tmp);
// 迁移守卫：main.js 会把旧数据目录搬进空 userData，这里先占位阻止它
fs.writeFileSync(path.join(tmp, 'library.json'), '[]'); // migrate-guard

// Windows 的 Electron 是 GUI 子系统，console.log 不会进终端：日志一律落文件
const logPath = path.join(root, 'demo', 'probe-login.log');
fs.writeFileSync(logPath, '');
const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
  try { console.log(line); } catch {}
};

const ne = require(path.join(root, 'netease.js'));
const jsqrMod = require('jsqr');
const jsQR = typeof jsqrMod === 'function' ? jsqrMod : jsqrMod.default;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

let win = null;
app.on('browser-window-created', (_e, w) => { win = w; });

require(path.join(root, 'main.js'));

async function js(code) { return win.webContents.executeJavaScript(code, true); }
async function shot(name) {
  for (let i = 0; i < 6; i++) {
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    if (png.length > 1000) { fs.writeFileSync(path.join(root, 'screenshots', name), png); return; }
    await sleep(350);        // 首帧还没合成，抓出来是空图
  }
}
const scrollSet = () => js(`(() => {
  const el = document.querySelector('#qrWrap');
  if (el) el.scrollIntoView({ block: 'center' });
})()`);

const state = () => js(`(() => {
  const q = s => document.querySelector(s);
  const box = q('#qrShot') && q('#qrShot').parentElement;
  return {
    wrap: !!q('#qrWrap') && q('#qrWrap').classList.contains('show'),
    state: q('#qrState') ? q('#qrState').textContent : '',
    cls: q('#qrState') ? q('#qrState').className : '',
    dead: !!box && box.classList.contains('dead'),
    mask: q('#qrMask') ? q('#qrMask').textContent : '',
    svg: !!q('#qrShot svg'),
    svgLen: q('#qrShot svg') ? q('#qrShot svg').outerHTML.length : 0,
    auth: q('#neAuthState') ? q('#neAuthState').textContent : '',
    note: q('#neNote') ? q('#neNote').textContent : '',
    linked: q('#neNote') ? q('#neNote').classList.contains('linked') : false,
    toast: q('#toast') ? q('#toast').textContent : ''
  };
})()`);

// 把页面里的二维码 SVG 光栅化 → 主进程 jsQR 反解
async function decodeQr() {
  const px = await js(`(async () => {
    const svg = document.querySelector('#qrShot svg');
    if (!svg) return null;
    const s = new XMLSerializer().serializeToString(svg);
    const bytes = new TextEncoder().encode(s);
    let raw = '';
    for (const b of bytes) raw += String.fromCharCode(b);
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(raw);
    await img.decode();
    const n = 232;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, n, n);
    ctx.drawImage(img, 0, 0, n, n);
    return Array.from(ctx.getImageData(0, 0, n, n).data);
  })()`);
  if (!px) return null;
  const res = jsQR(new Uint8ClampedArray(px), 232, 232);
  return res && res.data;
}

(async () => {
  await app.whenReady();
  for (let i = 0; i < 100 && !win; i++) await sleep(50);
  if (!win) { console.log('FAIL: no window'); app.exit(1); return; }
  win.showInactive();
  await sleep(1200);
  // 后台窗口里 CSS transition 不一定推进（没有合成帧），抽屉会卡在屏幕外：
  // 探针里直接压掉过渡，让状态和截图都取最终值
  await js(`(() => {
    const s = document.createElement('style');
    s.id = 'probe-noanim';
    s.textContent = '*{transition:none!important;animation:none!important}';
    document.head.appendChild(s);
  })()`);

  /* 0) 启动时没有凭证 */
  log('[0] 启动（无凭证）→', JSON.stringify(await state()));

  /* 0b) 模拟「上次扫码留下的凭证已失效」：注入后切到网易云源触发状态刷新 */
  ne.setCookie('MUSIC_U=expired-token');
  await js(`(() => { const b = document.querySelector('#segSrc b[data-s="net"]'); if (b) b.click(); })()`);
  await sleep(1500);        // 等 account 接口返回
  log('[0b] 失效凭证 →', JSON.stringify((({ auth, note, linked }) => ({ auth, note, linked }))(await state())));
  await js(`(() => { const b = document.querySelector('#segSrc b[data-s="local"]'); if (b) b.click(); })()`);

  const authPath = path.join(tmp, 'ne-auth.bin');

  /* 1) 真实取码 */
  await js(`document.querySelector('#btnSet').click()`);
  await sleep(700);
  log('[1a] 抽屉状态 =', JSON.stringify(await js(`(() => {
    const d = document.querySelector('#dSet');
    const r = d.getBoundingClientRect();
    return { cls: d.className, x: Math.round(r.x), w: Math.round(r.width), scrim: document.querySelector('#scrim').className, vw: innerWidth, vh: innerHeight };
  })()`)));
  await js(`document.querySelector('#btnNeQr').click()`);
  await waitFor(async () => (await state()).svg, 12000);
  const s1 = await state();
  log('[1] 取码后 →', JSON.stringify(s1));
  const decoded = await decodeQr();
  log('[1b] jsQR 反解 =', decoded);
  log('[1c] 二维码内容是否官方登录链接 =', /^https:\/\/music\.163\.com\/login\?codekey=[0-9a-f-]{36}$/.test(String(decoded)));
  await scrollSet();
  await sleep(200);
  await shot('13-qr-wait.png');

  /* 2) 802 已扫码待确认 */
  ne.qrPoll = async () => ({ code: 802, message: '已扫码，请在手机上确认' });
  const got802 = await waitFor(async () => (await state()).state.includes('已扫码'));
  log('[2] 802 命中 =', got802, JSON.stringify((({ state, cls }) => ({ state, cls }))(await state())));

  /* 3) 800 过期 */
  ne.qrPoll = async () => ({ code: 800, message: '二维码已过期' });
  const got800 = await waitFor(async () => (await state()).dead);
  log('[3] 800 命中 =', got800, JSON.stringify((({ state, cls, dead, mask }) => ({ state, cls, dead, mask }))(await state())));
  await scrollSet();
  await shot('14-qr-expired.png');

  /* 4) 刷新 → 803 成功（假 cookie：验证落盘与后续过期识别） */
  const realSet = ne.setCookie;
  ne.qrPoll = async () => {
    realSet('MUSIC_U=fake-session-for-test; __csrf=csrf-test');
    return { code: 803, message: '登录成功', nickname: '测试账号', avatarUrl: '', cookie: 'MUSIC_U=fake-session-for-test; __csrf=csrf-test' };
  };
  await js(`document.querySelector('#btnQrRefresh').click()`);
  const got803 = await waitFor(async () => (await state()).state.includes('登录成功'));
  await sleep(250);
  const s4 = await state();
  log('[4] 803 命中 =', got803, JSON.stringify(s4));
  const bin = fs.existsSync(authPath) ? fs.readFileSync(authPath) : null;
  const plain = bin && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(bin) : '';
  log('[4b] 凭证落盘 =', !!bin, '| 字节', bin && bin.length, '| 解密含 MUSIC_U =', /MUSIC_U=/.test(plain), '| 文件里明文出现 MUSIC_U =', bin ? bin.includes(Buffer.from('MUSIC_U')) : '-');
  await scrollSet();
  await shot('15-qr-success.png');

  /* 4c) 服务端让凭证失效 → 账号校验应判「已过期」，而不是看文件在不在 */
  await sleep(1600);                      // 等面板自动收起
  ne.setCookie('MUSIC_U=expired-token');  // 只改内存，文件仍是上次的
  await js(`(() => { const b = document.querySelector('#segSrc b[data-s="net"]'); if (b) b.click(); })()`);
  await sleep(1600);
  log('[4c] 假凭证校验后 →', JSON.stringify((({ auth, note, linked }) => ({ auth, note, linked }))(await state())));

  /* 5) 退出 */
  await js(`document.querySelector('#btnNeLogout').click()`);
  await sleep(900);
  log('[5] 退出后 →', JSON.stringify(await state()), '| 文件还在 =', fs.existsSync(authPath));

  fs.writeFileSync(path.join(tmp, 'RESULT.json'), JSON.stringify({ ok: true }));
  await sleep(200);
  app.exit(0);
})().catch(async e => {
  log('FAIL', (e && e.stack) || String(e));
  app.exit(1);
});
