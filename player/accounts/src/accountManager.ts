import type { Account, AudioRequest, AudioResult, Credential, LibraryRefresh, LoginSnapshot, Logger, ProviderId, QualityId } from './types';
import { PROVIDER_LABEL } from './types';
import type { CredentialStore } from './credentialStore';
import { LoginSession, type LoginSessionOptions } from './loginSession';
import { resolveAudio, isUrlFresh, type StreamProvider } from './stream';
import { AccountError, errorMessage, providerError } from './errors';
import type { Provider } from './providers/base';

/**
 * 账号管理器（主进程侧唯一入口）
 * ---------------------------------------------------------------------------
 * 职责：
 *   - 给渲染层提供「扫码 → 轮询 → 已登录」的统一快照（LoginSnapshot）；
 *   - 确认登录时把凭据加密落盘、登记账号、设为该平台当前账号；
 *   - 多账号：列出 / 切换 / 删除；切换后清空取流缓存与歌单缓存；
 *   - 取流：带凭据调用 provider，再交给降级引擎；
 *   - 重启后懒校验：有凭据但没有 verifiedAt 时补一次 verify（避免界面永远显示未登录）。
 */

export type AccountEvent =
  | { type: 'login'; provider: ProviderId; account: Account; revision?: number; library?: LibraryRefresh }
  | { type: 'switch'; provider: ProviderId; account: Account; revision?: number; library?: LibraryRefresh }
  | { type: 'logout'; provider: ProviderId; accountId?: string; revision?: number; library?: LibraryRefresh }
  | { type: 'invalidated'; provider: ProviderId; revision?: number };

export interface AccountManagerDeps {
  store: CredentialStore;
  providers: Record<ProviderId, Provider>;
  logger: Logger;
  now?: () => number;
  session?: Omit<LoginSessionOptions, 'provider' | 'poll' | 'now' | 'logger'>;
}

interface StreamCacheEntry extends AudioResult {
  accountId: string;
}

export class AccountManager {
  private readonly deps: AccountManagerDeps;
  private readonly now: () => number;
  private readonly sessions = new Map<ProviderId, LoginSession>();
  private readonly listeners = new Set<(e: AccountEvent) => void>();
  private readonly streamCache = new Map<string, StreamCacheEntry>();

  constructor(deps: AccountManagerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    // 迁移：清掉历史误判（没有账号标识的占位账号）
    try {
      for (const acc of this.deps.store.list()) {
        if (!acc.userId || acc.userId === 'unknown') {
          this.deps.store.remove(acc.id);
          this.deps.logger.warn('清掉历史误判账号', { provider: acc.provider, id: acc.id });
        }
      }
    } catch {
      /* 账本坏了由 credentialStore 自己兜底 */
    }
  }

