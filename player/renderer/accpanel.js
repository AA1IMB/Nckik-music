/* 播放账号面板：QQ 音乐（App 扫码）与酷狗音乐各一张卡，互不干扰。
 * - 每张卡自己维护轮询（retryAfterMs 驱动），切平台不再清掉另一张卡的码；
 * - 账号切换/登录/退出后，主进程会推一版带 revision 的 acc:event，
 *   这里据此作废该平台的收藏/歌单缓存（window.__accOnAccountChange）并重画账号列表。 */
(function () {
  'use strict';

  const CARDS = [
    {
      id: 'qqapp',
      title: 'QQ 音乐',
      help: '手机打开 QQ 音乐 → 我的 → 右上角「扫一扫」，确认后即登录。二维码约 15 分钟有效。'
    },
    {
      id: 'kugou',
      title: '酷狗音乐',
      help: '手机打开酷狗音乐 → 我的 → 扫一扫，确认后即登录。二维码约 3 分钟有效。'
    }
  ];

  const PHASE_TEXT = {
    waiting: '正在等待手机扫码',
    scanned: '已扫码，请在手机上确认',
    confirmed: '登录成功',
    expired: '二维码已失效',
    failed: '获取失败'
  };

  const $ = (sel, root) => (root || document).querySelector(sel);

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function makeCard(def) {
    const card = h('div', 'acccard');
    card.dataset.p = def.id;

    const head = h('div', 'line');
    const k = h('div', 'k', '登录状态');
    k.appendChild(h('small', null, '手机 App 扫码；凭据用系统密钥库加密，只存在本机'));
    const state = h('div', 'v accstate', '未登录');
    head.append(k, state);

    const acts = h('div', 'line col');
    const row = h('div', 'authrow');
    const btnQr = h('button', 'ghost', '扫码登录');
    const btnCancel = h('button', 'ghost mini', '取消');
    row.append(btnQr, btnCancel);
    acts.appendChild(row);

    /* 合规上游：留空就走本地免费链路；填了就走你自己的网关（VIP 由网关身份决定） */
    let upRow = null;
    if (def.id === 'kugou') {
      upRow = h('div', 'line col uprow');
      const lab = h('div', 'k', '上游网关');
      lab.appendChild(h('small', null, '可选：填自建/本地的酷狗 API 地址（如 http://127.0.0.1:3000）；留空则只放免费曲'));
      const ibox = h('div', 'authrow');
      const inp = h('input', 'upinput');
      inp.type = 'text';
      inp.placeholder = 'http://127.0.0.1:3000';
      const save = h('button', 'ghost mini', '保存');
      save.onclick = async () => {
        try {
          const st = (await window.api.getSettings()) || {};
          st.upstream = Object.assign({}, st.upstream || {}, { kugou: String(inp.value || '').trim() });
          await window.api.setSettings(st);
          window.__accToast && window.__accToast('已保存酷狗上游地址');
        } catch (e) {
          window.__accToast && window.__accToast('保存失败：' + (e && e.message ? e.message : e));
        }
      };
      ibox.append(inp, save);
      upRow.append(lab, ibox);
      /* 打开面板时把已保存的值回填 */
      (async () => {
        try {
          const st = (await window.api.getSettings()) || {};
          inp.value = (st.upstream && st.upstream.kugou) || '';
        } catch { /* 读不到就留空 */ }
      })();
    }

    const wrap = h('div', 'qrwrap');
    const box = h('div', 'qrbox');
    const img = h('div', 'qrimg');
    const mask = h('div', 'qrmask');
    box.append(img, mask);
    const qrState = h('div', 'qrstate', '正在获取二维码…');
    const help = h('div', 'qrhelp', def.help);
    const qrActs = h('div', 'qracts');
    const btnRetry = h('button', 'ghost', '重新获取');
    qrActs.appendChild(btnRetry);
    wrap.append(box, qrState, help, qrActs);

    const listLine = h('div', 'line col');
    const list = h('div', 'acc-list');
    listLine.appendChild(list);

    const upLine = h('div', 'line');
    const upK = h('div', 'k', '取流');
    upK.appendChild(h('small', null, '需要配置合规上游网关；未配置时只做登录与账号管理'));
    const upV = h('div', 'v dim', '未配置');
    upLine.append(upK, upV);

    const title = h('div', 'acctitle');
    title.append(h('span', 'acctitle-name', def.title),
      h('span', 'acctitle-tag', def.id === 'kugou' ? '即将上线' : '官方 App 扫码'));

    /* 酷狗暂时整体关掉登录入口：面板只留一句「敬请期待」。
     * 已登录的凭据仍在本地（不清除），只是不再从界面发起新的登录。 */
    if (def.id === 'kugou') {
      const coming = h('div', 'acc-coming');
      coming.append(
        h('div', 'acc-coming-t', '敬请期待'),
        h('small', null, '酷狗音乐登录正在适配中，暂时不开放扫码与 Cookie 导入；曲库里的免费曲仍可正常试听。')
      );
      card.append(title, coming);
      return {
        def: Object.assign({}, def, { disabled: true }),
        card,
        state,
        btnQr,
        btnCancel,
        box,
        img,
        mask,
        qrState,
        qrHelp: help,
        btnRetry,
        list,
        upV,
        accounts: [],
        timer: null,
        snapshot: null,
        shownSrc: ''
      };
    }

    const kids = [title, head, acts, wrap];
    if (upRow) kids.push(upRow);
    kids.push(listLine, upLine);
    card.append(...kids);

    return {
      def,
      card,
      state,
      btnQr,
      btnCancel,
      box,
      img,
      mask,
      qrState,
      wrap,
      btnRetry,
      list,
      upV,
      timer: 0,
      shownSrc: '',
      snapshot: null,
      accounts: []
    };
  }

  function api() {
    return window.api || {};
  }

  function createPanel(mount) {
    const cards = CARDS.map(def => {
      const c = makeCard(def);
      mount.appendChild(c.card);
      bind(c);
      return c;
    });

    function bind(c) {
      c.btnQr.addEventListener('click', () => start(c));
      c.btnRetry.addEventListener('click', () => start(c));
      c.btnCancel.addEventListener('click', () => cancel(c));
    }

    /* ---------------- 交互 ---------------- */

    async function start(c) {
      const fn = api().accBegin;
      if (!fn) return;
      stopTimer(c);
      c.qrState.textContent = '正在打开登录页…';
      c.box.classList.remove('dead', 'ok');
      c.mask.textContent = '';
      c.wrap.classList.add('show');
      const res = await fn(c.def.id);
      if (!res || !res.ok) {
        fail(c, res && res.error);
        return;
      }
      handle(c, { phase: res.data.phase, qr: res.data.qr, message: res.data.message, retryAfterMs: 200 });
    }

    async function cancel(c) {
      stopTimer(c);
      const fn = api().accCancel;
      if (fn) await fn(c.def.id).catch(() => null);
      c.img.textContent = '';
      c.shownSrc = '';
      c.box.classList.remove('dead', 'ok', 'show');
      c.qrState.textContent = '已取消';
      c.mask.textContent = '';
    }

    function stopTimer(c) {
      if (c.timer) clearTimeout(c.timer);
      c.timer = 0;
    }

    function schedule(c, ms) {
      stopTimer(c);
      c.timer = setTimeout(() => poll(c), Math.max(300, Math.min(ms || 2000, 8000)));
    }

    async function poll(c) {
      const fn = api().accPoll;
      if (!fn) return;
      const res = await fn(c.def.id);
      if (!res || !res.ok) {
        fail(c, res && res.error);
        return;
      }
      handle(c, res.data);
    }

    /* ---------------- 渲染 ---------------- */

    function handle(c, snap) {
      c.snapshot = snap;
      const phase = snap.phase;
      const qr = snap.qr;

      const src = qr && (qr.image || qr.src);
      if (src && src !== c.shownSrc) {
        c.shownSrc = src;
        c.img.replaceChildren(makeImg(src));
        c.wrap.classList.add('show');
      }

      c.box.classList.toggle('dead', phase === 'expired' || phase === 'failed');
      c.box.classList.toggle('ok', phase === 'confirmed');
      c.mask.textContent =
        phase === 'expired' ? '已失效' :
        phase === 'failed' ? '获取失败' :
        phase === 'confirmed' ? '已登录' : '';

      const text = snap.message || PHASE_TEXT[phase] || '';
      c.qrState.textContent = text;
      c.qrState.classList.toggle('bad', phase === 'failed' || phase === 'expired');

      if (phase === 'confirmed') {
        stopTimer(c);
        api().accStatus(c.def.id).then(r => {
          if (r && r.ok) paintState(c, r.data);
        });
        refreshAccounts(c);
        return;
      }
      if (phase === 'expired' || phase === 'failed') {
        stopTimer(c);
        c.btnRetry.disabled = false;
        return;
      }
      schedule(c, snap.retryAfterMs || 2000);
    }

    function makeImg(src) {
      const el = document.createElement('img');
      el.alt = '登录二维码';
      el.src = src;
      el.addEventListener('load', () => el.classList.add('in'), { once: true });
      return el;
    }

    function fail(c, error) {
      stopTimer(c);
      c.box.classList.add('dead');
      c.mask.textContent = '获取失败';
      c.qrState.textContent = (error && error.message) || '获取二维码失败，请稍后再试。';
      c.qrState.classList.add('bad');
    }

    function paintState(c, status) {
      const acc = (status && status.account) || null;
      c.state.textContent = acc ? acc.name : '未登录';
      c.state.classList.toggle('off', !acc);
      if (acc && c.def.id === 'kugou' && api().accVip) {
        api().accVip().then(v => {
          if (!v || !v.ok) return;
          /* vip 三态：true 明确有权益 / false 服务端明确不给（附 code）/ null 判断不了。
           * 以前把「免费取流失败」当成「免费账号」，等于替用户下了错误结论。 */
          if (v.vip === true) c.state.textContent = acc.name + ' · 会员';
          else if (v.vip === false) {
            c.state.textContent = acc.name + ' · 会员曲未授权';
            c.state.title = '服务端返回 ' + (v.code || v.reason || 'E_NO_VIP_PRIVILEGE')
              + (v.privStatus === 0 ? '（priv_status 0）' : '') + '：当前会话没有会员播放权益';
          }
        }).catch(() => {});
      }
      c.upV.textContent = status && status.upstreamReady ? '已配置' : '未配置';
      c.upV.classList.toggle('dim', !(status && status.upstreamReady));
    }

    async function refreshAccounts(c) {
      if (c.def && c.def.disabled) return;
      const [st, list] = await Promise.all([
        api().accStatus ? api().accStatus(c.def.id) : null,
        api().accList ? api().accList(c.def.id) : null
      ]);
      if (st && st.ok) paintState(c, st.data);
      const accounts = (list && list.ok && list.data) || [];
      c.accounts = accounts;
      paintList(c, accounts);
    }

    function paintList(c, accounts) {
      c.list.replaceChildren();
      if (!accounts.length) {
        c.list.appendChild(h('div', 'acc-empty', '这个平台还没有登录过账号。'));
        return;
      }
      for (const acc of accounts) {
        const row = h('div', 'acc-row' + (acc.current ? ' on' : ''));
        const av = h('div', 'acc-avatar');
        if (acc.avatarUrl) {
          const im = document.createElement('img');
          im.src = acc.avatarUrl;
          im.alt = '';
          av.appendChild(im);
        }
        const meta = h('div', 'acc-meta');
        meta.append(h('div', 'acc-name', acc.name || acc.userId || '未知账号'), h('div', 'acc-sub', acc.current ? '当前账号' : (acc.userId || '')));
        const acts = h('div', 'acc-rowacts');
        if (!acc.current) {
          const sw = h('button', 'ghost mini', '切换');
          sw.addEventListener('click', () => switchTo(c, acc));
          acts.appendChild(sw);
        }
        const out = h('button', 'ghost mini', '退出');
        out.addEventListener('click', () => logout(c, acc));
        acts.appendChild(out);
        row.append(av, meta, acts);
        c.list.appendChild(row);
      }
    }

    async function switchTo(c, acc) {
      const fn = api().accSwitch;
      if (!fn) return;
      const res = await fn(acc.id);
      if (!res || !res.ok) {
        toast((res && res.error && res.error.message) || '切换失败，请重试。');
        return;
      }
      toast('已切换到 ' + (res.data.name || acc.name || '该账号') + '，正在刷新数据…');
      await refreshAccounts(c);
    }

    async function logout(c, acc) {
      const fn = api().accLogout;
      if (!fn) return;
      await fn(acc.id).catch(() => null);
      await refreshAccounts(c);
    }

    function toast(msg) {
      if (typeof window.__accToast === 'function') window.__accToast(msg);
      else if (typeof window.toast === 'function') window.toast(msg);
    }

    /* ---------------- 对外 ---------------- */

    async function refreshAll() {
      await Promise.all(cards.map(c => refreshAccounts(c)));
    }

    let lastRevision = {};

    function onEvent(ev) {
      if (!ev || !ev.provider) return;
      const c = cards.find(x => x.def.id === ev.provider);
      if (!c) return;

      // 数据版本变了 → 该平台的收藏/歌单缓存作废，让上层重新拉取
      if (ev.revision && lastRevision[ev.provider] !== ev.revision) {
        lastRevision[ev.provider] = ev.revision;
        if (typeof window.__accOnAccountChange === 'function') {
          try { window.__accOnAccountChange(ev.provider, ev.revision); } catch (_) {}
        }
      }
      if (ev.type === 'switch' || ev.type === 'login' || ev.type === 'logout') refreshAccounts(c);
      if (ev.library) {
        if (ev.library.message) toast(ev.library.message);
        if (typeof window.__accOnLibraryRefresh === 'function') {
          try { window.__accOnLibraryRefresh(ev.provider, ev.library); } catch (_) {}
        }
      }
    }

    if (api().onAccEvent) api().onAccEvent(onEvent);

    return { refreshAll, cards };
  }

  let panel = null;

  window.AccountPanel = {
    mount(root) {
      if (panel) {
        panel.refreshAll();
        return panel;
      }
      if (!root) return null;
      panel = createPanel(root);
      panel.refreshAll();
      return panel;
    }
  };
})();
