import type { Account, Cipher, Credential, Logger, ProviderId } from './types';
import { AccountError } from './errors';

/**
 * 凭据存储
 * ---------------------------------------------------------------------------
 * 落盘形态（`%APPDATA%\NckiksMusic\accounts.bin`，单文件、UTF-8 JSON）：
 *   {
 *     "version": 1,
 *     "current": { "qq": "qq:12345", "kugou": "kugou:abcd" },
 *     "buckets": {
 *       "qq":    { "qq:12345": { "account": {...}, "sealed": "<base64>" } },
 *       "kugou": { ... }
 *     }
 *   }
 *
 * 设计取舍：
 *   1. 账号元信息（昵称、头像、uid）明文存 —— 列表要能画出来而不必逐个解密；
 *   2. **凭据（整串 Cookie）单独用系统密钥库加密**，只以 base64 形式出现；
 *   3. 每个平台各自一份 bucket，删掉一个平台的登录不会波及另一个；
 *   4. 写入走「临时文件 + rename」，断电不会留下半截 JSON（与 main.js 的 writeJSON 同策略）。
 */

export interface FsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string): Buffer;
  writeFileSync(p: string, data: Buffer): void;
  renameSync(from: string, to: string): void;
  unlinkSync(p: string): void;
  mkdirSync(p: string, opts: { recursive: boolean }): void;
}

interface SealedEntry {
  account: Account;
  /** base64(AES/DPAPI 密文)，内容是 { cookie, extra, updatedAt, verifiedAt } 的 JSON */
  sealed: string;
}

interface StoreFile {
  version: 1;
  current: Partial<Record<ProviderId, string>>;
  buckets: Partial<Record<ProviderId, Record<string, SealedEntry>>>;
}

/** 每次都给新对象：这条常量被多个实例共用时会被 upsert 污染（自测抓到过） */
function emptyStore(): StoreFile {
  return { version: 1, current: {}, buckets: {} };
}

export interface CredentialStoreOptions {
  file: string;
  cipher: Cipher;
  fs: FsLike;
  logger: Logger;
  now: () => number;
}

export class CredentialStore {
  private readonly opt: CredentialStoreOptions;
  private state: StoreFile = emptyStore();
  private loaded = false;
  /** 解密缓存：id → 凭据，避免每次取流都解一次系统密钥库 */
  private plain = new Map<string, Credential>();

  constructor(opt: CredentialStoreOptions) {
    this.opt = opt;
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const { fs, file, logger } = this.opt;
    if (!fs.existsSync(file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file).toString('utf8')) as StoreFile;
      if (!raw || raw.version !== 1 || typeof raw.buckets !== 'object') throw new Error('unexpected shape');
      this.state = { version: 1, current: raw.current ?? {}, buckets: raw.buckets ?? {} };
    } catch (e) {
      // 坏文件不删：改名留档，避免用户「登录全没了」还查不到原因
      const bak = `${file}.bad-${this.opt.now()}`;
      try {
        fs.renameSync(file, bak);
      } catch {}
      logger.warn('accounts.bin 解析失败，已留档', { backup: bak, error: (e as Error).message });
      this.state = emptyStore();
    }
  }

  list(provider?: ProviderId): Account[] {
    this.load();
    const out: Account[] = [];
    for (const [pid, bucket] of Object.entries(this.state.buckets)) {
      if (!bucket) continue;
      if (provider && pid !== provider) continue;
      for (const entry of Object.values(bucket)) out.push(entry.account);
    }
    return out.sort((a, b) => b.lastLoginAt - a.lastLoginAt);
  }

  find(id: string): Account | null {
    this.load();
    for (const bucket of Object.values(this.state.buckets)) {
      const hit = bucket && bucket[id];
      if (hit) return hit.account;
    }
    return null;
  }

  /** 取凭据：解密失败（换机、密钥库重置）时返回 null 并清掉该条，等同「登录失效」 */
  credential(id: string): Credential | null {
    this.load();
    const cached = this.plain.get(id);
    if (cached) return cached;
    const entry = this.findEntry(id);
    if (!entry) return null;
    if (!this.opt.cipher.available()) return null;
    try {
      const json = this.opt.cipher.decrypt(Buffer.from(entry.sealed, 'base64'));
      const cred = JSON.parse(json) as Credential;
      if (!cred || typeof cred.cookie !== 'string') throw new Error('bad credential');
      this.plain.set(id, cred);
      return cred;
    } catch (e) {
      this.opt.logger.warn('凭据解密失败，按未登录处理', { id, error: (e as Error).message });
      return null;
    }
  }

  upsert(account: Account, credential: Credential): void {
    this.load();
    if (!this.opt.cipher.available()) {
      throw new AccountError('E_CIPHER_UNAVAILABLE', '系统密钥库不可用，无法安全保存登录凭据。', {
        hint: 'Windows 上请确认已登录系统账户；某些精简系统会禁用 DPAPI'
      });
    }
    const sealed = this.opt.cipher.encrypt(JSON.stringify(credential)).toString('base64');
    const bucket = (this.state.buckets[account.provider] ??= {});
    bucket[account.id] = { account, sealed };
    this.plain.set(account.id, credential);
    this.save();
  }

  remove(id: string): boolean {
    this.load();
    let removed = false;
    for (const [pid, bucket] of Object.entries(this.state.buckets)) {
      if (!bucket || !bucket[id]) continue;
      delete bucket[id];
      this.plain.delete(id);
      if (this.state.current[pid as ProviderId] === id) delete this.state.current[pid as ProviderId];
      removed = true;
    }
    if (removed) this.save();
    return removed;
  }

  setCurrent(provider: ProviderId, id: string | null): void {
    this.load();
    if (id === null) delete this.state.current[provider];
    else this.state.current[provider] = id;
    this.save();
  }

  current(provider: ProviderId): Account | null {
    this.load();
    const id = this.state.current[provider];
    return id ? this.find(id) : null;
  }

  /** 当前账号的凭据；没有当前账号时回落成「该平台最近一次登录的账号」 */
  currentCredential(provider: ProviderId): { account: Account; credential: Credential } | null {
    const acc = this.current(provider) ?? this.list(provider)[0] ?? null;
    if (!acc) return null;
    const credential = this.credential(acc.id);
    return credential ? { account: acc, credential } : null;
  }

  /** 明文重置（仅测试与「忘记所有账号」使用） */
  clearAll(): void {
    this.load();
    this.state = { version: 1, current: {}, buckets: {} };
    this.plain.clear();
    this.save();
  }

  private findEntry(id: string): SealedEntry | null {
    for (const bucket of Object.values(this.state.buckets)) {
      const hit = bucket && bucket[id];
      if (hit) return hit;
    }
    return null;
  }

  private save(): void {
    const { fs, file } = this.opt;
    try {
      fs.mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(JSON.stringify(this.state, null, 2), 'utf8'));
      fs.renameSync(tmp, file);
    } catch (e) {
      throw new AccountError('E_STORAGE_FAILED', '账号数据写入失败，请检查磁盘权限或空间。', { cause: e });
    }
  }
}

/** 只为 `dirname` 一个函数引入 node:path 会破坏「零依赖」，这里手写足够用的实现 */
export function dirname(p: string): string {
  const norm = p.replace(/[\\/]+$/, '');
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  return i <= 0 ? '.' : norm.slice(0, i);
}
