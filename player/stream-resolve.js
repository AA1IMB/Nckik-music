'use strict';
const crypto = require('crypto');
/* ---------------- 取流：QQ 音乐 / 酷狗 ----------------
 * 只做「拿到可播的直链」，音频本身交给自定义协议代理（带 Referer / 超时）。
 *   - 酷狗：m.kugou.com 的 playInfo 公开接口，按 128k→320k 依次试；
 *   - QQ 音乐：musicu 的 GetVkey（用登录 cookie 里的 uin + musickey），
 *     拿到 purl 再拼成 http(s) 直链，VIP/版权受限时给明确错误码。
 * 两条路都不做签名算法；拿不到就抛带 code 的错误。
 */

const KG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const QQ_UA = 'QQMusic 14090008(android 12)';
const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ---------- 酷狗 ---------- */

/* 客户端签名取链（会员权益走这条）：
 * signature = md5(salt + 排序后的 k=v 拼接 + salt)；key = md5(hash + salt2 + appid + mid + userid)。
 * 只在本地拼参数、只读接口，不伪造登录、不绕过任何授权校验。 */
const KG_WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const KG_KEY_SALT = '57ae12eb6890223e355ccfcb74edf70d';

function kgSign(params) {
  const raw = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('');
  return crypto.createHash('md5').update(KG_WEB_SALT + raw + KG_WEB_SALT, 'utf8').digest('hex');
}

function kgCookieField(cookie, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(String(cookie || ''));
  return m ? m[1] : '';
}

/** 用客户端 token 问 trackercdn 要直链；拿不到返回 null（不抛错，交给免费链路兜底） */
async function kgPrivilegeUrl(cred, hash, qualityKey) {
  const extra = (cred && cred.extra) || {};
  const token = extra.token || kgCookieField(cred && cred.cookie, 'token');
  const userid = extra.userid || kgCookieField(cred && cred.cookie, 'userid');
  if (!token || !userid) return null;
  const mid = extra.mid || kgCookieField(cred && cred.cookie, 'mid');
  const dfid = extra.dfid || kgCookieField(cred && cred.cookie, 'dfid');
  const appid = '1005';
  const lower = String(hash).toLowerCase();
  const params = {
    dfid: dfid || '-',
    mid: mid || '',
    uuid: '-',
    appid,
    clientver: '11430',
    clienttime: String(Math.floor(Date.now() / 1000)),
    token,
    userid,
    hash: lower,
    album_id: '0',
    album_audio_id: '0',
    quality: String(qualityKey),
    page_id: '151369488',
    ppage_id: '463467626,350369493,788954147',
    pid: '2',
    cmd: '26',
    key: crypto.createHash('md5').update(lower + KG_KEY_SALT + appid + (mid || '') + userid, 'utf8').digest('hex')
  };
  params.signature = kgSign(params);
  const url = 'https://trackercdn.kugou.com/v5/url?' + new URLSearchParams(params).toString();
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': KG_UA,
        'x-router': 'trackercdn.kugou.com',
        Accept: 'application/json'
      }
    });
    if (!r.ok) return null;
    const j = await r.json();
    const first = Array.isArray(j.url) ? j.url[0] : j.url;
    const picked = typeof first === 'string' ? first : (first && first.url);
    if (typeof picked === 'string' && /^https?:\/\//.test(picked)) return picked;
    return null;
  } catch {
    return null;
  }
}

const KG_QUALITY = [
  { key: '320', label: '320k' },
  { key: '128', label: '128k' }
];

async function kgPlayInfo(hash, qualityKey) {
  const url = `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}&album_id=0&album_audio_id=0`;
  const r = await fetch(url, { headers: { 'User-Agent': KG_UA, Referer: 'https://www.kugou.com/' } });
  if (!r.ok) throw fail('E_UPSTREAM_HTTP', `酷狗取流返回 ${r.status}`);
  let j;
  try { j = await r.json(); } catch { throw fail('E_UPSTREAM_BAD_JSON', '酷狗取流没有返回 JSON'); }
  const pay = Number(j.pay_type || 0);
  if (pay > 0 || (!j.url && !j.backup_url)) {
    if (pay > 0) throw fail('E_NO_COPYRIGHT', '这首是 VIP/付费曲目，需要用会员账号播放');
    throw fail('E_NO_STREAM', '酷狗没有给出可播地址');
  }
  /* playInfo 同时给 128k 的 url 与 320k 的 url：按请求档位挑，拿不到就退回另一个 */
  const pick = qualityKey === '320'
    ? (j.url || j.backup_url)
    : (j.backup_url || j.url);
  if (!pick) throw fail('E_NO_STREAM', '酷狗没有给出可播地址');
  return { url: String(pick), bitrate: Number(j.bitRate || 0), ext: String(j.extName || 'mp3') };
}

async function kgResolve(hash, prefer, cred) {
  const h = String(hash || '').toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(h)) throw fail('E_BAD_TRACK', '酷狗曲目 id 不正确');
  const order = prefer === 'standard' ? [...KG_QUALITY].reverse() : KG_QUALITY;
  let lastErr = null;
  for (const q of order) {
    /* 先问客户端签名通道：付费曲只有这条能给直链；免费曲也走它，失败再回落 playInfo */
    if (cred) {
      const signedUrl = await kgPrivilegeUrl(cred, h, q.key);
      if (signedUrl) {
        return { url: signedUrl, quality: q.label, headers: { Referer: 'https://www.kugou.com/', 'User-Agent': KG_UA } };
      }
    }
    try {
      const r = await kgPlayInfo(h, q.key);
      return { url: r.url, quality: q.label, headers: { Referer: 'https://www.kugou.com/', 'User-Agent': KG_UA } };
    } catch (e) {
      lastErr = e;
      if (e.code === 'E_NO_COPYRIGHT') break;
    }
  }
  throw lastErr || fail('E_NO_STREAM', '酷狗没有给出可播地址');
}

