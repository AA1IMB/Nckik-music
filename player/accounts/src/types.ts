/* 统一账号层的公共类型（纯类型，不依赖 electron / node，便于单独编译与自测） */

/** 目前接入的两个平台；新增平台只在此处追加，其余层按 ProviderId 分发 */
export type ProviderId = 'qq' | 'kugou' | 'qqapp';

/** 音质档位：与现有 settings.quality 的命名保持一致（标准/较高/极高/无损/高解析） */
export type QualityId = 'standard' | 'high' | 'lossless' | 'hires';

/** 扫码登录状态机相位，顺序即正常路径：starting → waiting → scanned → confirmed */
export type LoginPhase =
  | 'idle'          // 没有进行中的登录
  | 'starting'      // 正在打开官方登录页 / 申请二维码
  | 'waiting'       // 二维码已显示，等手机扫
  | 'scanned'       // 手机上已扫，等确认
  | 'confirmed'     // 已确认并拿到凭据
  | 'expired'       // 二维码过期（可重取）
  | 'failed'        // 失败（错误码见 AccountErrorCode）
  | 'cancelled';    // 用户主动取消

/** 账号：只放展示用信息，凭据单独存，避免账号列表被拿去拼请求 */
export interface Account {
  /** 稳定主键：`<provider>:<userId>`，同一平台同一账号重复扫码不会产生两条 */
  id: string;
  provider: ProviderId;
  /** 昵称，取不到时回落 `uid <userId>` */
  name: string;
  /** 平台内的用户 id（字符串，避免大整数精度问题） */
  userId: string;
  avatarUrl: string;
  createdAt: number;
  lastLoginAt: number;
}

/** 凭据：整串 cookie 是各平台通用格式，额外字段按平台放 extra，不硬编码字段名 */
export interface Credential {
  /** 原始 Cookie 串（`k=v; k=v`），大小写与顺序原样保留（B 站踩过小写化导致 -101） */
  cookie: string;
  /** 平台特有字段：qq: qm_keyst/g_tk；kugou: token/userid/dfid */
  extra: Record<string, string>;
  updatedAt: number;
  /** 最近一次校验成功的时间；0 表示尚未校验 */
  verifiedAt: number;
}

/** 二维码数据：image 是 data URL（PNG/SVG），由渲染层直接塞进 <img> */
export interface QrPayload {
  image: string;
  /** 该码的绝对过期时刻（ms） */
  expiresAt: number;
}

export interface AccountErrorPayload {
  code: AccountErrorCode;
  /** 给用户看的一句话（中文，可直接显示） */
  message: string;
  /** 可选的下一步提示，例如「稍后重试」「去扫码」 */
  hint?: string;
  /** 限流类错误建议的等待毫秒数 */
  retryAfterMs?: number;
}

/** 切换账号后刷新收藏/歌单的结果 */
export interface LibraryRefresh {
  /** 这次是否真的去刷了（该平台还没接歌单接口时为 false） */
  refreshed: boolean;
  /** 刷新后的条目数 */
  items?: number;
  /** 给用户看的一句话 */
  message?: string;
}

/** 对外快照：渲染层只认这一个结构，不再自己拼文案 */
export interface LoginSnapshot {
  provider: ProviderId;
  phase: LoginPhase;
  /** 状态行文案，UI 直接显示 */
  message: string;
  qr?: QrPayload;
  error?: AccountErrorPayload;
  /** 距下一次轮询的毫秒数（渲染层据此 setTimeout，而不是自己拍脑袋） */
  retryAfterMs?: number;
  /** 已登录账号（phase === 'confirmed' 时给出） */
  account?: Account;
}

/** 取流结果：带上「实际拿到」的档位，UI 按真实档位显示（不按请求档位） */
export interface AudioResult {
  url: string;
  quality: QualityId;
  bitrateKbps: number;
  /** 绝对过期时刻（ms）；取流时按此判断是否要重新解析 */
  expiresAt: number;
  /** 降级过程中被跳过的档位，按尝试顺序 */
  tried: QualityId[];
}

export interface AudioRequest {
  /** 平台内曲目 id：qq 为 songmid，kugou 为 hash */
  songId: string;
  /** 某些平台降级取链需要专辑 id（酷狗） */
  albumId?: string;
  quality: QualityId;
}

