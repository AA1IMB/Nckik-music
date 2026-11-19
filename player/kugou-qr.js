'use strict';
/*
 * 酷狗扫码登录（主进程侧）
 *
 * 背景：`login-user.kugou.com/v1/qrcode` 这类接口要签名，裸调一律 error_code 20010。
 * 但酷狗自己的网页登录页（统一登录）是现成的：它内部完成签名、二维码刷新与轮询，
 * 扫码成功后把 `token` / `userid` 写进 `.kugou.com` 的 cookie。
 *
 * 所以我们不重写协议，只做三件事：
 *   1. 在一个隐藏窗口里加载官方登录页（独立 session 分区，不污染主窗口）；
 *   2. 把页面里的二维码（`<img src="data:image/png;base64,…">`）取出来给设置页显示；
 *   3. 定期读该分区的 cookie，出现 `token` 就把 cookie 串交回上层保存 —— 保存逻辑
 *      与「导入 Cookie」完全相同（`kg:login`），所以取链、自检、脱敏都复用现成的。
 *
 * 任何一步失败都返回可读的错误码，上层据此显式降级回「导入 Cookie」，不静默。
 */

const path = require('node:path');

const LOGIN_URL =
  'https://login-user.kugou.com/login/?appid=1014' +
  '&ref=https://www.kugou.com/reg/web/' +
  '&redirect_uri=https://staticssl.kugou.com/common/html/login/regok.html' +
  '&callback=UsLoginCallback';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* 只保留这些键：其余埋点 cookie 对取链没用，串太长还可能撞到服务端的长度限制 */
const KEEP = new Set([
  'kg_mid', 'kg_dfid', 'kg_dfid_collect',
  'token', 'userid', 'kugoo', 'kugoo_id', 'kg_userid', 'uid',
]);

const QR_READY_TIMEOUT = 15000;   // 等二维码出现
const SESSION_TTL = 5 * 60 * 1000; // 一次扫码流程最多留这么久

function createQrLogin({ BrowserWindow, app }) {
  let win = null;
  let idSeq = 0;
  let current = null;   // { id, startedAt, timer }
  let lastCookie = '';  // 登录成功后暂存，等上层取走

  const closed = () => !win || win.isDestroyed();

  function readQr(js) {
    return js(`(() => {
      const imgs = [...document.querySelectorAll('img')];
      const qr = imgs.find(i => /^data:image\\/(png|jpe?g)/i.test(i.getAttribute('src') || ''));
      const tip = (document.body ? document.body.innerText : '') || '';
      return { img: qr ? qr.getAttribute('src') : '', tip: tip.slice(0, 200) };
    })()`).catch(() => ({ img: '', tip: '' }));
  }

  async function readCookie(js) {
    if (closed()) return '';
    const { session } = win.webContents;
    const list = await session.cookies.get({ domain: '.kugou.com' }).catch(() => []);
    const map = new Map();
    for (const c of list) {
      if (KEEP.has(c.name) && c.value) map.set(c.name, c.value);
    }
    return [...map.entries()].map(([k, v]) => k + '=' + v).join('; ');
  }

  /* 从页面提示里判断「已扫码待确认」，只用来给界面加一句反馈，不影响判定 */
  function guessState(tip, cookie) {
    if (/\btoken=/.test(cookie)) return 'confirmed';
    if (/确认|已扫码|手机.*确认/.test(tip)) return 'scanned';
    if (/失效|刷新/.test(tip)) return 'expired';
    return 'waiting';
  }

  async function waitQr(js, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (closed()) return { img: '', tip: '' };
      const got = await readQr(js);
      if (got && got.img) return got;
      await new Promise(r => setTimeout(r, 300));
    }
    return { img: '', tip: '' };
  }

  async function start() {
    if (win && !win.isDestroyed()) { win.destroy(); win = null; }
    lastCookie = '';

    win = new BrowserWindow({
      show: false,
      width: 460,
      height: 640,
      webPreferences: {
        partition: 'persist:kg-qr',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    win.webContents.setUserAgent(UA);

    const wc = win.webContents;
    const js = code => wc.executeJavaScript(code, true);

    try {
      await win.loadURL(LOGIN_URL, { userAgent: UA });
    } catch (e) {
      if (!closed()) win.destroy();
      win = null;
      const err = new Error('打不开酷狗登录页（网络不通或页面改版）：' + (e && e.message));
      err.code = 'KG_QR_LOAD';
      throw err;
    }

    const got = await waitQr(js, QR_READY_TIMEOUT);
    if (!got.img) {
      if (!closed()) win.destroy();
      win = null;
      const err = new Error('登录页已打开，但没有取到二维码（页面可能改版）');
      err.code = 'KG_QR_NO_IMG';
      throw err;
    }

    current = { id: ++idSeq, startedAt: Date.now(), timer: 0 };
    current.timer = setTimeout(() => { stop('timeout'); }, SESSION_TTL);

    return { key: String(current.id), img: got.img, tip: got.tip, expiresAt: Date.now() + SESSION_TTL };
  }

  async function poll(key) {
    if (!current || String(current.id) !== String(key)) {
      const err = new Error('扫码会话已结束，请重新开始');
      err.code = 'KG_QR_GONE';
      throw err;
    }
    if (closed()) {
      const err = new Error('扫码窗口已关闭，请重新开始');
      err.code = 'KG_QR_GONE';
      throw err;
    }

    const wc = win.webContents;
    const js = code => wc.executeJavaScript(code, true);
    const cookie = await readCookie(js);
    if (/\btoken=/.test(cookie)) {
      lastCookie = cookie;
      const state = 'confirmed';
      stop('confirmed');
      return { state, cookie, img: '' };
    }

    if (Date.now() - current.startedAt > SESSION_TTL) {
      stop('timeout');
      const err = new Error('二维码已超时，请重新开始');
      err.code = 'KG_QR_TIMEOUT';
      throw err;
    }

    const qr = await readQr(js);
    return { state: guessState(qr.tip, cookie), img: qr.img, tip: qr.tip, cookie: '' };
  }

  function stop(reason) {
    if (current && current.timer) clearTimeout(current.timer);
    if (current) current.timer = 0;
    current = null;
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    return { ok: true, reason: reason || 'cancelled' };
  }

  function takeCookie() {
    const c = lastCookie;
    lastCookie = '';
    return c;
  }

  function status() {
    return { active: !!current, hasCookie: !!lastCookie };
  }

  app.on('before-quit', () => { if (win && !win.isDestroyed()) win.destroy(); });

  return { start, poll, stop, takeCookie, status, LOGIN_URL };
}

module.exports = { createQrLogin, LOGIN_URL, KEEP };