/* ---------- QQ 音乐 ---------- */

const QQ_FILES = [
  { prefix: 'M800', ext: '.mp3', quality: '320k' },
  { prefix: 'M500', ext: '.mp3', quality: '128k' }
];

function qqComm(cred) {
  return {
    ct: 11, cv: 14090008, v: 14090008, chid: '10003505', tmeAppID: 'qqmusic',
    tmeLoginType: 2, qq: String(cred.uin || ''), authst: String(cred.musickey || '')
  };
}

function qqGuid() {
  /* vkey 需要 guid；用一个稳定的伪随机串即可（服务端只当作会话标识） */
  let s = '';
  const hex = '0123456789abcdef';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

async function qqVkey(cred, mid, file, tune) {
  const comm = qqComm(cred);
  if (tune.qqZero) comm.qq = '0';
  if (tune.noAuthst) delete comm.authst;
  if (tune.loginType) comm.tmeLoginType = tune.loginType;
  const body = {
    comm,
    req_0: {
      module: 'music.vkey.GetVkey', method: 'UrlGetVkey',
      param: {
        filename: [file], guid: tune.guid || qqGuid(), songmid: [mid], songtype: [0],
        uin: String(tune.uinOverride != null ? tune.uinOverride : (cred.uin || '0')),
        loginflag: 1, platform: tune.platform || '20'
      }
    }
  };
  const r = await fetch(MUSICU, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': QQ_UA, Referer: 'https://y.qq.com/' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw fail('E_UPSTREAM_HTTP', `QQ 音乐取流返回 ${r.status}`);
  const j = await r.json();
  const code = (j.req_0 && j.req_0.code) || j.code || 0;
  if (code !== 0) {
    const msg = (j.req_0 && j.req_0.message) || j.message || '';
    throw fail(code === 1000 || code === 104400 ? 'E_AUTH_REQUIRED' : 'E_UPSTREAM_CODE',
      `QQ 音乐取流返回 ${code}${msg ? '：' + msg : ''}`);
  }
  const info = (j.req_0 && j.req_0.data && j.req_0.data.midurlinfo && j.req_0.data.midurlinfo[0]) || {};
  return String(info.purl || '');
}

async function qqResolve(mid, cred, prefer) {
  const m = String(mid || '').trim();
  if (!/^[0-9A-Za-z]{10,20}$/.test(m)) throw fail('E_BAD_TRACK', 'QQ 曲目 id 不正确');
  if (!cred || !cred.musickey) throw fail('E_AUTH_REQUIRED', 'QQ 音乐还没有登录');
  const files = prefer === 'standard' ? [...QQ_FILES].reverse() : QQ_FILES;
  /* GetVkey 对 comm 的细节很敏感：不同账号/版本下 uin 该放 comm.qq 还是 param.uin、
   * guid 是否需要与登录一致、platform 给 20 还是 yqq，都可能决定 purl 是否为空。
   * 这里按「最像官方客户端」到「最宽松」的顺序试，命中即返回。 */
  const tunes = [
    { platform: '20' },
    { platform: 'yqq.json' },
    { qqZero: true, platform: '20' },
    { loginType: 6, platform: '20' },
    { noAuthst: true, platform: 'yqq.json' },
    { uinOverride: '0', platform: '20' }
  ];
  let lastErr = null;
  for (const f of files) {
    for (const t of tunes) {
      try {
        /* filename 必须是「prefix + songmid + media_mid + ext」两段识别值：
         * 只送一段时 vkey server 照样给 purl，但 CDN 会 403/404（folia 的注释也这么写）。 */
        const purl = await qqVkey(cred, m, f.prefix + m + m + f.ext, t);
        if (!purl) { lastErr = fail('E_NO_STREAM', 'QQ 音乐没有给出可播地址'); continue; }
        const path = purl.startsWith('http') ? purl.replace(/^https?:\/\/[^/]+\//, '') : purl;
        const url = 'https://sjy6.stream.qqmusic.qq.com/' + path;
        console.log('[qqvkey] ok', JSON.stringify(t), f.prefix, purl.slice(0, 40));
        /* CDN 对未带登录 cookie 的请求会 403/302 到空内容，带上 uin + keyst 最稳 */
        const cookie = `uin=${cred.uin}; qm_keyst=${cred.musickey}; qqmusic_key=${cred.musickey}`;
        return { url, quality: f.quality, headers: { Referer: 'https://y.qq.com/', 'User-Agent': QQ_UA, Cookie: cookie } };
      } catch (e) {
        lastErr = e;
        console.log('[qqvkey] fail', JSON.stringify(t), f.prefix, e.code, String(e.message).slice(0, 60));
        if (e.code === 'E_NO_COPYRIGHT' || e.code === 'E_AUTH_REQUIRED') return Promise.reject(e);
      }
    }
  }
  throw lastErr || fail('E_NO_STREAM', 'QQ 音乐没有给出可播地址');
}

module.exports = { kgResolve, qqResolve };
