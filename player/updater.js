'use strict';
/**
 * GitHub 自动检查更新与播放器内下载安装模块
 * ---------------------------------------------------------------------------
 * 目标仓库：https://github.com/AA1IMB/Nckik-music
 *
 * 策略：
 *   1. 检查最新版本时优先调 GitHub Releases API（信息最全，带精确文件大小与预发布标记）；
 *      若遇未认证限流（403/429）或 API 异常，自动回退到免限流的 releases.atom +
 *      releases/expanded_assets/<tag> 页面解析，确保国内/共享代理 IP 下依然可用。
 *   2. 版本号解析兼容本仓库 `v0.94` 这类标签与 `NckiksMusic-Setup-0.9.4.exe` 三段语义化版本：
 *      优先从安装包文件名提取 X.Y.Z，其次从标题/说明提取，最后才从 tag 提取。
 *   3. 下载走 Electron net.fetch（自动继承系统代理），写入 <userData>/updates/*.part，
 *      校验非空与 Windows PE 头（MZ）后原子改名，支持取消与实时进度上报。
 *   4. 安装调用 shell.openPath 触发系统正常拉起（兼容 UAC），随后退出当前实例让安装器覆盖。
 */
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');

const DEFAULT_REPO = 'AA1IMB/Nckik-music';
const REQUEST_TIMEOUT = 15000;
const ALLOWED_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com'
]);

function getRepo() {
  const raw = String(process.env.NCKIK_UPDATE_REPO || DEFAULT_REPO).trim();
  return /^[\w.-]+\/[\w.-]+$/.test(raw) ? raw : DEFAULT_REPO;
}

function getApiBase() {
  return String(process.env.NCKIK_UPDATE_API || 'https://api.github.com').replace(/\/+$/, '');
}

function getWebBase() {
  return String(process.env.NCKIK_UPDATE_WEB || 'https://github.com').replace(/\/+$/, '');
}

function isAllowedUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  const customApi = process.env.NCKIK_UPDATE_API ? new URL(process.env.NCKIK_UPDATE_API) : null;
  const customWeb = process.env.NCKIK_UPDATE_WEB ? new URL(process.env.NCKIK_UPDATE_WEB) : null;
  if (customApi && u.origin === customApi.origin) return true;
  if (customWeb && u.origin === customWeb.origin) return true;
  if (u.protocol !== 'https:') return false;
  if (ALLOWED_HOSTS.has(u.hostname)) return true;
  return u.hostname.endsWith('.githubusercontent.com');
}

/* 解析三段语义化版本：返回 [major, minor, patch] 或 null */
function parseSemver(str) {
  if (!str) return null;
  const s = String(str).trim();
  const m3 = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  if (m3) return [Number(m3[1]), Number(m3[2]), Number(m3[3])];
  const m2 = /^v?(\d+)\.(\d+)$/i.exec(s);
  if (m2) {
    // 兼容 `v0.94` 这种把 0.9.4 写成两段的标签（仅在无三段版本可提取时兜底）
    const maj = Number(m2[1]);
    const min = Number(m2[2]);
    return [maj, min, 0];
  }
  return null;
}

function formatSemver(v) {
  return v ? `${v[0]}.${v[1]}.${v[2]}` : '';
}

function compareSemver(a, b) {
  const va = Array.isArray(a) ? a : parseSemver(a);
  const vb = Array.isArray(b) ? b : parseSemver(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] > vb[i] ? 1 : -1;
  }
  return 0;
}

/* 从发布条目中提取最准确的版本号：
 * 1) 优先匹配资产文件名里的 NckiksMusic-(Setup|Portable)-X.Y.Z.exe
 * 2) 其次匹配其他资产名里的 X.Y.Z
 * 3) 其次匹配 tag / title / notes 里的三段 X.Y.Z
 * 4) 最后才退回 tag 里的两段版本号 */
function resolveReleaseVersion(rel) {
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  for (const a of assets) {
    const m = /NckiksMusic-(?:Setup|Portable)-(\d+\.\d+\.\d+)\.exe$/i.exec(a.name || '');
    if (m) return m[1];
  }
  for (const a of assets) {
    const m = /(\d+\.\d+\.\d+)/.exec(a.name || '');
    if (m) return m[1];
  }
  for (const text of [rel.tag, rel.title, rel.notes]) {
    const m = /\bv?(\d+\.\d+\.\d+)\b/i.exec(String(text || ''));
    if (m) return m[1];
  }
  const fallback = parseSemver(rel.tag);
  return fallback ? formatSemver(fallback) : '';
}

function decodeHtml(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseHumanSize(text) {
  const m = /([\d.]+)\s*(B|KB|MB|GB)\b/i.exec(String(text || ''));
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2].toUpperCase();
  const mul = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1;
  return Math.round(n * mul);
}

