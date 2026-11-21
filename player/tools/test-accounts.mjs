/**
 * 账号层自测（node 直接跑编译产物，不依赖 electron）
 * 覆盖：状态机四相位 / 二维码过期 / 已扫码 60s / 瞬时失败容忍 / 多账号切换持久化 /
 *       取流降级 / 限流立即停 / 未登录拒绝 / 密钥库不可用。
 *
 * 运行：npx tsc -p tsconfig.accounts.json && node tools/test-accounts.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'accounts', 'dist', 'src');
const { createAccountsModule, registerAccountsIpc } = require(path.join(dist, 'index.js'));
const { AccountManager } = require(path.join(dist, 'accountManager.js'));
const { LoginSession } = require(path.join(dist, 'loginSession.js'));
const { CredentialStore } = require(path.join(dist, 'credentialStore.js'));
const { resolveAudio } = require(path.join(dist, 'stream.js'));
const { AccountError } = require(path.join(dist, 'errors.js'));

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(name + (extra ? ` → ${JSON.stringify(extra)}` : ''));
    console.log(`  ✗ ${name}`, extra ?? '');
  }
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), name, { actual, expected });
}

/* ---------------- 假实现 ---------------- */

const nowRef = { t: 1_700_000_000_000 };
const now = () => nowRef.t;
const logger = { info() {}, warn() {} };

function fakeCipher(available = true) {
  return {
    available: () => available,
    encrypt: s => Buffer.from('enc:' + s, 'utf8'),
    decrypt: b => {
      const s = b.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('bad cipher');
      return s.slice(4);
    }
  };
}

function fakeFs() {
  const files = new Map();
  const renames = [];
  return {
    files,
    renames,
    existsSync: p => files.has(p),
    readFileSync: p => Buffer.from(files.get(p)),
    writeFileSync: (p, d) => files.set(p, String(d)),
    renameSync: (a, b) => {
      renames.push([a, b]);
      files.set(b, files.get(a));
      files.delete(a);
    },
    unlinkSync: p => files.delete(p),
    mkdirSync() {}
  };
}

/** 可编排的登录窗口：二维码、cookie、页面文案都按脚本变 */
function fakeHost(script) {
  const state = { url: '', cookies: {}, text: '', qr: script.qr ?? null, opened: false };
  return {
    state,
    async open(url) {
      state.opened = true;
      state.url = url;
    },
    async readCookies(names) {
      const out = {};
      for (const n of names) if (state.cookies[n]) out[n] = state.cookies[n];
      return out;
    },
    async readQrImage() {
      return state.qr;
    },
    async readPageText() {
      return state.text;
    },
    async currentUrl() {
      return state.url;
    },
    async close() {
      state.opened = false;
    },
    onCookiesChanged() {
      return () => {};
    }
  };
}

const BIG_QR = 'data:image/png;base64,' + 'A'.repeat(2000);
const transportStub = { getJson: async () => ({ status: 200, body: {} }), postJson: async () => ({ status: 200, body: {} }) };

/* ---------------- 1. 状态机 ---------------- */

{
  const snaps = [];
  let i = 0;
  const session = new LoginSession({
    provider: 'qq',
    now,
    logger,
    poll: async () => {
      i += 1;
      if (i === 1) return { phase: 'waiting' };
      if (i === 2) return { phase: 'scanned' };
      return {
        phase: 'confirmed',
        account: { id: 'qq:1', provider: 'qq', name: 'n', userId: '1', avatarUrl: '', createdAt: now(), lastLoginAt: now() },
        credential: { cookie: 'uin=1', extra: { uid: '1' }, updatedAt: now(), verifiedAt: 0 }
      };
    }
  });
  snaps.push(session.opened({ image: BIG_QR, expiresAt: now() + 180_000 }, '请扫码').phase);
  snaps.push((await session.tick()).phase);
  snaps.push((await session.tick()).phase);
  const confirmed = await session.tick();
  snaps.push(confirmed.phase);
  eq(snaps, ['waiting', 'waiting', 'scanned', 'confirmed'], '状态机 visited 正常路径');
  ok(!!session.takeCredential(), '确认后能取到凭据');
  ok(session.takeCredential() === null, '凭据只能取一次');
  eq((await session.tick()).phase, 'confirmed', '已终态的 tick 幂等');
}

