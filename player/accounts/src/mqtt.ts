/**
 * 最小 MQTT 5.0 客户端（只做扫码登录需要的那几个包）
 * ---------------------------------------------------------------------------
 * QQ 音乐 App 扫码确认后，服务端不是回 HTTP 响应，而是往 MQTT 主题
 * `management.qrcode_login/<qrcodeId>` 上推一条消息（`scanned` / `cookies`）。
 * 因此这里只需要：
 *   CONNECT（带 User Properties）→ 等 CONNACK → SUBSCRIBE（带 User Properties）
 *   → 等 SUBACK → 收 PUBLISH → 定时 PINGREQ → DISCONNECT
 *
 * 不引第三方 MQTT 库、不做 QoS 2／保留消息／遗嘱：协议面窄，自己写反而好查。
 * 传输用「鸭子类型的 socket」而不是直接依赖 `ws`，这样主进程传 ws、单测传假实现，
 * 谁都不用为了测试去连真的 broker。
 */

export interface MqttSocket {
  send(data: Uint8Array): void;
  close(): void;
}

export interface MqttSocketHandlers {
  onopen?: () => void;
  onmessage?: (data: Uint8Array) => void;
  onclose?: (code?: number, reason?: string) => void;
  onerror?: (err: Error) => void;
}

/** 建一条到 broker 的连接；主进程用 `ws` 实现，单测用假的 */
export type MqttConnect = (url: string, handlers: MqttSocketHandlers) => MqttSocket;

export interface MqttUserProperty {
  key: string;
  value: string;
}

const PACKET = {
  CONNECT: 0x10,
  CONNACK: 0x20,
  PUBLISH: 0x30,
  PUBACK: 0x40,
  SUBSCRIBE: 0x82,
  SUBACK: 0x90,
  PINGREQ: 0xc0,
  PINGRESP: 0xd0,
  DISCONNECT: 0xe0
} as const;

/** MQTT 5 属性 id */
const PROP = {
  PAYLOAD_FORMAT: 0x01,
  SESSION_EXPIRY: 0x11,
  /** 认证方式：QQ 音乐的 broker 要求 CONNECT 里声明 "pass"，否则回 0x8C（Bad authentication method） */
  AUTH_METHOD: 0x15,
  USER_PROPERTY: 0x26
} as const;

/* ---------------- 编码 ---------------- */

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return out;
}

function str(s: string): number[] {
  const bytes = Array.from(utf8(s));
  return [(bytes.length >> 8) & 0xff, bytes.length & 0xff, ...bytes];
}