function pickBestAsset(assets, isPortable) {
  const exes = (assets || []).filter(a => a && /\.exe$/i.test(a.name || '') && a.url);
  if (!exes.length) return null;
  const setup = exes.find(a => /setup/i.test(a.name));
  const portable = exes.find(a => /portable/i.test(a.name));
  if (isPortable) return portable || setup || exes[0];
  return setup || portable || exes[0];
}

function createUpdater({ app, net, shell, userDir, getUpdatesDir, sendProgress, logError }) {
  const resolveUpdatesDir = () => (
    typeof getUpdatesDir === 'function' ? getUpdatesDir() : path.join(userDir, 'updates')
  );
  let activeCtrl = null;
  let downloading = false;

  const getCurrentVersion = () => {
    if (app.isPackaged) return String(app.getVersion() || '0.0.0');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
      if (pkg && pkg.version) return String(pkg.version);
    } catch {}
    return String(app.getVersion() || '0.0.0');
  };
  const ua = () => `NckiksMusic/${getCurrentVersion()}`;
  const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;
  const runMode = () => (!app.isPackaged ? 'dev' : (isPortable() ? 'portable' : 'installed'));

  async function fetchWithTimeout(url, opts = {}, timeoutMs = REQUEST_TIMEOUT) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('TIMEOUT')), timeoutMs);
    try {
      return await net.fetch(url, {
        ...opts,
        signal: ctrl.signal,
        headers: { 'User-Agent': ua(), ...(opts.headers || {}) }
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchViaApi() {
    const repo = getRepo();
    const url = `${getApiBase()}/repos/${repo}/releases?per_page=10`;
    const res = await fetchWithTimeout(url, {
      headers: { Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) {
      const err = new Error(`GitHub API ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('GitHub API 返回格式异常');
    const published = list.filter(x => x && !x.draft);
    if (!published.length) return null;

    const normalized = published.map(x => {
      const assets = (x.assets || [])
        .filter(a => a && a.name && a.browser_download_url)
        .map(a => ({
          name: String(a.name),
          url: String(a.browser_download_url),
          size: Number(a.size) || 0
        }));
      const base = {
        tag: String(x.tag_name || ''),
        title: String(x.name || x.tag_name || ''),
        notes: String(x.body || '').trim(),
        publishedAt: String(x.published_at || x.created_at || ''),
        htmlUrl: String(x.html_url || `${getWebBase()}/${repo}/releases/tag/${encodeURIComponent(x.tag_name || '')}`),
        prerelease: !!x.prerelease,
        assets,
        source: 'api'
      };
      base.version = resolveReleaseVersion(base);
      return base;
    });

    // 选出语义化版本号最高的发布（版本相同时优先正式版而非预发布）
    normalized.sort((a, b) => {
      const c = compareSemver(b.version, a.version);
      if (c !== 0) return c;
      if (a.prerelease !== b.prerelease) return a.prerelease ? 1 : -1;
      return String(b.publishedAt).localeCompare(String(a.publishedAt));
    });
    return normalized[0];
  }

  async function fetchExpandedAssets(repo, tag) {
    const web = getWebBase();
    const url = `${web}/${repo}/releases/expanded_assets/${encodeURIComponent(tag)}`;
    const res = await fetchWithTimeout(url, { headers: { Accept: 'text/html' } });
    if (!res.ok) return [];
    const html = await res.text();
    const assets = [];
    const seen = new Set();
    // 只锚定真实下载链接，避免 GitHub 页面 <li> 内部结构变长时漏匹配；文件大小从后文片段就近提取
    const re = /href="([^"]*\/releases\/download\/[^"]+)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      const fullUrl = href.startsWith('http') ? href : `${web}${href.startsWith('/') ? '' : '/'}${href}`;
      if (seen.has(fullUrl)) continue;
      seen.add(fullUrl);
      let name = '';
      try { name = decodeURIComponent(path.posix.basename(new URL(fullUrl).pathname)); } catch {}
      if (!name) continue;
      const tail = html.slice(m.index, m.index + 2400);
      const liEnd = tail.indexOf('</li>');
      const seg = liEnd >= 0 ? tail.slice(0, liEnd) : tail;
      assets.push({ name, url: fullUrl, size: parseHumanSize(seg) });
    }
    return assets;
  }

  async function fetchViaAtom() {
    const repo = getRepo();
    const web = getWebBase();
    const res = await fetchWithTimeout(`${web}/${repo}/releases.atom`, {
      headers: { Accept: 'application/atom+xml, application/xml, text/xml' }
    });
    if (!res.ok) {
      const err = new Error(`GitHub Atom ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const xml = await res.text();
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].slice(0, 6);
    if (!entries.length) return null;

    const candidates = [];
    for (const em of entries) {
      const block = em[1];
      const hrefM = /<link[^>]+href="([^"]+)"/i.exec(block);
      const htmlUrl = hrefM ? hrefM[1] : `${web}/${repo}/releases`;
      const tagM = /\/releases\/tag\/([^/?#]+)/i.exec(htmlUrl);
      const tag = tagM ? decodeURIComponent(tagM[1]) : '';
      if (!tag) continue;
      const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block);
      const updM = /<updated>([\s\S]*?)<\/updated>/i.exec(block);
      const contentM = /<content[^>]*>([\s\S]*?)<\/content>/i.exec(block);
      candidates.push({
        tag,
        title: decodeHtml(titleM ? titleM[1] : tag),
        notes: decodeHtml(contentM ? contentM[1] : ''),
        publishedAt: updM ? updM[1].trim() : '',
        htmlUrl,
        prerelease: false,
        assets: [],
        source: 'atom'
      });
    }
    if (!candidates.length) return null;

    // 优先拉取最新一条的资产列表（避免一次拉太多页）
    const top = candidates[0];
    top.assets = await fetchExpandedAssets(repo, top.tag);
    top.version = resolveReleaseVersion(top);
    return top;
  }

  async function check() {
    const currentVersion = getCurrentVersion();
    const repo = getRepo();
    let release = null;
    let apiErr = null;
    try {
      release = await fetchViaApi();
    } catch (e) {
      apiErr = e;
    }
    if (!release) {
      try {
        release = await fetchViaAtom();
      } catch (e) {
        const msg = apiErr && e
          ? `无法连接 GitHub（${e.message || apiErr.message}）`
          : `检查更新失败：${(e && e.message) || (apiErr && apiErr.message) || '网络异常'}`;
        return { ok: false, error: { code: 'UPD_NET', message: msg }, currentVersion };
      }
    }
    if (!release) {
      return {
        ok: true,
        currentVersion,
        latestVersion: currentVersion,
        hasUpdate: false,
        repoUrl: `${getWebBase()}/${repo}/releases`,
        mode: runMode(),
        asset: null,
        assets: []
      };
    }

    const latestVersion = release.version || currentVersion;
    const hasUpdate = compareSemver(latestVersion, currentVersion) > 0;
    const asset = pickBestAsset(release.assets, isPortable());
    return {
      ok: true,
      currentVersion,
      latestVersion,
      tag: release.tag,
      title: release.title,
      notes: release.notes,
      publishedAt: release.publishedAt,
      htmlUrl: release.htmlUrl,
      repoUrl: `${getWebBase()}/${repo}/releases`,
      prerelease: release.prerelease,
      hasUpdate,
      mode: runMode(),
      asset,
      assets: release.assets,
      source: release.source
    };
  }

  async function cleanupOldDownloads(dir, keepName) {
    try {
      const files = await fsp.readdir(dir);
      for (const f of files) {
        if (f === keepName) continue;
        try { await fsp.unlink(path.join(dir, f)); } catch {}
      }
    } catch {}
  }

  async function download({ url, name, expectedSize } = {}) {
    if (downloading) {
      return { ok: false, error: { code: 'UPD_BUSY', message: '正在下载更新，请稍候' } };
    }
    if (!url || !isAllowedUrl(url)) {
      return { ok: false, error: { code: 'UPD_BAD_URL', message: '下载地址不受信任，已拒绝下载' } };
    }
    const safeName = path.basename(String(name || 'NckiksMusic-Update.exe')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    if (!safeName || safeName === '.' || safeName === '..') {
      return { ok: false, error: { code: 'UPD_BAD_NAME', message: '无效的文件名' } };
    }

    const updatesDir = resolveUpdatesDir();
    await fsp.mkdir(updatesDir, { recursive: true });
    const finalPath = path.join(updatesDir, safeName);
    const partPath = finalPath + '.part';

    downloading = true;
    activeCtrl = new AbortController();
    const emit = (p) => { try { sendProgress(p); } catch {} };

    try {
      emit({ state: 'downloading', downloaded: 0, total: Number(expectedSize) || 0, percent: 0, name: safeName });
      const res = await net.fetch(url, {
        signal: activeCtrl.signal,
        headers: { 'User-Agent': ua() }
      });
      if (!res.ok || !res.body) {
        throw new Error(`下载失败（HTTP ${res.status}）`);
      }

      const headerTotal = Number(res.headers.get('content-length')) || 0;
      const total = headerTotal || Number(expectedSize) || 0;
      let downloaded = 0;
      let lastEmit = 0;

      const out = fs.createWriteStream(partPath);
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          downloaded += chunk.length;
          if (!out.write(chunk)) {
            await new Promise((resolve, reject) => {
              out.once('drain', resolve);
              out.once('error', reject);
            });
          }
          const now = Date.now();
          if (now - lastEmit >= 120) {
            lastEmit = now;
            const percent = total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0;
            emit({ state: 'downloading', downloaded, total, percent, name: safeName });
          }
        }
        await new Promise((resolve, reject) => {
          out.on('finish', resolve);
          out.on('error', reject);
          out.end();
        });
      } catch (err) {
        try { out.destroy(); } catch {}
        try { reader.cancel().catch(() => {}); } catch {}
        throw err;
      }

      if (downloaded <= 0) throw new Error('下载的文件为空');

      // 校验 Windows 可执行文件头（MZ），防止镜像或网关返回 HTML 错误页
      if (/\.exe$/i.test(safeName)) {
        const fh = await fsp.open(partPath, 'r');
        try {
          const head = Buffer.alloc(2);
          await fh.read(head, 0, 2, 0);
          if (head[0] !== 0x4d || head[1] !== 0x5a) {
            throw new Error('下载的文件不是有效的 Windows 安装程序（文件头校验失败）');
          }
        } finally {
          await fh.close();
        }
      }

      await cleanupOldDownloads(updatesDir, safeName + '.part');
      try { await fsp.unlink(finalPath); } catch {}
      await fsp.rename(partPath, finalPath);

      emit({ state: 'downloaded', downloaded, total: total || downloaded, percent: 100, name: safeName, filePath: finalPath });
      return { ok: true, filePath: finalPath, name: safeName, size: downloaded };
    } catch (e) {
      try { await fsp.unlink(partPath); } catch {}
      const aborted = activeCtrl && activeCtrl.signal.aborted;
      const code = aborted ? 'UPD_CANCELLED' : 'UPD_DOWNLOAD_FAILED';
      const message = aborted ? '已取消下载' : String((e && e.message) || e);
      emit({ state: aborted ? 'cancelled' : 'error', error: message });
      if (!aborted && logError) logError('updater:download', e);
      return { ok: false, error: { code, message } };
    } finally {
      downloading = false;
      activeCtrl = null;
    }
  }

  function cancel() {
    if (activeCtrl) {
      try { activeCtrl.abort(new Error('USER_CANCEL')); } catch {}
      return { ok: true, cancelled: true };
    }
    return { ok: true, cancelled: false };
  }

  async function install({ filePath } = {}) {
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, error: { code: 'UPD_NO_FILE', message: '找不到已下载的更新包' } };
    }
    const resolved = path.resolve(filePath);
    const base = path.resolve(resolveUpdatesDir());
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      return { ok: false, error: { code: 'UPD_BAD_PATH', message: '更新包路径不在允许目录内' } };
    }
    try {
      const st = await fsp.stat(resolved);
      if (!st.isFile() || st.size < 2) throw new Error('文件不存在或为空');
    } catch {
      return { ok: false, error: { code: 'UPD_MISSING', message: '更新包已被移动或删除，请重新下载' } };
    }

    let launchPath = resolved;
    // 免安装版：若下载的是新版 Portable exe，尝试复制到原免安装版同目录（新文件名带版本号不冲突）
    if (isPortable() && /portable/i.test(path.basename(resolved)) && process.env.PORTABLE_EXECUTABLE_DIR) {
      const target = path.join(process.env.PORTABLE_EXECUTABLE_DIR, path.basename(resolved));
      if (path.resolve(target) !== path.resolve(process.env.PORTABLE_EXECUTABLE_FILE || '')) {
        try {
          await fsp.copyFile(resolved, target);
          launchPath = target;
        } catch {}
      }
    }

    if (process.env.NCKIK_UPDATE_DRY_INSTALL === '1') {
      return { ok: true, dryRun: true, filePath: launchPath };
    }

    const openErr = await shell.openPath(launchPath);
    if (openErr) {
      return { ok: false, error: { code: 'UPD_LAUNCH_FAILED', message: '无法启动安装程序：' + openErr } };
    }
    setTimeout(() => { try { app.quit(); } catch {} }, 600);
    return { ok: true, filePath: launchPath, launching: true };
  }

  function openRelease(url) {
    const repo = getRepo();
    const target = (typeof url === 'string' && isAllowedUrl(url))
      ? url
      : `${getWebBase()}/${repo}/releases`;
    shell.openExternal(target);
    return { ok: true, url: target };
  }

  function reveal(filePath) {
    if (!filePath || typeof filePath !== 'string') return { ok: false };
    const resolved = path.resolve(filePath);
    const base = path.resolve(resolveUpdatesDir());
    if (!resolved.startsWith(base + path.sep)) return { ok: false };
    if (!fs.existsSync(resolved)) return { ok: false };
    shell.showItemInFolder(resolved);
    return { ok: true };
  }

  return { check, download, cancel, install, openRelease, reveal };
}

module.exports = {
  createUpdater,
  parseSemver,
  compareSemver,
  resolveReleaseVersion,
  pickBestAsset
};
