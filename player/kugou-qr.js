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

/* 从页面提示里判断状态。
 * 实测（隐藏窗口每 15s 采样）：登录页的二维码约 5 分钟有效，到点后页面自己把正文换成
 * 「二维码已失效 请点击刷新」，而且**不会自动换图**（img 的 src 一直不变）。
 * 所以这里只做三态判定；「失效」意味着这张码已经废了，必须重开一次会话拿新码，
 * 上层不能把它当成「已刷新、再扫一次」。 */
function guessState(tip, cookie) {
  if (/\btoken=/.test(cookie)) return 'confirmed';
  if (/失效|过期|请点击刷新/.test(tip)) return 'expired';
  if (/确认|已扫码|手机.*确认/.test(tip)) return 'scanned';
  return 'waiting';
}

/* 页面自己轮询 `v2/get_userinfo_qrcode`，返回体形如
 *   {"status":1,"data":{"status":1}}                    等待扫码
 *   {"status":1,"data":{"status":2,"pic":"…","nickname":"…"}}  已扫码待确认
 *   {"status":1,"data":{"status":4,"userid":…,"token":"…"}}     手机上已确认
 *   {"status":1,"data":{"status":0}}                    二维码失效
 * 我们旁听它（DevTools 协议，只读不改），于是：
 *   - 不必猜「页面文案」就能知道扫到哪一步；
 *   - 拿到 status=4 的 token/userid 后，直接调页面自己的 `KgUser.QRCodeLogin`
 *     去换会话 —— 这一步由官方页面完成签名/加密，我们只当“按键的人”。
 * 这样即使页面自身的自动换会话在隐藏窗口里没跑起来，登录也能走完。 */
const POLL_PATH = '*get_userinfo_qrcode*';

