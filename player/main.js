'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, globalShortcut, shell, net, safeStorage, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');
const ne = require('./netease');
const bil = require('./bilibili');
const { createQrLogin } = require('./bilibili-qr');
const upstream = require('./upstream-library');
const streams = require('./stream-resolve');
const upmeta = require('./upstream-meta');

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.wma', '.aiff', '.aif']);
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wma': 'audio/x-ms-wma',
  '.aiff': 'audio/aiff', '.aif': 'audio/aiff'
};
const IMG_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const SIDECAR_NAMES = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'albumart.jpg'];

/* ---------------- 应用身份 ----------------
 * 显示名带一个撇号（U+2032），用在窗口标题、关于页、安装包与快捷方式上。
 * 数据目录另起一个纯 ASCII 的名字：路径里出现 ′ 这类字符，备份/同步/命令行
 * 工具很容易转义出错，而用户根本不需要看到这个目录名。
 * 注意顺序：必须先把 userData 指过去，再取 userDir，否则下面拿到的还是旧路径。
 */
const APP_NAME = 'Nckik′s music';
const APP_DATA_DIR = 'NckiksMusic';
app.setName(APP_NAME);
/* 只在 userData 还等于「按应用名推出来的默认值」时才改道：
 * 用户显式传了 --user-data-dir（多配置 / 调试）、或测试先 setPath 过临时目录，
 * 都必须尊重 —— 无条件覆盖会把外部指定整个吃掉（审计时靠探针抓出来的）。 */
const nameDefaultDir = path.join(app.getPath('appData'), app.getName());
if (app.getPath('userData') === nameDefaultDir) {
  app.setPath('userData', path.join(app.getPath('appData'), APP_DATA_DIR));
}

const userDir = app.getPath('userData');
const settingsPath = path.join(userDir, 'settings.json');
const libraryPath = path.join(userDir, 'library.json');

/* media 是本地文件；neaudio 是网易云音频，bilaudio 是哔哩哔哩音频（都由主进程代理，
 * 带 Range 透传）。远程地址会过期，且 http/https 混杂，交给自建协议统一处理：
 * 渲染层始终只看到 neaudio://s/<id> / bilaudio://s/<bvid>:<cid>，音频源换了服务器也不用改前端。 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  { scheme: 'neaudio', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  { scheme: 'bilaudio', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  { scheme: 'upaudio', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
]);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.env.SHOT_DPR) app.commandLine.appendSwitch('force-device-scale-factor', process.env.SHOT_DPR);
// Windows 任务栏分组与通知身份：不设的话打包后会显示成 electron.app.Electron
if (process.platform === 'win32') app.setAppUserModelId('com.nckik.music');

/* 兜底日志：主进程里任何没接住的异常都别静默消失。
 * 只写文件、不弹窗、不中断，避免把「某个 IPC 里的编程错误」升级成闪退。 */
const crashLogPath = path.join(app.getPath('userData'), 'crash.log');
function logCrash(where, err) {
  try {
    // 目录可能还不存在（首次运行 / userData 被清掉）：appendFileSync 不会自动建目录，
    // 少了这一步，真正启动失败时反而什么都留不下来。
    fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
    const line = `[${new Date().toISOString()}] ${where} :: ${(err && err.stack) || err}\n`;
    if (fs.existsSync(crashLogPath) && fs.statSync(crashLogPath).size > 512 * 1024) fs.unlinkSync(crashLogPath);
    fs.appendFileSync(crashLogPath, line);
  } catch {}
}
process.on('uncaughtException', e => logCrash('uncaughtException', e));
process.on('unhandledRejection', e => logCrash('unhandledRejection', e));

let win = null;
let preFull = null;        // 进入全屏前的窗口状态，退出时原样还原

/* 单实例：两个实例会抢音频设备，也会互相覆盖全局快捷键注册。
 *
 * 不能只信 requestSingleInstanceLock()。它在 Windows 上要靠 Chromium 的
 * ProcessSingleton 在 userData 里建锁文件（SingletonLock），一旦这个建不出来
 * —— 权限收紧、杀软拦截、受限令牌、残留的同名文件 —— 它就返回 false，
 * 而这里的 app.quit() 会让应用「一闪而过」，用户完全看不到原因（连 crash.log
 * 都不会有，因为根本没走到写日志的地方）。
 *
 * 所以再叠一层纯 Node 的 pid 锁，只有当「两个判定都说另有实例」时才退出。 */
const PID_LOCK = path.join(userDir, 'instance.pid');
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }  // EPERM = 进程在，只是不归我们管
}
function claimPidLock() {
  let held = 0;
  try { held = Number(String(fs.readFileSync(PID_LOCK, 'utf8')).trim()) || 0; } catch {}
  if (pidAlive(held)) return 'held';           // 真有实例在跑
  try { fs.unlinkSync(PID_LOCK); } catch {}    // 残留（上次崩溃没清），进程已经没了
  try {
    fs.writeFileSync(PID_LOCK, String(process.pid), { flag: 'wx' });
    return 'claimed';
  } catch (e) {
    return e && e.code === 'EEXIST' ? 'held' : 'error';
  }
}
const gotLock = app.requestSingleInstanceLock();
const pidState = claimPidLock();
if (!gotLock && pidState === 'held') {
  // 两票都说有实例 → 确实是第二个实例。给一句人话，别让用户对着空屏幕反复双击。
  try {
    dialog.showErrorBox('Nckik′s music', '已经有一个窗口在运行了，请到任务栏看看。\n\n如果找不到，说明上一个实例卡住了：在任务管理器里结束 electron.exe 再启动。');
  } catch {}
  app.quit();
} else if (!gotLock) {
  // Chromium 的锁用不了，但 pid 锁说没有实例：照常启动，别让用户对着闪退发呆
  console.warn('[single-instance] Chromium 锁不可用，已回退到 pid 锁继续启动');
  logCrash('single-instance', new Error('Chromium 单实例锁不可用，已回退到 pid 锁（pid=' + pidState + '）'));
} else if (pidState !== 'claimed') {
  // Chromium 说我们是唯一实例 → 旧 pid 文件是残留（pid 被别的进程复用），直接覆盖
  try { fs.writeFileSync(PID_LOCK, String(process.pid)); } catch {}
}
if (pidState === 'claimed') {
  app.on('quit', () => { try { fs.unlinkSync(PID_LOCK); } catch {} });
}

/* ---------------- 本地媒体协议：带 Range 支持，保证拖动进度条可 seek ---------------- */
function registerMediaProtocol() {
  protocol.handle('media', async (request) => {
    let filePath;
    try {
      // searchParams.get 已经做过百分号解码，这里绝不能再 decode 一次：
      // 路径里只要有一个裸 '%'（如 "100% Pure.mp3"），二次解码就会抛 URIError → 400。
      filePath = new URL(request.url).searchParams.get('p') || '';
    } catch { return new Response('bad url', { status: 400 }); }
    if (!filePath) return new Response('bad url', { status: 400 });
    if (!AUDIO_EXT.has(path.extname(filePath).toLowerCase())) return new Response('unsupported', { status: 415 });

    let stat;
    try { stat = await fsp.stat(filePath); } catch { return new Response('not found', { status: 404 }); }
    if (!stat.isFile()) return new Response('not found', { status: 404 });

    const total = stat.size;
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = request.headers.get('range');

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = 0;
      let end = total - 1;
      if (m) {
        if (!m[1] && m[2]) {
          // `bytes=-N` 是「最后 N 字节」，不是「0 到 N」。按 0..N 解会让播放器
          // 以为文件只有 N 字节，尾部请求也都拿到错误区间。
          const tail = parseInt(m[2], 10);
          start = Math.max(0, total - (Number.isFinite(tail) ? tail : 0));
        } else {
          if (m[1]) start = parseInt(m[1], 10);
          if (m[2]) end = parseInt(m[2], 10);
        }
      }
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= total) end = total - 1;
      if (start > end || total === 0) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
      const stream = fs.createReadStream(filePath, { start, end });
      return new Response(Readable.toWeb(stream), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes'
        }
      });
    }

    return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(total), 'Accept-Ranges': 'bytes' }
    });
  });
}

/* ---------------- 网易云音频协议 ----------------
 * 渲染层拿到的地址是 neaudio://s/<id>，真正的 CDN 地址在这里解析并代理。
 * 必须做的点：
 *   1. 透传 Range —— 不转发 Range，audio 元素就无法 seek，进度条拖拽会退化成从头加载；
 *   2. 地址过期换一次 —— 网易云返回的直链 20 分钟失效，命中 401/403 时
 *      丢掉缓存重新解析一次，而不是让播放直接失败；
 *   3. 上游必须有超时，而且必须能被取消 —— 见下面的 NE_HEAD_TIMEOUT 与
 *      proxyBody 的注释：少这两条，切歌时会卡在「加载中」不动。
 */
const PASSTHROUGH_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

/* 等上游响应头的上限：CDN 偶尔会接受连接却迟迟不吐响应（实测有 20~35 秒的），
 * 没有上限时 audio 元素既拿不到数据也不会报 error，界面就永远停在「正在加载封面…」。 */
const NE_HEAD_TIMEOUT = 15000;

