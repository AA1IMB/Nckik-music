import * as nodeFs from 'fs';
import type { Account, Cipher, LibraryRefresh, LoginWindowHost, Logger, ProviderId, Transport } from './types';
import { PROVIDER_LABEL } from './types';
import { CredentialStore, type FsLike } from './credentialStore';
import { AccountManager } from './accountManager';
import { AccountError, wrapUnknown } from './errors';
import { QqProvider } from './providers/qq';
import { KugouProvider } from './providers/kugou';
import { QqAppProvider } from './providers/qqapp';
import { createWsConnect } from './wsConnect';
import type { MqttConnect } from './mqtt';
import type { Provider } from './providers/base';
import {
  ACC,
  type AccountStatusPayload,
  type AccEvent,
  type AudioReq,
  type BeginReq,
  type IpcResult,
  type LogoutReq,
  type SwitchReq
} from './ipcContract';

/**
 * 装配层：主进程只需要调一次 createAccountsModule，再调 registerAccountsIpc。
 * ---------------------------------------------------------------------------
 * 这里刻意不 import electron：`host` / `cipher` / `transport` 都由调用方注入，
 * 于是同一套代码在 main.js（真 Electron）、单元测试（假实现）、未来的 CLI 里都能跑。
 */

export interface AccountsModuleOptions {
  /** userData 目录；凭据文件放 `<dataDir>/accounts.bin` */
  dataDir: string;
  cipher: Cipher;
  host: LoginWindowHost;
  transport: Transport;
  logger: Logger;
  /** 合规上游地址（自建网关 / 官方开放平台代理）。缺省则该平台只做登录，不做取流 */
  upstream?: Partial<Record<ProviderId, string>>;
  /** 单测注入假的 MQTT 连接；主进程不传，走 ws 实现 */
  mqttConnect?: MqttConnect;
  now?: () => number;
  fs?: FsLike;
}

export interface AccountsModule {
  manager: AccountManager;
  store: CredentialStore;
  providers: Record<ProviderId, Provider>;
  /** 账号数据版本（登录/切换/退出各 +1）；渲染层据此作废该平台的收藏与歌单缓存 */
  revision: { value: number };
  /** 统一释放：关掉隐藏登录窗口 */
  dispose(): Promise<void>;
}

export function createAccountsModule(opts: AccountsModuleOptions): AccountsModule {
  const now = opts.now ?? Date.now;
  const store = new CredentialStore({
    file: pathJoin(opts.dataDir, 'accounts.bin'),
    cipher: opts.cipher,
    fs: opts.fs ?? nodeFsLike(),
    logger: opts.logger,
    now
  });

  const providers: Record<ProviderId, Provider> = {
    qq: new QqProvider({
      host: opts.host,
      transport: opts.transport,
      logger: opts.logger,
      now,
      upstreamBase: opts.upstream?.qq
    }),
    kugou: new KugouProvider({
      host: opts.host,
      transport: opts.transport,
      logger: opts.logger,
      now,
      upstreamBase: opts.upstream?.kugou
    }),
    // QQ 音乐 App 扫码：不需要隐藏窗口，走 musicu 协议 + MQTT 推送
    qqapp: new QqAppProvider({
      transport: opts.transport,
      logger: opts.logger,
      connect: opts.mqttConnect ?? createWsConnect(),
      now,
      upstreamBase: opts.upstream?.qqapp
    })
  };

  const manager = new AccountManager({ store, providers, logger: opts.logger, now });
  // 账号数据版本：每次登录/切换/退出 +1。渲染层拿到新版本就作废该平台的收藏/歌单缓存，
  // 避免「切了账号还看着上一个人的歌单」。
  const revision = { value: 0 };

  return {
    manager,
    store,
    providers,
    revision,
    async dispose() {
      await Promise.all([manager.cancelLogin('qq'), manager.cancelLogin('kugou'), manager.cancelLogin('qqapp')]);
    }
  };
}

/* ---------------- IPC 注册 ---------------- */

type AnyFn = (req: any) => any;

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, req: any) => unknown): void;
  removeHandler(channel: string): void;
}

export interface RegisterIpcOptions {
  ipcMain: IpcMainLike;
  module: AccountsModule;
  /** 把事件推给渲染层；主进程传 `win.webContents.send` */
  sendEvent?: (channel: string, payload: AccEvent) => void;
  upstream?: Partial<Record<ProviderId, string>>;
  /** 登录/切换/退出之后刷新该平台的收藏与歌单（主进程注入） */
  refreshLibrary?: (provider: ProviderId, account: Account | null) => Promise<LibraryRefresh>;
}

