import type { AccountErrorPayload, AudioRequest, LoginSnapshot, ProviderId } from './types';

/**
 * 主进程 ↔ 渲染进程的 IPC 契约（与项目既有风格一致：`<域>:<动作>` + `{ ok, ... }`）
 * ---------------------------------------------------------------------------
 * 命名沿用现有 `ne:*` / `bil:*` 的形状，只是把域换成 `acc:`，这样 preload 里可以
 * 用同一套「平铺方法名 + 统一拆 ok/error」的写法接进来。
 */

export const ACC = {
  /** 开始扫码（打开官方登录页并取码） */
  begin: 'acc:begin',
  /** 走一拍轮询 */
  poll: 'acc:poll',
  /** 二维码过期后重取 */
  refresh: 'acc:refresh',
  /** 关面板 / 换平台时取消 */
  cancel: 'acc:cancel',
  /** 当前登录快照（不触发网络） */
  status: 'acc:status',
  /** 账号列表 */
  list: 'acc:list',
  /** 某平台当前账号 */
  current: 'acc:current',
  /** 切换当前播放账号 */
  switch: 'acc:switch',
  /** 退出某个账号（或该平台当前账号） */
  logout: 'acc:logout',
  /** 取流（带凭据 + 逐档降级） */
  audio: 'acc:audio',
  /** 音质设置变更后丢弃取流缓存 */
  invalidate: 'acc:invalidate',
  /** 主进程向渲染层推事件：登录成功 / 切换 / 退出 / 缓存失效 */
  event: 'acc:event'
} as const;

export type AccChannel = (typeof ACC)[keyof typeof ACC];

export interface Ok<T> {
  ok: true;
  data: T;
}

export interface Fail {
  ok: false;
  error: AccountErrorPayload;
}

export type IpcResult<T> = Ok<T> | Fail;

export interface BeginReq {
  provider: ProviderId;
}

export interface AudioReq extends AudioRequest {
  provider: ProviderId;
}

export interface SwitchReq {
  /** 账号 id（`<provider>:<userId>`） */
  id: string;
}

export interface LogoutReq {
  /** 不给 id 时退出该平台的当前账号 */
  id?: string;
  provider?: ProviderId;
}

export interface AccountStatusPayload {
  provider: ProviderId;
  account: import('./types').Account | null;
  /** 有没有可用的加密凭据 */
  hasCredential: boolean;
  /** 该平台是否配置了合规上游（未配置时取流会报 E_NOT_IMPLEMENTED） */
  upstreamReady: boolean;
  /** 账号数据版本：登录/切换/退出各加一，渲染层据此作废该平台的收藏与歌单缓存 */
  dataRevision: number;
}

export interface AccEvent {
  type: 'login' | 'switch' | 'logout' | 'invalidated';
  provider: ProviderId;
  accountId?: string;
  account?: import('./types').Account | null;
  /** 账号数据版本（与 status.dataRevision 同源）；渲染层变了就清该平台的收藏/歌单缓存 */
  revision?: number;
  /** 切换后刷新收藏/歌单的结果（先发无 library 的一版，刷新完再发一版） */
  library?: import('./types').LibraryRefresh;
}

export type Snapshot = LoginSnapshot;