/* 诊断开关：NCKIK_TRACE_NE=1 时打印协议层每级耗时（songUrl / fetch 头 / 换链 / 取消），
 * 用来定位「请求被挂住」卡在哪一级。正常运行完全静默，没有开销。 */
const NE_TRACE = !!process.env.NCKIK_TRACE_NE;
let neTraceN = 0;
function neTrace(...a) {
  if (!NE_TRACE) return;
  console.log('[neaudio]', String(Date.now() % 100000), '#' + (++neTraceN), ...a);
}

/* 把上游响应体接到协议响应上，并把「媒体元素中止」翻译成「取消上游」。
 *
 * 不能直接把 res.body 交出去：ProtocolRequest 上根本没有 signal，主进程无从得知
 * 渲染层已经放弃了这次加载（切歌 / 换源 / 关窗都会发生）。变成孤儿响应体之后，
 * 上游还会继续把整首（十几 MB）下完而没人消费；实测连着切歌十几次之后，
 * 新的请求要 20~35 秒才拿到响应头，媒体元素就一直卡在 loading。
 * 包一层流：Electron 取消响应体时会调到 cancel()，这里 abort 上游连接即刻释放。 */
function proxyBody(res, ctrl, id) {
  if (!res.body) { ctrl.abort(); return new ReadableStream({ start: c => c.close() }); }
  const reader = res.body.getReader();
  const abort = () => { try { ctrl.abort(); } catch {} };
  return new ReadableStream({
    async pull(stream) {
      try {
        const { done, value } = await reader.read();
        if (done) { stream.close(); return; }
        stream.enqueue(value);
      } catch (e) {
        abort();
        try { stream.error(e); } catch {}
      }
    },
    cancel(reason) {
      neTrace('body cancel', 'id=' + id, String(reason || 'aborted'));
      abort();
      reader.cancel().catch(() => {});
    }
  });
}

function registerNeProtocol() {
  protocol.handle('neaudio', async (request) => {
    let id = 0;
    try {
      const u = new URL(request.url);
      id = Number((u.pathname || '').replace(/^\/+/, '')) || Number(u.searchParams.get('id')) || 0;
    } catch {}
    if (!id) return new Response('bad id', { status: 400 });

    const range = request.headers.get('range');
    let lastStatus = 0;
    const tIn = Date.now();
    neTrace('in', 'id=' + id, 'range=' + range);

    for (let attempt = 0; attempt < 2; attempt++) {
      let info;
      try {
        const t0 = Date.now();
        info = await ne.songUrl(id);
        neTrace('songUrl ok', 'id=' + id, (Date.now() - t0) + 'ms', 'attempt=' + attempt);
      } catch (e) {
        // 需要会员 / 无版权：返回 404，渲染层按 mediaErr 走「跳过并提示」
        neTrace('songUrl fail', 'id=' + id, (e && e.code) || '', (e && e.message) || e);
        return new Response(String((e && e.message) || e), {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'x-ne-reason': (e && e.code) || 'NE_ERROR' }
        });
      }

      const headers = {};
      if (range) headers.Range = range;

      /* 每次响应一个独立的 controller：既用来给「等响应头」设上限，
       * 也用来在媒体元素放弃这次加载时掐掉上游下载（见 proxyBody）。 */
      const ctrl = new AbortController();
      const headTimer = setTimeout(() => ctrl.abort(new Error('NE_HEAD_TIMEOUT')), NE_HEAD_TIMEOUT);
      let res;
      try {
        const tf = Date.now();
        res = await net.fetch(info.url, { headers, signal: ctrl.signal });
        neTrace('fetch ok', 'id=' + id, (Date.now() - tf) + 'ms', 'status=' + res.status);
      } catch (e) {
        /* 超时 / 连接失败：必须回一个真正的 HTTP 错误码。
         * 之前这里只有「不超时、不取消」，上游一慢，媒体元素就永远停在 loading：
         * 既没有数据也不派发 error，play() 的 Promise 不 settle，界面卡在加载态。
         * 回了 5xx，媒体元素才会走 error → 渲染层「跳过并提示」的既有路径。 */
        const timedOut = String((e && e.message) || e).includes('NE_HEAD_TIMEOUT');
        neTrace('fetch fail', 'id=' + id, timedOut ? 'TIMEOUT' : ((e && e.message) || e));
        return new Response(timedOut ? 'upstream timeout' : 'upstream failed', {
          status: timedOut ? 504 : 502,
          headers: { 'x-ne-reason': timedOut ? 'NE_UPSTREAM_TIMEOUT' : 'NE_UPSTREAM_FAIL' }
        });
      } finally {
        clearTimeout(headTimer);
      }
      lastStatus = res.status;

      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        neTrace('expired', 'id=' + id, 'status=' + res.status, '换链重试');
        ctrl.abort();               // 这一份响应体不要了，别留着占连接
        ne.invalidateUrl(id);       // 直链过期，换一条再来
        continue;
      }

      const h = new Headers();
      for (const k of PASSTHROUGH_HEADERS) {
        const v = res.headers.get(k);
        if (v) h.set(k, v);
      }
      if (!h.has('accept-ranges')) h.set('accept-ranges', 'bytes');
      neTrace('return', 'id=' + id, (Date.now() - tIn) + 'ms 总计', 'ct=' + h.get('content-type'));
      return new Response(proxyBody(res, ctrl, id), { status: res.status, headers: h });
    }
    neTrace('give up', 'id=' + id, 'lastStatus=' + lastStatus, (Date.now() - tIn) + 'ms');
    return new Response('upstream ' + lastStatus, { status: 410 });
  });
}

/* ---------------- 哔哩哔哩音频代理 ----------------
 * 与 neaudio 同一套骨架，差异只有三处：
 *   1. 一次取流会拿到多条 CDN 地址（主地址 + 备份），主地址常是 mcdn（P2P 节点，
 *      部分网络直接超时），所以这里按顺序逐个试，而不是只试一次；
 *   2. 上游把 m4s 的 content-type 报成 application/octet-stream，直接透传会让
 *      媒体元素不认，统一改写成 audio/mp4；
 *   3. 401/403/404 都当成「这条链失效」换下一条，全部失败才回 5xx/404。
 */
const BIL_HEAD_TIMEOUT = 15000;

function parseBilId(url) {
  try {
    const u = new URL(url);
    const rest = decodeURIComponent((u.pathname || '').replace(/^\/+/, ''));
    const id = /^BV/.test(rest) ? rest : '';
    const [bvid, cid] = id.split(':');
    return { bvid: bvid || '', cid: Number(cid) || 0 };
  } catch { return { bvid: '', cid: 0 }; }
}

/* ---------------- 上游音源协议（kugou / qqapp） ----------------
 * 与 bilaudio 同一套做法：解析直链 → 带 Referer/UA 代理 → 透传 Range。
 * 直链有时效（酷狗约几分钟、QQ 的 vkey 更长），所以每次请求都重新解析，
 * 但同一 track 在 90 秒内复用结果，避免 Range 请求把接口打爆。
 */
const UP_HEAD_TIMEOUT = 15000;
const upCache = new Map();

function parseUpId(url) {
  const m = /^upaudio:\/\/s\/([a-z]+)\/(.+)$/.exec(String(url || ''));
  return m ? { provider: m[1], id: decodeURIComponent(m[2]) } : { provider: '', id: '' };
}

async function upResolve(provider, id) {
  const key = provider + ':' + id;
  const now = Date.now();
  const hit = upCache.get(key);
  if (hit && now - hit.at < 90_000) return hit.info;

  const cred = credOf(provider);
  if (!cred) throw Object.assign(new Error('还没有登录该音源'), { code: 'E_AUTH_REQUIRED' });
  const extra = cred.extra || {};
  const info = provider === 'kugou'
    ? await streams.kgResolve(id, 'high')
    : await streams.qqResolve(id, { uin: extra.uin, musickey: extra.musickey }, 'high');
  /* QQ 的 purl 只在部分 CDN 主机上有效：dl 常常 404，isure/ws 才是真正给播放器的。
   * 这里一次解析出候选主机列表，代理层按顺序试。 */
  if (provider === 'qqapp' && info.url) {
    const path = info.url.replace(/^https?:\/\/[^/]+\//, '');
    info.urls = [
      'https://sjy6.stream.qqmusic.qq.com/' + path,
      'https://isure.stream.qqmusic.qq.com/' + path,
      'https://dl.stream.qqmusic.qq.com/' + path,
      'https://ws.stream.qqmusic.qq.com/' + path
    ];
  }
  upCache.set(key, { at: now, info });
  return info;
}

function registerUpProtocol() {
  protocol.handle('upaudio', async (request) => {
    const { provider, id } = parseUpId(request.url);
    if (!/^(kugou|qqapp)$/.test(provider) || !id) {
      return new Response('bad id', { status: 400, headers: { 'x-up-reason': 'UP_BAD_ID' } });
    }
    let info;
    try {
      info = await upResolve(provider, id);
    } catch (e) {
      return new Response(String((e && e.message) || e), {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'x-up-reason': (e && e.code) || 'UP_ERROR' }
      });
    }

    const range = request.headers.get('range');
    const targets = info.urls && info.urls.length ? info.urls : [info.url];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('UP_HEAD_TIMEOUT')), UP_HEAD_TIMEOUT);
    let res = null;
    for (const target of targets) {
      try {
        const r0 = await net.fetch(target, {
          headers: { ...(info.headers || {}), ...(range ? { Range: range } : {}) },
          signal: ctrl.signal
        });
        if (r0.status === 401 || r0.status === 403 || r0.status === 404 || r0.status === 410) { try { r0.body?.cancel(); } catch {} continue; }
        res = r0; break;
      } catch (e) { /* 换下一条 */ }
    }
    if (!res) { clearTimeout(timer); return new Response('upstream expired', { status: 502, headers: { 'x-up-reason': 'UP_EXPIRED' } }); }
    clearTimeout(timer);
    console.log('[up]', provider, res.status, String(res.headers.get('content-type') || ''), info.url.slice(0, 70));
    if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
      try { ctrl.abort(); } catch {}
      upCache.delete(provider + ':' + id);
      return new Response('upstream ' + res.status, { status: 502, headers: { 'x-up-reason': 'UP_EXPIRED' } });
    }

    const h = new Headers();
    for (const k of PASSTHROUGH_HEADERS) {
      const v = res.headers.get(k);
      if (v) h.set(k, v);
    }
    if (!h.has('accept-ranges')) h.set('accept-ranges', 'bytes');
    const ct = String(h.get('content-type') || '');
    if (!/^audio\//i.test(ct) && !/^video\//i.test(ct)) h.set('content-type', 'audio/mpeg');
    return new Response(proxyBody(res, ctrl, provider + ':' + id), { status: res.status, headers: h });
  });
}

