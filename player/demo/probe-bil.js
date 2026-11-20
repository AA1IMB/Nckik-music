'use strict';
/**
 * 探针：哔哩哔哩音源（搜索 → 取流 → 播放 → 加入播放列表 → Cookie 导入 → 退出）
 * ---------------------------------------------------------------------------
 * 只走真实用户路径：点「哔哩哔哩」标签 → 在搜索框里输入 → 点结果 → 看播放器真的出声
 * → 拖到 10s（验 Range）→ 再点一次同一条（验去重）→ 导入一份假 Cookie（验保存与降级）
 * → 退出。所有判断读真实 DOM、真实 S 状态与 audio 元素，不看截图。
 *
 * 需要外网（api.bilibili.com）。没有网络时前半段会明确失败，这是预期行为。
 */
const { app, safeStorage } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';      // 绝不搬本机旧配置进测试环境
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-bil-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'library.json'), '[]');            // 迁移守卫
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false,
  playMode: 'seq', playlist: []
}));

const logPath = path.join(root, 'demo', 'probe-bil.log');
fs.writeFileSync(logPath, '');
const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
  try { console.log(line); } catch {}
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, step = 150) {
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
  if (!win) win = w;
  w.webContents.on('console-message', (_ev, lvl, msg) => {
    if (lvl >= 2 && !/Autofill|DevTools|Electron Security/.test(msg)) errors.push(msg);
  });
});

const js = code => win.webContents.executeJavaScript(code, true);
const click = sel => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

/** 一次读回所有关心的状态，避免多次 executeJavaScript 之间状态漂移 */
const snap = () => js(`(() => {
  const q = document.querySelector('#q');
  const items = [...document.querySelectorAll('#libList .item')];
  const cur = (typeof S !== 'undefined' && S.i >= 0 && S.tracks.length) ? S.tracks[S.i] : null;
  /* 这个应用没有 <audio> 标签：app.js 用 new Audio() 建元素，靠顶层词法绑定
   * 暴露给同页脚本，executeJavaScript 里可以直接按名字用 audio。 */
  const a = audio;
  const art = document.querySelector('#cover').style.backgroundImage || '';
  return {
    mode: (typeof S !== 'undefined') ? S.srcMode : '',
    placeholder: q ? q.placeholder : '',
    count: (document.querySelector('#libCount') || {}).textContent || '',
    rows: items.length,
    firstBil: items.length ? (items[0].dataset.bil || '') : '',
    firstTitle: items.length ? ((items[0].querySelector('.n') || {}).textContent || '').trim() : '',
    note: (document.querySelector('#bilNote') || {}).textContent || '',
    empty: !!document.querySelector('#libList .empty-row'),
    title: cur ? cur.title : '',
    path: cur ? cur.path : '',
    source: cur ? cur.source : '',
    bitrate: cur ? cur.bitrate : 0,
    cid: cur ? cur.bilCid : 0,
    qLen: (typeof S !== 'undefined') ? S.q.length : -1,
    playList: (typeof S !== 'undefined' && S.settings.playlist) ? S.settings.playlist.length : -1,
    src: a ? a.src : '',
    paused: a ? a.paused : true,
    ct: a ? a.currentTime : 0,
    dur: a ? (Number.isFinite(a.duration) ? a.duration : 0) : 0,
    rs: a ? a.readyState : 0,
    err: a && a.error ? a.error.code : null,
    coverIsImage: (() => {
      const img = document.querySelector('#coverImg');
      const bg = (document.querySelector('#cover') || { style: {} }).style.backgroundImage || '';
      return ((img && (img.getAttribute('src') || '')).indexOf('data:image') === 0) || bg.indexOf('data:image') >= 0;
    })(),
    toast: (document.querySelector('#toast') || {}).textContent || '',
    loggedIn: (typeof S !== 'undefined' && S.bil && S.bil.status) ? !!S.bil.status.loggedIn : false,
    authState: (document.querySelector('#bilAuthState') || {}).textContent || ''
  };
})()`);

