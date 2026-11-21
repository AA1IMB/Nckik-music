'use strict';
/**
 * 探针：登录后「我的歌单 / 每日推荐 / 私人FM」在抽屉里的展示（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 用 demo/mock-ne.js 起一个本地假接口，NE_BASE 指过去，预置一个已登录凭证，
 * 然后按真实用户路径走：打开曲库 → 切到网易云 → 看歌单 → 进歌单 → 每日推荐 → 私人FM
 * → 搜索 → 清空 → 退出登录 → 登录过期 → 接口失败 → 换账号。
 * 每一步都读真实 DOM 与真实 S 状态，不靠截图肉眼判断。
 */
const { app, safeStorage } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createMock } = require('./mock-ne');

const root = path.join(__dirname, '..');
// 探针必须隔离：绝不把本机旧配置搬进测试环境
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-home-'));
app.setPath('userData', tmp);
// 迁移守卫：main.js 会把旧数据目录搬进空 userData，这里先占位阻止它
fs.writeFileSync(path.join(tmp, 'library.json'), '[]'); // migrate-guard

const logPath = path.join(root, 'demo', 'probe-home.log');
fs.writeFileSync(logPath, '');
const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
  try { console.log(line); } catch {}
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 12000, step = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

let win = null;
const errors = [];
app.on('browser-window-created', (_e, w) => {
  win = w;
  w.webContents.on('console-message', (_ev, lvl, msg) => {
    if (lvl >= 2 && !/Autofill|DevTools/.test(msg)) errors.push(msg);
  });
});

