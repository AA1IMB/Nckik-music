'use strict';
/**
 * 桌面悬浮歌词独立透明置顶窗口（主进程模块）
 * - 支持逐字/整句进度高亮、外文译文、鼠标穿透锁定（setIgnoreMouseEvents forward）
 * - 位置与尺寸自动记忆，关闭主窗时同步销毁，避免进程残留
 */
const path = require('node:path');

function createDesktopLyric({ BrowserWindow, screen, baseDir, onStateChange, logCrash }) {
  let dwin = null;
  let locked = false;
  let lastPayload = null;
  let savedBounds = null;
  let boundsTimer = 0;

  function clampBounds(b) {
    const wa = screen.getPrimaryDisplay().workArea;
    const width = Math.max(340, Math.min(1100, Number(b && b.width) || 680));
    const height = Math.max(76, Math.min(180, Number(b && b.height) || 108));
    const defX = Math.round(wa.x + (wa.width - width) / 2);
    const defY = Math.round(wa.y + wa.height - height - 42);
    const hasX = b && b.x != null && Number.isFinite(Number(b.x));
    const hasY = b && b.y != null && Number.isFinite(Number(b.y));
    const x = hasX ? Math.max(wa.x - width + 80, Math.min(wa.x + wa.width - 80, Math.round(Number(b.x)))) : defX;
    const y = hasY ? Math.max(wa.y, Math.min(wa.y + wa.height - 48, Math.round(Number(b.y)))) : defY;
    return { x, y, width, height };
  }

  function isOpen() {
    return !!(dwin && !dwin.isDestroyed());
  }

  function emitState() {
    if (typeof onStateChange === 'function') {
      onStateChange({ open: isOpen(), locked, bounds: savedBounds });
    }
  }

  function applyLock(nextLocked) {
    locked = !!nextLocked;
    if (isOpen()) {
      try {
        dwin.setIgnoreMouseEvents(locked, { forward: true });
        dwin.webContents.send('dlyr:lock-state', locked);
      } catch (e) { logCrash('dlyr-lock', e); }
    }
    emitState();
    return { ok: true, open: isOpen(), locked };
  }

  function open(opts = {}) {
    if (opts && opts.bounds) savedBounds = clampBounds(opts.bounds);
    if (typeof opts.locked === 'boolean') locked = opts.locked;

    if (isOpen()) {
      try { dwin.showInactive(); } catch {}
      applyLock(locked);
      if (lastPayload) push(lastPayload);
      return { ok: true, open: true, locked };
    }

    const b = clampBounds(savedBounds);
    savedBounds = b;
    dwin = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      minWidth: 340,
      minHeight: 76,
      maxHeight: 190,
      frame: false,
      transparent: true,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: true,
      show: false,
      webPreferences: {
        preload: path.join(baseDir, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    try { dwin.setAlwaysOnTop(true, 'screen-saver'); } catch {}
    try { dwin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}

    dwin.loadFile(path.join(baseDir, 'renderer', 'desktop-lyric.html'));
    dwin.once('ready-to-show', () => {
      if (!isOpen()) return;
      dwin.showInactive();
      applyLock(locked);
      if (lastPayload) push(lastPayload);
    });

    const saveSoon = () => {
      if (!isOpen()) return;
      clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        if (!isOpen()) return;
        try {
          savedBounds = dwin.getBounds();
          emitState();
        } catch {}
      }, 300);
    };
    dwin.on('moved', saveSoon);
    dwin.on('resized', saveSoon);
    dwin.on('closed', () => {
      clearTimeout(boundsTimer);
      dwin = null;
      emitState();
    });

    emitState();
    return { ok: true, open: true, locked };
  }

  function close() {
    if (isOpen()) {
      try { dwin.close(); } catch {}
    }
    dwin = null;
    emitState();
    return { ok: true, open: false, locked };
  }

  function toggle(opts = {}) {
    return isOpen() ? close() : open(opts);
  }

  function push(payload) {
    lastPayload = payload;
    if (!isOpen()) return false;
    try {
      dwin.webContents.send('dlyr:data', { ...payload, locked });
      return true;
    } catch { return false; }
  }

  function getState() {
    return { open: isOpen(), locked, bounds: savedBounds };
  }

  return { open, close, toggle, applyLock, push, isOpen, getState };
}

module.exports = { createDesktopLyric };