function props(entries: MqttUserProperty[], opts: { authMethod?: string; sessionExpiry?: number } = {}): number[] {
  const body: number[] = [];
  // 顺序照官方客户端：认证方式 → 会话过期 → 用户属性
  if (opts.authMethod) body.push(PROP.AUTH_METHOD, ...str(opts.authMethod));
  if (opts.sessionExpiry !== undefined) body.push(PROP.SESSION_EXPIRY, ...u32(opts.sessionExpiry));
  for (const e of entries) {
    body.push(PROP.USER_PROPERTY, ...str(e.key), ...str(e.value));
  }
  return [...varint(body.length), ...body];
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function packet(type: number, body: number[]): Uint8Array {
  return new Uint8Array([type, ...varint(body.length), ...body]);
}

export interface ConnectOptions {
  clientId: string;
  userProperties: MqttUserProperty[];
  keepAliveSec?: number;
  /** 会话过期秒数；QQ 音乐不送这个字段，默认不写 */
  sessionExpirySec?: number;
  /** 认证方式（QQ 音乐固定 'pass'） */
  authMethod?: string;
}

export function encodeConnect(o: ConnectOptions): Uint8Array {
  const flags = 0x02; // clean start
  const body = [
    ...str('MQTT'),
    5, // protocol level 5.0
    flags,
    ((o.keepAliveSec ?? 45) >> 8) & 0xff,
    (o.keepAliveSec ?? 45) & 0xff,
    ...props(o.userProperties, { authMethod: o.authMethod, sessionExpiry: o.sessionExpirySec }),
    ...str(o.clientId)
  ];
  return packet(PACKET.CONNECT, body);
}

export function encodeSubscribe(packetId: number, topic: string, userProperties: MqttUserProperty[]): Uint8Array {
  const body = [
    (packetId >> 8) & 0xff,
    packetId & 0xff,
    ...props(userProperties, {}),
    ...str(topic),
    0x00 // QoS 0
  ];
  return packet(PACKET.SUBSCRIBE, body);
}

export function encodePingreq(): Uint8Array {
  return new Uint8Array([PACKET.PINGREQ, 0x00]);
}

export function encodeDisconnect(): Uint8Array {
  return new Uint8Array([PACKET.DISCONNECT, 0x00]);
}

/* ---------------- 解码 ---------------- */

export type MqttPacket =
  | { kind: 'connack'; sessionPresent: boolean; reasonCode: number }
  | { kind: 'suback'; packetId: number; reasons: number[] }
  | { kind: 'publish'; topic: string; payload: string; qos: number }
  | { kind: 'pingresp' }
  | { kind: 'other'; type: number };

interface Reader {
  at: number;
  bytes: Uint8Array;
}

function readVarint(r: Reader): number {
  let multiplier = 1;
  let value = 0;
  for (;;) {
    if (r.at >= r.bytes.length) throw new Error('MQTT 包不完整：长度字段');
    const byte = r.bytes[r.at++];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return value;
    multiplier *= 128;
    if (multiplier > 128 * 128 * 128) throw new Error('MQTT 长度字段非法');
  }
}

function readStr(r: Reader): string {
  if (r.at + 1 >= r.bytes.length) throw new Error('MQTT 包不完整：字符串长度');
  const len = (r.bytes[r.at] << 8) | r.bytes[r.at + 1];
  r.at += 2;
  if (r.at + len > r.bytes.length) throw new Error('MQTT 包不完整：字符串内容');
  const s = new TextDecoder().decode(r.bytes.subarray(r.at, r.at + len));
  r.at += len;
  return s;
}

function skipVarint(r: Reader): number {
  return readVarint(r);
}

/** 解析单包；返回 null 表示数据还没收全，调用方留着下次拼 */
function readOne(bytes: Uint8Array): { pkt: MqttPacket; used: number } | null {
  if (bytes.length < 2) return null;
  const type = bytes[0];
  const r: Reader = { at: 1, bytes };
  let remaining: number;
  try {
    remaining = readVarint(r);
  } catch {
    return null;
  }
  const headerLen = r.at;
  if (bytes.length < headerLen + remaining) return null;

  const body: Reader = { at: headerLen, bytes };
  const kind = type & 0xf0;

  switch (kind) {
    case PACKET.CONNACK: {
      const ackFlags = body.bytes[body.at++];
      const reasonCode = body.bytes[body.at++];
      skipVarint(body); // 属性长度（本客户端不读 CONNACK 属性）
      body.at = headerLen + remaining;
      return { pkt: { kind: 'connack', sessionPresent: (ackFlags & 1) === 1, reasonCode }, used: headerLen + remaining };
    }
    case PACKET.SUBACK: {
      const packetId = (body.bytes[body.at] << 8) | body.bytes[body.at + 1];
      body.at += 2;
      const propsLen = skipVarint(body);
      const propsEnd = body.at + propsLen;
      body.at = propsEnd;
      const reasons: number[] = [];
      while (body.at < headerLen + remaining) reasons.push(body.bytes[body.at++]);
      return { pkt: { kind: 'suback', packetId, reasons }, used: headerLen + remaining };
    }
    case PACKET.PUBLISH: {
      const qos = (type >> 1) & 0x03;
      const topic = readStr(body);
      if (qos > 0) body.at += 2; // packetId
      const propsLen = skipVarint(body);
      body.at += propsLen;
      const payloadStart = body.at;
      const payload = new TextDecoder().decode(
        body.bytes.subarray(payloadStart, headerLen + remaining)
      );
      return { pkt: { kind: 'publish', topic, payload, qos }, used: headerLen + remaining };
    }
    case PACKET.PINGRESP:
      return { pkt: { kind: 'pingresp' }, used: headerLen + remaining };
    default:
      return { pkt: { kind: 'other', type }, used: headerLen + remaining };
  }
}

export interface MqttPushEvent {
  /** 推送的原始 JSON（解析失败时为 { raw }） */
  json: Record<string, unknown>;
  topic: string;
}

export interface MqttListenOptions {
  url: string;
  topic: string;
  clientId: string;
  /** CONNECT 的 User Properties（QQ 音乐要求 hashTag/userID 都是 qrcodeId） */
  connectProperties: MqttUserProperty[];
  /** 认证方式（QQ 音乐固定 'pass'） */
  authMethod?: string;
  /** SUBSCRIBE 的 User Properties（authorization=tmelogin, pubsub=unicast） */
  subscribeProperties: MqttUserProperty[];
  connect: MqttConnect;
  logger?: { info(m: string, d?: Record<string, unknown>): void; warn(m: string, d?: Record<string, unknown>): void };
  /** SUBACK 之后才算连接可用；超时抛 E_APP_PUSH_TIMEOUT */
  readyTimeoutMs?: number;
  keepAliveMs?: number;
  now?: () => number;
}

/**
 * 一条订阅连接的生命周期。
 * - `ready` 在收到 SUBACK 时兑现（CONNACK 只表示 TCP+MQTT 握手成功）；
 * - 之后每收到一条 PUBLISH 就交给 `onEvent`；
 * - `close()` 发 DISCONNECT 并断开。
 */
export class MqttSubscription {
  private socket: MqttSocket | null = null;
  private buffer = new Uint8Array(0);
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private ready = false;
  private closed = false;
  private packetId = 1;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: MqttListenOptions) {}

  onEvent: ((e: MqttPushEvent) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;

  /** 建立连接，等到 SUBACK */
  async open(): Promise<void> {
    const readyTimeoutMs = this.opts.readyTimeoutMs ?? 12000;
    const done = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimer = setTimeout(() => {
        reject(new Error('MQTT 订阅超时：broker 没有回 SUBACK'));
      }, readyTimeoutMs);
    });

    this.socket = this.opts.connect(this.opts.url, {
      onopen: () => {
        this.send(
          encodeConnect({
            clientId: this.opts.clientId,
            userProperties: this.opts.connectProperties,
            authMethod: this.opts.authMethod
          })
        );
      },
      onmessage: data => this.feed(data),
      onerror: err => this.fail(err),
      onclose: (code, reason) => {
        if (!this.closed) this.fail(new Error(`MQTT 连接被关闭 ${code ?? ''} ${reason ?? ''}`.trim()));
      }
    });

    await done;
    this.startKeepAlive();
  }

  private startKeepAlive(): void {
    const every = this.opts.keepAliveMs ?? 30_000;
    this.pingTimer = setInterval(() => {
      try {
        this.send(encodePingreq());
      } catch {
        /* 下一拍 socket 事件会兜底 */
      }
    }, every);
    // 无头环境里 interval 不应把进程钩住
    (this.pingTimer as unknown as { unref?: () => void }).unref?.();
  }

  private send(bytes: Uint8Array): void {
    this.socket?.send(bytes);
  }

  private feed(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    for (;;) {
      const parsed = readOne(this.buffer);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.used);
      this.handle(parsed.pkt);
    }
  }

  private handle(pkt: MqttPacket): void {
    if (pkt.kind === 'connack') {
      if (pkt.reasonCode !== 0) {
        this.fail(new Error(`MQTT 握手被拒：reason ${pkt.reasonCode}`));
        return;
      }
      this.send(
        encodeSubscribe(this.packetId++, this.opts.topic, this.opts.subscribeProperties)
      );
      return;
    }
    if (pkt.kind === 'suback') {
      const denied = pkt.reasons.find(r => r >= 0x80);
      if (denied !== undefined) {
        this.fail(new Error(`MQTT 订阅被拒：reason 0x${denied.toString(16)}`));
        return;
      }
      this.ready = true;
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this.opts.logger?.info('[acc] MQTT 已订阅', { topic: this.opts.topic });
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (pkt.kind === 'publish') {
      let json: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(pkt.payload) as unknown;
        if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
      } catch {
        json = { raw: pkt.payload };
      }
      this.onEvent?.({ json, topic: pkt.topic });
      return;
    }
    // pingresp / 其它包：不需要处理
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.close('error');
    this.onClosed?.(err.message);
    this.readyReject?.(err);
    this.readyReject = null;
    this.readyResolve = null;
  }

  get isReady(): boolean {
    return this.ready && !this.closed;
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    try {
      if (this.ready) this.send(encodeDisconnect());
    } catch {
      /* 忽略：连接可能已经断了 */
    }
    try {
      this.socket?.close();
    } catch {
      /* 同上 */
    }
    this.socket = null;
    if (reason !== 'error') this.onClosed?.(reason);
  }
}