function registerBilProtocol() {
  protocol.handle('bilaudio', async (request) => {
    const { bvid, cid } = parseBilId(request.url);
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
      return new Response('bad id', { status: 400, headers: { 'x-bil-reason': 'BIL_BAD_ID' } });
    }

    let info;
    try {
      info = await bil.playUrl(bvid, cid);
    } catch (e) {
      // 需要会员 / 无音轨：回 404 + 原因，渲染层按 mediaErr 走「跳过并提示」
      return new Response(String((e && e.message) || e), {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'x-bil-reason': (e && e.code) || 'BIL_ERROR' }
      });
    }

    const range = request.headers.get('range');
    let last = 0;

    for (const target of info.urls) {
      const ctrl = new AbortController();
      const headTimer = setTimeout(() => ctrl.abort(new Error('BIL_HEAD_TIMEOUT')), BIL_HEAD_TIMEOUT);
      let res;
      try {
        res = await net.fetch(target, {
          headers: {
            // CDN 校验 Referer 与 UA，缺了直接 403 —— 这是 B 站取流最常见的坑
            Referer: 'https://www.bilibili.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            Origin: 'https://www.bilibili.com',
            ...(range ? { Range: range } : {})
          },
          signal: ctrl.signal
        });
      } catch (e) {
        clearTimeout(headTimer);
        last = 0;
        continue;                        // 这条链连不上，换下一条
      }
      clearTimeout(headTimer);
      last = res.status;

      if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
        try { ctrl.abort(); } catch {}
        continue;                        // 地址过期 / 权限不足，试下一条
      }
      if (res.status >= 500) {
        try { ctrl.abort(); } catch {}
        continue;
      }

      const h = new Headers();
      for (const k of PASSTHROUGH_HEADERS) {
        const v = res.headers.get(k);
        if (v) h.set(k, v);
      }
      if (!h.has('accept-ranges')) h.set('accept-ranges', 'bytes');
      const ct = String(h.get('content-type') || '');
      if (!/^audio\//i.test(ct) && !/^video\//i.test(ct)) {
        h.set('content-type', info.fallback ? 'video/mp4' : 'audio/mp4');
      }
      return new Response(proxyBody(res, ctrl, 'bil:' + bvid + ':' + cid), { status: res.status, headers: h });
    }

    return new Response('upstream ' + last, {
      status: last ? 502 : 504,
      headers: { 'x-bil-reason': last ? 'BIL_UPSTREAM_FAIL' : 'BIL_UPSTREAM_TIMEOUT' }
    });
  });
}

/* ---------------- 网易云凭证 ----------------
 * 只存扫码登录换来的会话串（MUSIC_U / __csrf 等），不接收也不保存账号密码。
 * 用系统密钥库（Windows DPAPI / macOS Keychain）加密后落盘，settings.json 里不出现明文。
 */
const neAuthPath = path.join(userDir, 'ne-auth.bin');

/* 改名（云音乐 → Nckik′s music）会换掉数据目录。老用户升级上来不该丢曲库：
 * 新目录里还没有 library.json/settings.json 时，从旧目录把三份文件搬过来。
 * 只搬这三个文件，别的（缓存、日志）不带；拷贝失败不影响启动。
 * 测试/调试环境可设 NCKIK_SKIP_MIGRATION=1 跳过（空配置是刻意的，不要搬旧数据）。 */
function migrateOldUserData() {
  if (process.env.NCKIK_SKIP_MIGRATION === '1') return;
  try {
    if (fs.existsSync(libraryPath) || fs.existsSync(settingsPath)) return;   // 已有数据，绝不覆盖
    const appData = app.getPath('appData');
    const names = ['云音乐', 'yun-music-player'];
    for (const name of names) {
      const dir = path.join(appData, name);
      if (dir === userDir || !fs.existsSync(dir)) continue;
      const files = ['library.json', 'settings.json', 'ne-auth.bin'].filter(f => {
        try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
      });
      if (!files.length) continue;
      fs.mkdirSync(userDir, { recursive: true });
      for (const f of files) {
        try { fs.copyFileSync(path.join(dir, f), path.join(userDir, f)); } catch {}
      }
      console.log('migrated from', dir, files.join(','));
      return;                                   // 只迁一次，取第一个有数据的旧目录
    }
  } catch {}
}

function readNeCookie() {
  try {
    if (!fs.existsSync(neAuthPath)) return '';
    if (!safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(fs.readFileSync(neAuthPath));
  } catch { return ''; }
}

function writeNeCookie(cookie) {
  const v = String(cookie || '').trim();
  if (!v) {
    try { fs.unlinkSync(neAuthPath); } catch {}
    return false;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统密钥库不可用，无法安全保存凭证');
  }
  fs.writeFileSync(neAuthPath, safeStorage.encryptString(v));
  return true;
}

/* ---------------- 哔哩哔哩凭证 ----------------
 * 与网易云同一套做法：只存会话串（SESSDATA / bili_jct / DedeUserID），
 * 用系统密钥库加密后落盘；settings.json 与日志里都不出现明文。
 * 单独一个文件是为了「删掉一个音源的登录」不会波及另一个。 */
/* 扫码走「官方登录页 + 隐藏窗口」：见 bilibili-qr.js 顶部注释 */
const bilQr = createQrLogin({ BrowserWindow, app });

const bilAuthPath = path.join(userDir, 'bil-auth.bin');

/* 只把 Cookie 的键名拿出来记日志，值一律不落盘 */
function parseBilCookieKeys(raw) {
  return String(raw || '')
    .replace(/^cookie:\s*/i, '')
    .split(/[;\n\r]+/)
    .map(x => x.trim().split('=')[0].toLowerCase())
    .filter(Boolean);
}

function readBilCookie() {
  try {
    if (!fs.existsSync(bilAuthPath)) return '';
    if (!safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(fs.readFileSync(bilAuthPath));
  } catch { return ''; }
}

function writeBilCookie(cookie) {
  const v = String(cookie || '').trim();
  if (!v) {
    try { fs.unlinkSync(bilAuthPath); } catch {}
    return false;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统密钥库不可用，无法安全保存凭证');
  }
  fs.writeFileSync(bilAuthPath, safeStorage.encryptString(v));
  return true;
}

/* ---------------- 持久化 ---------------- */
/* 解析失败时把坏文件改名留档，避免"曲库凭空消失"；写入走 临时文件 + rename，断电不会写出半截 JSON */
const readJSON = (p, fb) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) {
    if (e && e.code !== 'ENOENT') {
      const bak = `${p}.bad-${Date.now()}`;
      try { fs.renameSync(p, bak); console.error('readJSON failed, kept copy at', bak, e.message); } catch {}
    }
    return fb;
  }
};
const writeJSON = (p, v) => {
  try {
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
    fs.renameSync(tmp, p);
  } catch (e) { console.error('writeJSON', p, e); }
};

const DEFAULT_SETTINGS = {
  theme: 'auto', volume: 0.78, shuffle: false, repeat: 'off', sinkId: '', muted: false,
  lat: 31.2304, lon: 121.4737, city: '上海', globalKeys: true,
  quality: 'exhigh',           // 网易云音质档位：standard / higher / exhigh / lossless
  lyricTrans: true             // 歌词翻译默认显示；没有译文的歌不受影响
};

/* ---------------- 元数据 ---------------- */
let mmPromise = null;
const getMM = () => (mmPromise ||= import('music-metadata'));

