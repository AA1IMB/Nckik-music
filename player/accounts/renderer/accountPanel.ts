import type { Account, AccountErrorPayload, LoginSnapshot, ProviderId, QualityId } from '../src/types';
import { PROVIDER_LABEL, QUALITY_LABEL } from '../src/types';
import type { IpcResult, AccountStatusPayload, AccEvent } from '../src/ipcContract';

/**
 * 账号面板（渲染层）
 * ---------------------------------------------------------------------------
 * 只做三件事：画二维码 + 按主进程给的 retryAfterMs 定时轮询 + 列账号/切换/退出。
 * 判定逻辑一律不在这里复制：相位、超时、过期都由主进程状态机给出。
 * 用原生 DOM 实现，不引框架，方便直接挂进现有 `#dSet` 抽屉。
 */

export interface AccountPanelApi {
  begin(provider: ProviderId): Promise<IpcResult<LoginSnapshot>>;
  poll(provider: ProviderId): Promise<IpcResult<LoginSnapshot>>;
  refresh(provider: ProviderId): Promise<IpcResult<LoginSnapshot>>;
  cancel(provider: ProviderId): Promise<IpcResult<unknown>>;
  status(provider: ProviderId): Promise<IpcResult<AccountStatusPayload>>;
  list(provider?: ProviderId): Promise<IpcResult<Account[]>>;
  switchTo(id: string): Promise<IpcResult<Account>>;
  logout(id?: string, provider?: ProviderId): Promise<IpcResult<unknown>>;
  onEvent(cb: (e: AccEvent) => void): () => void;
}

export interface MountOptions {
  root: HTMLElement;
  api: AccountPanelApi;
  /** 默认 qq；设置页里跟着当前音源走 */
  initial?: ProviderId;
  quality?: QualityId;
}

export interface AccountPanel {
  open(provider?: ProviderId): void;
  close(): void;
  destroy(): void;
}

const PHASE_TEXT: Record<string, string> = {
  idle: '未登录',
  starting: '正在打开登录页…',
  waiting: '请用手机 App 扫码',
  scanned: '已扫码，请在手机上确认',
  confirmed: '登录成功',
  expired: '二维码已失效',
  failed: '登录失败',
  cancelled: '已取消'
};

