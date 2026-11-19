'use strict';
/*
 * 酷狗凭证存取（只管「存哪儿、怎么加密、怎么解析」，不发请求）
 * ---------------------------------------------------------------
 * 与网易云的 ne-auth.bin 同一套策略：
 *   - 用系统密钥库（Windows DPAPI / macOS Keychain）加密后落盘为 kg-auth.bin；
 *   - 明文只在这一层内存里出现，IPC 只回脱敏后的摘要（见 mask()）；
 *   - 解析失败/解密失败一律当作「没登录」，不让坏文件把启动搞挂。
 *
 * 为什么不直接塞进 settings.json：那个文件会被导出/分享/进备份，
 * 而且 renderer 能通过 getSettings 读到全部字段 —— 凭证不该走那条路。
 */

const fs = require('node:fs');
const path = require('node:path');

/* 酷狗会话相关的 cookie 名（浏览器里登录后都能看到）：
 *   kg_mid / kg_dfid 是设备号，必须保留；
 *   token / userid（或 KugooID / KuGoo）才是账号身份。 */
const DEVICE_KEYS = ['kg_mid', 'kg_dfid', 'kg_dfid_collect'];
const AUTH_KEYS = ['token', 'userid', 'kugoo', 'kugoo_id', 'kg_userid', 'uid'];

function createStore({ filePath, safeStorage }) {
  const p = filePath;

  function readRaw() {
    try {
      if (!fs.existsSync(p)) return null;
      const buf = fs.readFileSync(p);
      if (!safeStorage.isEncryptionAvailable()) return null;   // 没有密钥库：不读，避免读到密文乱码
      const text = safeStorage.decryptString(buf);
      const j = JSON.parse(text);
      return j && typeof j === 'object' ? j : null;
    } catch {
      return null;                                             // 坏文件当没登录，不删也不报错
    }
  }

  function writeRaw(obj) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw Object.assign(new Error('系统密钥库不可用，无法安全保存凭证'), { code: 'KG_AUTH_NO_KEYSTORE' });
    }
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(obj)));
    fs.renameSync(tmp, p);                                     // 临时文件 + rename：断电不会写半截
  }

  function clear() {
    try { fs.unlinkSync(p); } catch {}
  }

  /* 把用户从浏览器复制来的 Cookie 串拆成「设备头 + 身份」。
   * 兼容几种常见粘法：
   *   "kg_mid=...; token=...; userid=123"
   *   "Cookie: kg_mid=...; ..."
   *   每行一个 "name=value"（DevTools 的 Copy all as HAR 之外的纯文本）
   * 只保留认识的键，其余（实验性 cookie）丢掉，避免把无关追踪串带进请求。 */
  function parseCookie(input) {
    let s = String(input || '').trim();
    if (!s) return { cookie: '', token: '', userid: 0, keys: [] };
    s = s.replace(/^cookie\s*:\s*/i, '').replace(/[\r\n]+/g, '; ');
    const kept = new Map();
    for (const part of s.split(';')) {
      const seg = part.trim();
      if (!seg) continue;
      const at = seg.indexOf('=');
      if (at <= 0) continue;
      const k = seg.slice(0, at).trim().toLowerCase();
      const v = seg.slice(at + 1).trim();
      if (!v) continue;
      if (DEVICE_KEYS.includes(k) || AUTH_KEYS.includes(k)) kept.set(k, v);
      else if (k === 'token') kept.set(k, v);                  // 上面 AUTH_KEYS 里已含，兜底重复
    }
    const cookie = [...kept.entries()].map(([k, v]) => k + '=' + v).join('; ');
    const token = kept.get('token') || kept.get('kugoo') || '';
    const userid = Number(kept.get('userid') || kept.get('kugoo_id') || kept.get('kg_userid') || kept.get('uid') || 0) || 0;
    return { cookie, token, userid, keys: [...kept.keys()] };
  }

  function hasIdentity(parsed) {
    return !!(parsed.token || parsed.userid);
  }

  /* 只给探针/日志用的脱敏摘要：真值一个字符都不外流，长度也能帮忙判断有没有粘全。 */
  function mask(value) {
    const s = String(value || '');
    if (!s) return '';
    if (s.length <= 8) return '*'.repeat(s.length);
    return s.slice(0, 4) + '…' + s.slice(-2) + `(${s.length})`;
  }

  function maskSummary(obj) {
    if (!obj) return null;
    return {
      hasCookie: !!obj.cookie,
      cookieLen: obj.cookie ? obj.cookie.length : 0,
      token: mask(obj.token),
      userid: Number(obj.userid) || 0
    };
  }

  return { filePath: p, readRaw, writeRaw, clear, parseCookie, hasIdentity, mask, maskSummary };
}

module.exports = { createStore, DEVICE_KEYS, AUTH_KEYS };