/* ---------------- 2. 二维码过期 ---------------- */

{
  const session = new LoginSession({ provider: 'qq', now, logger, poll: async () => ({ phase: 'waiting' }) });
  session.opened({ image: BIG_QR, expiresAt: now() + 1_000 }, '');
  nowRef.t += 2_000;
  const snap = await session.tick();
  eq(snap.phase, 'expired', '二维码到期即 expired');
  eq(snap.error.code, 'E_QR_EXPIRED', '过期错误码');
  nowRef.t -= 2_000;
}

/* ---------------- 3. 已扫码 60s 未确认 ---------------- */

{
  const session = new LoginSession({ provider: 'kugou', now, logger, poll: async () => ({ phase: 'scanned' }) });
  session.opened({ image: BIG_QR, expiresAt: now() + 180_000 }, '');
  eq((await session.tick()).phase, 'scanned', '进入 scanned');
  nowRef.t += 61_000;
  const snap = await session.tick();
  eq(snap.phase, 'failed', '已扫码超时判失败');
  eq(snap.error.code, 'E_LOGIN_TIMEOUT', '超时错误码');
  nowRef.t -= 61_000;
}

/* ---------------- 4. 瞬时失败容忍 ---------------- */

{
  let calls = 0;
  const session = new LoginSession({
    provider: 'qq',
    now,
    logger,
    transientLimit: 2,
    poll: async () => {
      calls += 1;
      throw new AccountError('E_UPSTREAM_UNAVAILABLE', '网络抖动');
    }
  });
  session.opened({ image: BIG_QR, expiresAt: now() + 180_000 }, '');
  const a = await session.tick();
  const b = await session.tick();
  const c = await session.tick();
  eq([a.phase, b.phase, c.phase], ['waiting', 'waiting', 'failed'], '两次抖动继续等，第三次失败');
  eq(calls, 3, '三次才真正失败');
}

/* ---------------- 5. 存储 + 多账号切换 ---------------- */

{
  const fs = fakeFs();
  const store = new CredentialStore({ file: 'U/accounts.bin', cipher: fakeCipher(), fs, logger, now });
  const acc = (id, name, last) => ({ id, provider: 'qq', name, userId: id.split(':')[1], avatarUrl: '', createdAt: now(), lastLoginAt: last });
  store.upsert(acc('qq:1', '甲', 10), { cookie: 'a=1', extra: {}, updatedAt: now(), verifiedAt: now() });
  store.upsert(acc('qq:2', '乙', 20), { cookie: 'b=2', extra: {}, updatedAt: now(), verifiedAt: now() });
  store.setCurrent('qq', 'qq:2');
  eq(store.list('qq').map(a => a.name), ['乙', '甲'], '列表按最近登录排序');
  eq(store.current('qq').id, 'qq:2', '当前账号');
  eq(store.credential('qq:1').cookie, 'a=1', '凭据可解密');
  const raw = fs.files.get('U/accounts.bin');
  const sealed = JSON.parse(raw).buckets.qq['qq:1'].sealed;
  ok(!!sealed && /^[A-Za-z0-9+/=]+$/.test(sealed), '落盘凭据是 base64 密文');
  ok(!raw.includes('a=1'), '明文 cookie 不落盘');

  // 重新加载：模拟重启
  const store2 = new CredentialStore({ file: 'U/accounts.bin', cipher: fakeCipher(), fs, logger, now });
  eq(store2.list('qq').length, 2, '重启后账号仍在');
  eq(store2.current('qq').id, 'qq:2', '重启后当前账号仍是乙');
  store2.remove('qq:2');
  eq(store2.current('qq'), null, '删掉当前账号后 current 清空');

  // 坏文件留档
  const fs2 = fakeFs();
  fs2.files.set('U/accounts.bin', '{not json');
  const store3 = new CredentialStore({ file: 'U/accounts.bin', cipher: fakeCipher(), fs: fs2, logger, now });
  eq(store3.list().length, 0, '坏文件当空库');
  ok(fs2.renames.length === 1, '坏文件被改名留档');

  // 密钥库不可用
  const store4 = new CredentialStore({ file: 'V/accounts.bin', cipher: fakeCipher(false), fs: fakeFs(), logger, now });
  let cipherErr = null;
  try {
    store4.upsert(acc('qq:9', '丙', 1), { cookie: 'c=3', extra: {}, updatedAt: now(), verifiedAt: now() });
  } catch (e) {
    cipherErr = e;
  }
  eq(cipherErr && cipherErr.code, 'E_CIPHER_UNAVAILABLE', '密钥库不可用时拒写并给错误码');
}

