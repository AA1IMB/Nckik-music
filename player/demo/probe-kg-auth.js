'use strict';
/*
 * 探针：酷狗账号态
 * ---------------------------------------------------------------
 * 覆盖四段：未登录 / 导入凭证（含无效凭证）/ 会员曲取链（无权益时的降级）/ token 失效与退出。
 *
 * 分两次启动跑（同一个 userData）：
 *   第一遍（默认）：导入一份「合成凭证」，断言保存、脱敏、落盘加密。
 *   第二遍（KG_PHASE=2）：不再导入，断言启动时已从加密文件恢复登录态 —— 这是持久化
 *   唯一诚实的验证方式（只读文件判断「有没有密文」证明不了「读回来能用」）。
 *
 * 真账号验证需要自己提供 Cookie：
 *   $env:KG_TEST_COOKIE='kg_mid=…; token=…; userid=…'
 * 此时额外跑「登录成功 + 会员曲真的能取到 kgaudio 链」。没有这个环境变量就跳过那几项，
 * 并明确打印 SKIP —— 不拿合成凭证假装会员。
 *
 * 输出约定：任何地方都只打印脱敏摘要（token 前 4 位 + 长度），凭证明文不落日志。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.join(__dirname, '..');
const phase = String(process.env.KG_PHASE || '1');
process.env.NCKIK_SKIP_MIGRATION = '1';

const tmp = process.env.KG_UD
  ? process.env.KG_UD
  : fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-kgauth-'));
fs.mkdirSync(tmp, { recursive: true });
app.setPath('userData', tmp);

/* 合成凭证：形状与真实一致（cookie 里带 token/userid），但 token 是假的。
 * 用来验证「解析 / 保存 / 加密 / 恢复 / 脱敏」这些本地逻辑，不声称它能播会员曲。 */
const FAKE_TOKEN = 'probe-token-' + 'a'.repeat(24);
const FAKE_COOKIE = `kg_mid=${'b'.repeat(32)}; kg_dfid=${'c'.repeat(32)}; token=${FAKE_TOKEN}; userid=424242`;
const AUTH_FILE = path.join(tmp, 'kg-auth.bin');

fs.writeFileSync(path.join(tmp, 'library.json'), '[]');
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false, playMode: 'seq', playlist: []
}, null, 2));

