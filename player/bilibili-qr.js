/* 哔哩哔哩扫码登录：让官方登录页自己完成取码、轮询与「换会话」那一整套。
 *
 * 为什么不用直接调 API：我们试过 `/x/passport-login/web/qrcode/generate` + `poll`，
 * 也能拿到 SESSDATA，但拿回来的会话拿去调 `nav` 一律是 `-101 账号未登录`。
 * 原因是登录这件事在浏览器里还有几步（设备指纹 buvid3/buvid4、跨域写 cookie、
 * 登录后的跳转），纯 HTTP 拼不出来。所以这里开一个隐藏窗口把官方页面打开：
 * 二维码从页面里取，登录成功后直接从窗口的 cookie 罐里读 SESSDATA —— 与用户
 * 在浏览器里扫码的路径完全一致。
 */
const LOGIN_URL = 'https://passport.bilibili.com/login';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* 只搬这些名字的 cookie：登录态 + 设备指纹，其余（埋点、实验分组）不带出去 */
const KEEP = [
  'SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckmd5', 'sid',
  'buvid3', 'buvid4', 'b_nut', 'bili_ticket', 'bili_ticket_expires', 'buvid_fp'
];

const QR_READY_TIMEOUT = 15000;      // 页面加载到出码的上限
const QR_TIMEOUT = 3 * 60 * 1000;    // 一张码的有效期（与界面文案一致）

function createQrLogin({ BrowserWindow, app }) {
  let win = null;
  let session = null;
  let idSeq = 0;
  let current = null;                // { id, at, ttl, img, timer }
  let lastCookie = '';               // 刚确认过的会话：容忍渲染层在确认后又多问一次

  function destroy() {
    if (current && current.timer) clearTimeout(current.timer);
    current = null;
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    session = null;
  }

  async function waitQr() {
    const deadline = Date.now() + QR_READY_TIMEOUT;
    while (Date.now() < deadline) {
      if (!win || win.isDestroyed()) throw new Error('登录窗口已关闭');
      const img = await win.webContents.executeJavaScript(`(() => {
        const pick = () => {
          const list = [...document.querySelectorAll('img')];
          return list.find(i => /^data:image\\//.test(i.src || '') && (i.naturalWidth || 0) >= 120)
              || list.find(i => /qrcode/i.test(i.className || ''))
              || null;
        };
        const hit = pick();
        const cv0 = document.querySelector('canvas');
        const src = (hit && hit.src) || (cv0 && cv0.width >= 120 ? cv0.toDataURL('image/png') : '');
        if (!src) return '';
        /* 页面里这张码只有 140px，直接拉到 216 的框里会发虚。
         * 用 canvas 按整数倍 2x 重画一遍（关掉平滑，模块边缘保持硬边），
         * 只在第一次取到新码时做，避免每 300ms 都重画。 */
        if (window.__bilQrSrc === src && window.__bilQrUp) return window.__bilQrUp;
        window.__bilQrSrc = src;
        window.__bilQrUp = src;
        const im = new Image();
        im.onload = () => {
          const scale = im.width < 200 ? 2 : 1;
          const c = document.createElement('canvas');
          c.width = im.width * scale; c.height = im.height * scale;
          const g = c.getContext('2d');
          g.imageSmoothingEnabled = false;
          g.drawImage(im, 0, 0, c.width, c.height);
          window.__bilQrUp = c.toDataURL('image/png');
        };
        im.src = src;
        return src;
      })()`).catch(() => '');
      if (img) return img;
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('登录页没出现二维码（可能被风控或页面改版）');
  }

  async function readCookie() {
    if (!session) return '';
    /* 不按 domain 过滤：登录页会把 SESSDATA 写到 www./passport./.bilibili.com 等
     * 不同作用域上，用 domain 过滤很容易「看漏」（酷狗那版就踩过这个坑）。
     * 这里取全部 cookie，再按名字白名单挑，看到同名取最后一个非空值。 */
    const all = await session.cookies.get({});
    const map = new Map();
    for (const c of all) {
      if (!KEEP.includes(c.name)) continue;
      if (c.value) map.set(c.name, c.value);
    }
    if (!map.get('SESSDATA')) return '';
    return KEEP.filter(k => map.get(k)).map(k => k + '=' + map.get(k)).join('; ');
  }

  /* 诊断用：把「现在罐里有哪些 cookie 名字」记一行，扫码确认后没反应时靠它定位 */
  async function cookieNames() {
    if (!session) return [];
    const all = await session.cookies.get({});
    return [...new Set(all.map(c => c.name))];
  }

  async function pageText() {
    if (!win || win.isDestroyed()) return '';
    return win.webContents.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => '');
  }

  async function start() {
    destroy();
    const id = String(++idSeq);
    win = new BrowserWindow({
      show: false, width: 960, height: 720,
      webPreferences: {
        partition: 'persist:bil-qr',      // 独立的 cookie 罐：与主窗口、与其它音源都不串
        contextIsolation: true, nodeIntegration: false, sandbox: true
      }
    });
    win.webContents.setUserAgent(UA);
    session = win.webContents.session;
    await win.loadURL(LOGIN_URL);
    const img = await waitQr();
    current = {
      id, at: Date.now(), ttl: QR_TIMEOUT, img,
      timer: setTimeout(() => { current = null; destroy(); }, QR_TIMEOUT)
    };
    return { key: id, img, ttl: QR_TIMEOUT, expiresAt: Date.now() + QR_TIMEOUT };
  }

  async function poll() {
    if (!current) {
      /* 已经确认过、只是渲染层多发了一次轮询：把同一个结果再回一遍，别报错 */
      if (lastCookie) return { state: 'confirmed', cookie: lastCookie, img: '' };
      throw new Error('登录窗口已关闭，请重新获取二维码');
    }
    const cookie = await readCookie();
    if (cookie) {
      lastCookie = cookie;
      destroy();
      return { state: 'confirmed', cookie, img: '' };
    }
    const text = await pageText();
    let state = 'waiting';
    if (/已失效|已过期|请刷新/.test(text)) state = 'expired';
    else if (/已扫码|扫描成功|请在手机|登录成功|正在跳转/.test(text)) state = 'scanned';
    if (state === 'scanned' && current && !current.sawScan) {
      current.sawScan = true;
      current.names = await cookieNames();
    }
    let img = '';
    if (state !== 'expired' && win && !win.isDestroyed()) {
      img = await win.webContents.executeJavaScript(`(() => {
        const i = [...document.querySelectorAll('img')].find(x => /^data:image\\//.test(x.src || '') && (x.naturalWidth || 0) >= 120);
        return i ? i.src : '';
      })()`).catch(() => '');
      if (img && current) current.img = img;
    }
    /* 页面自己换码时把最新的图带回去，界面跟着换，用户不用手动重试 */
    return { state, img: img || (current ? current.img : ''), names: (current && current.names) || [] };
  }

  function stop() {
    lastCookie = '';
    destroy();
  }

  if (app && typeof app.on === 'function') app.on('before-quit', stop);

  return { start, poll, stop, LOGIN_URL };
}

module.exports = { createQrLogin, LOGIN_URL, KEEP };
