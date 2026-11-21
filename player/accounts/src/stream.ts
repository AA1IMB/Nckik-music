import type { AccountErrorCode, AudioRequest, AudioResult, ProviderId, QualityId } from './types';
import { QUALITY_LABEL } from './types';
import { AccountError, providerError, qualityError } from './errors';

/**
 * 取流降级引擎（平台无关）
 * ---------------------------------------------------------------------------
 * 各平台的档位名称不同、失败长相不同，但决策逻辑一样，抽在这里：
 *   1. 从请求档位开始，沿该平台的降级链逐档尝试（顺序由 provider 给）；
 *   2. 「不可播放」（无版权 / 会员限定 / 地区限制）→ 继续降档；
 *   3. 「需要重新登录」「限流」「风控」→ **立即停**，降档没有意义，只会放大请求量；
 *   4. 网络类失败 → 继续降档，但全部失败时报 E_UPSTREAM_UNAVAILABLE，不要谎称没版权；
 *   5. 拿到可用地址即返回，并回传实际档位与被跳过的档位，UI 按真实档位显示。
 */

export type BlockKind = 'copyright' | 'vip' | 'region' | 'unknown';

export interface AudioBlock {
  kind: BlockKind;
  code?: string | number;
  message?: string;
}

export interface AudioAttempt {
  /** 空串 / 缺省都表示这一档没拿到可用地址 */
  url?: string;
  bitrateKbps?: number;
  /** 上游给的地址有效期；缺省用引擎默认值 */
  ttlMs?: number;
  /** 不可播放的具体原因（没有 url 时尽量给出） */
  block?: AudioBlock;
}

export interface AudioFetchContext {
  songId: string;
  albumId?: string;
  quality: QualityId;
}

export interface StreamProvider {
  readonly id: ProviderId;
  /** 档位 → 降级链，第一位是自身 */
  readonly ladder: Readonly<Record<QualityId, readonly QualityId[]>>;
  fetchAudio(ctx: AudioFetchContext): Promise<AudioAttempt>;
}

export interface ResolveOptions {
  now?: () => number;
  /** 地址默认有效期：平台直链一般 20 分钟量级，默认 15 分钟留余量 */
  defaultTtlMs?: number;
}

/** 这几种错误一旦出现就停止降档：重试或降档都不会变好，反而更容易触发风控 */
const STOP_CODES: ReadonlySet<AccountErrorCode> = new Set<AccountErrorCode>([
  'E_AUTH_REQUIRED',
  'E_RATE_LIMITED',
  'E_RISK_CONTROL',
  'E_ACCOUNT_LIMIT',
  'E_CIPHER_UNAVAILABLE',
  'E_STORAGE_FAILED'
]);

export async function resolveAudio(
  provider: StreamProvider,
  req: AudioRequest,
  opts: ResolveOptions = {}
): Promise<AudioResult> {
  const now = opts.now ?? Date.now;
  const defaultTtlMs = opts.defaultTtlMs ?? 15 * 60 * 1000;
  const chain = provider.ladder[req.quality] ?? [req.quality];

  const tried: QualityId[] = [];
  const blocked: Array<{ quality: QualityId; block: AudioBlock }> = [];
  let lastNetworkError: AccountError | null = null;

  for (const quality of chain) {
    tried.push(quality);
    let attempt: AudioAttempt;
    try {
      attempt = await provider.fetchAudio({ songId: req.songId, albumId: req.albumId, quality });
    } catch (e) {
      const err =
        e instanceof AccountError
          ? e
          : providerError(provider.id, 'E_UPSTREAM_UNAVAILABLE', `取流失败，请稍后重试。`, { cause: e });
      if (STOP_CODES.has(err.code) || err.code === 'E_RATE_LIMITED') throw err;
      lastNetworkError = err;
      continue;
    }

    if (attempt.url) {
      return {
        url: attempt.url,
        quality,
        bitrateKbps: attempt.bitrateKbps ?? 0,
        expiresAt: now() + (attempt.ttlMs ?? defaultTtlMs),
        tried
      };
    }
    if (attempt.block) blocked.push({ quality, block: attempt.block });
  }

  // 全部档位都没拿到：按「最后一次可见原因」给结论，优先级 copyright > vip > region > 网络
  const vip = blocked.find(b => b.block.kind === 'vip');
  const region = blocked.find(b => b.block.kind === 'region');
  const copyright = blocked.find(b => b.block.kind === 'copyright');

  if (copyright) {
    throw providerError(provider.id, 'E_NO_COPYRIGHT', `这首在${QUALITY_LABEL[req.quality]}及以下档位都不可播放（无版权或已下架）。`, {
      quality: req.quality
    });
  }
  if (vip) {
    throw providerError(provider.id, 'E_NO_COPYRIGHT', `这首需要会员权限才能播放，当前账号无可用档位。`, {
      hint: '可改用标准档，或换一个有权限的账号',
      quality: req.quality
    });
  }
  if (region) {
    throw providerError(provider.id, 'E_NO_COPYRIGHT', `这首在当前地区不可播放（地区限制）。`, { quality: req.quality });
  }
  if (lastNetworkError) throw lastNetworkError;
  throw qualityError(provider.id, req.quality, []);
}

/** 地址是否仍可用：留 60s 余量，避免卡在过期边界上打出一次必然失败的播放 */
export function isUrlFresh(expiresAt: number, now = Date.now()): boolean {
  return expiresAt - now > 60_000;
}
