'use strict';
/**
 * WASAPI 独占音频子进程桥接（主进程模块）
 * - 懒启动：默认关闭独占时不拉起 nckik-audio.exe，仅在枚举独占设备或加载独占曲目时启动
 * - 按行协议与子进程 stdin/stdout 通信；异步事件经 excl:event 推送给渲染层
 * - 非主动退出时自动清理挂起请求并通知渲染层安全回退到系统混音
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function createAudioExclusive({ app, baseDir, userDir, send, logCrash }) {
  const logPath = path.join(userDir, 'audio-exclusive.log');
  let child = null;
  let readyPromise = null;
  let closing = false;
  let reqId = 0;
  let buf = '';
  const pending = new Map();

  function appendLog(line) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const msg = `[${new Date().toISOString()}] ${line}\n`;
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 64 * 1024) {
        fs.writeFileSync(logPath, msg);
      } else {
        fs.appendFileSync(logPath, msg);
      }
    } catch {}
  }

  function resolveBinaryPath() {
    if (app && app.isPackaged) {
      return path.join(process.resourcesPath, 'bin', 'nckik-audio.exe');
    }
    return path.join(baseDir, 'bin', 'nckik-audio.exe');
  }

  function settleAll(code, message) {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code, message });
      pending.delete(id);
    }
  }

  function ensureRunning() {
    if (child && !child.killed && child.exitCode === null && readyPromise) {
      return readyPromise;
    }
    if (process.platform !== 'win32') {
      return Promise.reject(Object.assign(new Error('仅支持 Windows'), { code: 'PLATFORM_UNSUPPORTED' }));
    }
    const binPath = resolveBinaryPath();
    if (!fs.existsSync(binPath)) {
      return Promise.reject(Object.assign(new Error('未找到独占音频引擎：' + binPath), { code: 'BIN_MISSING' }));
    }

    closing = false;
    buf = '';
    readyPromise = new Promise((resolve, reject) => {
      let settled = false;
      const proc = spawn(binPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      child = proc;

      const bootTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(Object.assign(new Error('独占音频引擎启动超时'), { code: 'BOOT_TIMEOUT' }));
        }
      }, 4000);

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let msg = null;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.ev) {
            if (msg.ev === 'ready' && !settled) {
              settled = true;
              clearTimeout(bootTimer);
              resolve(true);
              continue;
            }
            send('excl:event', msg);
            continue;
          }
          if (msg.id != null) {
            const p = pending.get(msg.id);
            if (p) {
              clearTimeout(p.timer);
              pending.delete(msg.id);
              p.resolve(msg);
            }
          }
        }
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => {
        const s = String(d || '').trim();
        if (s) appendLog('stderr: ' + s);
      });

      proc.on('error', (err) => {
        clearTimeout(bootTimer);
        appendLog('proc error: ' + ((err && err.message) || err));
        if (logCrash) logCrash('audio-exclusive:spawn', err);
        if (!settled) {
          settled = true;
          reject(err);
        }
        if (child === proc) {
          child = null;
          readyPromise = null;
        }
        settleAll('PROC_ERROR', (err && err.message) || '独占音频引擎启动失败');
      });

      proc.on('exit', (code, signal) => {
        clearTimeout(bootTimer);
        if (child === proc) {
          child = null;
          readyPromise = null;
        }
        settleAll('PROC_EXITED', '独占音频引擎已退出');
        if (!closing) {
          appendLog(`unexpected exit code=${code} signal=${signal || ''}`);
          send('excl:event', { ev: 'crashed', code: code == null ? -1 : code });
        }
        if (!settled) {
          settled = true;
          reject(new Error('独占音频引擎已退出'));
        }
      });
    });

    return readyPromise;
  }

  async function request(cmd, params = {}, timeoutMs = 4000) {
    try {
      await ensureRunning();
    } catch (e) {
      return {
        ok: false,
        code: (e && e.code) || 'ENGINE_UNAVAILABLE',
        message: (e && e.message) || '独占音频引擎不可用'
      };
    }
    if (!child || !child.stdin || !child.stdin.writable) {
      return { ok: false, code: 'STDIN_CLOSED', message: '独占音频引擎通道未就绪' };
    }
    const id = ++reqId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ ok: false, code: 'RPC_TIMEOUT', message: `指令 ${cmd} 超时` });
        }
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      try {
        child.stdin.write(JSON.stringify({ id, cmd, ...params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ ok: false, code: 'WRITE_FAILED', message: (e && e.message) || '发送指令失败' });
      }
    });
  }

  function isRunning() {
    return !!(child && !child.killed && child.exitCode === null);
  }

  function status() {
    const binPath = resolveBinaryPath();
    return {
      ok: true,
      supported: process.platform === 'win32',
      available: process.platform === 'win32' && fs.existsSync(binPath),
      running: isRunning(),
      binPath
    };
  }

  function listDevices() {
    return request('devices', {}, 4000);
  }

  function load(opts = {}) {
    const targetPath = String(opts.path || '');
    const isHttp = /^https?:\/\//i.test(targetPath);
    return request('load', {
      path: targetPath,
      deviceId: String(opts.deviceId || ''),
      volume: Number.isFinite(Number(opts.volume)) ? Number(opts.volume) : 0.78,
      muted: !!opts.muted,
      autoplay: opts.autoplay !== false,
      seekTo: Number.isFinite(Number(opts.seekTo)) ? Number(opts.seekTo) : 0
    }, isHttp ? 18000 : 8000);
  }

  function play() {
    return request('play', {}, 4000);
  }

  function pause() {
    if (!isRunning()) return Promise.resolve({ ok: true });
    return request('pause', {}, 4000);
  }

  function stop() {
    if (!isRunning()) return Promise.resolve({ ok: true });
    return request('stop', {}, 4000);
  }

  function seek(time) {
    if (!isRunning()) return Promise.resolve({ ok: false, code: 'NOT_RUNNING', message: '未运行' });
    return request('seek', { time: Number(time) || 0 }, 4000);
  }

  function setVolume(volume, muted) {
    if (!isRunning()) return Promise.resolve({ ok: true });
    return request('volume', {
      volume: Number.isFinite(Number(volume)) ? Number(volume) : 0.78,
      muted: !!muted
    }, 4000);
  }

  function queueNext(opts = {}) {
    if (!isRunning()) return Promise.resolve({ ok: false, code: 'NOT_RUNNING', message: '未运行' });
    const targetPath = String(opts.path || '');
    const isHttp = /^https?:\/\//i.test(targetPath);
    return request('queue_next', {
      path: targetPath,
      trackId: String(opts.trackId || '')
    }, isHttp ? 18000 : 8000);
  }

  function clearNext() {
    if (!isRunning()) return Promise.resolve({ ok: true });
    return request('clear_next', {}, 4000);
  }

  function dispose() {
    closing = true;
    settleAll('DISPOSED', '播放器已关闭');
    const proc = child;
    child = null;
    readyPromise = null;
    if (!proc || proc.killed || proc.exitCode !== null) return;
    try {
      if (proc.stdin && proc.stdin.writable) {
        proc.stdin.write(JSON.stringify({ id: ++reqId, cmd: 'quit' }) + '\n');
      }
    } catch {}
    setTimeout(() => {
      try {
        if (proc.exitCode === null && !proc.killed) proc.kill();
      } catch {}
    }, 400);
  }

  return {
    status,
    listDevices,
    load,
    play,
    pause,
    stop,
    seek,
    setVolume,
    queueNext,
    clearNext,
    dispose
  };
}

module.exports = { createAudioExclusive };
