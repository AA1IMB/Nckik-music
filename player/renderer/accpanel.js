'use strict';
/* QQ 音乐 / 酷狗音乐 账号面板（渲染层）
 * -------------------------------------------------------------------------
 * 只负责画：二维码、状态行、账号列表，以及按主进程给的 retryAfterMs 定时轮询。
 * 所有相位判定、超时、过期、风控与错误码都在主进程的账号模块里（player/accounts），
 * 这里不再复制一份，避免两处文案与两种真相。
 */
(() => {
  const PROVIDERS = ['qq', 'qqapp', 'kugou'];
  const LABEL = { qq: 'QQ 音乐', qqapp: 'QQ 音乐 App', kugou: '酷狗音乐' };
  const HELP = {
    qq: '用手机 QQ 扫一扫（官方登录页的「扫码登录」页签），在手机上确认后即登录 QQ 音乐；二维码约 3 分钟有效，失效后点「重新获取」。',
    qqapp: '用手机 QQ 音乐 App 的「扫一扫」扫这个码，在手机上确认后即登录；二维码约 15 分钟有效，失效后点「重新获取」。',
    kugou: '用手机酷狗 App 扫一扫，在手机上确认后即登录；二维码约 3 分钟有效，失效后点「重新获取」。'
  };
  const PHASE = {
    idle: '未登录',
    starting: '正在打开登录页…',
    waiting: '请用手机 App 扫码',
    scanned: '已扫码，请在手机上确认',
    confirmed: '登录成功',
    expired: '二维码已失效',
    failed: '登录失败',
    cancelled: '已取消'
  };

  let provider = 'qq';
  let timer = 0;
  let polling = false;

  const $ = id => document.getElementById(id);
  const el = {
    seg: $('accSeg'),
    state: $('accAuthState'),
    qrBtn: $('btnAccQr'),
    cancelBtn: $('btnAccCancel'),
    retryBtn: $('btnAccRetry'),
    wrap: $('accQrWrap'),
    box: $('accQrBox'),
    shot: $('accQrShot'),
    mask: $('accQrMask'),
    qrState: $('accQrState'),
    help: $('accQrHelp'),
    list: $('accList'),
    up: $('accUp')
  };
  if (!el.seg || !window.api || !window.api.accBegin) return;

  /* ---------------- 绘制 ---------------- */

  function paintTabs() {
    for (const b of el.seg.querySelectorAll('b')) b.classList.toggle('on', b.dataset.p === provider);
  }

  function showQr(wrapOn) {
    el.wrap.classList.toggle('show', !!wrapOn);
  }

  function paintQr(snap) {
    if (snap.qr && snap.qr.image) {
      if (el.shot.dataset.src !== snap.qr.image) {
        el.shot.dataset.src = snap.qr.image;
        el.shot.innerHTML = '';
        const img = document.createElement('img');
        img.src = snap.qr.image;
        img.alt = '二维码';
        el.shot.append(img);
      }
      el.box.classList.remove('dead');
    }
    if (snap.phase === 'expired') {
      el.box.classList.add('dead');
      el.mask.textContent = '二维码已失效，点「重新获取」';
    } else if (snap.phase === 'failed') {
      el.box.classList.add('dead');
      el.mask.textContent = '获取失败';
    } else if (snap.phase === 'confirmed') {
      el.box.classList.add('dead');
      el.mask.textContent = '已登录';
    } else if (snap.phase !== 'cancelled' && snap.phase !== 'idle') {
      el.box.classList.remove('dead');
    }
    el.qrState.textContent = snap.message || PHASE[snap.phase] || '';
    el.help.textContent = hintOf(snap.error) || el.help.dataset.base || '';
  }

  function hintOf(err) {
    if (!err) return '';
    const parts = [];
    if (err.message) parts.push(err.message);
    if (err.hint) parts.push(err.hint);
    if (err.retryAfterMs) parts.push(Math.round(err.retryAfterMs / 1000) + ' 秒后可重试');
    return parts.join(' · ');
  }

  /* ---------------- 轮询 ---------------- */

  function stopTimer() {
    if (timer) clearTimeout(timer);
    timer = 0;
  }

  function schedule(ms) {
    stopTimer();
    timer = setTimeout(() => { void poll(); }, Math.max(300, ms || 2000));
  }

  async function handle(res, onOk) {
    if (!res) return;
    if (!res.ok) {
      el.qrState.textContent = (res.error && res.error.message) || '请求失败';
      el.help.textContent = hintOf(res.error);
      stopTimer();
      return;
    }
    onOk(res.data);
  }

  async function begin() {
    stopTimer();
    showQr(true);
    el.shot.dataset.src = '';
    el.shot.innerHTML = '';
    el.box.classList.remove('dead');
    el.mask.textContent = '';
    el.qrState.textContent = PHASE.starting;
    el.help.textContent = '';
    const res = await window.api.accBegin(provider);
    await handle(res, snap => {
      paintQr(snap);
      if (snap.phase === 'waiting' || snap.phase === 'starting') schedule(snap.retryAfterMs);
      else if (snap.phase === 'confirmed') void refreshList();
    });
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const res = await window.api.accPoll(provider);
      await handle(res, snap => {
        paintQr(snap);
        if (snap.phase === 'starting' || snap.phase === 'waiting' || snap.phase === 'scanned') {
          schedule(snap.retryAfterMs);
        } else {
          stopTimer();
          if (snap.phase === 'confirmed') void refreshList();
        }
      });
    } finally {
      polling = false;
    }
  }

  /* ---------------- 账号列表 ---------------- */

  async function refreshList() {
    const [st, ls] = await Promise.all([window.api.accStatus(provider), window.api.accList(provider)]);
    if (st && st.ok) {
      const acc = st.data.account;
      el.state.textContent = acc ? acc.name : '未登录';
      el.up.textContent = st.data.upstreamReady ? '已配置' : '未配置';
      el.up.classList.toggle('dim', !st.data.upstreamReady);
    }
    el.list.innerHTML = '';
    if (!ls || !ls.ok) {
      el.list.textContent = (ls && ls.error && ls.error.message) || '';
      return;
    }
    const currentId = st && st.ok && st.data.account ? st.data.account.id : '';
    if (!ls.data.length) {
      const empty = document.createElement('div');
      empty.className = 'acc-empty';
      empty.textContent = '这个平台还没有登录过账号。';
      el.list.append(empty);
      return;
    }
    for (const acc of ls.data) {
      const row = document.createElement('div');
      row.className = 'acc-row' + (acc.id === currentId ? ' on' : '');
      const av = document.createElement('div');
      av.className = 'acc-avatar';
      if (acc.avatarUrl) av.style.backgroundImage = 'url("' + acc.avatarUrl + '")';
      const meta = document.createElement('div');
      meta.className = 'acc-meta';
      const nm = document.createElement('div');
      nm.className = 'acc-name';
      nm.textContent = acc.name;
      const sub = document.createElement('div');
      sub.className = 'acc-sub';
      sub.textContent = 'uid ' + acc.userId;
      meta.append(nm, sub);
      const acts = document.createElement('div');
      acts.className = 'acc-rowacts';
      if (acc.id !== currentId) {
        const sw = document.createElement('button');
        sw.className = 'ghost mini';
        sw.textContent = '切换';
        sw.onclick = async () => {
          const r = await window.api.accSwitch(acc.id);
          if (!r || !r.ok) {
            el.help.textContent = hintOf(r && r.error);
            return;
          }
          await refreshList();
        };
        acts.append(sw);
      }
      const out = document.createElement('button');
      out.className = 'ghost mini';
      out.textContent = '退出';
      out.onclick = async () => {
        await window.api.accLogout(acc.id);
        await refreshList();
      };
      acts.append(out);
      row.append(av, meta, acts);
      el.list.append(row);
    }
  }

  /* ---------------- 事件 ---------------- */

  el.seg.addEventListener('click', e => {
    const b = e.target.closest('b[data-p]');
    if (!b || b.dataset.p === provider) return;
    provider = b.dataset.p;
    paintTabs();
    stopTimer();
    showQr(false);
    el.shot.dataset.src = '';
    el.shot.innerHTML = '';
    el.qrState.textContent = PHASE.idle;
    el.help.dataset.base = HELP[provider] || '';
    el.help.textContent = el.help.dataset.base;
    void refreshList();
  });

  el.qrBtn.addEventListener('click', () => { void begin(); });
  el.retryBtn.addEventListener('click', () => { void begin(); });
  el.cancelBtn.addEventListener('click', async () => {
    stopTimer();
    await window.api.accCancel(provider);
    showQr(false);
    el.qrState.textContent = '已取消';
  });

  if (window.api.onAccEvent) {
    window.api.onAccEvent(e => {
      if (!e || e.provider !== provider) return;
      if (e.type === 'login' || e.type === 'switch' || e.type === 'logout') void refreshList();
    });
  }

  el.help.dataset.base = HELP[provider] || el.help.textContent;
  el.help.textContent = el.help.dataset.base;
  paintTabs();
  showQr(false);
  void refreshList();
  PROVIDERS.forEach(p => { if (!LABEL[p]) console.warn('unknown provider', p); });
})();