function createQrLogin({ BrowserWindow, app }) {
  let win = null;
  let idSeq = 0;
  let current = null;   // { id, startedAt, timer }
  let lastCookie = '';  // 登录成功后暂存，等上层取走
  let watch = { status: 0, userId: '', token: '', pic: '', nickname: '', exchanged: '' };
  let watcher = null;   // { dbg, onMessage }

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
    /* 不按域名挑：换会话的响应来自 loginservice.kugou.com，写下的可能是 host-only cookie，
     * 用 '.kugou.com' 过滤会漏掉。这里是独立的隐藏分区，按名字白名单收就够了。 */
    const list = await session.cookies.get({}).catch(() => []);
    const map = new Map();
    for (const c of list) {
      if (KEEP.has(c.name) && c.value) map.set(c.name, c.value);
    }
    return [...map.entries()].map(([k, v]) => k + '=' + v).join('; ');
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

  /* 旁听页面的轮询响应：只读，读完立刻放行，不拖慢页面自己的节奏 */
  function attachWatcher(wc) {
    if (!wc || wc.isDestroyed()) return;
    const dbg = wc.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch (e) {
      return;   // 附不上就退回「只看 cookie」的老路，不影响扫码本身
    }

    const onMessage = async (_e, method, params) => {
      if (method !== 'Fetch.requestPaused') return;
      const { requestId } = params;
      try {
        const body = await dbg.sendCommand('Fetch.getResponseBody', { requestId });
        const text = body.base64Encoded
          ? Buffer.from(body.body, 'base64').toString('utf8')
          : String(body.body || '');
        let j = null;
        try { j = JSON.parse(text); } catch (e) { j = null; }
        const d = j && j.data;
        if (j && j.status === 1 && d && typeof d.status === 'number') {
          if (d.status !== watch.status) trace('poll status=' + d.status);
          watch.status = d.status;
          if (d.pic) watch.pic = d.pic;
          if (d.nickname) watch.nickname = d.nickname;
          if (d.status === 4 && d.token) {
            watch.token = String(d.token);
            watch.userId = String(d.userid || '');
          }
        }
      } catch (e) {
        /* 读不到响应体不影响流程：cookie 兜底仍然有效 */
      }
      try { await dbg.sendCommand('Fetch.continueRequest', { requestId }); } catch (e) {}
    };

    dbg.on('message', onMessage);
    dbg.sendCommand('Fetch.enable', {
      patterns: [{ urlPattern: POLL_PATH, requestStage: 'Response' }],
    }).catch(() => {});

    watcher = { dbg, onMessage };
  }

  function detachWatcher() {
    if (!watcher) return;
    const { dbg, onMessage } = watcher;
    watcher = null;
    try {
      if (!dbg.isAttached()) return;
      dbg.removeListener('message', onMessage);
      dbg.sendCommand('Fetch.disable').catch(() => {});
      dbg.detach();
    } catch (e) { /* 窗口已销毁时忽略 */ }
  }

  /* 拿到 status=4 的 token 后，用页面自己的函数换一次会话（只做一次） */
  async function exchange(wc) {
    if (!watch.token || watch.exchanged === watch.token) return false;
    watch.exchanged = watch.token;
    const args = JSON.stringify([1014, watch.userId || '0', watch.token]);
    try {
      await wc.executeJavaScript(`new Promise(r => {
        const done = v => { try { r(String(v).slice(0, 120)); } catch (e) { r('cb-error'); } };
        const t = setTimeout(() => r('timeout'), 8000);
        try {
          if (!window.KgUser || typeof KgUser.QRCodeLogin !== 'function') { clearTimeout(t); return r('no-fn'); }
          const a = ${args};
          KgUser.QRCodeLogin(a[0], a[1], a[2], function (res) { clearTimeout(t); done(res); });
        } catch (e) { clearTimeout(t); done('throw ' + e.message); }
      })`, true);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* 诊断开关：NCKIK_TRACE_KGQR=1 时把每一步状态写进 userData/kgqr.log
   * （只有状态码与时间，不含 token、不含 cookie，出问题时让用户回传这个文件即可定位） */
  const TRACE = process.env.NCKIK_TRACE_KGQR === '1';
  function trace(msg) {
    if (!TRACE) return;
    try {
      const fs = require('node:fs');
      const file = path.join(app.getPath('userData'), 'kgqr.log');
      const line = new Date().toISOString() + ' ' + msg + '\n';
      if (fs.existsSync(file) && fs.statSync(file).size > 64 * 1024) fs.truncateSync(file, 0);
      fs.appendFileSync(file, line);
    } catch (e) { /* 日志失败不影响流程 */ }
  }

  async function start() {
    if (win && !win.isDestroyed()) { win.destroy(); win = null; }
    detachWatcher();
    lastCookie = '';
    watch = { status: 0, userId: '', token: '', pic: '', nickname: '', exchanged: '' };

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

    attachWatcher(wc);

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

    /* 页面已经自己换好会话（或 cookie 已被写入）：直接成功 */
    let cookie = await readCookie(js);
    if (/\btoken=/.test(cookie)) {
      trace('cookie has token (page path)');
      lastCookie = cookie;
      stop('confirmed');
      return { state: 'confirmed', cookie, img: '' };
    }

    /* 手机点了确认但页面没换会话：我们替它按一次「登录」（页面自己的函数，签名/加密都在页面里完成），
     * 再读一次 cookie。成功与否都以 cookie 为准，不谎报状态。 */
    if (watch.token && watch.token !== watch.exchanged) {
      trace('status=4 captured, trying QRCodeLogin');
      const ok = await exchange(wc);
      cookie = await readCookie(js);
      trace('exchange=' + ok + ' cookieToken=' + /\btoken=/.test(cookie));
      if (/\btoken=/.test(cookie)) {
        lastCookie = cookie;
        stop('confirmed');
        return { state: 'confirmed', cookie, img: '' };
      }
    }

    if (Date.now() - current.startedAt > SESSION_TTL) {
      stop('timeout');
      const err = new Error('二维码已超时，请重新开始');
      err.code = 'KG_QR_TIMEOUT';
      throw err;
    }

    const qr = await readQr(js);
    /* 状态优先用页面轮询的真实返回，文案只作兜底 */
    let state = 'waiting';
    if (watch.status === 2) state = 'scanned';
    else if (watch.status === 0 && Date.now() - current.startedAt > 5000) state = 'expired';
    else state = guessState(qr.tip, cookie);
    if (watch.status === 2 && state === 'waiting') state = 'scanned';
    /* 失效的码不再回传图：上层会把二维码盖住，避免用户去扫一张已经废掉的码 */
    return {
      state,
      img: state === 'expired' ? '' : qr.img,
      tip: qr.tip,
      nickname: watch.nickname,
      cookie: '',
    };
  }

  function stop(reason) {
    if (current && current.timer) clearTimeout(current.timer);
    if (current) current.timer = 0;
    current = null;
    detachWatcher();
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
    return {
      active: !!current,
      hasCookie: !!lastCookie,
      phase: watch.status,              // 1 等待 / 2 已扫码 / 4 已确认 / 0 失效
      nickname: watch.nickname || '',
    };
  }

  app.on('before-quit', () => {
    detachWatcher();
    if (win && !win.isDestroyed()) win.destroy();
  });

  return { start, poll, stop, takeCookie, status, LOGIN_URL };
}

module.exports = { createQrLogin, LOGIN_URL, KEEP, guessState };