process.env.NCKIK_SKIP_MIGRATION = '1';
require(path.join(root, 'main.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let win = null;
let pass = 0, fail = 0, skip = 0;
function say(ok, name, extra) {
  if (ok) pass++; else fail++;
  const tail = extra === undefined ? '' : '  ' + JSON.stringify(extra);
  console.log((ok ? '  PASS ' : '  FAIL ') + name + tail);
}
function skipSay(name, why) {
  skip++;
  console.log('  SKIP ' + name + (why ? '  ' + why : ''));
}
const js = async code => {
  try { return await win.webContents.executeJavaScript(code); }
  catch (e) {
    console.error('JS ERR', String(e && e.message || e));
    return null;
  }
};
async function waitFor(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
  return false;
}
const click = sel => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

/* 一次读全：账号摘要 + 面板 + 播放器 + 落盘状态。 */
async function snap() {
  return await js(`(() => {
    /* 注意：渲染层的 S 是脚本顶层的 const，不挂在 window 上（只有裸名字可见），
     * 所以这里必须直接写 S.kg.status，不能写 window.S && …（那会短路成 undefined）。 */
    const st = (typeof S !== 'undefined' && S.kg && S.kg.status) || {};
    const who = document.querySelector('#kgWho');
    const msg = document.querySelector('#kgMsg');
    const out = document.querySelector('#kgLogoutBtn');
    return {
      srcMode: S.srcMode,
      loggedIn: !!st.loggedIn,
      userId: st.userid || 0,
      vip: !!st.vip,
      verified: !!st.verified,
      tokenMasked: st.tokenMasked || '',
      note: st.note || '',
      who: who ? who.textContent.replace(/\\s+/g, ' ').trim() : '',
      whoVisible: !!(who && document.querySelector('#kgAccount').style.display !== 'none'),
      loginBtn: (document.querySelector('#kgLoginBtn') || {}).textContent || '',
      logoutVisible: !!(out && out.style.display !== 'none'),
      msg: msg ? msg.textContent : '',
      popOpen: !!(document.querySelector('#popKgAuth') || {}).classList?.contains('show'),
      i: S.i, qLen: S.q.length, src: audio.src || '', paused: audio.paused,
      toast: (document.querySelector('#toast') || {}).textContent || ''
    };
  })()`);
}

(async () => {
  /* 等主进程把窗口建出来：main.js 不向外暴露窗口引用，这里按「第一个窗口」取。 */
  while (!win || win.webContents.isLoading()) {
    if (!win) win = BrowserWindow.getAllWindows()[0] || null;
    await sleep(150);
  }
  await sleep(900);

  const hasEnvCookie = String(process.env.KG_TEST_COOKIE || '').trim().length > 0;

  /* ---------------- 第一遍：未登录 → 导入 ---------------- */
  if (phase !== '2') {
    console.log('\n=== 1. 未登录态 ===');
    await click('#btnLib');
    await sleep(300);
    await click('#segSrc [data-s="kg"]');
    await sleep(600);
    let s = await snap();
    say(s.srcMode === 'kg', '切到酷狗来源', { srcMode: s.srcMode });
    say(!s.loggedIn, '初始为未登录', { loggedIn: s.loggedIn });
    say(/未登录/.test(s.who), '账号条显示未登录', { who: s.who.slice(0, 40) });
    say(/导入 Cookie/.test(s.loginBtn), '有「导入 Cookie」入口', { btn: s.loginBtn });
    say(s.logoutVisible === false, '未登录时不显示退出', { visible: s.logoutVisible });
    say(!fs.existsSync(AUTH_FILE), '未登录时没有凭证文件');

    console.log('\n=== 2. 未登录点会员曲：可读提示、不残留音源 ===');
    await js(`(() => { const q = $('#q'); q.value = '发如雪'; q.dispatchEvent(new Event('input')); })()`);
    const searched = await waitFor(async () => (await js('S.kg.items.length')) > 0, 20000, 300);
    if (!searched) skipSay('会员曲降级（搜索无结果）');
    else {
      const vipHash = await js(`(S.kg.items.find(t => t.vip) || {}).kgHash || ''`);
      const before = await snap();
      await js(`(() => { const el = document.querySelector('#libList .item[data-kg="' + ${JSON.stringify(vipHash)} + '"]'); if (el) el.click(); })()`);
      const toasted = await waitFor(async () => /会员|无法播放/.test((await snap()).toast || ''), 20000, 250);
      s = await snap();
      say(toasted, '给出了「需要会员」的提示', { toast: s.toast, hash: vipHash.slice(0, 8) });
      say(s.src === before.src && s.i === before.i, '没有把播放器切到失败曲目上', { i: s.i, src: s.src.slice(0, 18) });
    }

    console.log('\n=== 3. 无效凭证：明确拒绝、不落盘 ===');
    await click('#kgLoginBtn');
    await sleep(300);
    await js(`(() => { $('#kgCookie').value = 'kg_mid=${'d'.repeat(32)}'; })()`);
    await click('#kgAuthSave');
    const rejected = await waitFor(async () => /没有 token|userid/.test((await snap()).msg || ''), 8000, 200);
    s = await snap();
    say(rejected, '缺 token/userid 被拒绝并说明原因', { msg: s.msg.slice(0, 40) });
    say(!fs.existsSync(AUTH_FILE), '无效凭证没有写盘');
    say(!s.loggedIn, '状态仍是未登录', { loggedIn: s.loggedIn });

    console.log('\n=== 4. 合成凭证：保存、脱敏、加密 ===');
    await js(`(() => { $('#kgCookie').value = ${JSON.stringify(FAKE_COOKIE)}; })()`);
    await click('#kgAuthSave');
    const saved = await waitFor(async () => {
      const x = await snap();
      return x.loggedIn && !x.popOpen;
    }, 25000, 300);
    s = await snap();
    const info = await js(`(async () => { try { return await window.api.kgAuthInfo(); } catch (e) { return { thrown: String(e && e.message || e) }; } })()`);
    say(saved, '保存成功并关闭面板', { loggedIn: s.loggedIn, popOpen: s.popOpen, msg: s.msg, info });
    say(s.userId === 424242, 'userid 被正确解析', { userId: s.userId });
    say(/已登录/.test(s.who), '账号条切到已登录', { who: s.who.slice(0, 40) });
    say(s.logoutVisible === true, '登录后出现退出按钮');
    say(!!s.tokenMasked && s.tokenMasked.length <= 12 && !s.tokenMasked.includes('aaaaaaaa'), '状态里的 token 是脱敏的', { masked: s.tokenMasked });
    say(fs.existsSync(AUTH_FILE), '凭证文件已生成', { size: fs.existsSync(AUTH_FILE) ? fs.statSync(AUTH_FILE).length : 0 });

    const blob = fs.existsSync(AUTH_FILE) ? fs.readFileSync(AUTH_FILE).toString('latin1') : '';
    say(!blob.includes(FAKE_TOKEN), '密文里不含 token 明文');
    const raw = [fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'), fs.readFileSync(path.join(tmp, 'library.json'), 'utf8')].join('\n');
    say(!raw.includes(FAKE_TOKEN) && !raw.includes('kg_dfid=' + 'c'.repeat(8)), 'settings/library 里没有凭证');

    console.log('\n=== 5. 无权益账号取会员曲：降级而不是卡死 ===');
    const vipHash = await js(`(S.kg.items.find(t => t.vip) || {}).kgHash || ''`);
    if (!vipHash) skipSay('无权益降级（列表里没有会员曲）');
    else {
      const probe = await js(`(async () => {
        const r = await window.api.kgUrl(${JSON.stringify(vipHash)});
        return { ok: !!r.ok, code: (r.error && r.error.code) || '', message: (r.error && r.error.message) || '' };
      })()`);
      say(probe && probe.ok === false && probe.code === 'KG_PAID', '合成凭证取会员曲 → KG_PAID（不是崩溃/空链）', probe);
      const st = await js(`(async () => { const r = await window.api.kgStatus(); return r; })()`);
      say(st && st.ok && st.loggedIn && st.vip === false, '自检结论是「已登录但无会员权益」', { vip: st && st.vip, note: (st && st.note || '').slice(0, 30) });
    }
  }

  /* ---------------- 第二遍：启动即恢复 ---------------- */
  if (phase === '2') {
    console.log('\n=== 6. 重启后从加密文件恢复登录态 ===');
    await click('#btnLib');
    await sleep(300);
    await click('#segSrc [data-s="kg"]');
    await sleep(700);
    const s = await snap();
    say(fs.existsSync(AUTH_FILE), '凭证文件仍在', { size: fs.existsSync(AUTH_FILE) ? fs.statSync(AUTH_FILE).length : 0 });
    say(s.loggedIn, '启动后自动恢复为已登录', { loggedIn: s.loggedIn });
    say(s.userId === 424242, '恢复的 userid 正确', { userId: s.userId });
    say(/已登录/.test(s.who), '账号条显示已登录', { who: s.who.slice(0, 40) });

    console.log('\n=== 7. 退出：文件删除、状态回未登录 ===');
    await js(`document.querySelector('#kgLogoutBtn').click()`);
    const out = await waitFor(async () => {
      const x = await snap();
      return !x.loggedIn && !fs.existsSync(AUTH_FILE);
    }, 10000, 250);
    const s2 = await snap();
    say(out, '退出后文件被删除、状态回未登录', { loggedIn: s2.loggedIn, file: fs.existsSync(AUTH_FILE) });

    /* 退出后仍然能放免费曲：确认登录态与匿名态没有互相污染 */
    const freeHash = '48c685f679ffc7cf08b8a8341ca9db44';   // 晴天（免费）
    const url = await js(`(async () => { const r = await window.api.kgUrl(${JSON.stringify(freeHash)}); return { ok: !!r.ok, code: (r.error && r.error.code) || '' }; })()`);
    say(url && url.ok, '退出后免费曲照常取链', url);

    if (hasEnvCookie) {
      console.log('\n=== 8. 真账号（KG_TEST_COOKIE）：登录成功 + 会员曲播放 ===');
      await click('#kgLoginBtn');
      await sleep(250);
      await js(`(() => { $('#kgCookie').value = ${JSON.stringify(String(process.env.KG_TEST_COOKIE || ''))}; })()`);
      await click('#kgAuthSave');
      const ok = await waitFor(async () => (await snap()).loggedIn, 25000, 300);
      const s3 = await snap();
      say(ok, '真凭证登录成功', { userId: s3.userId, masked: s3.tokenMasked });
      say(s3.vip, '自检判定账号有会员权益', { vip: s3.vip, note: s3.note.slice(0, 30) });
      const vipHash2 = await js(`(S.kg.items.find(t => t.vip) || {}).kgHash || ''`);
      if (vipHash2) {
        const r = await js(`(async () => { const x = await window.api.kgUrl(${JSON.stringify(vipHash2)}); return { ok: !!x.ok, code: (x.error && x.error.code) || '' }; })()`);
        say(r && r.ok, '真账号取到会员曲直链', r);
      }
    } else {
      skipSay('真账号登录成功 / 会员曲播放', '未设置 KG_TEST_COOKIE');
    }
  }

  console.log('\n=== 结果 ===');
  console.log(`通过 ${pass} 项，失败 ${fail} 项${skip ? `，跳过 ${skip} 项` : ''}（phase ${phase}）`);
  app.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('PROBE CRASH', (e && e.stack) || e);
  app.exit(2);
});
setTimeout(() => { console.error('PROBE TIMEOUT'); app.exit(3); }, 240000);
