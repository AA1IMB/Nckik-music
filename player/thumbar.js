'use strict';
/**
 * Windows 任务栏缩略图工具栏与任务栏进度条（主进程模块）
 * - 鼠标悬停任务栏图标时显示「上一首 / 播放或暂停 / 下一首」
 * - 强引用按钮数组与具名回调 + WM_COMMAND (THBN_CLICKED) 80ms 去重兜底
 * - 自动适配任务栏深/浅色主题（注册表 SystemUsesLightTheme + nativeTheme）
 * - 集成 win.setProgressBar 任务栏播放进度条
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const WM_COMMAND = 0x0111;
const THBN_CLICKED = 0x1800;
const THUMBAR_CMDS = ['prev', 'toggle', 'next'];

function createThumbar({ appName, baseDir, userDir, nativeImage, nativeTheme, getWin, send, logCrash }) {
  const thumbarLogPath = path.join(userDir, 'thumbar.log');

  function thumbarLog(what, extra) {
    try {
      fs.mkdirSync(path.dirname(thumbarLogPath), { recursive: true });
      const line = JSON.stringify({ at: new Date().toISOString(), what, ...extra });
      fs.appendFileSync(thumbarLogPath, line + '\n');
      if (fs.statSync(thumbarLogPath).size > 64 * 1024) fs.writeFileSync(thumbarLogPath, line + '\n');
    } catch {}
  }

  const state = {
    playing: false,
    hasQueue: false,
    title: '',
    artist: '',
    dark: true,
    applied: false,
    calls: 0,
    lastButtons: null,
    lastCmdAt: 0,
    lastCmd: '',
    retryTimers: [],
    lastProg: -1,
    lastProgMode: 'none'
  };

  function clearRetries() {
    for (const t of state.retryTimers) clearTimeout(t);
    state.retryTimers = [];
  }

  function scheduleRetry() {
    if (process.platform !== 'win32' || state.applied) return;
    clearRetries();
    for (const ms of [250, 800, 2000]) {
      const t = setTimeout(() => {
        const w = getWin();
        if (!state.applied && w && !w.isDestroyed()) apply('retry-' + ms);
      }, ms);
      state.retryTimers.push(t);
    }
  }

  function loadIcon(dark, name) {
    const key = dark ? 'dark' : 'light';
    const filePath = path.join(baseDir, 'assets', 'thumbar', key, name + '.png');
    try {
      const img = nativeImage.createFromPath(filePath);
      if (img && !img.isEmpty()) return img;
    } catch {}
    try {
      const buf = fs.readFileSync(filePath);
      return nativeImage.createFromBuffer(buf);
    } catch (e) {
      logCrash('thumbar-icon ' + key + '/' + name, e);
      return nativeImage.createEmpty();
    }
  }

  function dispatchCmd(cmd, source) {
    const now = Date.now();
    if (cmd === state.lastCmd && (now - state.lastCmdAt) < 80) return;
    state.lastCmd = cmd;
    state.lastCmdAt = now;
    thumbarLog('cmd', { cmd, source, playing: state.playing, hasQueue: state.hasQueue });
    send('player:cmd', cmd);
  }

  function onPrev() { dispatchCmd('prev', 'click'); }
  function onToggle() { dispatchCmd('toggle', 'click'); }
  function onNext() { dispatchCmd('next', 'click'); }

  function mapButtonIndex(btnId) {
    if (btnId >= 40001 && btnId <= 40003) return btnId - 40001;
    if (btnId >= 10001 && btnId <= 10003) return btnId - 10001;
    if (btnId >= 0 && btnId <= 2) return btnId;
    return -1;
  }

  function hookMessages(targetWin) {
    if (process.platform !== 'win32' || !targetWin || targetWin.isDestroyed()) return;
    try {
      targetWin.hookWindowMessage(WM_COMMAND, (wParam) => {
        if (!wParam || wParam.length < 4) return;
        const wp = wParam.readUInt32LE(0);
        const notify = (wp >>> 16) & 0xffff;
        if (notify !== THBN_CLICKED) return;
        const btnId = wp & 0xffff;
        const idx = mapButtonIndex(btnId);
        thumbarLog('wm_command', { notify, btnId, idx });
        if (idx < 0 || idx >= THUMBAR_CMDS.length) return;
        const cmd = THUMBAR_CMDS[idx];
        setImmediate(() => dispatchCmd(cmd, 'wm_command'));
      });
    } catch (e) {
      logCrash('thumbar-hook', e);
    }
  }

  function detectDark() {
    state.dark = nativeTheme.shouldUseDarkColors;
    if (process.platform !== 'win32') return;
    try {
      execFile(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme'],
        { windowsHide: true, timeout: 1500 },
        (err, stdout) => {
          if (err || !stdout) return;
          const m = /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(stdout));
          if (!m) return;
          const isDark = parseInt(m[1], 16) === 0;
          if (isDark !== state.dark) {
            state.dark = isDark;
            apply('theme-reg');
          }
        }
      );
    } catch {}
  }

  function apply(reason = 'update') {
    if (process.platform !== 'win32') return false;
    const win = getWin();
    if (!win || win.isDestroyed()) return false;
    const prevIcon = loadIcon(state.dark, 'prev');
    const midIcon = loadIcon(state.dark, state.playing ? 'pause' : 'play');
    const nextIcon = loadIcon(state.dark, 'next');
    const buttons = [
      { tooltip: '上一首', icon: prevIcon, click: onPrev },
      { tooltip: state.playing ? '暂停' : '播放', icon: midIcon, click: onToggle },
      { tooltip: '下一首', icon: nextIcon, click: onNext }
    ];
    state.lastButtons = buttons;
    state.calls++;
    let ok = false;
    try {
      ok = !!win.setThumbarButtons(buttons);
    } catch (e) {
      logCrash('thumbar-set', e);
      ok = false;
    }
    state.applied = ok;
    if (ok) clearRetries();
    thumbarLog('apply', {
      reason,
      ok,
      dark: state.dark,
      playing: state.playing,
      hasQueue: state.hasQueue,
      title: state.title
    });
    try {
      const tip = state.title
        ? (state.artist ? `${state.title} - ${state.artist}` : state.title)
        : appName;
      win.setThumbnailToolTip(tip);
    } catch {}
    win.__thumbar = {
      applied: ok,
      calls: state.calls,
      dark: state.dark,
      playing: state.playing,
      hasQueue: state.hasQueue,
      title: state.title,
      artist: state.artist,
      buttons: buttons.map(b => ({
        tooltip: b.tooltip,
        flags: [...(b.flags || [])],
        iconEmpty: b.icon.isEmpty(),
        iconSize: b.icon.getSize(),
        click: b.click
      }))
    };
    return ok;
  }

  function setProgress(progress, mode = 'normal') {
    const win = getWin();
    if (!win || win.isDestroyed()) return false;
    const validMode = ['none', 'normal', 'indeterminate', 'error', 'paused'].includes(mode) ? mode : 'normal';
    const val = validMode === 'none' ? -1 : Math.max(0, Math.min(1, Number(progress) || 0));
    state.lastProg = val;
    state.lastProgMode = validMode;
    try {
      win.setProgressBar(val, { mode: validMode });
      win.__taskbarProgress = { progress: val, mode: validMode };
      return true;
    } catch {
      return false;
    }
  }

  function onWindowClosed() {
    clearRetries();
    state.applied = false;
    state.lastButtons = null;
  }

  function updatePlayState(st) {
    const nextPlaying = !!(st && st.playing);
    const nextHasQueue = !!(st && st.hasQueue);
    const nextTitle = (st && typeof st.title === 'string') ? st.title.trim() : '';
    const nextArtist = (st && typeof st.artist === 'string') ? st.artist.trim() : '';
    const changed = nextPlaying !== state.playing
      || nextHasQueue !== state.hasQueue
      || nextTitle !== state.title
      || nextArtist !== state.artist;
    state.playing = nextPlaying;
    state.hasQueue = nextHasQueue;
    state.title = nextTitle;
    state.artist = nextArtist;
    if (changed || !state.applied) apply('player:state');
    return changed;
  }

  return {
    state,
    apply,
    detectDark,
    hookMessages,
    scheduleRetry,
    clearRetries,
    setProgress,
    updatePlayState,
    onWindowClosed
  };
}

module.exports = { createThumbar };