function guessFromName(file) {
  const base = path.basename(file, path.extname(file));
  const m = /^(.*?)\s+-\s+(.*)$/.exec(base);
  if (m) return { title: m[2].trim(), artist: m[1].trim(), album: '' };
  return { title: base, artist: '未知艺人', album: '' };
}

/* 同目录的通用封面只读一次：一张 cover.jpg 被整张专辑共享，没必要每首读一遍 */
const dirCoverCache = new Map();

async function readImage(dir, name) {
  const ext = path.extname(name).toLowerCase();
  if (!IMG_EXT.has(ext)) return null;
  try {
    const buf = await fsp.readFile(path.join(dir, name));
    if (buf.length > 12 * 1024 * 1024) return null;
    return `data:${IMG_MIME[ext]};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

async function sidecarCover(file) {
  const dir = path.dirname(file);
  let files;
  try { files = fs.readdirSync(dir); } catch { return null; }
  const lower = new Map(files.map(f => [f.toLowerCase(), f]));
  const base = path.basename(file, path.extname(file)).toLowerCase();

  // 1) 与曲目同名的封面：每首不同，不缓存
  for (const ext of IMG_EXT) {
    const real = lower.get(base + ext);
    if (real) { const data = await readImage(dir, real); if (data) return data; }
  }
  // 2) 目录通用封面：整目录共享，按目录缓存，避免 N 首重复读同一张图
  if (dirCoverCache.has(dir)) return dirCoverCache.get(dir);
  let found = null;
  for (const n of SIDECAR_NAMES) {
    const real = lower.get(n);
    if (real) { found = await readImage(dir, real); if (found) break; }
  }
  // 只缓存「读到了」的结果：之前这里把 null 也按目录写死，只要第一次读的时候封面还没就位
  // （正在拷文件、刚改完名），整个会话里这一整个目录都不会再有封面。
  if (found) {
    dirCoverCache.set(dir, found);
    while (dirCoverCache.size > 200) dirCoverCache.delete(dirCoverCache.keys().next().value);
  }
  return found;
}

/* 内嵌歌词与封面互不影响：歌词无论 withCover 与否都要取，否则"内嵌兜底"永远为空 */
function pickLyrics(common) {
  const list = (common && common.lyrics) || [];
  return list.map(l => (typeof l === 'string' ? l : l && l.text)).filter(Boolean)[0] || '';
}

/* 内嵌歌词里可能存了不止一份：第二份带有时间轴时按翻译处理（有些抓轨工具
 * 会把原文和译文都塞进同一条 tag）。只取第二份，不做更多猜测。 */
function pickLyricsTr(common) {
  const list = (common && common.lyrics) || [];
  const all = list.map(l => (typeof l === 'string' ? l : l && l.text)).filter(Boolean);
  const second = all[1] || '';
  return /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(second) ? second : '';
}

async function readTrack(file, withCover = false) {
  const g = guessFromName(file);
  const out = {
    path: file, title: g.title, artist: g.artist, album: g.album,
    duration: 0, codec: '', sampleRate: 0, bitDepth: 0, bitrate: 0, lossless: false, cover: null
  };
  try {
    const mm = await getMM();
    const meta = await mm.parseFile(file, { duration: true, skipCovers: !withCover });
    const c = meta.common || {};
    if (c.title) out.title = c.title;
    if (c.artist) out.artist = c.artist;
    if (c.album) out.album = c.album;
    out.duration = Math.round(meta.format?.duration || 0);
    out.codec = (meta.format?.codec || path.extname(file).slice(1)).toUpperCase();
    out.sampleRate = meta.format?.sampleRate || 0;
    out.bitDepth = meta.format?.bitsPerSample || 0;
    out.bitrate = meta.format?.bitrate || 0;
    out.lossless = !!meta.format?.lossless;

    const lyr = pickLyrics(c);
    if (lyr) out.embeddedLyrics = lyr;

    if (withCover) {
      const pic = (c.picture || [])[0];
      out.cover = pic
        ? `data:${pic.format || 'image/jpeg'};base64,${Buffer.from(pic.data).toString('base64')}`
        : await sidecarCover(file);
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

function findSidecarLrc(file) {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  const candidates = [`${base}.lrc`];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.toLowerCase() === `${base.toLowerCase()}.lrc`) { candidates.unshift(path.join(dir, name)); break; }
    }
  } catch {}
  for (const c of candidates) {
    const p = path.isAbsolute(c) ? c : path.join(dir, c);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

/* 翻译歌词的旁挂文件：`同名.zh.lrc` / `.trans.lrc` / `.tlyric.lrc` / `.zh-CN.lrc`。
 * 顺序即优先级，和主歌词一样大小写不敏感。 */
const TR_SIDECAR = ['.zh.lrc', '.zh-CN.lrc', '.trans.lrc', '.tlyric.lrc'];
function findSidecarTrans(file) {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const lower = new Map(names.map(n => [n.toLowerCase(), n]));
  for (const suf of TR_SIDECAR) {
    const hit = lower.get((base + suf).toLowerCase());
    if (!hit) continue;
    const p = path.join(dir, hit);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

async function scanFolder(dir, acc = []) {
  let list = [];
  try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const d of list) {
    if (d.name.startsWith('.')) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) await scanFolder(full, acc);
    else if (AUDIO_EXT.has(path.extname(d.name).toLowerCase())) acc.push(full);
  }
  return acc;
}

/* 有限并发：串行解析大目录会把主进程 CPU 打满，1000 首要等很久且全程无反馈 */
async function mapLimit(items, limit, fn) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

const scanState = { busy: false, abort: false };
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

/* ---------------- 窗口 ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 700, minWidth: 860, minHeight: 560,
    frame: false, backgroundColor: '#0b0b0e', show: false,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.on('closed', () => { win = null; });
  // 渲染进程崩溃时留证并给一次自动恢复，总比留个白窗口强
  win.webContents.on('render-process-gone', (_e, details) => {
    logCrash('render-process-gone', JSON.stringify(details));
    if (!win || win.isDestroyed()) return;
    if (details && details.reason === 'clean-exit') return;
    try { win.webContents.reload(); } catch {}
  });
  win.webContents.on('preload-error', (_e, p, err) => logCrash('preload-error ' + p, err));

  const q = (process.env.SHOT_T || process.env.SHOT_OPEN)
    ? { query: { t: process.env.SHOT_T || '', open: process.env.SHOT_OPEN || '' } }
    : undefined;
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), q);
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));
  win.on('enter-full-screen', () => send('win:state', { fullscreen: true, maximized: false }));
  win.on('leave-full-screen', () => {
    const wasMax = !!(preFull && preFull.maximized);
    restoreFromFull();
    // maximize() 在 Windows 上异步生效，此刻 isMaximized 可能仍是 false；
    // 按即将还原的目标状态回报，随后的 maximize 事件会再校正一次。
    send('win:state', { fullscreen: false, maximized: wasMax ? true : win.isMaximized() });
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.SHOT) {
    win.webContents.once('did-finish-load', () => {
      if (process.env.SHOT_FS) {
        setTimeout(() => { setFullscreen(true); setTimeout(capture, 1200); }, 700);
      } else {
        setTimeout(capture, 2600);
      }
    });
  }
}

async function capture() {
  try {
    if (process.env.SHOT_P) {
      await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector('.ln.on'); if (el) el.style.setProperty('--p', ${JSON.stringify(process.env.SHOT_P)}); return true; })()`
      );
      await new Promise(r => setTimeout(r, 120));
    }
    const rect = process.env.SHOT_RECT
      ? (([x, y, width, height]) => ({ x, y, width, height }))(process.env.SHOT_RECT.split(',').map(Number))
      : undefined;
    const img = await win.webContents.capturePage(rect);
    const out = process.env.SHOT;
    fs.writeFileSync(out, img.toPNG());
    console.log('SHOT saved', out);
  } catch (e) { console.error('SHOT failed', e); }
  setTimeout(() => app.quit(), 300);
}

/* ---------------- 全屏 ---------------- */
/*
 * 用原生 setFullScreen 而不是「放大到屏幕尺寸 + 置顶」：
 * 后者盖不住任务栏（任务栏在 Z 序上更靠前），要盖住就得 alwaysOnTop，
 * 而 alwaysOnTop 会让窗口压在其他程序之上，不像全屏。
 */
function setFullscreen(on) {
  if (!win || win.isDestroyed()) return false;
  if (on) {
    if (win.isFullScreen()) return true;
    // getNormalBounds 拿的是「还原态」尺寸，最大化时也能拿到正确值
    preFull = { maximized: win.isMaximized(), bounds: win.getNormalBounds() };
    win.setFullScreen(true);
    return true;
  }
  if (!win.isFullScreen()) return false;
  win.setFullScreen(false);
  return false;
}

function restoreFromFull() {
  const s = preFull;
  preFull = null;
  if (!s || !win || win.isDestroyed()) return;
  if (s.maximized) { win.maximize(); return; }
  if (win.isMaximized()) win.unmaximize();
  win.setBounds(s.bounds);
}