/** 错误码：任何失败都必须落到其中一个，渲染层据此给可读提示 */
export type AccountErrorCode =
  | 'E_AUTH_REQUIRED'        // 未登录 / 登录失效
  | 'E_LOGIN_TIMEOUT'        // 轮询整体超时
  | 'E_QR_EXPIRED'           // 二维码过期
  | 'E_LOGIN_DENIED'         // 手机端拒绝或取消
  | 'E_RISK_CONTROL'         // 风控拦截（验证码、异常登录）
  | 'E_RATE_LIMITED'         // 频控 / 429
  | 'E_ACCOUNT_LIMIT'        // 设备或账号数上限
  | 'E_NO_COPYRIGHT'         // 无版权 / 不可播放
  | 'E_QUALITY_UNAVAILABLE'  // 所有档位都取不到
  | 'E_UPSTREAM_UNAVAILABLE' // 上游不可达 / 超时
  | 'E_CIPHER_UNAVAILABLE'   // 系统密钥库不可用
  | 'E_STORAGE_FAILED'       // 本地存储失败
  | 'E_CANCELLED'            // 用户取消
  | 'E_NOT_IMPLEMENTED';     // 骨架占位（例如未接入的上游）

/** 传输层：只暴露两个方法，主进程用 net/https 实现，测试用假实现 */
export interface Transport {
  getJson<T>(url: string, init?: TransportInit): Promise<TransportResponse<T>>;
  postJson<T>(url: string, body: unknown, init?: TransportInit): Promise<TransportResponse<T>>;
}

export interface TransportInit {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 真机调试用：请求落日志（不含 Cookie 值） */
  label?: string;
}

export interface TransportResponse<T> {
  status: number;
  body: T;
  headers?: Record<string, string>;
}

/** 系统密钥库：主进程传 safeStorage 的薄封装，测试传假实现 */
export interface Cipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(sealed: Buffer): string;
}

/** 隐藏登录窗口：主进程用 BrowserWindow 实现（官方登录页 + 读 cookie），测试用假实现 */
export interface LoginWindowHost {
  /** 打开官方登录页并等页面稳定 */
  open(
    url: string,
    opts: {
      partition: string;
      size?: { width: number; height: number };
      /** 必须先点一下才出码时的可见按钮文案，按顺序点（QQ 音乐要「登录」→「QQ登录」→「扫码登录」） */
      clickTexts?: readonly string[];
      /** 兼容单条文案写法 */
      clickText?: string;
      /** 打开前是否清空该分区的 cookie（默认 true；酷狗需要在重开时保留已登录态） */
      clearCookies?: boolean;
    }
  ): Promise<void>;
  /** 读到指定名字的 cookie（值可能为空串，表示尚未写入） */
  readCookies(names: readonly string[]): Promise<Record<string, string>>;
  /** 读页面上的二维码图（canvas.toDataURL 或 img.src）；没有则 null */
  readQrImage(): Promise<string | null>;
  /** 读页面可见文本，用来判别「已扫码」「已失效」这类文案状态 */
  readPageText(): Promise<string>;
  /** 当前页面地址（判断是否已跳到登录成功页） */
  currentUrl(): Promise<string>;
  /**
   * 旁听页面自己的 XHR/fetch 响应（只读，读完立刻放行）。
   * 酷狗的登录页自己轮询 `get_userinfo_qrcode`，返回体里的 `data.status` 才是权威状态，
   * 4 表示手机上已确认、`data.token` 就是换会话要用的凭据。
   */
  tapJson?(patterns: readonly string[], onJson: (json: unknown) => void): () => void;
  /** 在登录页主框架里执行一段脚本（只用于调用页面自己已有的函数） */
  evalInPage?(code: string): Promise<unknown>;
  /**
   * 把旁听到的凭据写回这个分区的 cookie。
   * 酷狗页面在隐藏窗口里偶尔不肯自己换会话，此时 `data.token/userid` 已经是登录凭据，
   * 我们直接按官方写入的同样形态落到 `.kugou.com`，后续读取/校验都走同一条路。
   */
  writeCookies?(cookies: Record<string, string>, domain: string): Promise<void>;
  close(): Promise<void>;
  /** 订阅 cookie 变化；返回退订函数。凭据靠它「第一时间」拿到，避免轮询拍点错过 */
  onCookiesChanged(cb: (names: Record<string, string>) => void): () => void;
}

/** 最小日志接口：主进程写 crash.log/控制台，测试收集断言 */
export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  qq: 'QQ 音乐',
  kugou: '酷狗音乐',
  qqapp: 'QQ 音乐（App 扫码）'
};

export const QUALITY_LABEL: Record<QualityId, string> = {
  standard: '标准',
  high: '较高',
  lossless: '无损',
  hires: '高解析'
};
