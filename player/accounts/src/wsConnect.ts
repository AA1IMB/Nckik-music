import type { MqttConnect, MqttSocket, MqttSocketHandlers } from './mqtt';

/**
 * 主进程用的 WebSocket 实现（MQTT over WebSocket）
 * ---------------------------------------------------------------------------
 * Electron 33 的 Node 20 没有全局 WebSocket，所以用 `ws`（生产依赖）。
 * 这里把 `ws` 包成 `MqttConnect`，让 `mqtt.ts` / `providers/qqapp.ts` 不直接依赖它，
 * 单测可以塞一个纯内存的假连接。
 */
export function createWsConnect(loadWs: () => unknown = () => require('ws')): MqttConnect {
  return (url: string, handlers: MqttSocketHandlers): MqttSocket => {
    const loaded = loadWs() as { default?: unknown } | ((u: string, p: string[]) => unknown);
    const Ctor =
      typeof loaded === 'function'
        ? loaded
        : ((loaded as { WebSocket?: unknown; default?: unknown }).WebSocket ??
            (loaded as { default?: unknown }).default);
    if (typeof Ctor !== 'function') throw new Error('ws 模块不可用');

    const ws = new (Ctor as new (u: string, protocols: string[]) => any)(url, ['mqtt']);
    ws.binaryType = 'arraybuffer';

    ws.on('open', () => handlers.onopen?.());
    ws.on('message', (data: unknown) => {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Array.isArray(data)
            ? new Uint8Array(Buffer.concat(data as Buffer[]))
            : new Uint8Array(Buffer.from(data as Buffer));
      handlers.onmessage?.(bytes);
    });
    ws.on('close', (code: number, reason: Buffer) => handlers.onclose?.(code, reason?.toString?.() ?? ''));
    ws.on('error', (err: Error) => handlers.onerror?.(err));

    return {
      send(data: Uint8Array) {
        ws.send(Buffer.from(data));
      },
      close() {
        try {
          ws.close();
        } catch {
          /* 已经断开 */
        }
      }
    };
  };
}