(async () => {
  const mock = await createMock();
  const st = mock.state;
  process.env.NE_BASE = mock.url;

  // 预置「上次已登录」的凭证。
  // safeStorage 在 app ready 之前不可用，而 main.js 的 whenReady 回调（读凭证 → 建窗）
  // 一定在它之后执行，所以这里先注册一个更早的 whenReady 回调，把文件写进去正好赶上。
  const authPath = path.join(tmp, 'ne-auth.bin');
  const ready = app.whenReady().then(() => {
    try {
      fs.writeFileSync(authPath, safeStorage.encryptString('MUSIC_U=mock-session-1001'));
      log('凭证已写入（加密可用=' + safeStorage.isEncryptionAvailable() + '）');
    } catch (e) {
      log('凭证写入失败：' + e.message);
    }
  });

  require(path.join(root, 'main.js'));
  await ready;
  const ne = require(path.join(root, 'netease.js'));
  const js = code => win.webContents.executeJavaScript(code, true);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) { e.click(); return true; } return false; })()`);

  await waitFor(() => !!win && !win.webContents.isLoading());
  await sleep(900);
  win.setSize(1100, 760);
  await sleep(200);
  // 后台窗口的 CSS transition 不推进，抽屉会卡在屏幕外
  await js(`(() => { const s = document.createElement('style'); s.textContent = '*{transition:none!important;animation-duration:0s!important}'; document.head.appendChild(s); })()`);

  async function shot(name) {
    await js(`(() => { const b = document.querySelector('#dLib .dr-body'); if (b) b.scrollTop = 0; })()`);
    await sleep(250);
    for (let i = 0; i < 6; i++) {
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      if (png.length > 3000) { fs.writeFileSync(path.join(root, 'screenshots', name), png); return; }
      await sleep(300);
    }
  }

  const homeState = () => js(`(() => {
    const q = s => document.querySelector(s);
    const rows = [...document.querySelectorAll('#neHome .plrow')];
    const body = q('#dLib .dr-body');
    return {
      view: S.ne.view,
      status: S.ne.home.status,
      uid: S.ne.uid,
      loggedIn: S.ne.loggedIn,
      hasCookie: S.ne.hasCookie,
      shown: q('#neHome').classList.contains('show'),
      recs: [...document.querySelectorAll('#neHome .rec')].map(e => ({
        t: e.querySelector('.rt').textContent, off: e.classList.contains('off')
      })),
      secs: [...document.querySelectorAll('#neHome .ne-sec')].map(e => e.textContent.replace(/\\s+/g, ' ').trim()),
      rows: rows.map(e => ({
        name: e.querySelector('.pn').textContent,
        sub: e.querySelector('.pd').textContent,
        origin: e.dataset.origin,
        img: e.querySelector('.pth').classList.contains('img')
      })),
      foot: q('#neHome .ne-foot') ? q('#neHome .ne-foot').textContent : '',
      msg: q('#neHome .ne-msg') ? q('#neHome .ne-msg').textContent : '',
      btns: [...document.querySelectorAll('#neHome .ne-act .ghost')].map(e => e.textContent.trim()),
      count: q('#libCount').textContent,
      overflowX: body.scrollWidth > body.clientWidth + 1
    };
  })()`);

  const collState = () => js(`(() => {
    const c = S.ne.coll;
    const first = document.querySelector('#libList .item .n');
    return {
      view: S.ne.view,
      kind: c && c.kind,
      name: c && c.name,
      sub: c && c.sub,
      status: c && c.status,
      items: document.querySelectorAll('#libList .item').length,
      count: document.querySelector('#libCount').textContent,
      first: first ? first.textContent : '',
      back: !!document.querySelector('#neHome .backbtn, #neHome .ne-back'),
      fmBtn: !!document.querySelector('#neHome [data-act="fm"]'),
      title: document.querySelector('#neHome .ne-title b') ? document.querySelector('#neHome .ne-title b').textContent : ''
    };
  })()`);

  log('\n=== 1. 登录后进入网易云：自动加载歌单 ===');
  await click('#btnLib');
  await sleep(300);
  await click('#segSrc b[data-s="net"]');
  const loaded = await waitFor(async () => {
    const s = await homeState();
    return s.status === 'ready' && s.rows.length >= 9;
  });
  let s = await homeState();
  ok('自动加载完成', loaded, 'status=' + s.status);
  ok('登录态已带上 uid', s.uid === 1001 && s.loggedIn === true, 'uid=' + s.uid);
  ok('默认在歌单首页', s.view === 'home' && s.shown === true);
  ok('我的 3 个 + 推荐 6 个 = 9 行', s.rows.length === 9, 'rows=' + s.rows.length);
  const mine = s.rows.filter(r => r.origin === 'mine' || r.origin === 'like');
  const picked = s.rows.filter(r => r.origin === 'picked');
  ok('我创建的歌单 3 个', mine.length === 3, mine.map(r => r.name).join(' / '));
  ok('我喜欢的音乐排第一', mine.length > 0 && mine[0].origin === 'like' && mine[0].name === '我喜欢的音乐', mine[0] && (mine[0].name + ' · ' + mine[0].sub));
  ok('推荐歌单 6 个', picked.length === 6, picked.map(r => r.name).join(' / '));
  ok('推荐歌单副信息是播放量', picked.length > 0 && /次播放$/.test(picked[0].sub), picked[0] && picked[0].sub);
  await waitFor(async () => (await homeState()).rows.filter(r => r.img).length >= 9, 6000);
  s = await homeState();
  ok('封面已下回来', s.rows.filter(r => r.img).length >= 8, 'img=' + s.rows.filter(r => r.img).length + '/9');
  ok('收藏歌单被隐藏并说明', /已隐藏 2 个收藏的歌单/.test(s.foot), s.foot);
  ok('分组标题齐全', s.secs.length === 3 && s.secs[0].includes('推荐') && s.secs[1].includes('推荐歌单') && s.secs[2].includes('我创建的歌单'), s.secs.join(' | '));
  ok('两个推荐入口都在', s.recs.length === 2 && s.recs[0].t === '每日推荐' && s.recs[1].t === '私人FM', s.recs.map(r => r.t).join(','));
  ok('无横向溢出', s.overflowX === false);
  await shot('17-net-home.png');

  log('\n=== 2. 打开自己的歌单 ===');
  await js(`(() => { const r = [...document.querySelectorAll('#neHome .plrow')].find(e => e.dataset.name === '深夜写代码'); r.click(); })()`);
  await waitFor(async () => (await collState()).status === 'ready');
  let c = await collState();
  ok('进入歌单详情', c.view === 'coll' && c.kind === 'playlist' && c.back === true);
  ok('标题与副信息', c.title === '深夜写代码' && /42 首/.test(c.sub), c.title + ' | ' + c.sub);
  ok('曲目渲染出来', c.items === 8, 'items=' + c.items);
  ok('数量在标题下，列表行不再重复', /^\d+ 首 ·/.test(c.sub) && c.count === '点击播放并加入曲库', c.sub + ' | ' + c.count);
  await shot('18-net-playlist.png');

  // 点一首：进入播放并加入曲库，同时当前行要能看出来
  await js(`(() => { document.querySelector('#libList .item').click(); })()`);
  await sleep(600);
  const marked = await js(`(() => {
    const e = document.querySelector('#libList .item.on');
    return e ? e.querySelector('.n').textContent : '';
  })()`);
  ok('点击后当前行高亮', /晴天/.test(marked), marked);
  const inLib = await js(`S.tracks.some(t => t.path === 'ne:101')`);
  ok('点过的曲目已进曲库', inLib === true);

  log('\n=== 3. 返回 → 每日推荐 ===');
  await click('#neHome .backbtn');
  await sleep(200);
  ok('返回首页', (await homeState()).view === 'home');
  await click('#neHome [data-act="daily"]');
  await waitFor(async () => (await collState()).status === 'ready');
  c = await collState();
  ok('每日推荐打开', c.name === '每日推荐' && c.status === 'ready');
  ok('6 首 · 带日期', /6 首 · \d{4}-\d{2}-\d{2}/.test(c.sub), c.sub);
  ok('首曲正确', /晴天/.test(c.first), c.first);

  log('\n=== 4. 私人FM：换一批 ===');
  await click('#neHome .backbtn');
  await sleep(200);
  await click('#neHome [data-act="fm"]');
  await waitFor(async () => (await collState()).status === 'ready');
  c = await collState();
  ok('私人FM 打开', c.name === '私人FM' && c.items >= 6, c.items + ' 首');
  ok('有「换一批」按钮', c.fmBtn === true);
  const before = c.first;
  const callsBefore = st.calls.filter(x => x.startsWith('/api/radio/get')).length;
  await click('#neHome [data-act="fm"]');
  await waitFor(async () => (await collState()).status === 'ready'
    && st.calls.filter(x => x.startsWith('/api/radio/get')).length > callsBefore, 8000);
  const callsAfter = st.calls.filter(x => x.startsWith('/api/radio/get')).length;
  c = await collState();
  ok('换一批真的重新取了（不是复用旧列表）', callsAfter > callsBefore, `${callsBefore} → ${callsAfter} 次取歌`);
  ok('换了一批（首曲不同）', c.first !== before, before + ' → ' + c.first);
  await shot('19-net-fm.png');

  log('\n=== 5. 搜索与清空 ===');
  await click('#neHome .backbtn');
  await sleep(200);
  await js(`(() => { const q = document.querySelector('#q'); q.value = '晴'; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(async () => (await homeState()).view === 'search' && (await js(`document.querySelectorAll('#libList .item').length`)) > 0, 6000);
  s = await homeState();
  ok('切到搜索结果', s.view === 'search' && s.shown === false, 'view=' + s.view + ' panelShown=' + s.shown);
  ok('结果渲染出来', (await js(`document.querySelectorAll('#libList .item').length`)) > 0);
  await js(`(() => { const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(250);
  s = await homeState();
  ok('清空后回到歌单首页', s.view === 'home' && s.shown === true && s.rows.length === 9, 'rows=' + s.rows.length);

  log('\n=== 6. 退出登录：我的歌单消失，公开推荐仍在 ===');
  await click('#btnNeLogout');
  await waitFor(async () => {
    const x = await homeState();
    return x.status === 'ready' && x.loggedIn === false && x.rows.length >= 6;
  }, 8000);
  s = await homeState();
  ok('未登录状态', s.loggedIn === false && s.hasCookie === false);
  ok('我的歌单区块变成登录提示', /未登录/.test(s.msg) && s.btns.includes('扫码登录'), s.msg);
  const recNow = s.rows.filter(r => r.origin === 'picked');
  ok('公开推荐歌单还在', recNow.length === 6, 'picked=' + recNow.length);
  ok('推荐入口标为不可用', s.recs.every(r => r.off === true));
  await shot('20-net-guest.png');

  log('\n=== 7. 登录过期 ===');
  st.mode = 'expired';
  ne.setCookie('MUSIC_U=expired-token');
  await js('S.ne.home = { status: "idle", err: "", data: null }; updateNeNote().then(() => neEnsureHome(true))');
  await waitFor(async () => (await homeState()).status === 'ready');
  s = await homeState();
  ok('识别为「过期」而不是「未登录」', s.hasCookie === true && s.loggedIn === false);
  ok('文案明确要求重新扫码', /登录已过期/.test(s.msg), s.msg);
  ok('仍提供扫码按钮', s.btns.includes('扫码登录'));

  log('\n=== 8. 接口失败：保留重试 ===');
  st.mode = 'fail';
  // 换一次 cookie 把账号缓存清掉，否则会命中上一轮的缓存、根本打不到接口（那样测的是缓存不是失败）
  ne.setCookie('MUSIC_U=boom-token');
  await js('S.ne.home = { status: "idle", err: "", data: null }; neEnsureHome(true)');
  await waitFor(async () => (await homeState()).status === 'error', 10000);
  s = await homeState();
  ok('进入失败态', s.status === 'error');
  ok('显示可读原因 + 重试', /加载失败/.test(s.msg) && s.btns.includes('重试'), s.msg);
  ok('失败时不留旧歌单', s.rows.length === 0, 'rows=' + s.rows.length);
  await shot('21-net-error.png');

  log('\n=== 9. 换账号：内容必须跟着换 ===');
  st.mode = 'ok';
  st.uid = 2002;
  st.nickname = '另一个号';
  st.playlists = [
    { ...st.playlists[0], id: 901, name: '我喜欢的音乐', creator: { userId: 2002, nickname: '另一个号' }, specialType: 5 },
    { ...st.playlists[1], id: 902, name: '新号的歌单', creator: { userId: 2002, nickname: '另一个号' } }
  ];
  ne.setCookie('MUSIC_U=mock-session-2002');
  await js('S.ne.home = { status: "idle", err: "", data: null }; S.ne.view = "home"; updateNeNote().then(() => neEnsureHome(true))');
  await waitFor(async () => (await homeState()).status === 'ready');
  s = await homeState();
  ok('uid 切到新账号', s.uid === 2002, 'uid=' + s.uid);
  const nowMine = s.rows.filter(r => r.origin === 'mine' || r.origin === 'like');
  ok('只剩新账号的歌单', nowMine.length === 2 && nowMine.every(r => /新号|我喜欢的音乐/.test(r.name)), nowMine.map(r => r.name).join(' / '));
  ok('没有上一个账号的残留', !s.rows.some(r => /深夜写代码|2026 循环/.test(r.name)));

  log('\n=== 10. 亮色主题 ===');
  await js(`(() => { S.settings.theme = 'light'; applyTheme(); })()`);
  await sleep(300);
  await shot('22-net-home-light.png');
  const light = await js(`({ theme: document.body.dataset.theme, rows: document.querySelectorAll('#neHome .plrow').length })`);
  ok('亮色下歌单仍完整渲染', light.theme === 'light' && light.rows >= 8, JSON.stringify(light));
  await js(`(() => { S.settings.theme = 'dark'; applyTheme(); })()`);

  log('\n=== 11. 扫码成功那一刻自动拉歌单（端到端） ===');
  // 先退出，回到「未登录」；再换一个 mock 账号，模拟「刚扫完码」
  await click('#btnNeLogout');
  await waitFor(async () => (await homeState()).status === 'ready' && (await homeState()).loggedIn === false, 8000);
  st.uid = 4004;
  st.nickname = '扫码进来的';
  st.playlists = [
    { ...st.playlists[0], id: 911, name: '我喜欢的音乐', creator: { userId: 4004, nickname: '扫码进来的' }, specialType: 5 },
    { ...st.playlists[1], id: 912, name: '扫码后看到的歌单', creator: { userId: 4004, nickname: '扫码进来的' } }
  ];
  const callsBeforeLogin = st.calls.filter(x => x.startsWith('/api/user/playlist')).length;

  await click('#btnSet');                 // 设置抽屉
  await sleep(200);
  await click('#btnNeQr');                // 真实取码 → 轮询 → 803
  const loggedIn = await waitFor(async () => {
    const x = await homeState();
    return x.loggedIn === true && x.status === 'ready' && x.uid === 4004;
  }, 15000);
  const callsAfterLogin = st.calls.filter(x => x.startsWith('/api/user/playlist')).length;
  ok('803 后自动请求了该账号的歌单', loggedIn && callsAfterLogin > callsBeforeLogin, `${callsBeforeLogin} → ${callsAfterLogin} 次`);
  s = await homeState();
  ok('账号切成刚扫码的这个', s.uid === 4004 && s.loggedIn === true, 'uid=' + s.uid);
  const afterLoginMine = s.rows.filter(r => r.origin === 'mine' || r.origin === 'like');
  ok('歌单是刚登录账号的', afterLoginMine.length === 2 && afterLoginMine.some(r => r.name === '扫码后看到的歌单'),
    afterLoginMine.map(r => r.name).join(' / '));
  const qrText = await js(`document.querySelector('#qrState').textContent`);
  ok('登录面板显示成功', /登录成功/.test(qrText), qrText);
  const saved = fs.existsSync(authPath) && safeStorage.decryptString(fs.readFileSync(authPath)).includes('MUSIC_U=mock-qr-session');
  ok('会话串已加密落盘', saved === true);

  log('\n=== 12. 渲染层异常 ===');
  ok('无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  log('\n----------------------------------------');
  log(`通过 ${pass} / ${pass + fail}`);
  mock.server.close();
  app.exit(fail ? 1 : 0);
})().catch(e => {
  log('FAIL ' + (e && e.stack || e));
  try { app.exit(1); } catch {}
});