export function mountAccountPanel(opts: MountOptions): AccountPanel {
  const { root, api } = opts;
  let provider: ProviderId = opts.initial ?? 'qq';
  let timer: number | undefined;
  let offEvent: (() => void) | undefined;

  root.innerHTML = '';
  root.classList.add('accpanel');

  const tabs = el('div', 'acc-tabs');
  const qrWrap = el('div', 'acc-qrwrap');
  const qrImg = el('img', 'acc-qr') as HTMLImageElement;
  const qrMask = el('div', 'acc-qrmask');
  const stateText = el('div', 'acc-state');
  const hintText = el('div', 'acc-hint');
  const acts = el('div', 'acc-acts');
  const btnRefresh = button('重新获取');
  const btnCancel = button('取消');
  const listBox = el('div', 'acc-list');
  acts.append(btnRefresh, btnCancel);
  qrWrap.append(qrImg, qrMask);
  root.append(tabs, qrWrap, stateText, hintText, acts, listBox);

  const tabEls = new Map<ProviderId, HTMLElement>();
  (Object.keys(PROVIDER_LABEL) as ProviderId[]).forEach(id => {
    const t = button(PROVIDER_LABEL[id]);
    t.dataset.provider = id;
    t.onclick = () => {
      void open(id);
    };
    tabEls.set(id, t);
    tabs.append(t);
  });

  btnRefresh.onclick = () => {
    void run(() => api.refresh(provider));
  };
  btnCancel.onclick = () => {
    stopTimer();
    void api.cancel(provider);
    paintIdle();
  };

  function paintTabs() {
    for (const [id, t] of tabEls) t.classList.toggle('on', id === provider);
  }

  function paintIdle() {
    qrImg.removeAttribute('src');
    qrMask.textContent = '未登录';
    qrMask.classList.add('show');
    stateText.textContent = PHASE_TEXT.idle;
    hintText.textContent = '';
  }

  function paintSnapshot(snap: LoginSnapshot) {
    paintTabs();
    stateText.textContent = snap.message || PHASE_TEXT[snap.phase] || '';
    hintText.textContent = snap.error ? hintOf(snap.error) : '';
    if (snap.qr) {
      qrImg.src = snap.qr.image;
      qrMask.classList.toggle('show', snap.phase === 'expired' || snap.phase === 'failed');
      if (snap.phase === 'expired') qrMask.textContent = '二维码已失效，点「重新获取」';
      else if (snap.phase === 'failed') qrMask.textContent = '获取失败';
      else qrMask.classList.remove('show');
    }
    if (snap.phase === 'confirmed' && snap.account) {
      stopTimer();
      qrMask.textContent = `已登录 ${snap.account.name}`;
      qrMask.classList.add('show');
      void refreshList();
    }
    if (snap.phase === 'expired' || snap.phase === 'failed' || snap.phase === 'cancelled') stopTimer();
  }

  function stopTimer() {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  }

  function schedule(delay: number) {
    stopTimer();
    timer = window.setTimeout(() => {
      void run(() => api.poll(provider));
    }, Math.max(300, delay || 2000));
  }

  async function run(fn: () => Promise<IpcResult<LoginSnapshot>>) {
    let res: IpcResult<LoginSnapshot>;
    try {
      res = await fn();
    } catch (e) {
      stateText.textContent = `请求失败：${(e as Error).message}`;
      return;
    }
    if (!res.ok) {
      stateText.textContent = res.error.message;
      hintText.textContent = hintOf(res.error);
      stopTimer();
      return;
    }
    paintSnapshot(res.data);
    const snap = res.data;
    if (snap.phase === 'starting' || snap.phase === 'waiting' || snap.phase === 'scanned') {
      schedule(snap.retryAfterMs ?? 2000);
    }
  }

  async function open(id: ProviderId) {
    provider = id;
    paintTabs();
    stopTimer();
    paintIdle();
    stateText.textContent = '正在打开登录页…';
    await run(() => api.begin(provider));
  }

  async function refreshList() {
    const res = await api.list(provider);
    listBox.innerHTML = '';
    if (!res.ok) {
      listBox.textContent = res.error.message;
      return;
    }
    const currentRes = await api.status(provider);
    const currentId = currentRes.ok ? currentRes.data.account?.id : undefined;
    if (!res.data.length) {
      listBox.textContent = '这个平台还没有登录过账号。';
      return;
    }
    for (const acc of res.data) {
      const row = el('div', 'acc-row' + (acc.id === currentId ? ' on' : ''));
      const avatar = el('div', 'acc-avatar');
      if (acc.avatarUrl) avatar.style.backgroundImage = `url("${acc.avatarUrl}")`;
      const meta = el('div', 'acc-meta');
      meta.append(el('div', 'acc-name', acc.name), el('div', 'acc-sub', `uid ${acc.userId}`));
      const btns = el('div', 'acc-rowacts');
      if (acc.id !== currentId) {
        const b = button('切换');
        b.onclick = () => {
          void api.switchTo(acc.id).then(r => {
            if (!r.ok) {
              hintText.textContent = hintOf(r.error);
              return;
            }
            void refreshList();
          });
        };
        btns.append(b);
      }
      const q = button('退出');
      q.onclick = () => {
        void api.logout(acc.id);
        void refreshList();
      };
      btns.append(q);
      row.append(avatar, meta, btns);
      listBox.append(row);
    }
  }

  offEvent = api.onEvent(e => {
    if (e.provider !== provider) return;
    if (e.type === 'login' || e.type === 'switch' || e.type === 'logout') void refreshList();
  });

  paintTabs();
  paintIdle();
  void refreshList();

  return {
    open(id) {
      void open(id ?? provider);
    },
    close() {
      stopTimer();
      void api.cancel(provider);
    },
    destroy() {
      stopTimer();
      offEvent?.();
      root.innerHTML = '';
    }
  };
}

/* ---------------- DOM 小工具 ---------------- */

function el(tag: string, cls = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function button(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'acc-btn';
  b.textContent = label;
  return b;
}

function hintOf(err: AccountErrorPayload): string {
  const parts = [err.hint, err.retryAfterMs ? `${Math.round(err.retryAfterMs / 1000)} 秒后可重试` : ''].filter(Boolean);
  return parts.join(' · ');
}

/** 音质下拉：与主进程的 QualityId 一一对应，避免两处文案漂移 */
export function qualitySelect(value: QualityId, onChange: (q: QualityId) => void): HTMLElement {
  const wrap = el('div', 'acc-quality');
  const sel = document.createElement('select');
  for (const [id, label] of Object.entries(QUALITY_LABEL)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = label;
    if (id === value) o.selected = true;
    sel.append(o);
  }
  sel.onchange = () => onChange(sel.value as QualityId);
  wrap.append(el('span', 'acc-q-label', '音质'), sel);
  return wrap;
}