(async () => {
  require(path.join(root, 'main.js'));       // 启动真正的应用（同一个进程里）
  await waitFor(() => !!win && !win.webContents.isLoading());
  await sleep(900);

  log('— §1 第三个音源标签');
  const tabs = await js(`[...document.querySelectorAll('#segSrc b')].map(b => b.dataset.s + ':' + b.textContent.trim())`);
  ok('曲库有三个音源标签', tabs.length === 3, JSON.stringify(tabs));
  ok('第三个是「哔哩哔哩」', /bil:哔哩哔哩/.test(tabs.join(',')));

  await click('#btnLib');
  await sleep(300);
  await click('#segSrc b[data-s="bil"]');
  await sleep(400);
  let s = await snap();
  ok('切到哔哩哔哩', s.mode === 'bil', s.mode);
  ok('搜索框提示改口', /哔哩哔哩/.test(s.placeholder), s.placeholder);
  ok('未登录提示可见', /未登录|已登录/.test(s.note), s.note);
  ok('初始是空状态而不是空白', s.empty, 'rows=' + s.rows);

  log('— §2 搜索');
  await js(`(() => { const q = document.querySelector('#q'); q.value = '晴天'; q.dispatchEvent(new Event('input')); })()`);
  const gotRows = await waitFor(async () => (await snap()).rows > 0, 20000);
  s = await snap();
  ok('搜索返回结果', gotRows && s.rows > 0, 'rows=' + s.rows + ' count=' + s.count);
  ok('计数文案说明可点播放', /点击播放/.test(s.count), s.count);
  ok('结果行带 bvid', /^BV[0-9A-Za-z]{10}$/.test(s.firstBil), s.firstBil);
  ok('结果行有标题', s.firstTitle.length > 0, s.firstTitle.slice(0, 24));

  log('— §3 点第一条：取流并播放');
  await click('#libList .item');
  const playing = await waitFor(async () => {
    const x = await snap();
    return !x.paused && x.rs >= 3 && x.ct > 0.2 && /^bilaudio:\/\/s\/BV/.test(x.src);
  }, 30000);
  s = await snap();
  ok('音频指向 bilaudio 协议', /^bilaudio:\/\/s\/BV[0-9A-Za-z]{10}:\d+$/.test(s.src), s.src);
  ok('真的在放（paused=false, readyState≥3）', !s.paused && s.rs >= 3, 'paused=' + s.paused + ' rs=' + s.rs + ' ct=' + s.ct.toFixed(2));
  ok('没有媒体错误', s.err === null, 'err=' + s.err);
  ok('曲目被标成 bilibili', s.source === 'bilibili' && /^bil:BV/.test(s.path), s.source + ' ' + s.path);
  ok('cid 已补齐', s.cid > 0, 'cid=' + s.cid);
  ok('码率写回曲目（kbps）', s.bitrate >= 60, 'br=' + s.bitrate);
  ok('时长可用', s.dur > 30, 'dur=' + (s.dur || 0).toFixed(1));
  ok('加入播放列表', s.qLen === 1 && s.playList === 1, 'q=' + s.qLen + ' pl=' + s.playList);
  const gotCover = await waitFor(async () => (await snap()).coverIsImage, 12000);
  ok('封面出图（bilCover）', gotCover);

  log('— §4 拖动 = Range/206 真的通');
  await js(`(() => { if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(10, audio.duration - 1); })()`);
  const seeked = await waitFor(async () => (await snap()).ct > 10.2, 12000);
  s = await snap();
  ok('seek 到 10s 后继续播', seeked, 'ct=' + s.ct.toFixed(2));

  log('— §5 再点同一条：不重复入列');
  await click('#libList .item');
  await sleep(1200);
  s = await snap();
  ok('播放列表仍然只有 1 首', s.qLen === 1 && s.playList === 1, 'q=' + s.qLen + ' pl=' + s.playList);

  log('— §6 Cookie 导入（假凭证，验保存与降级）');
  await click('#btnSet');
  await sleep(500);
  await click('#btnBilCookie');
  await sleep(300);
  const popShown = await js(`(() => { const p = document.querySelector('#popBilAuth'); return !!p && p.classList.contains('show'); })()`);
  ok('导入弹层已打开', popShown);
  await click('#bilAuthSave');                         // 空输入 → 报错
  await sleep(300);
  const msgEmpty = (await js(`(document.querySelector('#bilMsg') || {}).textContent || ''`)).trim();
  ok('空输入给出提示', /先粘贴/.test(msgEmpty), msgEmpty);
  await js(`(() => { const t = document.querySelector('#bilCookie'); t.value = 'SESSDATA=probe%2Cfake; bili_jct=abc; DedeUserID=1234567'; t.dispatchEvent(new Event('input')); })()`);
  await click('#bilAuthSave');
  const saved = await waitFor(async () => {
    const x = await js(`(document.querySelector('#bilMsg') || {}).textContent || ''`);
    return /正在验证/.test(x) === false && x.length > 0;
  }, 20000);
  await sleep(400);
  s = await snap();
  const cfg = path.join(tmp, 'bil-auth.bin');
  ok('假 Cookie 被拒或保存后验证失败（不静默）', saved && (/失败|没能验证|已保存/.test(s.toast) || /失败/.test(await js(`(document.querySelector('#bilMsg') || {}).textContent || ''`))),
    'toast=' + s.toast);
  ok('凭证文件已落盘且不是明文', fs.existsSync(cfg) && !fs.readFileSync(cfg, 'utf8').includes('probe%2Cfake'));

  log('— §7 退出');
  await click('#btnBilLogout');
  await sleep(600);
  s = await snap();
  ok('退出后回到未登录', s.loggedIn === false && s.authState === '未登录', s.authState);
  ok('退出后凭证文件已删', !fs.existsSync(cfg));

  log('— §8 失败分支：不存在的稿件');
  const bad = await js(`window.api.bilUrl('BV0000000000', 0).then(r => r).catch(e => ({ ok:false, error:{ code:'THROW', message:String(e && e.message || e) } }))`);
  ok('取流失败有错误码', bad && bad.ok === false && !!bad.error, JSON.stringify(bad && bad.error));

  log('— §10 收藏夹：未登录给引导而不是报错');
  const favGuest = await js(`window.api.bilFavs().then(r => r).catch(e => ({ ok:false, error:{ code:'THROW', message:String(e && e.message || e) } }))`);
  ok('未登录时收藏夹返回 BIL_NOT_LOGIN', favGuest && favGuest.ok === false && favGuest.error && favGuest.error.code === 'BIL_NOT_LOGIN',
    JSON.stringify(favGuest && favGuest.error));
  /* 回到哔哩哔哩空态，确认「我的收藏夹」那块给的是登录引导（.lnk 可点），不是红字报错 */
  await click('#segSrc b[data-s="bil"]');
  await sleep(500);
  const favUi = await js(`(() => {
    const home = document.querySelector('#bilHome');
    return {
      shown: !!home && home.classList.contains('show'),
      text: home ? (home.textContent || '').trim().slice(0, 80) : '',
      hasLogin: !!document.querySelector('#bilHome [data-bil-login]'),
      hasError: /失败|出错/.test(home ? home.textContent : '')
    };
  })()`);
  ok('收藏夹面板给出登录引导', favUi.hasLogin, favUi.text);
  ok('引导不是报错红字', favUi.hasError === false);

  log('— §11 搜索排序：VV音乐局置顶');
  const pin = await js(`window.api.bilSearch('VV音乐局', 20).then(r => r).catch(e => ({ ok:false, error:{ code:'THROW', message:String(e && e.message || e) } }))`);
  if (!pin || !pin.ok) {
    log('  · SKIP 置顶断言：搜索失败 ' + JSON.stringify(pin && pin.error));
  } else {
    const arr = pin.tracks || [];
    const flags = arr.map(t => !!t.pinned);
    const firstPlain = flags.indexOf(false);
    const lastPinned = flags.lastIndexOf(true);
    ok('置顶项都排在前面', lastPinned < 0 || firstPlain < 0 || lastPinned < firstPlain,
      'pinned=' + flags.filter(Boolean).length + ' total=' + arr.length);
    ok('置顶项标了 pinned 且作者含 VV音乐局',
      arr.filter(t => t.pinned).every(t => /VV音乐局/.test(t.artist || '')),
      arr.filter(t => t.pinned).slice(0, 2).map(t => t.artist).join(' / '));
    if (arr.some(t => t.pinned)) ok('置顶项带 VV 角标语义', arr[0].pinned === true, 'first=' + arr[0].title.slice(0, 20));
    else log('  · SKIP VV 角标：这次搜索没有该 UP 的内容');
  }

  log('— §11b sortPinned 单元验证（主进程直接调，纯函数）');
  const bilMod = require(path.join(root, 'bilibili.js'));
  const mixed = await Promise.resolve(bilMod.sortPinned([
    { title: 'a', artist: '别人' },
    { title: 'b', artist: 'VV音乐局' },
    { title: 'c', artist: '别人2' },
    { title: 'd', artist: 'VV音乐局' }
  ]));
  ok('置顶组在前、其余保持原序', mixed.map(t => t.title).join(',') === 'b,d,a,c', mixed.map(t => t.title).join(','));
  ok('置顶项被标 pinned', mixed[0].pinned === true && mixed[1].pinned === true && !mixed[2].pinned);
  ok('非置顶项没有被改动', mixed[2].title === 'a' && mixed[2].pinned === undefined);

  log('— §12 登录失效时的重新扫码引导');
  const expiredUi = await js(`(() => {
    S.bil.status = Object.assign({}, S.bil.status, { loggedIn: false, expired: true });
    paintBilNote();
    renderBil();
    const home = document.querySelector('#bilHome');
    return {
      note: (document.querySelector('#bilNote') || {}).textContent || '',
      auth: (document.querySelector('#bilAuthState') || {}).textContent || '',
      relogin: !!document.querySelector('#bilHome [data-bil-login]'),
      homeText: home ? (home.textContent || '').trim().slice(0, 60) : ''
    };
  })()`);
  ok('曲库提示切到「登录已失效」', /失效/.test(expiredUi.note), expiredUi.note);
  ok('设置页状态显示登录已失效', /失效/.test(expiredUi.auth), expiredUi.auth);
  ok('收藏夹面板给出重新扫码入口', expiredUi.relogin, expiredUi.homeText);
  await js(`(() => { S.bil.status = Object.assign({}, S.bil.status, { expired: false }); paintBilNote(); renderBil(); })()`);

  log('— §12b 收藏夹面板渲染与点击（合成数据）');
  const favUi2 = await js(`(async () => {
    S.bil.status = { loggedIn: true, userId: 123, nickname: '探针' };
    S.bil.favs = { status: 'ready', err: '', seq: 0, items: [
      { id: '111', name: '我喜欢的音乐', sub: '12 个内容', coverUrl: 'https://i0.hdslb.com/bfs/archive/x.jpg' },
      { id: '222', name: '深夜循环', sub: '3 个内容', coverUrl: '' }
    ] };
    S.bil.view = 'idle';
    renderBil();
    const rows = [...document.querySelectorAll('#bilHome .plrow[data-bil-fav]')];
    const first = rows[0];
    const title = first ? (first.querySelector('.pn') || {}).textContent : '';
    const sub = first ? (first.querySelector('.pd') || {}).textContent : '';
    if (first) first.click();
    await new Promise(r => setTimeout(r, 2500));
    const list = document.querySelector('#libList');
    return {
      rows: rows.length, title, sub,
      view: S.bil.view,
      favId: S.bil.fav.id,
      listText: (list ? list.textContent : '').trim().slice(0, 60),
      blank: !list || !(list.textContent || '').trim()
    };
  })()`);
  ok('收藏夹面板列出文件夹', favUi2.rows === 2, 'rows=' + favUi2.rows);
  ok('文件夹显示名称与条目数', favUi2.title === '我喜欢的音乐' && /12/.test(favUi2.sub || ''), favUi2.title + ' | ' + favUi2.sub);
  ok('点开文件夹进入条目视图', favUi2.view === 'fav' && favUi2.favId === '111', favUi2.view + ' id=' + favUi2.favId);
  ok('条目视图有内容而不是留白（失败也给出原因）', favUi2.blank === false, favUi2.listText);

  log('— §13 收藏夹（真实账号，需 BIL_TEST_COOKIE）');
  if (!process.env.BIL_TEST_COOKIE) {
    log('  · SKIP 未提供 BIL_TEST_COOKIE：真账号收藏夹（分页 / 条目字段）无法在本机自动验证');
  } else {
    const login = await js(`window.api.bilLogin(${JSON.stringify(process.env.BIL_TEST_COOKIE)}).then(r => r).catch(e => ({ ok:false, error:{ message:String(e && e.message || e) } }))`);
    ok('测试账号登录成功', !!login && login.ok === true);
    const folders = await js(`window.api.bilFavs().then(r => r).catch(e => ({ ok:false, error:{ message:String(e && e.message || e) } }))`);
    ok('拿到收藏夹列表', !!folders && folders.ok === true && Array.isArray(folders.items), folders && folders.ok ? 'folders=' + folders.items.length : JSON.stringify(folders && folders.error));
    if (folders && folders.ok && folders.items.length) {
      const one = folders.items[0];
      const page1 = await js(`window.api.bilFavList(${JSON.stringify(one.id)}, 1).then(r => r).catch(e => ({ ok:false, error:{ message:String(e && e.message || e) } }))`);
      ok('收藏夹条目可读', !!page1 && page1.ok === true && page1.items.length > 0, page1 && page1.ok ? 'items=' + page1.items.length : '');
      ok('条目字段齐全（bvid/标题/作者/时长）', !!page1 && page1.items.every(t => /^BV/.test(t.bilBvid || '') && t.title && t.artist && t.duration >= 0));
      ok('分页信息可用', !!page1 && typeof page1.hasMore === 'boolean', page1 && ('hasMore=' + page1.hasMore + ' total=' + page1.total));
    }
  }

  log('— §8b Cookie 头名字（大小写敏感，2026-11-20 复盘）');
  {
    /* 只在主进程里跑纯函数、不发请求：B 站只认 `SESSDATA` / `DedeUserID` 的写法，
     * 名字被小写发出去等于没带登录态（nav 回 -101，扫码成功也判未登录）。 */
    const bil = require(path.join(root, 'bilibili.js'));
    const raw = 'SESSDATA=abc%2C1799999999%2Cxyz; bili_jct=JJ; DedeUserID=42; buvid3=B3';
    const pairs = bil.parseCookiePairs(raw);
    ok('保留 cookie 名原写法', pairs.map(p => p[0]).join(',') === 'SESSDATA,bili_jct,DedeUserID,buvid3', pairs.map(p => p[0]).join(','));
    bil.applyAuth(raw);
    ok('请求头以 SESSDATA= 开头', /^SESSDATA=abc/.test(bil.cookieHeader()), bil.cookieHeader().slice(0, 24));
    ok('值里的 %2C 不被解码', /^SESSDATA=abc%2C1799999999%2Cxyz(;|$)/.test(bil.cookieHeader()));
    const lower = pairs.map(([k, v]) => k.toLowerCase() + '=' + v).join('; ');
    bil.applyAuth(lower);
    ok('小写名的对照：请求头确实会变成 sessdata=', /^sessdata=/.test(bil.cookieHeader()), bil.cookieHeader().slice(0, 24));
    bil.logout();
  }

  log('— §9 控制台');
  ok('渲染层无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  log('');
  log(`通过 ${pass} 项，失败 ${fail} 项`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(fail ? 1 : 0);
})().catch(e => {
  log('PROBE CRASH ' + (e && e.stack || e));
  app.exit(2);
});
