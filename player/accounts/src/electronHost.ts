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
  const ua =
    opts.userAgent ??
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  let win: any = null;
  let partition = '';
  let watchers: Array<() => void> = [];

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
      win.webContents.setUserAgent(ua);
      // 回调页就地打开：cookie 必须落在我们正在读的那个会话上
      win.webContents.setWindowOpenHandler(({ url: target }: { url: string }) => {
        if (/^https?:/i.test(target)) win.loadURL(target).catch(() => {});
        return { action: 'deny' };
      });
      await win.loadURL(url);
      await sleep(opts.settleMs ?? 600);
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
      const script = `(() => {
        const cs = document.querySelectorAll('canvas');
        for (const c of cs) { if (c.width >= 120 && c.height >= 120) { try { return c.toDataURL('image/png'); } catch (e) {} } }
        const imgs = Array.from(document.images).filter(i => i.naturalWidth >= 120 && i.naturalHeight >= 120);
        const hit = imgs.sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
        return hit ? hit.src : null;
      })()`;
      try {
        return (await requireWin().webContents.executeJavaScript(script, true)) as string | null;
      } catch {
        return null;
      }
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
