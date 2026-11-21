import type { Cipher, LoginWindowHost, Transport, TransportResponse } from './types';
import { sleep } from './providers/base';

/**
 * Electron 侧适配器（唯一 import electron 的地方）
 * ---------------------------------------------------------------------------
 * 三个用途：①把 safeStorage 包成 Cipher；②用 net 模块实现 Transport；③把隐藏
 * BrowserWindow 包成 LoginWindowHost（只读官方登录页自己产生的二维码与 cookie）。
 * 这里不包含任何签名/加密绕过逻辑，也不解析任何私有协议。
 */

type AnyElectron = {
  BrowserWindow: new (opts: Record<string, unknown>) => any;
  session: { fromPartition(partition: string): any };
  safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(plain: string): Buffer;
    decryptString(buf: Buffer): string;
  };
  net: { request(opts: Record<string, unknown>): any };
};

function electron(): AnyElectron {
  // 延迟 require：本文件在纯 node 测试里不会被加载
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('electron') as AnyElectron;
}

/* ---------------- safeStorage → Cipher ---------------- */

export function safeStorageCipher(): Cipher {
  return {
    available() {
      try {
        return electron().safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encrypt(plain) {
      return electron().safeStorage.encryptString(plain);
    },
    decrypt(sealed) {
      return electron().safeStorage.decryptString(sealed);
    }
  };
}

/* ---------------- net → Transport ---------------- */

export function netTransport(userAgent?: string): Transport {
  const doRequest = (method: 'GET' | 'POST', url: string, body: unknown, init?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<TransportResponse<any>> =>
    new Promise((resolve, reject) => {
      const req = electron().net.request({
        method,
        url,
        headers: { 'User-Agent': userAgent ?? 'Mozilla/5.0', ...(init?.headers ?? {}) }
      });
      const timer = setTimeout(() => {
        try {
          req.abort();
        } catch {}
        reject(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' }));
      }, init?.timeoutMs ?? 12_000);

      req.on('response', (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
        res.on('error', (e: Error) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      req.on('error', (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
      if (body !== undefined && method === 'POST') req.write(JSON.stringify(body));
      req.end();
    });

  return {
    getJson: (url, init) => doRequest('GET', url, undefined, init),
    postJson: (url, body, init) => doRequest('POST', url, body, init)
  };
}


/** 带超时的等待：读二维码这一段不能把整个登录流程卡死 */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))
  ]);
}

/* ---------------- BrowserWindow → LoginWindowHost ---------------- */

export interface ElectronHostOptions {
  userAgent?: string;
  /** 页面稳定判定的上限（等 did-finish-load 后再等一会儿） */
  settleMs?: number;
}

/**
 * 隐藏窗口宿主：一次只服务一个平台（登录完就关）。
 * 关键点（都是本项目踩过的坑）：
 *   - `partition` 独立，避免与主窗口/另一平台串 cookie；
 *   - 拒绝 `window.open`，把回调页就地 `loadURL`，否则 cookie 落在另一个窗口的生命周期里；
 *   - `cookies.on('changed')` 把「确认那一拍」立刻抛给上层，不依赖轮询拍点；
 *   - 读 cookie 用 `get({})` 全量再按名字白名单挑，绝不按 domain 过滤（子域会漏）。
 */
export function createElectronHost(opts: ElectronHostOptions = {}): LoginWindowHost & { userAgent: string } {
  // 默认不覆盖 UA：沿用 Electron 自带 UA（与真实浏览器一致、且酷狗登录页对其更宽容）；
  // 需要伪装时由调用方显式传 userAgent。
  const ua = opts.userAgent ?? '';
  let win: any = null;
  let partition = '';
  let watchers: Array<() => void> = [];

  const collectFrames = (main: any): any[] => {
    const out: any[] = [];
    const walk = (f: any) => {
      if (!f) return;
      out.push(f);
      for (const c of f.frames || []) walk(c);
    };
    walk(main);
    return out;
  };

  const requireWin = () => {
    if (!win) throw new Error('登录窗口未打开');
    return win;
  };

  return {
    userAgent: ua,
    async open(url, o) {
      const { BrowserWindow } = electron();
      partition = o.partition;
      win = new BrowserWindow({
        width: o.size?.width ?? 960,
        height: o.size?.height ?? 720,
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
          partition: o.partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false
        }
      });
      if (ua) win.webContents.setUserAgent(ua);
      // 回调页就地打开：cookie 必须落在我们正在读的那个会话上
      win.webContents.setWindowOpenHandler(({ url: target }: { url: string }) => {
        if (/^https?:/i.test(target)) win.loadURL(target).catch(() => {});
        return { action: 'deny' };
      });
      await win.loadURL(url);
      await sleep(opts.settleMs ?? 600);
      // 有的站点要用户先点几下才挂出二维码（QQ 音乐是「登录」→ 弹层「QQ登录」→「扫码登录」）。
      // 这里只点页面上本来就有、用户可见的按钮，不注入任何伪造参数。
      // 弹层里的按钮可能落在跨域子帧（graph.qq.com），所以每个文案在主帧和子帧各找一遍。
      const clicks = o.clickTexts ?? (o.clickText ? [o.clickText] : []);
      for (const want of clicks) {
        const CLICK = `(() => {
          const want = ${JSON.stringify(want)};
          const els = Array.from(document.querySelectorAll('a,button,div,span')).filter(
            (e) => (e.innerText || '').trim() === want && e.offsetParent !== null
          );
          if (!els.length) return false;
          els[els.length - 1].click();
          return true;
        })()`;
        let clicked = false;
        for (const f of collectFrames(win.webContents.mainFrame)) {
          const ok = await within<any>(f.executeJavaScript(CLICK, true), 5_000, false).catch(() => false);
          if (ok) { clicked = true; break; }
        }
        if (clicked) await sleep(1_200);
      }
    },
    async readCookies(names) {
      const sess = win ? win.webContents.session : electron().session.fromPartition(partition);
      const all: Array<{ name: string; value: string }> = await sess.cookies.get({});
      const out: Record<string, string> = {};
      for (const name of names) {
        // 同名可能出现在多个 domain，取最后一个非空（登录态通常最后写入）
        const hit = all.filter(c => c.name === name && !!c.value).pop();
        if (hit) out[name] = hit.value;
      }
      return out;
    },
    async readQrImage() {
      const w = requireWin();
      const wc = w.webContents;
      const frames = collectFrames(wc.mainFrame);

      // 判据：方形容器 + 足够大的位图；长度门槛只用来排除「占位白图」（约 900 字符，
      // 酷狗真正的二维码是调色板 PNG，data URL 只有 1414 字符，所以门槛必须低于它）。
      const PICK = `(() => {
        const square = (w, h) => w >= 120 && h >= 120 && Math.abs(w - h) <= Math.max(8, w * 0.12);
        const deco = /(logo|avatar|icon|sprite|scan-tip|placeholder|loading|default)/i;
        for (const c of document.querySelectorAll('canvas')) {
          if (square(c.width, c.height)) {
            try { const d = c.toDataURL('image/png'); if (d.length >= 800) return { kind: 'data', src: d }; } catch (e) {}
          }
        }
        // 只认「真正显示出来」的图：QQ 音乐弹层里另一路（微信）的二维码是 470×470 但 display:0x0，
        // 有些站还会把二维码缩到 150~200px 显示，所以看渲染尺寸而不是原始尺寸。
        const shown = (i) => {
          const r = i.getBoundingClientRect();
          return r.width >= 120 && r.height >= 120 && Math.abs(r.width - r.height) <= Math.max(8, r.width * 0.12);
        };
        const imgs = Array.from(document.images)
          .filter((i) => shown(i) && i.naturalWidth >= 120 && i.naturalHeight >= 120)
          .sort((a, b) => b.naturalWidth - a.naturalWidth);
        for (const i of imgs) {
          const src = i.currentSrc || i.src || '';
          if (deco.test(src)) continue;
          if (src.startsWith('data:image') && src.length >= 800) return { kind: 'data', src };
          if (/^https?:/i.test(src) && !src.split('?')[0].toLowerCase().endsWith('.svg')) return { kind: 'remote', src };
        }
        // 有的站把二维码画成 CSS 背景图（QQ 互联的 .plain-qrcode 就是 background-image: url(data:p...
        for (const e of Array.from(document.querySelectorAll('div,span,i,b,button'))) {
          const r = e.getBoundingClientRect();
          if (!square(r.width, r.height)) continue;
          const bg = getComputedStyle(e).backgroundImage || '';
          const m = /url\\(["']?(data:image\\/[^"')]+)["']?\\)/.exec(bg);
          if (m && m[1].length >= 800) return { kind: 'data', src: m[1] };
        }
        return null;
      })()`;

      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const isMain = i === 0;
        const url = (f.url || '') as string;
        if (!url && isMain) continue;
        let cand: { kind: string; src: string } | null = null;
        try {
          cand = await within(f.executeJavaScript(PICK, true) as Promise<{ kind: string; src: string } | null>, 2_500, null);
        } catch {
          continue;
        }
        if (!cand) continue;
        if (cand.kind === 'data') return cand.src;
        // 主窗口里的大图通常是封面，不当作二维码
        if (isMain) continue;
        // 二维码常常是普通 PNG 地址（微信 / QQ）：用同一个会话取字节，转成 data URL 交给渲染层
        try {
          const res = await within<any>(wc.session.fetch(cand.src), 4_000, null);
          if (!res || !res.ok) continue;
          const buf = Buffer.from(await within<ArrayBuffer>(res.arrayBuffer(), 4_000, new ArrayBuffer(0)));
          if (buf.length < 400) continue;
          const mime = String(res.headers.get('content-type') || 'image/png').split(';')[0];
          return `data:${mime};base64,${buf.toString('base64')}`;
        } catch {
          continue;
        }
      }
      return null;
    },
    async readPageText() {
      try {
        return (await requireWin().webContents.executeJavaScript('document.body ? document.body.innerText : ""', true)) as string;
      } catch {
        return '';
      }
    },
    async currentUrl() {
      try {
        return requireWin().webContents.getURL() as string;
      } catch {
        return '';
      }
    },
    async close() {
      for (const off of watchers) {
        try {
          off();
        } catch {}
      }
      watchers = [];
      if (win) {
        try {
          win.destroy();
        } catch {}
        win = null;
      }
    },
    onCookiesChanged(cb) {
      const sess = win ? win.webContents.session : electron().session.fromPartition(partition);
      const listener = (_e: unknown, cookie: { name: string; value: string }) => {
        cb({ [cookie.name]: cookie.value });
      };
      sess.cookies.on('changed', listener);
      const off = () => sess.cookies.removeListener('changed', listener);
      watchers.push(off);
      return off;
    }
  };
}