/* ---------------- 6. 管理器：扫码 → 落盘 → 切换 → 登出 ---------------- */

{
  const fs = fakeFs();
  const host = fakeHost({ qr: BIG_QR });
  const mod = createAccountsModule({
    dataDir: 'W',
    cipher: fakeCipher(),
    host,
    transport: transportStub,
    logger,
    now,
    fs
  });
  const begin = await mod.manager.beginLogin('qq');
  eq(begin.phase, 'waiting', 'beginLogin 出码即 waiting');
  ok(host.state.opened, '打开了官方登录页');

  // 页面写入登录 cookie（qm_keyst），下一次 poll 应确认
  await new Promise(r => setTimeout(r, 5));
  host.state.cookies = { qm_keyst: 'KEY1', uin: 'o12345' };
  const snap = await mod.manager.pollLogin('qq');
  eq(snap.phase, 'confirmed', 'poll 到 cookie 即 confirmed');
  eq(snap.account.id, 'qq:12345', 'uin 去 o 前缀后作为账号 id');
  eq(mod.manager.list('qq').length, 1, '账号已登记');
  ok(!!mod.manager.credentialOf('qq'), '凭据可取');

  // 切换：新增一个账号再切回第一个
  const first = mod.manager.current('qq');
  const cred = {
    cookie: 'qm_keyst=KEY2; uin=o999',
    extra: { uid: '999' },
    updatedAt: now(),
    verifiedAt: now()
  };
  mod.store.upsert({ ...first, id: 'qq:999', userId: '999', name: '第二号', lastLoginAt: now() }, cred);
  mod.store.setCurrent('qq', 'qq:999');
  const switched = await mod.manager.switchTo(first.id);
  eq(switched.id, 'qq:12345', '切回第一个账号');
  eq(mod.manager.current('qq').id, 'qq:12345', '当前账号已更新');

  mod.manager.logout(first.id);
  eq(mod.manager.list('qq').length, 1, '退出后只剩一个账号');
  await mod.dispose();
}

/* ---------------- 7. 取流降级 ---------------- */

