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
  let current = null;                // { id, at, ttl, img, timer, sessdata }
  let lastCookie = '';               // 刚确认过的会话：容忍渲染层在确认后又多问一次
  let unwatchCookie = null;          // 取消 cookies.on('changed') 监听

  function destroy() {
    if (current && current.timer) clearTimeout(current.timer);
    current = null;
    if (unwatchCookie) { try { unwatchCookie(); } catch (e) { /* 退订失败不影响关窗 */ } unwatchCookie = null; }
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    session = null;
  }

  async function waitQr() {
    const deadline = Date.now() + QR_READY_TIMEOUT;
    while (Date.now() < deadline) {
      if (!win || win.isDestroyed()) throw new Error('登录窗口已关闭');
      /* 只做一件事：把页面里那张二维码的 data URL 取出来。
       * 放大交给渲染层（CSS image-rendering: pixelated，140 → 216 用最近邻，
       * 边缘硬、不糊）。之前在这里用 canvas 重画过一版，注入脚本会稳定报
       * 「Script failed to execute」——页面环境对这条脚本不友好，干脆不在
       * 页面里动手，只读。 */
      /* 注意：页面刚渲染时这里先挂的是一张 ~900 字符的占位白图，
       * 真正的二维码（140×140）base64 约 5KB，要等它自己画完才出现。
       * 所以要求长度过阈值才算拿到，否则会一直显示一块白板。 */
      const img = await win.webContents.executeJavaScript(`(() => {
        const MIN = 1500;   // 占位图约 900 字符，真码约 5KB
        const c = document.querySelector('canvas');
        if (c && c.width >= 120) {
          const d = c.toDataURL('image/png');
          if (d.length >= MIN) return d;
        }
        const i = [...document.querySelectorAll('img')]
          .find(x => String(x.src || '').startsWith('data:image/') && (x.naturalWidth || 0) >= 120);
        return i && String(i.src).length >= MIN ? i.src : '';
      })()`).catch(() => '');
      if (img) return img;
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('登录页没出现二维码（可能被风控或页面改版）');
  }

  async function readCookie() {
    /* 每轮都从窗口拿会话：页面跳转/新开窗口后旧的 session 引用可能已经不代表当前罐 */
    const jar = (win && !win.isDestroyed()) ? win.webContents.session : session;
    if (!jar) return '';
    /* 不按 domain 过滤：登录页会把 SESSDATA 写到 www./passport./.bilibili.com 等
     * 不同作用域上，用 domain 过滤很容易「看漏」（酷狗那版就踩过这个坑）。
     * 这里取全部 cookie，再按名字白名单挑，看到同名取最后一个非空值。 */
    const all = await jar.cookies.get({});
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
    /* 登录完成后官方页面可能 window.open 一个回调页：那个窗口虽然也用同一个分区，
     * 但我们读罐的时机与它的生命周期对不上。直接拒掉，并把地址在当前隐藏窗口里
     * 走一遍，让 Set-Cookie 落在我们正在读的这个会话上。 */
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) win.loadURL(url).catch(() => { /* 打不开就把地址丢掉 */ });
      return { action: 'deny' };
    });
    /* 会话层监听：登录成功那一下 Set-Cookie 可能跟着一次跳转到来，页面马上就走了，
     * 单靠下轮 poll 去读罐容易错过「页面已经跳走、窗口还没销毁」这一拍。 */
    const onCookie = (_e, c) => {
      if (!c || c.name !== 'SESSDATA' || !c.value) return;
      if (current) current.sessdata = c.value;
    };
    session.cookies.on('changed', onCookie);
    unwatchCookie = () => session.cookies.removeListener('changed', onCookie);
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
    if (!cookie && current && current.sessdata) {
      /* 监听已经看到 SESSDATA 落地，但读罐这一拍还没刷出来：按白名单把它拼回去 */
      const c = current.sessdata;
      lastCookie = 'SESSDATA=' + c;
      destroy();
      return { state: 'confirmed', cookie: lastCookie, img: '' };
    }
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
        const MIN = 1500;
        const c = document.querySelector('canvas');
        if (c && c.width >= 120) {
          const d = c.toDataURL('image/png');
          if (d.length >= MIN) return d;
        }
        const i = [...document.querySelectorAll('img')]
          .find(x => String(x.src || '').startsWith('data:image/') && (x.naturalWidth || 0) >= 120);
        return i && String(i.src).length >= MIN ? i.src : '';
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