/* ---------------- IPC ---------------- */
ipcMain.handle('dialog:files', async () => {
  if (!win || win.isDestroyed()) return [];
  const r = await dialog.showOpenDialog(win, {
    title: '选择音乐文件', properties: ['openFile', 'multiSelections'],
    filters: [{ name: '音频', extensions: [...AUDIO_EXT].map(e => e.slice(1)) }]
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:folder', async () => {
  if (!win || win.isDestroyed()) return [];
  const r = await dialog.showOpenDialog(win, { title: '选择音乐文件夹', properties: ['openDirectory'] });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('scan:cancel', () => { scanState.abort = true; return true; });

ipcMain.handle('lib:scan', async (_e, { files = [], dirs = [] } = {}) => {
  if (scanState.busy) return [];
  const all = new Set();
  // 拖进来的路径可能是文件也可能是目录，两种都收
  for (const f of files) {
    try {
      const st = await fsp.stat(f);
      if (st.isDirectory()) for (const x of await scanFolder(f)) all.add(x);
      else if (AUDIO_EXT.has(path.extname(f).toLowerCase())) all.add(f);
    } catch {}
  }
  for (const d of dirs) for (const f of await scanFolder(d)) all.add(f);

  const list = [...all];
  scanState.busy = true;
  scanState.abort = false;
  let done = 0;
  send('scan:progress', { done: 0, total: list.length });

  const out = [];
  try {
    await mapLimit(list, 6, async (f) => {
      if (scanState.abort) return;
      const t = await readTrack(f, false);
      if (scanState.abort) return;
      out.push(t);
      done++;
      if (done % 8 === 0 || done === list.length) send('scan:progress', { done, total: list.length });
    });
  } finally {
    scanState.busy = false;
  }
  return out;
});

const isNeKey = p => typeof p === 'string' && p.startsWith('ne:');
/* 哔哩哔哩的键形如 bil:<bvid>:<cid>；cid 可能是 0（搜索阶段还没有），
 * 取流前由 bil:url 补齐 —— 所以这里只校验前缀与 bvid。 */
const isBilKey = p => typeof p === 'string' && p.startsWith('bil:') && /^bil:BV[0-9A-Za-z]{10}(:\d+)?$/.test(p);
const bilParts = p => {
  const [, bvid = '', cid = '0'] = String(p).split(':');
  return { bvid, cid: Number(cid) || 0 };
};

ipcMain.handle('track:detail', async (_e, file) => {
  // 远程音源的封面/时长在搜索与详情阶段已经拿到，没有本地文件可解析
  if (isNeKey(file)) return { source: 'netease' };
  if (isBilKey(file) || (typeof file === 'string' && file.startsWith('bil:'))) return { source: 'bilibili' };
  return readTrack(file, true);
});

ipcMain.handle('track:lyric', async (_e, file) => {
  /* 上游曲目（kg:<hash> / qq:<mid>）的歌词同样在这里返回，
   * 渲染层不用为「歌词从哪来」分叉。 */
  if (typeof file === 'string' && /^(kg|qq):/.test(file)) {
    try {
      const meta = await upstreamMetaOf(file);
      const text = (meta.lyric || []).map(l => `[${String(Math.floor(l.t / 60)).padStart(2, '0')}:${String(Math.floor(l.t % 60)).padStart(2, '0')}.${String(Math.round((l.t % 1) * 100)).padStart(2, '0')}]${l.text}`).join('\n');
      return { text, source: file.slice(0, 2) === 'kg' ? '酷狗' : 'QQ 音乐', note: text ? '' : '这首歌上游没有提供歌词' };
    } catch (e) {
      return { text: '', source: '', note: String((e && e.message) || e) };
    }
  }
  if (isNeKey(file)) {
    try { return await ne.lyric(Number(file.slice(3))); }
    catch (e) { return { text: '', source: '', note: String((e && e.message) || e) }; }
  }
  if (typeof file === 'string' && file.startsWith('bil:')) {
    // 视频没有歌词接口：明确说「没有」，别让界面一直转圈等一个不会来的结果
    return { text: '', source: '', note: '哔哩哔哩视频没有歌词' };
  }
  const side = findSidecarLrc(file);
  const trSide = findSidecarTrans(file);
  const readTr = async () => {
    if (!trSide) return '';
    try { return await fsp.readFile(trSide, 'utf8'); } catch { return ''; }
  };
  if (side) {
    try {
      return { text: await fsp.readFile(side, 'utf8'), tr: await readTr(), source: path.basename(side) };
    } catch {}
  }
  // 只取歌词：不解析封面、不读时长，比整条 readTrack 轻得多
  try {
    const mm = await getMM();
    const meta = await mm.parseFile(file, { duration: false, skipCovers: true });
    const lyr = pickLyrics(meta.common);
    return { text: lyr, tr: pickLyricsTr(meta.common), source: lyr ? '内嵌' : '' };
  } catch { return { text: '', source: '' }; }
});

ipcMain.handle('settings:get', () => ({ ...DEFAULT_SETTINGS, ...readJSON(settingsPath, {}) }));
ipcMain.handle('settings:set', (_e, s) => {
  writeJSON(settingsPath, { ...DEFAULT_SETTINGS, ...s });
  // 音质档位不只是界面开关：neaudio 协议在解析地址时用的是主进程这一份，
  // 只改渲染层的设置会让「本地曲目上选的档位」在下次播网易云时对不上。
  if (s && s.quality) ne.setQuality(s.quality);
  return true;
});

ipcMain.handle('library:get', () => readJSON(libraryPath, []));
ipcMain.handle('library:set', (_e, list) => {
  if (!Array.isArray(list)) return false;
  writeJSON(libraryPath, list.map(({ cover, ...rest }) => rest));
  return true;
});

/* 关窗前的最后一笔：renderer 用 send 发来，主进程保证落盘（200ms 防抖窗口内的改动不会丢） */
ipcMain.on('settings:set-sync', (_e, s) => {
  if (s && typeof s === 'object') {
    writeJSON(settingsPath, { ...DEFAULT_SETTINGS, ...s });
    if (s.quality) ne.setQuality(s.quality);
  }
});
ipcMain.on('library:set-sync', (_e, list) => {
  if (Array.isArray(list)) writeJSON(libraryPath, list.map(({ cover, ...rest }) => rest));
});

ipcMain.handle('media:url', (_e, file) => {
  const s = String(file || '');
  if (isNeKey(s)) return 'neaudio://s/' + s.slice(3);
  if (isBilKey(s)) {
    const { bvid, cid } = bilParts(s);
    return 'bilaudio://s/' + bvid + ':' + cid;
  }
  /* 上游音源（酷狗 / QQ 音乐）的曲目在列表里用前缀 id 存：
   * 播放时映射到 upaudio 协议，由主进程解析直链并带 Referer 代理。 */
  if (/^kg:[0-9A-Fa-f]{32}$/.test(s)) return 'upaudio://s/kugou/' + s.slice(3).toUpperCase();
  if (/^qq:[0-9A-Za-z]{8,24}$/.test(s)) return 'upaudio://s/qqapp/' + s.slice(3);
  return `media://f/?p=${encodeURIComponent(s)}`;
});

/* ---------------- 网易云 IPC ----------------
 * 统一返回 { ok, ... } / { ok:false, error:{code,message} }：
 * Error 对象过 IPC 会丢掉自定义字段，形如「需要会员」这种可判断的原因必须显式带出来。
 */
const neCall = async fn => {
  try { return { ok: true, ...(await fn()) }; }
  catch (e) {
    return { ok: false, error: { code: (e && e.code) || 'NE_ERROR', message: String((e && e.message) || e) } };
  }
};

ipcMain.handle('ne:search', (_e, { q, limit } = {}) =>
  neCall(async () => ({ tracks: await ne.searchSongs(q, limit) })));

ipcMain.handle('ne:songs', (_e, ids) =>
  neCall(async () => ({ tracks: await ne.songDetail(Array.isArray(ids) ? ids : [ids]) })));

ipcMain.handle('ne:playlist', (_e, id) => neCall(() => ne.playlistDetail(id)));
ipcMain.handle('ne:album', (_e, id) => neCall(() => ne.albumDetail(id)));
ipcMain.handle('ne:link', (_e, v) => neCall(async () => ({ link: await ne.resolveLink(v) })));

ipcMain.handle('ne:cover', (_e, url, size) =>
  neCall(async () => {
    const c = await ne.coverData(url, Number(size) || 500);
    return { dataUrl: c.dataUrl, bytes: c.bytes };
  }));

/* 播放前先问一次：既能拿到真实码率填「音质·实测」，
 * 也能在地址拿不到时给出可读原因，而不是等 audio 报一个 mediaErr 4。
 * 档位由渲染层传入（设置项），这里同步给音源层以保证地址缓存与档位一致。 */
ipcMain.handle('ne:url', (_e, id, quality) =>
  neCall(async () => {
    if (quality) ne.setQuality(quality);
    const i = await ne.songUrl(Number(id), quality);
    const type = String(i.type || '');
    return {
      codec: type ? type.toUpperCase() : '',
      bitrate: i.br,
      lossless: /flac|alac|ape|wav/i.test(type),
      level: i.level,
      requested: i.requested,
      downgraded: !!i.downgraded,
      size: i.size
    };
  }));

/* ---------------- 列表缩略封面 ----------------
 * 曲库列表一屏十几行，每行都要封面：这里只返回「小图」，不把几 MB 的内嵌原图
 * 塞进 IPC。主进程按路径缓存缩略结果，来回滚动不会反复解析文件。
 */
const THUMB_MAX = 240;
const THUMB_MISS_TTL = 5000;      // 「没封面」只记 5 秒：文件可能正被占用 / 刚拷进来，不该永久留白
const thumbCache = new Map();     // path -> { v: dataURL, at }

function thumbFrom(buf, fmt) {
  try {
    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) {
      const small = img.resize({ width: 96, height: 96, quality: 'good' });
      return small.toDataURL();     // PNG data URL，通常十几 KB
    }
  } catch {}
  return 'data:' + (fmt || 'image/jpeg') + ';base64,' + buf.toString('base64');
}

async function readThumb(file) {
  const hit = thumbCache.get(file);
  // 命中的是「有图」就永远有效；命中「没图」只在 TTL 内有效 —— 过期的空结果继续往下重新解析
  if (hit && (hit.v || Date.now() - hit.at < THUMB_MISS_TTL)) {
    thumbCache.delete(file);          // 命中即刷新 LRU 位置
    thumbCache.set(file, hit);
    return hit.v;
  }
  let out = '';
  try {
    const mm = await getMM();
    const meta = await mm.parseFile(file, { duration: false, skipCovers: false });
    const pic = ((meta.common && meta.common.picture) || [])[0];
    if (pic) out = thumbFrom(Buffer.from(pic.data), pic.format);
    else {
      const side = await sidecarCover(file);          // 同目录 cover.jpg 等
      if (side) out = thumbFrom(Buffer.from(side.slice(side.indexOf(',') + 1), 'base64'));
    }
  } catch { out = ''; }
  thumbCache.set(file, { v: out, at: Date.now() });
  while (thumbCache.size > THUMB_MAX) thumbCache.delete(thumbCache.keys().next().value);
  return out;
}

ipcMain.handle('track:cover', async (_e, file) => {
  if (isNeKey(file)) return { ok: false, error: { code: 'NE_NO_COVER', message: '网易云曲目请用 ne:cover' } };
  if (typeof file === 'string' && file.startsWith('bil:')) {
    return { ok: false, error: { code: 'BIL_NO_COVER', message: '哔哩哔哩曲目请用 bil:cover' } };
  }
  const url = await readThumb(String(file || ''));
  return url ? { ok: true, dataUrl: url } : { ok: false, error: { code: 'NO_COVER', message: '没有内嵌封面' } };
});

/* ---------------- 网易云账号：扫码登录 ----------------
 * 音源权限跟着账号走，所以登录入口是「扫码」，不是让用户去浏览器里翻 Cookie。
 *   - 二维码 SVG 由主进程本地生成并内联返回：不用联网取图，CSP 也不用给图片域名开口子；
 *   - 会话串只在 803 那一刻在主进程内部取出，加密落盘后不再回传渲染层，页面里不出现第二份凭证；
 *   - 密钥库不可用不算登录失败：本次会话照常可用，只是没法长期保存，需要明确告诉用户。
 */
const neErr = e => ({ code: (e && e.code) || 'NE_ERROR', message: String((e && e.message) || e) });

ipcMain.handle('ne:status', async () => {
  if (!ne.hasCookie()) return { hasCookie: false, loggedIn: false, uid: 0 };
  try {
    const a = await ne.account();
    return {
      hasCookie: true,
      loggedIn: !!a.loggedIn,
      uid: a.userId || 0,
      nickname: a.nickname || '',
      avatarUrl: a.avatarUrl || '',
      vipType: a.vipType || 0
    };
  } catch (e) {
    // 网络/风控异常不代表凭证失效：如实说「没验证成功」，不要误报已过期骗用户白扫一次
    return { hasCookie: true, loggedIn: true, unknown: true, uid: 0, nickname: '', error: neErr(e).message };
  }
});

/* 抽屉「网易云」首页：当前账号自己创建的歌单 + 推荐歌单。
 * 两段各自成败（推荐接口是公开的，登录态挂了也不该让整页空白）。 */
ipcMain.handle('ne:home', () => neCall(() => ne.home()));

/* 每日推荐 / 私人FM：都要求登录，失败码统一 NE_LOGIN_REQUIRED，界面据此提示重新扫码 */
ipcMain.handle('ne:daily', () => neCall(() => ne.dailySongs()));
ipcMain.handle('ne:fm', (_e, n) => neCall(() => ne.personalFm(n)));

ipcMain.handle('ne:qr', async () => {
  try {
    const q = await ne.qrCreate();
    return { ok: true, svg: ne.qrSvg(q.url, { margin: 3 }), url: q.url, ttl: q.ttl };
  } catch (e) {
    return { ok: false, error: neErr(e) };
  }
});

ipcMain.handle('ne:qrPoll', async () => {
  try {
    const r = await ne.qrPoll();
    if (r.code !== 803) return { ok: true, code: r.code, message: r.message, loggedIn: false };

    let saved = false, saveErr = '';
    try { saved = writeNeCookie(r.cookie); } catch (e) { saveErr = e.message; }
    return {
      ok: true, code: 803, loggedIn: true, saved,
      nickname: r.nickname || '', avatarUrl: r.avatarUrl || '',
      warning: saved ? '' : (saveErr || '登录成功，但凭证没能落盘，重启后需要重新扫码')
    };
  } catch (e) {
    return { ok: false, code: 0, error: neErr(e) };
  }
});

ipcMain.handle('ne:logout', () => {
  try { writeNeCookie(''); } catch {}
  ne.setCookie('');
  return { hasCookie: false, loggedIn: false };
});

/* ---------------- 哔哩哔哩 IPC ----------------
 * 与 neCall 同形：Error 过 IPC 会丢字段，可判断的原因必须显式带 code。
 * 所有入口都返回 { ok }，渲染层据此给提示，不做「静默失败」。
 */
const bilCall = async fn => {
  try { return { ok: true, ...(await fn()) }; }
  catch (e) {
    return { ok: false, error: { code: (e && e.code) || 'BIL_ERROR', message: String((e && e.message) || e) } };
  }
};

ipcMain.handle('bil:search', (_e, { q, limit } = {}) =>
  bilCall(async () => {
    const r = await bil.searchVideos(q, { page: 1 });
    const max = Number(limit) > 0 ? Number(limit) : 40;
    return { tracks: r.items.slice(0, max), total: r.total };
  }));

ipcMain.handle('bil:view', (_e, bvid) => bilCall(() => bil.viewInfo(bvid)));

/* 播放前预检：顺便把 cid 补齐（搜索结果里没有 cid）。
 * 返回里带 cid，渲染层要把它写回曲目的 path，否则 media:url 拿不到正确地址。 */
ipcMain.handle('bil:url', (_e, bvid, cid) =>
  bilCall(async () => {
    let useCid = Number(cid) || 0;
    if (!useCid) {
      const v = await bil.viewInfo(bvid);
      useCid = (v.pages[0] && v.pages[0].cid) || 0;
      if (!useCid) throw new bil.BilError('这个视频没有可用分 P', 'BIL_NO_PAGE');
    }
    const info = await bil.playUrl(bvid, useCid);
    return {
      cid: useCid,
      codec: 'AAC',
      bitrate: info.br,
      trackId: info.trackId,
      duration: info.duration,
      lossless: false
    };
  }));

/* 收藏夹：两个都要登录态，未登录由 BilError(BIL_NOT_LOGIN) 转成界面引导。 */
/* 收藏夹相关的调用写一行诊断日志：只记结果码与身份摘要，不落 Cookie 值。
 * 收藏夹依赖账号态，出问题时「界面只说失败」没法排障，日志能把环节钉死。 */
const bilFavLogPath = path.join(userDir, 'bil-fav.log');
function bilFavLog(what, extra) {
  try {
    const info = bil.authInfo();
    const line = JSON.stringify({
      at: new Date().toISOString(), what,
      loggedIn: info.loggedIn, verified: info.verified, expired: info.expired,
      userId: info.userId, sessdata: info.sessdataMasked,
      ...extra
    });
    fs.appendFileSync(bilFavLogPath, line + '\n');
    if (fs.statSync(bilFavLogPath).size > 256 * 1024) fs.writeFileSync(bilFavLogPath, '');
  } catch { /* 日志失败不影响功能 */ }
}

ipcMain.handle('bil:favs', () => bilCall(async () => {
  try {
    const r = await bil.favFolders();
    bilFavLog('favFolders', { ok: true, folders: r.items.length, userId: r.userId });
    return r;
  } catch (e) {
    /* 失败时再补一次 nav 的诊断：navCode / isLogin / 有没有携带设备指纹，
     * 这三个值能区分「凭证过期」「设备指纹不匹配」「上游风控」。 */
    let check = null;
    try { check = await bil.verify(); } catch (err) { check = { err: String((err && err.message) || err) }; }
    bilFavLog('favFolders', {
      ok: false, code: e && e.code, message: String((e && e.message) || e),
      navCode: check && check.navCode, isLogin: check && check.isLogin, hasBuvid3: check && check.hasBuvid3
    });
    throw e;
  }
}));

ipcMain.handle('bil:favList', (_e, mediaId, page) =>
  bilCall(async () => {
    try {
      const r = await bil.favList(mediaId, { page: Number(page) || 1 });
      bilFavLog('favList', { ok: true, mediaId: String(mediaId), page: r.page, items: r.items.length, total: r.total });
      return r;
    } catch (e) {
      bilFavLog('favList', { ok: false, mediaId: String(mediaId), code: e && e.code, message: String((e && e.message) || e) });
      throw e;
    }
  }));

ipcMain.handle('bil:cover', (_e, url, size) =>
  bilCall(async () => ({ dataUrl: await bil.coverData(url, Number(size) || 300) })));

ipcMain.handle('bil:status', () =>
  bilCall(async () => {
    /* 启动时只恢复了 Cookie、还没验过：面板一打开就补验一次。
     * 否则重启后明明凭证有效，界面仍按 nickname 空值显示「未登录」。 */
    if (bil.loggedIn() && !bil.authInfo().verified) await bil.verify().catch(() => null);
    return { status: bil.status() };
  }));

ipcMain.handle('bil:qr', () =>
  bilCall(async () => {
    const qr = await bilQr.start();
    bilFavLog('qrStart', { key: qr.key, imgLen: String(qr.img || '').length });
    return { qr };
  }));

/* 轮询：窗口里出现了 SESSDATA 才算登录成功（与浏览器里扫码一模一样） */
ipcMain.handle('bil:qrPoll', () =>
  bilCall(async () => {
    const r = await bilQr.poll();
    if (r.state !== 'confirmed') {
      return { loggedIn: false, state: r.state, img: r.img || '', code: r.state === 'expired' ? 86038 : 86101 };
    }
    bil.applyAuth(r.cookie);
    let saved = false, warn = '';
    try { saved = writeBilCookie(r.cookie); }
    catch (e) { warn = String(e.message || e); }
    const v = await bil.verify().catch(() => ({ ok: false }));
    bilFavLog('qrLogin', {
      ok: !!(v && v.ok), navCode: v && v.navCode, isLogin: v && v.isLogin,
      hasBuvid3: v && v.hasBuvid3, saved, cookieLen: r.cookie.length
    });
    return {
      loggedIn: !!(v && v.ok), saved, code: 0, state: 'confirmed',
      nickname: (v && v.nickname) || bil.authInfo().nickname || '',
      warning: (v && v.ok) ? '' : (saved
        ? '登录成功，但这个会话没通过校验（' + ((v && v.navCode) || '网络') + '），请重试或改用导入 Cookie'
        : (warn || '登录成功，但凭证没能落盘，重启后需要重新扫码'))
    };
  }));

ipcMain.handle('bil:qrCancel', () => { bilQr.stop(); return { ok: true }; });

/* 手工导入 Cookie：与扫码走同一条保存路径，只是没有「取码」这一段。 */
ipcMain.handle('bil:login', (_e, cookie) =>
  bilCall(async () => {
    const raw = String(cookie || '').trim();
    if (!raw) throw new bil.BilError('没有填写 Cookie', 'BIL_AUTH_EMPTY');
    bil.applyAuth(raw);
    if (!bil.loggedIn()) throw new bil.BilError('这份 Cookie 里没有 SESSDATA，可能复制的是未登录页面', 'BIL_AUTH_NO_IDENTITY');
    writeBilCookie(raw);
    const v = await bil.verify();
    return { status: bil.status(), check: v };
  }));

ipcMain.handle('bil:logout', () => {
  try { writeBilCookie(''); } catch {}
  bil.logout();
  return { ok: true, status: bil.status() };
});

/* ---------------- 主界面「当前账号」 ----------------
 * 四个音源各有自己的登录态，界面要能回答一句「我现在用的是谁的歌单」，
 * 所以单独存一份身份文件：当前音源 + 每个音源选中的账号。
 * 这里只存主键和展示用的昵称/头像，凭证仍在各自的安全存储里
 * （ne-auth.bin / bil-auth.bin / accounts.bin），不在这里出现明文。
 */
const identityPath = path.join(userDir, 'identity.json');
const IDN_LIST = [
  { id: 'ne', label: '网易云音乐' },
  { id: 'qqapp', label: 'QQ 音乐' },
  { id: 'kugou', label: '酷狗音乐' },
  { id: 'bil', label: '哔哩哔哩' }
];

function readIdentity() {
  const raw = readJSON(identityPath, null);
  const out = { current: '', active: {} };
  if (!raw || typeof raw !== 'object') return out;
  if (IDN_LIST.some(x => x.id === raw.current)) out.current = raw.current;
  if (raw.active && typeof raw.active === 'object') {
    for (const [k, v] of Object.entries(raw.active)) {
      if (typeof v === 'string' && v) out.active[k] = v;
    }
  }
  return out;
}

function writeIdentity(idn) {
  writeJSON(identityPath, { version: 1, current: idn.current || '', active: idn.active || {} });
}

/* 把四个音源归一成 { id, label, activeId, accounts[] }：
 * 渲染层只认这一种形状，不必知道网易云只有一份登录态、QQ/酷狗有多账号。 */
async function identitySnapshot() {
  const idn = readIdentity();
  const out = { ok: true, current: idn.current, providers: [] };

  const neRow = { id: 'ne', label: '网易云音乐', activeId: '', accounts: [] };
  try {
    const a = ne.hasCookie() ? await ne.account() : null;
    if (a && a.loggedIn) {
      const id = 'ne:' + (a.userId || 0);
      neRow.accounts.push({
        id, name: a.nickname || ('uid ' + a.userId), sub: '网易云',
        avatarUrl: a.avatarUrl || '', current: true
      });
      neRow.activeId = id;
    }
  } catch (e) { neRow.error = String((e && e.message) || e); }
  out.providers.push(neRow);

  for (const id of ['qqapp', 'kugou']) {
    const row = { id, label: id === 'qqapp' ? 'QQ 音乐' : '酷狗音乐', activeId: '', accounts: [] };
    try {
      if (accAccounts && accAccounts.manager) {
        const cur = accAccounts.manager.current(id);
        row.activeId = (cur && cur.id) || '';
        for (const a of accAccounts.manager.list(id)) {
          row.accounts.push({
            id: a.id, name: a.name || a.id,
            sub: row.label, avatarUrl: a.avatarUrl || '',
            current: a.id === row.activeId
          });
        }
      }
    } catch (e) { row.error = String((e && e.message) || e); }
    out.providers.push(row);
  }

  const bilRow = { id: 'bil', label: '哔哩哔哩', activeId: '', accounts: [] };
  try {
    /* 重启后只恢复了凭证、还没验过：这里补一次，否则下拉里只能显示 uid */
    if (bil.loggedIn() && !bil.authInfo().verified) await bil.verify().catch(() => null);
    const st = bil.status();
    if (st && st.loggedIn) {
      const id = 'bil:' + (st.userId || 0);
      bilRow.accounts.push({
        id, name: st.nickname || ('uid ' + st.userId), sub: '哔哩哔哩',
        avatarUrl: st.avatarUrl || '', current: true
      });
      bilRow.activeId = id;
    }
  } catch (e) { bilRow.error = String((e && e.message) || e); }
  out.providers.push(bilRow);

  /* 当前账号如果已经退出登录，别把界面卡在一个不存在的人身上：
   * 顺手回落到「第一个有账号的音源」，并把回落结果落盘。 */
  const curRow = out.providers.find(x => x.id === out.current);
  if (!curRow || !curRow.accounts.length) {
    const fallback = out.providers.find(x => x.accounts.length);
    if (fallback) {
      out.current = fallback.id;
      out.fallback = true;
      const next = readIdentity();
      next.current = fallback.id;
      if (fallback.activeId) next.active[fallback.id] = fallback.activeId;
      writeIdentity(next);
    } else {
      out.current = '';
    }
  }
  return out;
}

/* ---------------- 上游歌单（QQ 音乐 / 酷狗） ----------------
 * 只读自己的歌单：列表 + 歌单内的曲目。凭证从账号层取（已经在 safeStorage 里），
 * 这里不碰 cookie 的保存，失败一律回 { ok:false, error:{code,message} }。 */
function credOf(provider) {
  try {
    if (!accAccounts || !accAccounts.manager) return null;
    const c = accAccounts.manager.credentialOf(provider);
    return c || null;
  } catch { return null; }
}

/* 上游曲目的封面/歌词统一入口；fail-safe：任何异常都回空，不影响播放。 */
async function upstreamMetaOf(key, albumMid) {
  const s = String(key || '');
  if (s.startsWith('kg:')) {
    const m = await upmeta.kgMeta(s.slice(3));
    /* 酷狗封面是 http 地址，渲染层 CSP 只放行 https/data：在这里换成 data URL，
     * 否则「有封面但一片空白」。 */
    if (m && m.cover) m.cover = await upmeta.coverDataUrl(m.cover, 'https://www.kugou.com/');
    return m;
  }
  if (s.startsWith('qq:')) {
    const cred = credOf('qqapp') || {};
    const extra = cred.extra || {};
    /* albumMid 由渲染层带下来；没有也没关系 —— qqMeta 会按 songmid 自己反查专辑。 */
    const am = albumMid || '';
    const m = await upmeta.qqMeta(s.slice(3), { uin: extra.uin, musickey: extra.musickey }, am);
    if (m && m.cover) m.cover = await upmeta.coverDataUrl(m.cover, 'https://y.qq.com/');
    return m;
  }
  return { cover: '', lyric: [] };
}

ipcMain.handle('acc:meta', async (_e, key, albumMid) => {
  try { return { ok: true, ...(await upstreamMetaOf(key, albumMid)) }; }
  catch (e) { return { ok: false, error: { code: 'E_META', message: String((e && e.message) || e) } }; }
});

ipcMain.handle('acc:playlists', async (_e, arg) => {
  const provider = (arg && arg.provider) || '';
  const cred = credOf(provider);
  if (!cred) return { ok: false, error: { code: 'E_AUTH_REQUIRED', message: '还没有登录该音源' } };
  try {
    let items;
    if (provider === 'qqapp') items = await upstream.qqPlaylists({ ...cred.extra, cookie: cred.cookie });
    else if (provider === 'kugou') items = await upstream.kgPlaylists({ ...cred.extra, cookie: cred.cookie });
    else return { ok: false, error: { code: 'E_UPSTREAM_UNSUPPORTED', message: '这个音源没有歌单接口' } };
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: { code: (e && e.code) || 'E_UPSTREAM', message: String((e && e.message) || e) } };
  }
});

ipcMain.handle('acc:tracks', async (_e, arg) => {
  const provider = (arg && arg.provider) || '';
  const id = (arg && arg.id) || '';
  const dirId = (arg && arg.dirId) || 0;
  const cred = credOf(provider);
  if (!cred) return { ok: false, error: { code: 'E_AUTH_REQUIRED', message: '还没有登录该音源' } };
  try {
    const items = provider === 'qqapp'
      ? await upstream.qqPlaylistTracks({ ...cred.extra, cookie: cred.cookie }, id, dirId)
      : await upstream.kgPlaylistTracks({ ...cred.extra, cookie: cred.cookie }, id);
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: { code: (e && e.code) || 'E_UPSTREAM', message: String((e && e.message) || e) } };
  }
});

ipcMain.handle('idn:get', async () => {
  try { return await identitySnapshot(); }
  catch (e) {
    return { ok: false, error: { code: 'IDN_ERROR', message: String((e && e.message) || e) } };
  }
});

ipcMain.handle('idn:set', async (_e, arg) => {
  const provider = arg && arg.provider;
  const accountId = (arg && arg.accountId) || '';
  if (!IDN_LIST.some(x => x.id === provider)) {
    return { ok: false, error: { code: 'IDN_BAD_PROVIDER', message: '未知的音源' } };
  }
  const idn = readIdentity();
  idn.current = provider;
  if (accountId) idn.active[provider] = String(accountId);
  writeIdentity(idn);

  /* QQ 音乐 / 酷狗是多账号：选中的那条要真的切过去，
   * 否则界面显示 A、取流用的是 B。切换会触发 acc:event（带 revision）。 */
  if ((provider === 'qqapp' || provider === 'kugou') && accountId && accAccounts && accAccounts.manager) {
    try { accAccounts.manager.switchTo(provider, String(accountId)); }
    catch (e) {
      return {
        ok: false,
        error: { code: (e && e.code) || 'IDN_SWITCH_FAILED', message: String((e && e.message) || e) }
      };
    }
  }
  const snapshot = await identitySnapshot().catch(() => null);
  if (win && !win.isDestroyed()) win.webContents.send('idn:changed', snapshot);
  return { ok: true, snapshot };
});

ipcMain.handle('win:min', () => { if (win && !win.isDestroyed()) win.minimize(); });
ipcMain.handle('win:max', () => {
  if (!win || win.isDestroyed()) return false;
  if (win.isFullScreen()) return false;          // 全屏下最大化没有意义，忽略
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('win:close', () => { if (win && !win.isDestroyed()) win.close(); });
ipcMain.handle('win:fullscreen', (_e, on) => setFullscreen(!!on));
ipcMain.handle('win:fullscreen:get', () => !!win && !win.isDestroyed() && win.isFullScreen());

let keyTable = [];
ipcMain.handle('keys:register', (_e, list) => {
  const prev = keyTable;
  globalShortcut.unregisterAll();
  const res = [];
  const next = [];
  for (const { accel, id } of list || []) {
    let ok = false;
    try { ok = globalShortcut.register(accel, () => send('key:global', id)); }
    catch { ok = false; }
    if (ok) next.push({ accel, id });
    res.push({ accel, id, ok });
  }
  // 一个都没注册上（几乎都不该发生）：把上一次可用的表恢复回去，
  // 别因为一次失败把原本能用的快捷键全丢掉。
  if (!next.length && res.length && prev.length) {
    for (const { accel, id } of prev) {
      try { globalShortcut.register(accel, () => send('key:global', id)); } catch {}
    }
    keyTable = prev;
    return prev.map(p => ({ ...p, ok: true, restored: true }));
  }
  keyTable = next;
  return res;
});
ipcMain.handle('keys:clear', () => { globalShortcut.unregisterAll(); keyTable = []; return true; });

/* ---------------- 生命周期 ---------------- */
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

/* ---------------- QQ / 酷狗 账号层 ----------------
 * 代码在 player/accounts（TypeScript），这里只做接线；判定逻辑一律在主进程模块里。
 * dist 未编译时注册一组兜底 handler：界面会收到「需要先编译」的明确原因，
 * 而不是点了按钮没有任何反应。
 */
let accAccounts = null;
function setupAccounts() {
  const channels = ['acc:begin', 'acc:poll', 'acc:refresh', 'acc:cancel', 'acc:status',
    'acc:list', 'acc:current', 'acc:switch', 'acc:logout', 'acc:audio', 'acc:invalidate'];
  const fallback = () => ({
    ok: false,
    error: {
      code: 'E_NOT_IMPLEMENTED',
      message: '账号模块未编译：请先执行 cd player && npx tsc -p tsconfig.accounts.json'
    }
  });
  try {
    const acc = require('./accounts/dist/src');
    const host = require('./accounts/dist/src/electronHost');
    accAccounts = acc.createAccountsModule({
      dataDir: app.getPath('userData'),
      cipher: host.safeStorageCipher(),
      host: host.createElectronHost(),
      transport: host.netTransport(),
      logger: {
        info: (m, d) => console.log('[acc]', m, d || ''),
        warn: (m, d) => console.warn('[acc]', m, d || '')
      },
      // 合规上游：没配就只做登录，取流会明确报 E_NOT_IMPLEMENTED
      upstream: { qq: process.env.NCKK_QQ_UPSTREAM || '', kugou: process.env.NCKK_KUGOU_UPSTREAM || '',
      qqapp: process.env.NCKK_QQAPP_UPSTREAM || '' }
    });
    acc.registerAccountsIpc({
      ipcMain,
      module: accAccounts,
      sendEvent: (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p); },
      /* 账号切换/登录/退出后刷新该平台的数据。
       * QQ 音乐与酷狗的歌单/收藏接口还没接（要合规上游），所以这一版做的是「清干净」：
       * 作废封面缓存与取流缓存，并把实际情况如实回报，避免界面假装刷新成功。 */
      refreshLibrary: async (provider) => {
        thumbCache.clear();
        dirCoverCache.clear();
        try { accAccounts.manager.invalidateStreams(provider); } catch (e) { /* 忽略 */ }
        const name = provider === 'kugou' ? '酷狗音乐' : 'QQ 音乐';
        return {
          refreshed: false,
          message: `${name}：已切换到该账号并清空封面/取流缓存；歌单与收藏接口待接上游`
        };
      }
    });
    console.log('[acc] accounts ready');
  } catch (e) {
    console.warn('[acc] 账号模块未启用：', (e && e.message) || e);
    for (const ch of channels) ipcMain.handle(ch, fallback);
  }
}

app.whenReady().then(() => {
  /* 只有「pid 锁也说有实例」才该退出；Chromium 锁拿不到（权限/杀软占用）时
   * 上面已经回退到 pid 锁，这里必须继续启动，否则表现为「双击没反应」。 */
  if (!gotLock && pidState === 'held') return;
  migrateOldUserData();             // 改名后第一次启动：把老目录里的曲库/设置/凭证接过来
  registerMediaProtocol();
  registerNeProtocol();
  registerBilProtocol();
  registerUpProtocol();
  ne.setCookie(readNeCookie());     // 上次扫过的凭证在开窗前就位，首屏点歌即可用
  const savedBil = readBilCookie();
  bil.applyAuth(savedBil);          // 哔哩哔哩同理由，两个音源的凭证互不影响
  /* 记一行「凭证到底读到没有」：收藏夹出问题时，这一步是最容易出错又最难看出来的 */
  bilFavLog('startup', {
    cookieLen: savedBil.length,
    keys: parseBilCookieKeys(savedBil),
    sessdata: bil.sessdataShape()
  });
  ne.setQuality((readJSON(settingsPath, {}) || {}).quality);   // 上次选的音质同样在首屏就生效
  setupAccounts();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(e => logCrash('whenReady', e));

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