{
  const ladder = {
    standard: ['standard'],
    high: ['high', 'standard'],
    lossless: ['lossless', 'high', 'standard'],
    hires: ['hires', 'lossless', 'high', 'standard']
  };
  const seen = [];
  const provider = {
    id: 'kugou',
    ladder,
    async fetchAudio(ctx) {
      seen.push(ctx.quality);
      if (ctx.quality === 'lossless') return { block: { kind: 'copyright' } };
      if (ctx.quality === 'high') return { block: { kind: 'vip' } };
      if (ctx.quality === 'hires') return { block: { kind: 'copyright' } };
      return { url: 'https://cdn/x.mp3', bitrateKbps: 128, ttlMs: 60_000 };
    }
  };
  const res = await resolveAudio(provider, { songId: 'H1', quality: 'lossless' }, { now });
  eq(res.quality, 'standard', '无损不可播时降到标准档');
  eq(res.tried, ['lossless', 'high', 'standard'], '记录尝试过的档位');
  eq(res.bitrateKbps, 128, '回传真实码率');
  ok(res.expiresAt > now(), '地址带过期时刻');

  // 全部不可播 → 无版权
  const deadProvider = { id: 'kugou', ladder, fetchAudio: async () => ({ block: { kind: 'copyright' } }) };
  let deadErr = null;
  try {
    await resolveAudio(deadProvider, { songId: 'H2', quality: 'high' }, { now });
  } catch (e) {
    deadErr = e;
  }
  eq(deadErr && deadErr.code, 'E_NO_COPYRIGHT', '全档不可播报无版权');

  // 429 立即停，不再降档
  const seen2 = [];
  const rateProvider = {
    id: 'qq',
    ladder,
    async fetchAudio(ctx) {
      seen2.push(ctx.quality);
      throw new AccountError('E_RATE_LIMITED', '太频繁', { retryAfterMs: 30_000 });
    }
  };
  let rateErr = null;
  try {
    await resolveAudio(rateProvider, { songId: 'S1', quality: 'hires' }, { now });
  } catch (e) {
    rateErr = e;
  }
  eq(rateErr && rateErr.code, 'E_RATE_LIMITED', '限流立即抛');
  eq(seen2, ['hires'], '限流不再尝试低档位');

  // 未登录 → E_AUTH_REQUIRED
  const mod = createAccountsModule({
    dataDir: 'X',
    cipher: fakeCipher(),
    host: fakeHost({ qr: BIG_QR }),
    transport: transportStub,
    logger,
    now,
    fs: fakeFs()
  });
  let authErr = null;
  try {
    await mod.manager.audioFor('qq', { songId: 'S1', quality: 'high' });
  } catch (e) {
    authErr = e;
  }
  eq(authErr && authErr.code, 'E_AUTH_REQUIRED', '没有账号时拒绝取流');
  ok(authErr.hint && authErr.hint.includes('扫码'), '给出可读的下一步提示');
}

/* ---------------- 10. 误判回归：空必填名单 / 没有账号标识 ---------------- */

{
  // QQ 的 requiredCookieNames 是空数组：`[].every()` 恒真，早期版本因此在二维码刚出来时就 confirmed
  const { PageLoginProvider } = require(path.join(dist, 'providers', 'base.js'));
  const host = fakeHost({ qr: BIG_QR });
  const provider = new PageLoginProvider({
    cfg: {
      id: 'qq',
      label: 'QQ 音乐',
      loginUrl: 'https://y.qq.com/',
      partition: 'persist:t',
      cookieNames: ['qm_keyst', 'qqmusic_key', 'uin'],
      requiredCookieNames: [],
      qrTimeoutMs: 1000,
      qrTtlMs: 1000,
      expiredPatterns: [/失效/],
      scannedPatterns: [/已扫码/]
    },
    host,
    transport: transportStub,
    logger,
    ladder: { standard: ['standard'], high: ['high'], lossless: ['lossless'], hires: ['hires'] },
    fetchAudio: async () => ({ url: 'u' }),
    now
  });
  const first = await provider.login.poll();
  eq(first.phase, 'waiting', '必填名单为空 + 没有任何 cookie → 仍是 waiting');

  // 有登录类 cookie 但拿不到 uin：不能确认（否则会落盘成 uid unknown）
  host.state.cookies = { qm_keyst: 'k' };
  const second = await provider.login.poll();
  eq(second.phase, 'waiting', '只有 qm_keyst、没有 uin → 不确认');

  // 必填名单非空时，命中 + 有 uid 才确认
  const host2 = fakeHost({ qr: BIG_QR });
  const provider2 = new PageLoginProvider({
    cfg: {
      id: 'kugou',
      label: '酷狗',
      loginUrl: 'https://login-user.kugou.com/',
      partition: 'persist:t2',
      cookieNames: ['token', 'userid'],
      requiredCookieNames: ['token', 'userid'],
      qrTimeoutMs: 1000,
      qrTtlMs: 1000,
      expiredPatterns: [/失效/],
      scannedPatterns: [/已扫码/]
    },
    host: host2,
    transport: transportStub,
    logger,
    ladder: { standard: ['standard'], high: ['high'], lossless: ['lossless'], hires: ['hires'] },
    fetchAudio: async () => ({ url: 'u' }),
    now
  });
  host2.state.cookies = { token: 't' };
  eq((await provider2.login.poll()).phase, 'waiting', '只有 token、没有 userid → 不确认');
  host2.state.cookies = { token: 't', userid: '555' };
  const confirmed = await provider2.login.poll();
  eq(confirmed.phase, 'confirmed', 'token + userid 都齐 → confirmed');
  eq(confirmed.credential.extra.uid, '555', 'userid 进 extra.uid');

  // QQ 自己的判据：qm_keyst 必须配 uin
  const { QqProvider } = require(path.join(dist, 'providers', 'qq.js'));
  const kh = fakeHost({ qr: BIG_QR });
  const qq = new QqProvider({ host: kh, transport: transportStub, logger, now });
  kh.state.cookies = { qm_keyst: 'k' };
  eq((await qq.login.poll()).phase, 'waiting', 'QqProvider：只有 qm_keyst → waiting');
  kh.state.cookies = { qm_keyst: 'k', uin: 'o777' };
  const qqOk = await qq.login.poll();
  eq(qqOk.phase, 'confirmed', 'QqProvider：qm_keyst + uin → confirmed');
  eq(qqOk.credential.extra.uid, '777', 'uin 的 o 前缀被剥掉');
}