  on(cb: (e: AccountEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /* ---------------- 扫码登录 ---------------- */

  async beginLogin(provider: ProviderId): Promise<LoginSnapshot> {
    await this.cancelLogin(provider);
    const impl = this.provider(provider);
    try {
      const started = await impl.login.start();
      const session = new LoginSession({
        ...this.deps.session,
        provider,
        now: this.now,
        logger: this.deps.logger,
        poll: () => impl.login.poll(),
        generation: (this.sessions.get(provider)?.generation ?? 0) + 1
      });
      this.sessions.set(provider, session);
      return session.opened(started.qr, started.message);
    } catch (e) {
      const err = e instanceof AccountError ? e : providerError(provider, 'E_UPSTREAM_UNAVAILABLE', errorMessage(e));
      // 失败也要留一个终态会话，UI 才有地方显示错误与「重试」
      const session = new LoginSession({
        ...this.deps.session,
        provider,
        now: this.now,
        logger: this.deps.logger,
        poll: () => impl.login.poll(),
        generation: (this.sessions.get(provider)?.generation ?? 0) + 1
      });
      this.sessions.set(provider, session);
      return session.fail(err);
    }
  }

  /** 走一拍；confirmed 时在这里落盘（凭据不出主进程） */
  async pollLogin(provider: ProviderId): Promise<LoginSnapshot> {
    const session = this.sessions.get(provider);
    if (!session) return this.missing(provider);
    const snap = await session.tick();
    if (snap.phase === 'confirmed') {
      // 凭据只在主进程里由会话状态机带回，取一次即作废，避免重复落盘
      const credential = session.takeCredential();
      if (!credential) {
        return session.fail(providerError(provider, 'E_UPSTREAM_UNAVAILABLE', '登录确认了但没拿到凭据，请重试。'));
      }
      const account = await this.persist(provider, snap.account!, credential);
      return { ...snap, account };
    }
    return snap;
  }

  async refreshLogin(provider: ProviderId): Promise<LoginSnapshot> {
    return this.beginLogin(provider);
  }

  async cancelLogin(provider: ProviderId): Promise<void> {
    const session = this.sessions.get(provider);
    if (session) {
      session.cancel();
      this.sessions.delete(provider);
    }
    try {
      await this.provider(provider).login.cancel();
    } catch (e) {
      this.deps.logger.warn('关闭登录页失败', { provider, error: errorMessage(e) });
    }
  }

  /* ---------------- 多账号 ---------------- */

  list(provider?: ProviderId): Account[] {
    return this.deps.store.list(provider);
  }

  current(provider: ProviderId): Account | null {
    return this.deps.store.current(provider);
  }

  find(id: string): Account | null {
    return this.deps.store.find(id);
  }

  /** 该平台当前账号有没有能用的凭据（不触发网络） */
  credentialOf(provider: ProviderId): Credential | null {
    const current = this.deps.store.currentCredential(provider);
    return current ? current.credential : null;
  }

  /**
   * 切换当前账号：只改「用哪把凭据」，不动库里已有的歌单/歌曲；
   * 但取流缓存与列表缓存必须清掉，否则会拿上一个账号的直链继续播。
   */
  async switchTo(id: string): Promise<Account> {
    const account = this.deps.store.find(id);
    if (!account) throw new AccountError('E_AUTH_REQUIRED', '账号不存在，可能已被删除，请重新登录。');
    const credential = this.deps.store.credential(id);
    if (!credential) {
      throw providerError(account.provider, 'E_AUTH_REQUIRED', '这个账号的登录凭据已失效（可能是换了电脑或系统密钥库重置），请重新扫码登录。');
    }
    const impl = this.provider(account.provider);
    let verified: Account;
    try {
      verified = await impl.verify(credential);
    } catch (e) {
      throw e instanceof AccountError
        ? e
        : providerError(account.provider, 'E_UPSTREAM_UNAVAILABLE', errorMessage(e));
    }
    const merged: Account = { ...account, name: verified.name || account.name, avatarUrl: verified.avatarUrl || account.avatarUrl, lastLoginAt: this.now() };
    this.deps.store.upsert(merged, { ...credential, verifiedAt: this.now() });
    this.deps.store.setCurrent(account.provider, merged.id);
    this.invalidate(account.provider);
    this.emit({ type: 'switch', provider: account.provider, account: merged });
    return merged;
  }

  logout(id: string): void {
    const account = this.deps.store.find(id);
    if (!account) return;
    this.deps.store.remove(id);
    this.invalidate(account.provider);
    this.emit({ type: 'logout', provider: account.provider, accountId: id });
  }

  /**
   * 有凭据但没校验过（重启后的第一次）：补一次 verify 并回写昵称头像。
   * 校验失败按「登录失效」处理，但**不**删凭据，留给用户自己决定是否重扫。
   */
  async ensureVerified(provider: ProviderId): Promise<Account | null> {
    const account = this.current(provider);
    if (!account) return null;
    const credential = this.deps.store.credential(account.id);
    if (!credential) return null;
    if (credential.verifiedAt) return account;
    try {
      const verified = await this.provider(provider).verify(credential);
      const merged: Account = { ...account, name: verified.name || account.name, avatarUrl: verified.avatarUrl || account.avatarUrl };
      this.deps.store.upsert(merged, { ...credential, verifiedAt: this.now() });
      return merged;
    } catch (e) {
      this.deps.logger.warn('账号补验失败', { provider, error: errorMessage(e) });
      return account;
    }
  }

  /* ---------------- 取流 ---------------- */

  async audioFor(provider: ProviderId, req: AudioRequest): Promise<AudioResult> {
    const current = this.deps.store.currentCredential(provider);
    if (!current) {
      throw providerError(provider, 'E_AUTH_REQUIRED', '还没有登录账号，先扫码登录再播放。', { hint: '设置 → 账号 → 扫码登录' });
    }
    const key = cacheKey(provider, current.account.id, req);
    const cached = this.streamCache.get(key);
    if (cached && isUrlFresh(cached.expiresAt, this.now())) {
      return { ...cached, tried: [...cached.tried] };
    }

    const impl = this.provider(provider);
    const result = await resolveAudio(impl.stream as StreamProvider, req, { now: this.now });
    this.streamCache.set(key, { ...result, accountId: current.account.id });
    return result;
  }

  /** 音质切换后主动丢弃缓存（避免继续用旧档位地址） */
  invalidateStreams(provider?: ProviderId): void {
    for (const key of this.streamCache.keys()) {
      if (!provider || key.startsWith(provider + ':')) this.streamCache.delete(key);
    }
  }

  /* ---------------- 内部 ---------------- */

  private invalidate(provider: ProviderId): void {
    this.invalidateStreams(provider);
    this.emit({ type: 'invalidated', provider });
  }

  private emit(e: AccountEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        this.deps.logger.warn('账号事件监听器报错', { error: errorMessage(err) });
      }
    }
  }

  private provider(provider: ProviderId): Provider {
    const impl = this.deps.providers[provider];
    if (!impl) throw providerError(provider, 'E_NOT_IMPLEMENTED', '该平台尚未接入。');
    return impl;
  }

  private missing(provider: ProviderId): LoginSnapshot {
    return {
      provider,
      phase: 'idle',
      message: `${PROVIDER_LABEL[provider]}：没有进行中的登录，请先获取二维码。`
    };
  }

  private async persist(provider: ProviderId, snapshotAccount: Account, credential: Credential): Promise<Account> {
    // 兜底：没有账号标识的「登录成功」一定是误判，宁可报错让用户重扫，也不要往库里塞 uid unknown
    if (!snapshotAccount.userId || snapshotAccount.userId === 'unknown') {
      throw providerError(provider, 'E_AUTH_REQUIRED', '还没拿到账号标识：请在手机上点「确认登录」，或用手机 App 重新扫一次。');
    }
    const account: Account = { ...snapshotAccount, provider, lastLoginAt: this.now() };
    this.deps.store.upsert(account, { ...credential, verifiedAt: this.now() });
    this.deps.store.setCurrent(provider, account.id);
    this.invalidate(provider);
    this.emit({ type: 'login', provider, account });
    return account;
  }
}

function cacheKey(provider: ProviderId, accountId: string, req: AudioRequest): string {
  const quality: QualityId = req.quality;
  return `${provider}:${accountId}:${req.songId}:${req.albumId ?? ''}:${quality}`;
}
