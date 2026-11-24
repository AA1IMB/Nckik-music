'use strict';
/**
 * P2 形态扩展与桌面生态模块（渲染层）
 * - 紧凑迷你模式（Mini Player）
 * - 桌面悬浮歌词联动（逐字进度推送 + 穿透锁定）
 * - 任务栏播放进度条（低频节流同步）
 * - 睡眠定时（定时停播 / 播完当前曲停止）
 * - 省电 / 低动效模式、关闭到托盘选项、Windows 提权提醒
 */
(function initP2Module() {
  const P2 = {
    mini: false,
    dlyrOpen: false,
    dlyrLocked: false,
    sleepMode: 'off',       // 'off' | 'track' | 'minutes'
    sleepEndAt: 0,
    sleepTimer: 0,
    lastTbAt: 0,
    lastTbMode: '',
    lastDlyrAt: 0,
    lastDlyrKey: ''
  };

  function el(s) { return document.querySelector(s); }

  /* ---------------- 省电 / 低动效模式 ---------------- */
  function applyLowMotion() {
    const on = !!(S.settings && S.settings.lowMotion);
    document.body.classList.toggle('low-motion', on);
    const sw = el('#swLowMotion');
    if (sw) sw.classList.toggle('on', on);
  }

  /* ---------------- 关闭行为（退出 / 最小化到托盘） ---------------- */
  function syncCloseActionUI() {
    const act = (S.settings && S.settings.closeAction === 'tray') ? 'tray' : 'exit';
    document.querySelectorAll('#segClose b').forEach(b => b.classList.toggle('on', b.dataset.c === act));
  }

  /* ---------------- 任务栏播放进度条 ---------------- */
  function syncTaskbarProgress(t, force = false) {
    if (!window.api || !window.api.setTaskbarProgress) return;
    const enabled = !S.settings || S.settings.taskbarProgress !== false;
    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const hasTrack = !!curTrack() && dur > 0;
    if (!enabled || !hasTrack) {
      if (P2.lastTbMode !== 'none' || force) {
        P2.lastTbMode = 'none';
        window.api.setTaskbarProgress({ progress: -1, mode: 'none' });
      }
      return;
    }
    const mode = S.playing ? 'normal' : 'paused';
    const now = Date.now();
    if (!force && mode === P2.lastTbMode && (now - P2.lastTbAt) < 1200) return;
    P2.lastTbAt = now;
    P2.lastTbMode = mode;
    const cur = t != null ? Number(t) : (audio.currentTime || 0);
    window.api.setTaskbarProgress({ progress: clamp(cur / dur, 0, 1), mode });
  }

  /* ---------------- 紧凑迷你模式 ---------------- */
  function applyMiniState(on) {
    P2.mini = !!on;
    document.body.classList.toggle('mini', P2.mini);
    const btn = el('#btnMini');
    if (btn) btn.title = P2.mini ? '还原主窗口 (M)' : '迷你模式 (M)';
    if (P2.mini) {
      closeDrawers();
      closePops();
      syncMiniUI();
    } else {
      measureScrub();
      if (S.lastLy >= 0) setTimeout(() => centerLine(S.lastLy), 60);
    }
  }

  async function setMini(on) {
    if (!window.api || !window.api.winMini) return false;
    try {
      const state = await window.api.winMini(!!on);
      applyMiniState(state);
      return state;
    } catch { return P2.mini; }
  }

  function toggleMini() { return setMini(!P2.mini); }

  function syncMiniUI(curLineText) {
    const k = curTrack();
    const tEl = el('#miniT');
    const sEl = el('#miniS');
    const cov = el('#miniCov');
    const img = el('#miniImg');
    const ph = el('#miniPh');
    if (tEl) tEl.textContent = k ? (k.title || '未知曲目') : '未载入';
    if (sEl) {
      const sub = curLineText || (k ? ([k.artist, k.album].filter(Boolean).join(' · ') || '未知艺人') : 'Nckik′s music');
      if (sEl.textContent !== sub) sEl.textContent = sub;
    }
    if (cov && img) {
      const art = k ? getCover(k.path) : '';
      if (art) {
        if (img.src !== art) img.src = art;
        cov.classList.add('art');
      } else {
        cov.classList.remove('art');
        img.removeAttribute('src');
        if (ph) ph.textContent = k ? ((k.title || '♪').slice(0, 1)) : '♪';
      }
    }
    const pIc = el('#miniIcPlay'), psIc = el('#miniIcPause');
    if (pIc) pIc.style.display = S.playing ? 'none' : 'block';
    if (psIc) psIc.style.display = S.playing ? 'block' : 'none';
  }

  /* ---------------- 桌面悬浮歌词 ---------------- */
  function syncDlyrControls() {
    const sw = el('#swDlyr');
    const swLock = el('#swDlyrLock');
    if (sw) sw.classList.toggle('on', P2.dlyrOpen);
    if (swLock) swLock.classList.toggle('on', P2.dlyrLocked);
  }

  async function toggleDlyr(want) {
    if (!window.api || !window.api.dlyrOpen) return null;
    const opts = {
      locked: !!(S.settings && S.settings.dlyrLocked),
      bounds: (S.settings && S.settings.dlyrBounds) || null
    };
    const r = typeof want === 'boolean'
      ? (want ? await window.api.dlyrOpen(opts) : await window.api.dlyrClose())
      : await window.api.dlyrToggle(opts);
    if (r && r.ok) {
      P2.dlyrOpen = !!r.open;
      P2.dlyrLocked = !!r.locked;
      syncDlyrControls();
      if (P2.dlyrOpen) pushDlyr(audio.currentTime || 0, true);
    }
    return r;
  }

  async function setDlyrLock(on) {
    const locked = !!on;
    P2.dlyrLocked = locked;
    if (S.settings) {
      S.settings.dlyrLocked = locked;
      saveSettings();
    }
    if (window.api && window.api.dlyrLock) {
      try { await window.api.dlyrLock(locked); } catch {}
    }
    syncDlyrControls();
  }

  function calcLineSnapshot(t) {
    const k = curTrack();
    const title = k ? (k.title || '未知曲目') : 'Nckik′s music';
    const artist = k ? (k.artist || '') : '';
    if (!S.lyrics.length) {
      return { text: title, tr: artist, progress: 0 };
    }
    const idx = S.lastLy >= 0 ? S.lastLy : 0;
    const line = S.lyrics[idx];
    if (!line) return { text: title, tr: artist, progress: 0 };
    const tr = (S.settings && S.settings.lyricTrans === false) ? '' : String(line.tr || '').trim();
    const chars = line.chars;
    let pct = 0;
    if (chars && chars.length) {
      const lt = (t != null ? Number(t) : (audio.currentTime || 0)) + curLyricOffset();
      const firstT = chars[0].t0;
      const lastT = chars[chars.length - 1].t1;
      if (lt >= lastT) pct = 100;
      else if (lt > firstT) {
        let done = 0;
        for (let j = 0; j < chars.length; j++) {
          if (lt >= chars[j].t1) done = j + 1;
          else if (lt >= chars[j].t0) {
            const sp = chars[j].t1 - chars[j].t0;
            done = j + (sp > 0 ? clamp((lt - chars[j].t0) / sp, 0, 1) : 1);
            break;
          } else break;
        }
        pct = clamp((done / chars.length) * 100, 0, 100);
      }
    }
    return { text: line.text || title, tr, progress: pct };
  }

  function pushDlyr(t, force = false) {
    if (!P2.dlyrOpen || !window.api || !window.api.dlyrPush) return;
    const now = Date.now();
    const snap = calcLineSnapshot(t);
    const k = curTrack();
    const accent = getComputedStyle(document.body).getPropertyValue('--acInk').trim() || S.accent || '#8ab4ff';
    const key = `${snap.text}|${snap.tr}|${Math.round(snap.progress)}|${S.playing ? 1 : 0}|${accent}`;
    if (!force && key === P2.lastDlyrKey) return;
    if (!force && (now - P2.lastDlyrAt) < 70) return;
    P2.lastDlyrAt = now;
    P2.lastDlyrKey = key;
    window.api.dlyrPush({
      text: snap.text,
      tr: snap.tr,
      progress: snap.progress,
      title: k ? (k.title || '') : '',
      artist: k ? (k.artist || '') : '',
      playing: !!S.playing,
      accent,
      locked: P2.dlyrLocked
    });
  }

  /* ---------------- 睡眠定时 ---------------- */
  function fmtRemain(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function syncSleepUI() {
    const setVal = el('#setSleep');
    let label = '已关闭';
    let activeKey = 'off';
    if (P2.sleepMode === 'track') {
      label = '播完当前曲停止';
      activeKey = 'track';
    } else if (P2.sleepMode === 'minutes' && P2.sleepEndAt > Date.now()) {
      label = '剩余 ' + fmtRemain(P2.sleepEndAt - Date.now());
      activeKey = String(P2.sleepMins || '');
    }
    if (setVal) setVal.textContent = label;
    document.querySelectorAll('#sleepChips .sleep-chip').forEach(b => {
      b.classList.toggle('on', b.dataset.sleep === activeKey);
    });
  }

  function clearSleepTimer() {
    clearInterval(P2.sleepTimer);
    P2.sleepTimer = 0;
    P2.sleepMode = 'off';
    P2.sleepEndAt = 0;
    P2.sleepMins = 0;
    syncSleepUI();
  }

  function triggerSleepStop(msg) {
    clearSleepTimer();
    if (!audio.paused) {
      const targetVol = clamp(Number(S.settings.volume), 0, 1);
      if (audio.muted || document.hidden || targetVol <= 0.001) {
        audio.pause();
      } else {
        S.playing = false;
        syncPlayIcon();
        fadeAudioTo(0, 500, () => {
          audio.pause();
          audio.volume = targetVol;
        });
      }
    }
    toast(msg || '睡眠定时已到，已暂停播放', 3200);
  }

  function setSleep(val) {
    clearInterval(P2.sleepTimer);
    P2.sleepTimer = 0;
    if (!val || val === 'off') {
      clearSleepTimer();
      toast('已关闭睡眠定时');
      return;
    }
    if (val === 'track') {
      P2.sleepMode = 'track';
      P2.sleepEndAt = 0;
      P2.sleepMins = 0;
      syncSleepUI();
      toast('将在当前曲目播完后停止播放');
      return;
    }
    const mins = Number(val);
    if (!Number.isFinite(mins) || mins <= 0) return;
    P2.sleepMode = 'minutes';
    P2.sleepMins = mins;
    P2.sleepEndAt = Date.now() + mins * 60 * 1000;
    syncSleepUI();
    toast(`睡眠定时：${mins} 分钟后停止播放`);
    P2.sleepTimer = setInterval(() => {
      if (P2.sleepMode !== 'minutes') { clearInterval(P2.sleepTimer); P2.sleepTimer = 0; return; }
      if (Date.now() >= P2.sleepEndAt) {
        triggerSleepStop('睡眠定时已到，已暂停播放');
        return;
      }
      syncSleepUI();
    }, 1000);
  }

  /* ---------------- 生命周期与事件接线 ---------------- */
  function onFrame(t) {
    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    if (P2.mini) {
      const mf = el('#miniFill');
      if (mf) mf.style.transform = 'scaleX(' + (dur ? clamp((t || 0) / dur, 0, 1).toFixed(4) : '0') + ')';
      const snap = S.lyrics.length ? calcLineSnapshot(t) : null;
      syncMiniUI(snap && snap.text ? snap.text : '');
    }
    if (P2.dlyrOpen) pushDlyr(t, false);
    syncTaskbarProgress(t, false);
  }

  function onTrackEnded() {
    if (P2.sleepMode === 'track') {
      clearSleepTimer();
      if (!audio.paused) { try { audio.pause(); } catch {} }
      S.playing = false;
      syncPlayIcon();
      stopFrame();
      renderFrameOnce();
      persistPos(true);
      toast('当前曲目已播完，睡眠定时已停止播放', 3200);
      return true;
    }
    return false;
  }

  function onWinState(s) {
    if (s && typeof s.mini === 'boolean') applyMiniState(s.mini);
  }

  function bindUI() {
    const btnMini = el('#btnMini');
    if (btnMini) btnMini.onclick = () => toggleMini();
    const miniCov = el('#miniCov');
    if (miniCov) miniCov.onclick = () => setMini(false);
    const miniExp = el('#miniExpand');
    if (miniExp) miniExp.onclick = () => setMini(false);
    const miniCls = el('#miniClose');
    if (miniCls) miniCls.onclick = () => window.api.winClose();
    const miniPrev = el('#miniPrev');
    if (miniPrev) miniPrev.onclick = () => prev();
    const miniPlay = el('#miniPlay');
    if (miniPlay) miniPlay.onclick = () => togglePlay();
    const miniNext = el('#miniNext');
    if (miniNext) miniNext.onclick = () => next();

    const swDlyr = el('#swDlyr');
    if (swDlyr) swDlyr.onclick = () => toggleDlyr(!P2.dlyrOpen);
    const swDlyrLock = el('#swDlyrLock');
    if (swDlyrLock) swDlyrLock.onclick = () => setDlyrLock(!P2.dlyrLocked);

    const sleepChips = el('#sleepChips');
    if (sleepChips) {
      sleepChips.onclick = (e) => {
        const b = e.target.closest('.sleep-chip');
        if (!b) return;
        setSleep(b.dataset.sleep);
      };
    }

    const swLow = el('#swLowMotion');
    if (swLow) {
      swLow.onclick = () => {
        S.settings.lowMotion = !S.settings.lowMotion;
        applyLowMotion();
        saveSettings();
      };
    }

    const swTb = el('#swTaskbarProg');
    if (swTb) {
      swTb.onclick = () => {
        S.settings.taskbarProgress = !(S.settings.taskbarProgress !== false);
        swTb.classList.toggle('on', S.settings.taskbarProgress);
        saveSettings();
        syncTaskbarProgress(audio.currentTime || 0, true);
      };
    }

    document.querySelectorAll('#segClose b').forEach(b => {
      b.onclick = () => {
        const v = b.dataset.c === 'tray' ? 'tray' : 'exit';
        S.settings.closeAction = v;
        syncCloseActionUI();
        // 关闭行为须立即通知主进程，避免用户切完立刻点 × 落在 200ms 防抖窗口内
        if (window.api && window.api.setSettings) window.api.setSettings(S.settings).catch(() => {});
        else saveSettings();
        toast(v === 'tray' ? '点击关闭按钮将最小化到系统托盘' : '点击关闭按钮将直接退出播放器');
      };
    });

    if (window.api && window.api.onDlyrState) {
      window.api.onDlyrState(st => {
        if (!st || typeof st !== 'object') return;
        P2.dlyrOpen = !!st.open;
        if (typeof st.locked === 'boolean') P2.dlyrLocked = st.locked;
        if (st.bounds && S.settings) {
          S.settings.dlyrBounds = st.bounds;
          saveSettings();
        }
        syncDlyrControls();
        if (P2.dlyrOpen) pushDlyr(audio.currentTime || 0, true);
      });
    }
  }

  let initialized = false;
  function init() {
    if (initialized || !S.settings) return;
    initialized = true;
    if (S.settings.closeAction !== 'tray' && S.settings.closeAction !== 'exit') S.settings.closeAction = 'exit';
    if (typeof S.settings.taskbarProgress !== 'boolean') S.settings.taskbarProgress = true;
    if (typeof S.settings.lowMotion !== 'boolean') S.settings.lowMotion = false;
    if (typeof S.settings.dlyrLocked !== 'boolean') S.settings.dlyrLocked = false;
    P2.dlyrLocked = S.settings.dlyrLocked;

    applyLowMotion();
    syncCloseActionUI();
    const swTb = el('#swTaskbarProg');
    if (swTb) swTb.classList.toggle('on', S.settings.taskbarProgress !== false);
    syncDlyrControls();
    syncSleepUI();
    bindUI();

    if (window.api && window.api.isMini) {
      window.api.isMini().then(m => applyMiniState(m)).catch(() => {});
    }
    if (window.api && window.api.dlyrGet) {
      window.api.dlyrGet().then(st => {
        if (st) {
          P2.dlyrOpen = !!st.open;
          P2.dlyrLocked = typeof st.locked === 'boolean' ? st.locked : P2.dlyrLocked;
          syncDlyrControls();
        }
      }).catch(() => {});
    }
    if (window.api && window.api.sysElevation) {
      window.api.sysElevation().then(r => {
        const row = el('#elevRow');
        if (row && r && r.elevated) row.hidden = false;
      }).catch(() => {});
    }
  }

  window.P2 = {
    state: P2,
    init,
    onFrame,
    onTrackEnded,
    onWinState,
    syncMeta: () => {
      if (P2.mini) syncMiniUI();
      if (P2.dlyrOpen) pushDlyr(audio.currentTime || 0, true);
    },
    syncPlay: () => {
      if (P2.mini) syncMiniUI();
      if (P2.dlyrOpen) pushDlyr(audio.currentTime || 0, true);
      syncTaskbarProgress(audio.currentTime || 0, true);
    },
    setMini,
    toggleMini,
    toggleDlyr,
    setDlyrLock,
    setSleep,
    clearSleepTimer,
    applyLowMotion,
    syncTaskbarProgress
  };

  // 若 app.js 的异步初始化在 p2.js 加载前已拿到 S.settings，则立刻自启动
  if (typeof S !== 'undefined' && S.settings) init();
})();