{
  // 历史误判写进库里的 uid unknown 账号，构造时被清掉
  const fsLike = fakeFs();
  const store = new CredentialStore({ file: 'U/accounts.bin', cipher: fakeCipher(), fs: fsLike, logger, now });
  store.upsert(
    { id: 'qq:unknown', provider: 'qq', name: 'uid unknown', userId: 'unknown', avatarUrl: '', createdAt: now(), lastLoginAt: now() },
    { cookie: 'c=1', extra: {}, updatedAt: now(), verifiedAt: now() }
  );
  store.upsert(
    { id: 'qq:999', provider: 'qq', name: 'uid 999', userId: '999', avatarUrl: '', createdAt: now(), lastLoginAt: now() },
    { cookie: 'c=2', extra: {}, updatedAt: now(), verifiedAt: now() }
  );
  const mod = new AccountManager({
    store,
    providers: {},
    host: fakeHost({ qr: BIG_QR }),
    transport: transportStub,
    logger,
    now
  });
  void mod;
  eq(
    store.list().map(a => a.userId),
    ['999'],
    '构造时清掉 uid unknown 的占位账号'
  );
}

/* ---------------- §9 QQ 音乐 App 扫码（协议通道） ---------------- */

function fakeMusicu(opts = {}) {
  const calls = [];
  const stub = async (_url, body) => {
    const method = body.req_0.method;
    calls.push(method);
    if (method === 'CreateQRCode') {
      return {
        status: 200,
        body: { code: 0, req_0: { code: 0, data: { qrcodeID: 'QID-TEST-1', qrcode: 'data:image/png;base64,AAAA', expiresIn: 900 } } }
      };
    }
    if (method === 'Login') {
      if (opts.loginCode) return { status: 200, body: { code: 0, req_0: { code: opts.loginCode, data: {} } } };
      return {
        status: 200,
        body: {
          code: 0,
          req_0: { code: 0, data: { musickey: 'K'.repeat(48), str_musicid: '1707959004', loginType: 2, nick: '月亮在不在' } }
        }
      };
    }
    if (method === 'GetLoginUserInfo') {
      return { status: 200, body: { code: 0, req_0: { code: 0, data: { info: { nick: '月亮在不在' } } } } };
    }
    return { status: 200, body: { code: 0, req_0: { code: 0, data: {} } } };
  };
  return { calls, transport: { getJson: stub, postJson: stub } };
}

