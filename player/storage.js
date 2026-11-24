'use strict';
/**
 * 持久化与缓存目录统计/清理工具（主进程模块）
 * - readJSON：解析失败时把坏文件改名留档，避免曲库或设置凭空消失
 * - writeJSON：同步原子落盘（用于关窗前 *-sync）
 * - writeJSONAsync：按路径串行化异步原子写盘，不阻塞主进程事件循环
 * - calcDirStats / cleanDirContents：缓存目录体积统计与安全清理
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function readJSON(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) {
    if (e && e.code !== 'ENOENT') {
      const bak = `${p}.bad-${Date.now()}`;
      try { fs.renameSync(p, bak); console.error('readJSON failed, kept copy at', bak, e.message); } catch {}
    }
    return fb;
  }
}

function writeJSON(p, v, pretty = true) {
  try {
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v));
    fs.renameSync(tmp, p);
  } catch (e) { console.error('writeJSON', p, e); }
}

const writeQueues = new Map();
let writeSeq = 0;
function writeJSONAsync(p, v, pretty = false) {
  const payload = pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v);
  const prev = writeQueues.get(p) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const tmp = `${p}.${process.pid}.${++writeSeq}.tmp`;
    try {
      await fsp.writeFile(tmp, payload);
      await fsp.rename(tmp, p);
    } catch (e) {
      try { await fsp.unlink(tmp); } catch {}
      console.error('writeJSONAsync', p, e);
    }
  });
  writeQueues.set(p, next);
  next.finally(() => { if (writeQueues.get(p) === next) writeQueues.delete(p); });
  return next;
}

async function calcDirStats(rootDir, maxDepth = 6) {
  let bytes = 0;
  let files = 0;
  const walk = async (dir, depth) => {
    if (depth > maxDepth) return;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (ent.isFile()) {
        try {
          const st = await fsp.stat(full);
          bytes += st.size || 0;
          files++;
        } catch {}
      }
    }
  };
  await walk(rootDir, 0);
  return { bytes, files };
}

async function cleanDirContents(dirPath) {
  let ents;
  try { ents = await fsp.readdir(dirPath, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    const full = path.join(dirPath, ent.name);
    try { await fsp.rm(full, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  readJSON,
  writeJSON,
  writeJSONAsync,
  calcDirStats,
  cleanDirContents
};
