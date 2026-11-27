'use strict';
/**
 * WASAPI 独占在线音源认证回环微代理（Phase 2）
 * - 仅绑定 127.0.0.1 临时端口，每次会话生成随机令牌校验（?t=<token>）
 * - 懒启动：默认关闭独占或仅播放本地文件时不监听任何端口
 * - 复用主进程现有网易云 / 哔哩哔哩 / QQ 音乐 / 酷狗直链解析、401/403 换链与多 CDN 备份
 * - 完整支持 HEAD 探头（自动以 1 字节 Range 兼容不支持 HEAD 的国内 CDN）、字节 Range 拖拽与连接中断清理
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const PASSTHROUGH = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
const HEAD_TIMEOUT = 15000;

function extFromCodec(codec, fallback = '.mp3') {
  const c = String(codec || '').trim().toLowerCase();
  if (!c) return fallback;
  if (c.includes('flac')) return '.flac';
  if (c.includes('wav')) return '.wav';
  if (c.includes('alac') || c.includes('m4a') || c.includes('aac') || c.includes('mp4')) return '.m4a';
  if (c.includes('mp3') || c.includes('mpeg')) return '.mp3';
  if (c.includes('ogg') || c.includes('vorbis')) return '.ogg';
  if (c.includes('wma')) return '.wma';
  return fallback;
}

function extFromUrlOrMime(url, ct, fallback = '.mp3') {
  const m = String(ct || '').toLowerCase();
  if (m.includes('flac')) return '.flac';
  if (m.includes('wav')) return '.wav';
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return '.m4a';
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
  try {
    const p = new URL(url).pathname.toLowerCase();
    for (const e of ['.flac', '.wav', '.m4a', '.mp4', '.mp3', '.aac', '.wma', '.ogg']) {
      if (p.endsWith(e)) return e;
    }
  } catch {}
  return fallback;
}

function mimeFromExt(ext) {
  switch (String(ext || '').toLowerCase()) {
    case '.flac': return 'audio/flac';
    case '.wav': return 'audio/wav';
    case '.m4a':
    case '.mp4':
    case '.aac': return 'audio/mp4';
    case '.ogg': return 'audio/ogg';
    case '.wma': return 'audio/x-ms-wma';
    default: return 'audio/mpeg';
  }
}

function normalizeMime(raw, ext) {
  const ct = String(raw || '').split(';')[0].trim().toLowerCase();
  if (!ct || ct === 'application/octet-stream' || ct === 'binary/octet-stream') {
    return mimeFromExt(ext);
  }
  if (ct === 'audio/x-flac') return 'audio/flac';
  if (ct === 'audio/x-wav' || ct === 'audio/wave') return 'audio/wav';
  if (ct === 'audio/mp3') return 'audio/mpeg';
  return ct;
}

function parseTotalFromRange(contentRange) {
  const m = /\/(\d+)\s*$/.exec(String(contentRange || ''));
  return m ? Number(m[1]) : 0;
}

function createExclusiveStreamProxy({ net, ne, bil, upResolve, upCache, log }) {
  const token = crypto.randomBytes(24).toString('hex');
  let server = null;
  let port = 0;
  let starting = null;
  const activeControllers = new Set();
  const headCache = new Map(); // cacheKey -> { total, contentType, at }

  function note(...a) {
    if (typeof log === 'function') {
      try { log(...a); } catch {}
    }
  }

  function trackCtrl(ctrl) {
    activeControllers.add(ctrl);
    return () => activeControllers.delete(ctrl);
  }

  async function fetchWithTimeout(url, opts = {}, timeoutMs = HEAD_TIMEOUT, parentSignal = null) {
    const ctrl = new AbortController();
    const untrack = trackCtrl(ctrl);
    const onParentAbort = () => { try { ctrl.abort(new Error('CLIENT_CLOSED')); } catch {} };
    if (parentSignal) {
      if (parentSignal.aborted) { untrack(); throw new Error('CLIENT_CLOSED'); }
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    const timer = setTimeout(() => { try { ctrl.abort(new Error('UPSTREAM_TIMEOUT')); } catch {} }, timeoutMs);
    try {
      const res = await net.fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      return {
        res,
        abort: () => {
          clearTimeout(timer);
          if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
          untrack();
          try { ctrl.abort(); } catch {}
        },
        cleanup: () => {
          clearTimeout(timer);
          if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
          untrack();
        }
      };
    } catch (e) {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
      untrack();
      throw e;
    }
  }

  async function openUpstreamNe(id, range, signal) {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      let info;
      try { info = await ne.songUrl(id); }
      catch (e) { return { status: 404, err: String((e && e.message) || e) }; }

      const headers = {};
      if (range) headers.Range = range;
      let handle;
      try {
        handle = await fetchWithTimeout(info.url, { headers }, HEAD_TIMEOUT, signal);
      } catch (e) {
        const timedOut = String((e && e.message) || e).includes('UPSTREAM_TIMEOUT');
        return { status: timedOut ? 504 : 502, err: String((e && e.message) || e) };
      }
      lastStatus = handle.res.status;
      if ((lastStatus === 401 || lastStatus === 403) && attempt === 0) {
        note('ne expired, refresh url id=' + id);
        handle.abort();
        if (typeof ne.invalidateUrl === 'function') ne.invalidateUrl(id);
        continue;
      }
      return { ok: true, handle, extHint: extFromUrlOrMime(info.url, handle.res.headers.get('content-type'), extFromCodec(info.codec)) };
    }
    return { status: 410, err: 'upstream ' + lastStatus };
  }

  async function openUpstreamBil(bvid, cid, range, signal) {
    let info;
    try { info = await bil.playUrl(bvid, cid); }
    catch (e) { return { status: 404, err: String((e && e.message) || e) }; }

    let last = 0;
    for (const target of (info.urls || [])) {
      let handle;
      try {
        handle = await fetchWithTimeout(target, {
          headers: {
            Referer: 'https://www.bilibili.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            Origin: 'https://www.bilibili.com',
            ...(range ? { Range: range } : {})
          }
        }, HEAD_TIMEOUT, signal);
      } catch {
        last = 0;
        continue;
      }
      last = handle.res.status;
      if (last === 401 || last === 403 || last === 404 || last === 410 || last >= 500) {
        handle.abort();
        continue;
      }
      return { ok: true, handle, extHint: info.fallback ? '.mp4' : '.m4a', fallbackVideo: !!info.fallback };
    }
    return { status: last ? 502 : 504, err: 'bilibili upstream ' + last };
  }

  async function openUpstreamUp(provider, id, range, signal) {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      let info;
      try { info = await upResolve(provider, id); }
      catch (e) { return { status: 404, err: String((e && e.message) || e) }; }

      const targets = info.urls && info.urls.length ? info.urls : [info.url];
      for (const target of targets) {
        if (!target) continue;
        let handle;
        try {
          handle = await fetchWithTimeout(target, {
            headers: { ...(info.headers || {}), ...(range ? { Range: range } : {}) }
          }, HEAD_TIMEOUT, signal);
        } catch {
          continue;
        }
        lastStatus = handle.res.status;
        if (lastStatus === 401 || lastStatus === 403 || lastStatus === 404 || lastStatus === 410) {
          handle.abort();
          continue;
        }
        return { ok: true, handle, extHint: info.ext || extFromUrlOrMime(target, handle.res.headers.get('content-type'), info.lossless ? '.flac' : '.mp3') };
      }
      if (attempt === 0 && upCache) {
        const prefix = provider + ':' + id + ':';
        for (const ck of upCache.keys()) { if (ck.startsWith(prefix)) upCache.delete(ck); }
        continue;
      }
    }
    return { status: 502, err: 'upstream expired ' + lastStatus };
  }

  async function handleRequest(req, res) {
    let u;
    try { u = new URL(req.url, 'http://127.0.0.1'); }
    catch { res.writeHead(400); res.end('bad url'); return; }

    if (u.searchParams.get('t') !== token) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('method not allowed');
      return;
    }

    const pathname = u.pathname || '';
    const dotIdx = pathname.lastIndexOf('.');
    const urlExt = dotIdx >= 0 ? pathname.slice(dotIdx).toLowerCase() : '.mp3';
    const noExt = dotIdx >= 0 ? pathname.slice(0, dotIdx) : pathname;

    let kind = '';
    let neId = 0;
    let bilBvid = '';
    let bilCid = 0;
    let upProvider = '';
    let upId = '';
    let cacheKey = '';

    let m;
    if ((m = /^\/ne\/(\d+)$/.exec(noExt))) {
      kind = 'ne';
      neId = Number(m[1]) || 0;
      cacheKey = 'ne:' + neId;
    } else if ((m = /^\/bil\/([^/]+)$/.exec(noExt))) {
      kind = 'bil';
      const decoded = decodeURIComponent(m[1]);
      const parts = decoded.split(':');
      bilBvid = parts[0] || '';
      bilCid = Number(parts[1]) || 0;
      cacheKey = 'bil:' + bilBvid + ':' + bilCid;
    } else if ((m = /^\/up\/(qqapp|kugou)\/(.+)$/.exec(noExt))) {
      kind = 'up';
      upProvider = m[1];
      upId = decodeURIComponent(m[2]);
      cacheKey = 'up:' + upProvider + ':' + upId;
    } else {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const reqAbort = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) {
        try { reqAbort.abort(); } catch {}
      }
    });

    // HEAD 探头：优先命中短期缓存，否则以 1 字节 Range 探出精确总长度与 MIME（兼容拒收 HEAD 的 CDN）
    if (req.method === 'HEAD') {
      const hit = headCache.get(cacheKey);
      if (hit && Date.now() - hit.at < 60_000) {
        const hdr = { 'Content-Type': hit.contentType, 'Accept-Ranges': 'bytes' };
        if (hit.total > 0) hdr['Content-Length'] = String(hit.total);
        res.writeHead(200, hdr);
        res.end();
        return;
      }
    }

    const wantRange = req.method === 'HEAD' ? 'bytes=0-0' : (req.headers.range || '');
    let opened;
    if (kind === 'ne') opened = await openUpstreamNe(neId, wantRange, reqAbort.signal);
    else if (kind === 'bil') opened = await openUpstreamBil(bilBvid, bilCid, wantRange, reqAbort.signal);
    else opened = await openUpstreamUp(upProvider, upId, wantRange, reqAbort.signal);

    if (!opened || !opened.ok) {
      if (!res.headersSent) {
        res.writeHead((opened && opened.status) || 502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end((opened && opened.err) || 'upstream error');
      }
      return;
    }

    const { handle, extHint, fallbackVideo } = opened;
    const upRes = handle.res;
    const outHeaders = {};
    for (const k of PASSTHROUGH) {
      const v = upRes.headers.get(k);
      if (v) outHeaders[k] = v;
    }
    if (!outHeaders['accept-ranges']) outHeaders['accept-ranges'] = 'bytes';
    outHeaders['content-type'] = fallbackVideo
      ? 'video/mp4'
      : normalizeMime(outHeaders['content-type'], extHint || urlExt);

    const totalLen = parseTotalFromRange(outHeaders['content-range']) || Number(outHeaders['content-length'] || 0);
    if (totalLen > 0) {
      headCache.set(cacheKey, { total: totalLen, contentType: outHeaders['content-type'], at: Date.now() });
      if (headCache.size > 80) headCache.delete(headCache.keys().next().value);
    }

    if (req.method === 'HEAD') {
      handle.abort();
      const hdr = { 'Content-Type': outHeaders['content-type'], 'Accept-Ranges': 'bytes' };
      if (totalLen > 0) hdr['Content-Length'] = String(totalLen);
      res.writeHead(200, hdr);
      res.end();
      return;
    }

    res.writeHead(upRes.status, outHeaders);
    if (!upRes.body) {
      handle.cleanup();
      res.end();
      return;
    }

    const nodeStream = Readable.fromWeb(upRes.body);
    const finish = () => handle.cleanup();
    nodeStream.on('error', () => {
      handle.abort();
      try { res.destroy(); } catch {}
    });
    res.on('close', () => {
      if (!res.writableEnded) {
        handle.abort();
        try { nodeStream.destroy(); } catch {}
      }
    });
    res.on('finish', finish);
    nodeStream.pipe(res);
  }

  function ensureStarted() {
    if (server && port > 0) return Promise.resolve(port);
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        handleRequest(req, res).catch((e) => {
          note('proxy err:', (e && e.message) || e);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end('proxy internal error');
          } else {
            try { res.destroy(); } catch {}
          }
        });
      });
      srv.on('error', (err) => {
        starting = null;
        reject(err);
      });
      srv.listen(0, '127.0.0.1', () => {
        server = srv;
        port = srv.address().port;
        starting = null;
        note('loopback proxy listening on 127.0.0.1:' + port);
        resolve(port);
      });
    });
    return starting;
  }

  async function createStreamUrl(key, codec = '') {
    const s = String(key || '').trim();
    if (!s) return { ok: false, code: 'BAD_KEY', message: '缺少在线曲目标识' };
    let p;
    try { p = await ensureStarted(); }
    catch (e) { return { ok: false, code: 'PROXY_START_FAILED', message: (e && e.message) || '回环代理启动失败' }; }

    if (/^ne:\d+$/.test(s)) {
      const id = s.slice(3);
      const ext = extFromCodec(codec, '.mp3');
      return { ok: true, source: 'netease', url: `http://127.0.0.1:${p}/ne/${id}${ext}?t=${token}` };
    }
    if (/^bil:BV[0-9A-Za-z]{10}(?::\d+)?$/.test(s)) {
      const rest = s.slice(4);
      const [bvid, cid] = rest.split(':');
      return { ok: true, source: 'bilibili', url: `http://127.0.0.1:${p}/bil/${encodeURIComponent(bvid)}:${Number(cid) || 0}.m4a?t=${token}` };
    }
    if (/^qq:[0-9A-Za-z]{8,24}$/.test(s)) {
      const id = s.slice(3);
      const ext = extFromCodec(codec, '.mp3');
      return { ok: true, source: 'qqapp', url: `http://127.0.0.1:${p}/up/qqapp/${encodeURIComponent(id)}${ext}?t=${token}` };
    }
    if (/^kg:[0-9A-Fa-f]{32}$/.test(s)) {
      const id = s.slice(3).toUpperCase();
      const ext = extFromCodec(codec, '.mp3');
      return { ok: true, source: 'kugou', url: `http://127.0.0.1:${p}/up/kugou/${encodeURIComponent(id)}${ext}?t=${token}` };
    }
    return { ok: false, code: 'UNSUPPORTED_SOURCE', message: '该音源暂不支持回环直通' };
  }

  function status() {
    return { running: !!(server && port > 0), port };
  }

  function dispose() {
    for (const c of activeControllers) {
      try { c.abort(); } catch {}
    }
    activeControllers.clear();
    headCache.clear();
    const srv = server;
    server = null;
    port = 0;
    starting = null;
    if (srv) {
      try { srv.close(); } catch {}
    }
  }

  return { createStreamUrl, status, dispose };
}

module.exports = { createExclusiveStreamProxy };