/** 假 broker：收到 CONNECT 回 CONNACK，收到 SUBSCRIBE 回 SUBACK，之后由测试手动 feed */
function fakeMqtt() {
  const sent = [];
  const st = { sent, closed: false, url: '', handlers: null };
  st.connect = (url, handlers) => {
    st.url = url;
    st.handlers = handlers;
    setTimeout(() => handlers.onopen?.(), 0);
    return {
      send(bytes) {
        const buf = Buffer.from(bytes);
        sent.push(buf);
        if (buf[0] === 0x10) setTimeout(() => handlers.onmessage?.(new Uint8Array([0x20, 3, 0, 0, 0])), 0);
        if (buf[0] === 0x82) {
          const m = /management\.qrcode_login\/[A-Za-z0-9_-]+/.exec(buf.toString('latin1'));
          if (m) st.topic = m[0];
          setTimeout(() => handlers.onmessage?.(new Uint8Array([0x90, 4, 0, 1, 0, 0])), 0);
        }
      },
      close() {
        st.closed = true;
        handlers.onclose?.(1000, 'closed');
      }
    };
  };
  st.feed = obj => {
    const topic = Buffer.from(st.topic, 'utf8');
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const body = Buffer.concat([Buffer.from([topic.length >> 8, topic.length & 0xff]), topic, Buffer.from([0]), payload]);
    st.handlers.onmessage?.(new Uint8Array([0x30, ...mqttVarint(body.length), ...body]));
  };
  return st;
}

function mqttVarint(n) {
  const out = [];
  let v = n;
  do {
    let d = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) d |= 0x80;
    out.push(d);
  } while (v > 0);
  return out;
}

const sleep2 = ms => new Promise(r => setTimeout(r, ms));

{
  const { QqAppProvider } = require(path.join(dist, 'providers', 'qqapp.js'));
  const { encodeConnect } = require(path.join(dist, 'mqtt.js'));

  // 1) 编码：CONNECT 里必须带 auth method "pass" 与 qrcodeId 的 user properties
  const packet = Buffer.from(
    encodeConnect({
      clientId: '17000000000001234',
      authMethod: 'pass',
      userProperties: [
        { key: 'tmeAppID', value: 'qqmusic' },
        { key: 'hashTag', value: 'QID-TEST-1' }
      ]
    })
  );
  ok(packet[0] === 0x10, 'MQTT CONNECT 报文类型正确');
  ok(packet.includes(Buffer.from('pass', 'utf8')), 'CONNECT 带认证方式 pass（缺了会被回 0x8C）');
  ok(packet.includes(Buffer.from('QID-TEST-1', 'utf8')), 'CONNECT 带 qrcodeId 的 user property');

  // 2) 正常路径：出码 → waiting → scanned → cookies → confirmed
  {
    const mu = fakeMusicu();
    const mq = fakeMqtt();
    const prov = new QqAppProvider({
      transport: mu.transport,
      logger,
      connect: mq.connect,
      now: () => nowRef.t,
      readyTimeoutMs: 2000
    });
    const started = await prov.login.start();
    ok(/^data:image\/png/.test(started.qr.image), 'start 返回 data URL 二维码');
    ok(started.message.includes('QQ 音乐'), 'start 文案指向 QQ 音乐 App');
    eq(mu.calls[0], 'CreateQRCode', 'start 先调 CreateQRCode');

    const p1 = await prov.login.poll();
    eq(p1.phase, 'waiting', '刚出码是 waiting');

    mq.feed({ appName: 'QQ音乐', userNick: '月亮在不在', userLogo: 'http://x/a.png' });
    const p2 = await prov.login.poll();
    eq(p2.phase, 'scanned', '收到 scanned 推送后变 scanned');

    mq.feed({
      cookies: {
        qqmusic_key: { value: 'TOKEN-1' },
        qqmusic_uin: { value: '1707959004' },
        qrcode_id: { value: 'QID-TEST-1' }
      }
    });
    await sleep2(30);
    const p3 = await prov.login.poll();
    eq(p3.phase, 'confirmed', '收到 cookies 后确认登录');
    ok(p3.credential && /qm_keyst=K{10}/.test(p3.credential.cookie), '凭据里带 qm_keyst=musickey');
    eq(p3.credential.extra.uin, '1707959004', '凭据 extra 里带 uin');
    eq(p3.account && p3.account.name, '月亮在不在', '确认后带回昵称');
    ok(mq.sent.some(b => b[0] === 0x82), '向 broker 发过 SUBSCRIBE');

    await prov.login.cancel();
  }

  // 3) 换凭证被拒（104400）：必须落到 failed，而不是静默卡住
  {
    const mu = fakeMusicu({ loginCode: 104400 });
    const mq = fakeMqtt();
    const prov = new QqAppProvider({ transport: mu.transport, logger, connect: mq.connect, now: () => nowRef.t, readyTimeoutMs: 2000 });
    await prov.login.start();
    mq.feed({ cookies: { qqmusic_key: { value: 'T' }, qqmusic_uin: { value: '1707959004' } } });
    await sleep2(30);
    const p = await prov.login.poll();
    eq(p.phase, 'failed', '换凭证被拒时相位是 failed');
    ok(p.error && typeof p.error.code === 'string' && p.error.code.startsWith('E_'), '失败带明确错误码');
    ok(/104400|失败/.test(p.error.message), '错误文案说明上游拒绝');
  }

  // 4) 二维码过期：超过 expiresAt 后相位变 expired，并断开订阅
  {
    const mu = fakeMusicu();
    const mq = fakeMqtt();
    const t = { v: 1_700_000_000_000 };
    const prov = new QqAppProvider({ transport: mu.transport, logger, connect: mq.connect, now: () => t.v, readyTimeoutMs: 2000 });
    await prov.login.start();
    eq((await prov.login.poll()).phase, 'waiting', '过期前是 waiting');
    t.v += 15 * 60 * 1000;
    const p = await prov.login.poll();
    eq(p.phase, 'expired', '超时后变 expired');
    eq(p.error && p.error.code, 'E_QR_EXPIRED', '过期给 E_QR_EXPIRED');
  }
}

