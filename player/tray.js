'use strict';
/**
 * 系统托盘管理（主进程模块）
 * - 常驻托盘图标 + 右键快捷菜单（播放/暂停、切歌、迷你模式、桌面歌词、显示主窗、退出）
 * - 点击托盘图标自动恢复并聚焦主窗口；最小化操作仍保留任务栏入口，确保缩略图三键可用
 */
const path = require('node:path');

function createAppTray({ appName, baseDir, Tray, Menu, nativeImage, getWin, send, onShowMain, onToggleMini, onToggleDlyr, onQuit, logCrash }) {
  let tray = null;
  const state = {
    playing: false,
    title: '',
    artist: '',
    mini: false,
    dlyr: false
  };

  function makeIcon() {
    const iconPath = path.join(baseDir, 'build', 'icon.png');
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (img && !img.isEmpty()) return img.resize({ width: 16, height: 16 });
    } catch {}
    return nativeImage.createEmpty();
  }

  function buildMenu() {
    const header = state.title
      ? (state.artist ? `${state.title} - ${state.artist}` : state.title)
      : `${appName} · 未播放`;
    return Menu.buildFromTemplate([
      { label: header.slice(0, 48), enabled: false },
      { type: 'separator' },
      { label: state.playing ? '暂停' : '播放', click: () => send('player:cmd', 'toggle') },
      { label: '上一首', click: () => send('player:cmd', 'prev') },
      { label: '下一首', click: () => send('player:cmd', 'next') },
      { type: 'separator' },
      { label: state.mini ? '退出迷你模式' : '迷你模式', click: () => onToggleMini() },
      { label: state.dlyr ? '关闭桌面歌词' : '开启桌面歌词', click: () => onToggleDlyr() },
      { type: 'separator' },
      { label: '显示主窗口', click: () => onShowMain() },
      { label: `退出 ${appName}`, click: () => onQuit() }
    ]);
  }

  function refresh() {
    if (!tray || tray.isDestroyed()) return;
    try {
      const tip = state.title
        ? `${appName} · ${state.title}${state.artist ? ' - ' + state.artist : ''}`
        : appName;
      tray.setToolTip(tip.slice(0, 120));
      tray.setContextMenu(buildMenu());
    } catch {}
    const w = getWin();
    if (w && !w.isDestroyed()) {
      w.__tray = { active: true, ...state };
    }
  }

  function init() {
    if (tray && !tray.isDestroyed()) return true;
    try {
      tray = new Tray(makeIcon());
      tray.on('click', () => onShowMain());
      tray.on('double-click', () => onShowMain());
      refresh();
      return true;
    } catch (e) {
      logCrash('tray-init', e);
      tray = null;
      return false;
    }
  }

  function updateState(patch) {
    if (!patch || typeof patch !== 'object') return;
    let changed = false;
    for (const k of ['playing', 'title', 'artist', 'mini', 'dlyr']) {
      if (k in patch && patch[k] !== state[k]) {
        state[k] = patch[k];
        changed = true;
      }
    }
    if (changed) refresh();
  }

  function destroy() {
    if (tray && !tray.isDestroyed()) {
      try { tray.destroy(); } catch {}
    }
    tray = null;
  }

  return { init, updateState, refresh, destroy, isReady: () => !!(tray && !tray.isDestroyed()) };
}

module.exports = { createAppTray };
