'use strict';
/**
 * 探针：曲库首页统一（两音源一套 UI）+ 设置页酷狗扫码登录的降级
 * ---------------------------------------------------------------------------
 * 对应「曲库整齐」与「登录改造」两件事，全部从界面上验证，不看内部返回值：
 *   1. 网易云首页：三栏都在（每日推荐 / 推荐歌单 / 我创建的歌单），未登录时后两栏给引导
 *   2. 酷狗首页：同样三栏；每日推荐与我创建的歌单是「上游未开放」并给出原因
 *   3. 打开酷狗榜单：曲目列表 + 「加载更多」，翻页后条目增加
 *   4. 返回曲库：回到首页而不是留在空列表
 *   5. 设置页扫码：入口在、点击后进入「扫码不可用」的显式降级，并能一键切到导入 Cookie
 *   6. 网络异常：首页给出失败原因 + 重试按钮，不静默空白
 *
 * 需要联网（两份首页都打真接口）。接口全挂时前四节会失败，这时先看第 6 节的
 * 行为是否符合预期——第 6 节把 srcHome 换成必然失败的桩，不依赖网络。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-src-'));
app.setPath('userData', tmp);

const wav = path.join(tmp, 'src-a.wav');
fs.copyFileSync(path.join(root, 'demo', 'demo.wav'), wav);
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify([{
  path: wav, title: '样本', artist: '探针', album: '曲库首页', duration: 42,
  codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true
}], null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false, playMode: 'seq', playlist: []
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0; let fail = 0;
const say = (ok, name, detail) => {
  if (ok) pass++; else fail++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
};
const waitFor = async (fn, ms = 25000, step = 200) => {
  const to = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > to) return false;
    await sleep(step);
  }
};

let win = null;
app.on('browser-window-created', (_e, w) => { win = w; });
const js = c => win.webContents.executeJavaScript(c, true);
const click = sel => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false; el.click(); return true; })()`);

/* 一次读回整页状态：首页的三栏文本、歌单行数、歌单页的曲目数 */
const snap = () => js(`(() => {
  const secs = [...document.querySelectorAll('#neHome .ne-sec')].map(x => {
    const b = x.querySelector('span'); return b ? b.textContent.trim() : '';
  });
  const msgs = [...document.querySelectorAll('#neHome .ne-msg')].map(x => x.textContent.replace(/\\s+/g, ' ').trim());
  const homeText = ($('#neHome') && $('#neHome').textContent || '').replace(/\\s+/g, ' ');
  const rows = [...document.querySelectorAll('#neHome .plrow')];
  const cards = [...document.querySelectorAll('#neHome .rec')];
  const items = [...document.querySelectorAll('#libList .item')];
  const c = S.srcColl;
  return {
    srcMode: S.srcMode,
    status: (S.srcHome[S.srcMode === 'kg' ? 'kugou' : 'netease'] || {}).status,
    secs, msgs, cards: cards.length, rows: rows.length, items: items.length,
    rowNames: rows.slice(0, 3).map(r => (r.querySelector('.pn') || {}).textContent || ''),
    /* 只数 .pth 不够：图片地址错了也是同一个类名，必须确认背景里真的有 data:image */
    covers: rows.filter(r => {
      const p = r.querySelector('.pth');
      const bg = (p && p.style.backgroundImage) || '';
      return !!p && bg.indexOf('data:image') >= 0;
    }).length,
    count: ($('#libCount') || {}).textContent || '',
    homeText: homeText.slice(0, 1500),
    coll: c ? { kind: c.kind, name: c.name, status: c.status, tracks: c.tracks.length, hasMore: !!c.hasMore } : null,
    more: !!document.querySelector('#libList [data-act="more"]'),
    playable: (() => { try { return S.q.length; } catch { return -1; } })()
  };
})()`);

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('  [renderer]', msg); });
  for (let i = 0; i < 200 && !(await js('S.tracks !== undefined')); i++) await sleep(100);
  await js('window.addEventListener("error", e => { window.__err = String(e.message); });');

  console.log('\n=== 1. 网易云曲库首页（未登录）===');
  await js(`document.querySelector('#btnLib').click()`);
  await sleep(400);
  await click('#segSrc [data-s="net"]');
  const netReady = await waitFor(async () => {
    const s = await snap();
    return s.status === 'ready' || s.status === 'error';
  }, 25000);
  let s = await snap();
  say(netReady && s.status === 'ready', '网易云首页拿到数据', { status: s.status });
  say(s.secs.join('|') === '每日推荐|推荐歌单|我创建的歌单', '三栏顺序固定', { secs: s.secs });
  say(/登录后可用|登录后可同步/.test(s.homeText), '未登录时每日推荐/我的歌单给引导', { hits: (s.homeText.match(/登录后/g) || []).length });
  say(s.rows >= 1, '推荐歌单有行', { rows: s.rows, names: s.rowNames });
  /* 网易云的取图返回对象、酷狗返回字符串，适配层漏归一就会得到 url("[object Object]")：
   * 行还在、类名还在，但方块是空的，所以这里必须确认背景里真的有 data:image。 */
  const neCoverOk = await waitFor(async () => (await snap()).covers >= 1, 8000);
  say(neCoverOk, '推荐歌单行有封面', { covers: (await snap()).covers });
  say(/扫码登录|登录后/.test(s.homeText), '未登录时给出登录入口', { tail: s.msgs.slice(-1)[0] });

  console.log('\n=== 2. 酷狗曲库首页：三栏结构一致，未开放的写原因 ===');
  await click('#segSrc [data-s="kg"]');
  const kgReady = await waitFor(async () => {
    const x = await snap();
    return x.status === 'ready' || x.status === 'error';
  }, 25000);
  s = await snap();
  say(kgReady && s.status === 'ready', '酷狗首页拿到数据', { status: s.status });
  say(s.secs.join('|') === '每日推荐|推荐歌单|我创建的歌单', '与网易云同一套三栏', { secs: s.secs });
  say((s.msgs.join(' ').match(/未开放/g) || []).length >= 2,
    '每日推荐/我创建的歌单写明上游未开放', { msgs: s.msgs });
  say(/原因/.test(s.homeText), '未开放处附了原因', { sample: s.homeText.slice(0, 160) });
  say(s.rows >= 10, '推荐歌单（榜单）有足够条目', { rows: s.rows, names: s.rowNames });
  const coversOk = await waitFor(async () => (await snap()).covers >= 1, 10000);
  s = await snap();
  say(coversOk && s.covers >= 1, '榜单封面加载出来了', { covers: s.covers });

  console.log('\n=== 3. 打开榜单：曲目 + 加载更多 ===');
  await js(`(() => { const r = document.querySelector('#neHome .plrow'); if (r) r.click(); })()`);
  const collReady = await waitFor(async () => {
    const x = await snap();
    return x.coll && x.coll.status !== 'loading';
  }, 25000);
  s = await snap();
  say(collReady && s.coll && (s.coll.status === 'ready' || s.coll.status === 'ok'), '榜单打开成功', { coll: s.coll });
  say(s.items >= 30, '曲目列表有内容', { items: s.items });
  say(s.more === true, '底部有「加载更多」', { more: s.more });
  say(/首|曲目/.test(s.count) || s.count.length > 0, '计数文案有值', { count: s.count });

  const before = s.items;
  await js(`(() => { const b = document.querySelector('#libList [data-act="more"]'); if (b) b.click(); })()`);
  await waitFor(async () => (await snap()).items > before, 15000);
  s = await snap();
  say(s.items > before, '翻页后条目变多', { before, after: s.items });

  console.log('\n=== 4. 返回曲库 ===');
  await js(`(() => { const b = document.querySelector('#neHome [data-act="back"], #libList [data-act="back"], [data-act="back"]'); if (b) b.click(); })()`);
  await waitFor(async () => !(await snap()).coll, 8000);
  s = await snap();
  say(s.coll === null, '回到首页（歌单状态清空）', { coll: s.coll });
  say(s.rows >= 10, '首页歌单还在', { rows: s.rows });

  console.log('\n=== 5. 设置页：扫码入口与显式降级 ===');
  await js(`document.querySelector('#btnSet').click()`);
  await sleep(400);
  const hasQr = await js(`!!document.querySelector('#btnKgQr')`);
  say(hasQr, '设置页有「扫码登录」入口');
  say(await js(`(() => { const e = document.querySelector('#kgAuthState'); return !!e && /未登录|已登录/.test(e.textContent); })()`),
    '登录状态有文案', { text: await js(`(document.querySelector('#kgAuthState') || {}).textContent`) });
  await js(`(() => { const b = document.querySelector('#btnKgQr'); if (b) b.click(); })()`);
  const degraded = await waitFor(async () => {
    const r = await js(`(() => { const w = document.querySelector('#kgQrWrap');
      const m = document.querySelector('#kgQrMask');
      const st = document.querySelector('#kgQrState');
      return { show: !!w && w.classList.contains('show'), dead: !!document.querySelector('#kgQrBox.dead'),
        mask: m ? m.textContent : '', state: st ? st.textContent : '' }; })()`);
    return r.show && (r.dead || /扫码|签名|Cookie/.test(r.state));
  }, 12000);
  const qr = await js(`(() => { const w = document.querySelector('#kgQrWrap');
    const m = document.querySelector('#kgQrMask'); const st = document.querySelector('#kgQrState');
    return { show: !!w && w.classList.contains('show'), dead: !!document.querySelector('#kgQrBox.dead'),
      mask: m ? m.textContent : '', state: st ? st.textContent : '' }; })()`);
  say(degraded && qr.show, '点扫码后展开二维码区', qr);
  say(qr.dead && /未开放|失败/.test(qr.mask), '不可用时明确标出（不假装在轮询）', qr);
  say(/签名|20010|Cookie/.test(qr.state), '状态行说明原因与替代方案', { state: qr.state });
  await js(`(() => { const b = document.querySelector('#btnKgQrCookie'); if (b) b.click(); })()`);
  const fellBack = await waitFor(async () => js(`!!document.querySelector('#popKgAuth.show')`), 5000);
  say(fellBack, '一键降级到「导入 Cookie」面板');

  console.log('\n=== 6. 网络异常：失败原因 + 重试 ===');
  /* contextBridge 暴露的 api 是冻结对象，改不动成员；这里直接摆成失败态，
   * 验证的是「失败时界面长什么样」，网络层本身已有探针覆盖。 */
  await js(`(() => { document.querySelector('#popKgAuth').classList.remove('show');
    S.srcColl = null;
    S.srcMode = 'kg';
    S.srcHome.kugou = { status: 'error', err: '模拟网络异常', data: null, seq: 0 };
    renderSrcLib(); })()`);
  await waitFor(async () => (await snap()).status === 'error', 8000);
  s = await snap();
  say(s.status === 'error', '首页进入失败态', { status: s.status });
  say(/曲库加载失败/.test(s.homeText) && /模拟网络异常/.test(s.homeText), '把原因写清楚', { text: s.homeText.slice(0, 160) });
  say(await js(`!!document.querySelector('#neHome [data-act="refresh"]')`), '给出重试入口');

  const err = await js('window.__err || ""');
  if (err) { console.log('  [renderer error] ' + err); fail++; }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  app.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE CRASH', e); app.exit(2); });