/* ---------------- 账号切换后刷新收藏/歌单 ---------------- */

async function testSwitchRefresh() {
  const events = [];
  const handlers = new Map();
  const fakeIpc = {
    handle(ch, fn) { handlers.set(ch, fn); },
    removeHandler(ch) { handlers.delete(ch); }
  };
  const account = { id: 'qqapp:1707959004', provider: 'qqapp', userId: '1707959004', name: '月亮在不在', addedAt: 1, lastUsedAt: 1 };
  let listener = null;
  const fakeManager = {
    list: () => [account],
    current: () => account,
    find: () => account,
    credentialOf: () => ({ cookie: 'a=b', extra: {}, updatedAt: 1 }),
    switchTo: async () => account,
    logout: () => {},
    invalidateStreams: () => {},
    audioFor: async () => ({ url: '', quality: 'standard', fetchedAt: 1 }),
    on(cb) { listener = cb; return () => { listener = null; }; }
  };
  const fakeModule = { manager: fakeManager, store: {}, providers: {}, revision: { value: 0 }, dispose: async () => {} };

  const off = registerAccountsIpc({
    ipcMain: fakeIpc,
    module: fakeModule,
    sendEvent: (ch, payload) => events.push({ ch, payload }),
    refreshLibrary: async (provider) => ({ refreshed: false, items: 0, message: provider + '：已切换并清空缓存' })
  });

  // 先同步拿到 status，确认初始版本号是 0
  const status0 = await handlers.get('acc:status')(null, { provider: 'qqapp' });
  eq(status0.data.dataRevision, 0, '初始 dataRevision 为 0');

  listener({ type: 'switch', provider: 'qqapp', account });
  eq(fakeModule.revision.value, 1, '切换后 revision 加一');
  eq(events.length >= 1, true, '切换立刻推一版事件');
  eq(events[0].payload.revision, 1, '事件带 revision');
  eq(!!events[0].payload.library, false, '第一版事件还没带 library');

  await new Promise(r => setTimeout(r, 30));
  const second = events.find(e => e.payload.library);
  eq(!!second, true, '刷新完成后补推第二版事件');
  eq(second.payload.library.message.includes('已切换'), true, '第二版带刷新结果');

  const status1 = await handlers.get('acc:status')(null, { provider: 'qqapp' });
  eq(status1.data.dataRevision, 1, 'status 里的 dataRevision 跟事件同源');
  off();
}

/* ---------------- 汇总 ---------------- */

await testSwitchRefresh();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