/**
 * 注册所有 `acc:*` 通道。返回值是反注册函数（热重载 / 退出时调用）。
 * 所有 handler 都保证返回 `{ok:true,data}` 或 `{ok:false,error:{code,message,hint?,retryAfterMs?}}`，
 * 渲染层不需要 try/catch，也不会看到英文栈。
 */
export function registerAccountsIpc(opts: RegisterIpcOptions): () => void {
  const { ipcMain, module } = opts;
  const { manager } = module;
  const channels: string[] = [];

  const on = (channel: string, fn: AnyFn) => {
    channels.push(channel);
    ipcMain.handle(channel, async (_e: unknown, req: any) => toResult(await fn(req)));
  };

  on(ACC.begin, (req: BeginReq) => manager.beginLogin(req.provider));
  on(ACC.poll, (req: BeginReq) => manager.pollLogin(req.provider));
  on(ACC.refresh, (req: BeginReq) => manager.refreshLogin(req.provider));
  on(ACC.cancel, async (req: BeginReq) => {
    await manager.cancelLogin(req.provider);
    return { provider: req.provider };
  });
  on(ACC.status, (req: BeginReq) => {
    const account = manager.current(req.provider);
    const payload: AccountStatusPayload = {
      provider: req.provider,
      account,
      hasCredential: !!(account && manager.credentialOf(req.provider)),
      upstreamReady: !!opts.upstream?.[req.provider],
      dataRevision: module.revision.value
    };
    return payload;
  });
  on(ACC.list, (req: { provider?: ProviderId } | undefined) => manager.list(req?.provider));
  on(ACC.current, (req: BeginReq) => manager.current(req.provider));
  on(ACC.switch, (req: SwitchReq) => manager.switchTo(req.id));
  on(ACC.logout, (req: LogoutReq) => {
    const target: Account | null = req.id ? manager.find(req.id) : req.provider ? manager.current(req.provider) : null;
    if (target) manager.logout(target.id);
    return { id: target?.id ?? null };
  });
  on(ACC.audio, (req: AudioReq) => {
    const { provider, ...rest } = req;
    return manager.audioFor(provider, rest);
  });
  on(ACC.invalidate, (req: { provider?: ProviderId } | undefined) => {
    manager.invalidateStreams(req?.provider);
    return { invalidated: true };
  });

  const off = manager.on(event => {
    const needsRefresh = event.type === 'login' || event.type === 'switch' || event.type === 'logout';
    if (needsRefresh) module.revision.value += 1;
    const revision = module.revision.value;
    // 先发一版（界面立刻切到新账号），刷新结果到了再发一版（带 library）
    opts.sendEvent?.(ACC.event, { ...event, revision });

    if (!needsRefresh || !opts.refreshLibrary) return;
    const account = 'account' in event ? event.account ?? null : manager.current(event.provider);
    void opts.refreshLibrary(event.provider, account)
      .then(library => opts.sendEvent?.(ACC.event, { ...event, revision, library }))
      .catch(err =>
        opts.sendEvent?.(ACC.event, {
          ...event,
          revision,
          library: { refreshed: false, message: (err as Error).message }
        })
      );
  });

  return () => {
    off();
    for (const ch of channels) ipcMain.removeHandler(ch);
  };
}

/* ---------------- 小工具 ---------------- */

function toResult<T>(value: T): IpcResult<T> {
  return { ok: true, data: value };
}

/** 给上层用的统一失败包装（主进程 catch 里调一次即可） */
export function toFail(e: unknown, provider: ProviderId = 'qq'): IpcResult<never> {
  const err = e instanceof AccountError ? e : wrapUnknown(provider, e);
  return { ok: false, error: err.toPayload() };
}

export function labelOf(provider: ProviderId): string {
  return PROVIDER_LABEL[provider];
}

function pathJoin(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

/** 默认 fs 适配：只暴露凭据存储需要的那几个同步方法 */
export function nodeFsLike(): FsLike {
  return {
    existsSync: p => nodeFs.existsSync(p),
    readFileSync: p => nodeFs.readFileSync(p),
    writeFileSync: (p, data) => nodeFs.writeFileSync(p, data),
    renameSync: (a, b) => nodeFs.renameSync(a, b),
    unlinkSync: p => nodeFs.unlinkSync(p),
    mkdirSync: (p, o) => {
      nodeFs.mkdirSync(p, o);
    }
  };
}
