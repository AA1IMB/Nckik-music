'use strict';
/**
 * 探针：播放列表面板「选择歌单 / 插入歌曲」视图里滚动，会不会串回播放列表
 * ---------------------------------------------------------------------------
 * 现场：播放列表里已经有歌 → 点左下角入口 → 点「选择歌单」→ 在面板里上下滚，
 * 面板内容会变回播放列表的歌曲行（再点一下就直接切歌了）。
 *
 * 不碰网络，只用本地 wav：先把面板切到 pick / add 视图，再制造滚动
 * （pick 视图只有一两个来源、不一定能滚，所以直接派发 scroll 事件；
 *  add 视图有 12 首候选、真的能滚，用真实 scrollTop 再验证一次）。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-plscroll-'));
app.setPath('userData', tmp);

const media = path.join(tmp, 'media');
fs.mkdirSync(media, { recursive: true });
const srcWav = path.join(root, 'demo', 'demo.wav');
const mk = (name, title) => {
  const f = path.join(media, name + '.wav');
  fs.copyFileSync(srcWav, f);
  return { path: f, title, artist: '探针', album: '', duration: 42,
    codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true };
};
const lib = Array.from({ length: 40 }, (_, i) => mk('p' + String(i + 1).padStart(2, '0'), 'P' + String(i + 1).padStart(2, '0')));
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(lib, null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false,
  playMode: 'seq',
  playlist: lib.map(t => ({ id: t.path, title: t.title, artist: t.artist, duration: t.duration }))
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0; let fail = 0;
const say = (ok, name, detail) => {
  if (ok) pass++; else fail++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
};
const waitFor = async (fn, ms = 12000, step = 120) => {
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

/* 一次把面板状态读全：视图、各类行、确认条、音频与游标 */
const snap = () => js(`(() => {
  const body = $('#plBody');
  const rows = [...body.querySelectorAll('.pl-row')];
  const q = sel => body.querySelectorAll(sel).length;
  return {
    view: PL.view,
    show: $('#popPl').classList.contains('show'),
    rows: rows.length,
    dataI: rows.map(r => r.dataset.i).filter(v => v !== undefined).map(Number),
    dataSrc: rows.map(r => r.dataset.src).filter(v => v !== undefined).map(Number),
    dataAdd: rows.map(r => r.dataset.add).filter(v => v !== undefined).map(Number),
    ask: $('#plAsk').textContent.trim().slice(0, 40),
    bodyText: body.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120),
    pad: q('.pl-pad'),
    scrollTop: Math.round(body.scrollTop),
    scrollMax: Math.round(body.scrollHeight - body.clientHeight),
    i: S.i,
    paused: audio.paused,
    src: (audio.currentSrc || audio.src || '').split('/').pop(),
    qLen: S.q.length
  };
})()`);

/* 与用户操作一致：点面板里的按钮 / 行 */
const click = sel => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
const fireScroll = () => js(`(() => { $('#plBody').dispatchEvent(new Event('scroll')); return true; })()`);
const setScroll = px => js(`(() => { $('#plBody').scrollTop = ${px}; return $('#plBody').scrollTop; })()`);

setTimeout(() => { console.log('\nTIMEOUT 探针超时退出'); app.exit(3); }, 120000);

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  for (let i = 0; i < 200 && (await js('S.q.length')) < 40; i++) await sleep(100);
  await sleep(300);

  console.log('\n§0 打开面板（列表视图）');
  await click('#btnPl');
  await sleep(250);
  let s = await snap();
  say(s.show && s.view === 'list', '面板打开且停在列表视图', { show: s.show, view: s.view });
  say(s.dataI.length > 0 && s.dataSrc.length === 0, '列表视图渲染的是歌曲行（data-i）', { rows: s.rows, dataI: s.dataI.slice(0, 3) });

  console.log('\n§1 点「选择歌单」→ pick 视图');
  await click('#plSelect');
  await sleep(200);
  s = await snap();
  say(s.view === 'pick', '切到选择歌单视图', s.view);
  say(s.dataSrc.length > 0 && s.dataI.length === 0, 'pick 视图只有歌单行（data-src），没有歌曲行', { rows: s.rows, dataSrc: s.dataSrc });
  const pickText = s.bodyText;

  console.log('\n§2 pick 视图里触发滚动（复现点）');
  await fireScroll();
  await sleep(150);
  s = await snap();
  say(s.view === 'pick', '滚动后面板仍停在选择歌单视图', s.view);
  say(s.dataI.length === 0, '滚动后没有被换成歌曲行（data-i 应为 0）', { dataI: s.dataI.slice(0, 5), rows: s.rows });
  say(s.dataSrc.length > 0 && s.bodyText === pickText, 'pick 内容没变（歌单仍在）', { before: pickText, after: s.bodyText });

  console.log('\n§3 「插入歌曲」→ add 视图，真实滚动');
  await click('#plInsert');
  await sleep(200);
  const before = await snap();
  say(before.view === 'add' && before.dataAdd.length > 0, '切到挑歌视图且渲染了候选（data-add）', { view: before.view, add: before.dataAdd.length });
  say(before.scrollMax > 0, '挑歌视图内容超出一屏、可以滚动', { scrollMax: before.scrollMax });
  await setScroll(200);
  await sleep(250);
  s = await snap();
  say(s.view === 'add', '真实滚动后仍停在挑歌视图', s.view);
  say(s.dataAdd.length > 0 && s.dataI.length === 0, '真实滚动后没有被换成歌曲行', { dataAdd: s.dataAdd.length, dataI: s.dataI.slice(0, 5) });
  say(s.i === before.i && s.paused === before.paused, '真实滚动没有切歌（S.i 与播放状态不变）', { iBefore: before.i, iAfter: s.i, paused: s.paused });

  console.log('\n§4 返回列表：虚拟滚动仍然工作');
  await click('#plBody [data-view="list"]');
  await sleep(250);
  s = await snap();
  say(s.view === 'list' && s.dataI.length > 0, '回到列表视图', { view: s.view, dataI: s.dataI.slice(0, 3) });
  await setScroll(99999);
  await sleep(250);
  s = await snap();
  say(s.scrollTop > 0 && s.dataI.length > 0, '列表视图仍能滚动并重画窗口', { scrollTop: s.scrollTop, rows: s.dataI.length });
  say(s.dataI[0] > 0, '滚到底后首行下标跟着前移（虚拟滚动生效）', { first: s.dataI[0], last: s.dataI[s.dataI.length - 1] });
  await setScroll(0);
  await sleep(150);

  console.log('\n§5 确认条不串视图');
  await click('#plClear');
  await sleep(200);
  s = await snap();
  say(s.ask.length > 0, '点「清空」后列表视图出现确认条', s.ask);
  await click('#plSelect');
  await sleep(200);
  s = await snap();
  say(s.view === 'pick' && s.ask === '', '切到选择歌单后确认条已清掉', { view: s.view, ask: s.ask });

  console.log('\n§6 列表行点击仍然能切歌（防回归）');
  await click('#plBody [data-view="list"]');
  await sleep(200);
  const beforePlay = await snap();
  await click('#plBody .pl-row[data-i="4"]');
  await waitFor(async () => (await js('S.i')) === 4, 6000);
  await sleep(200);
  s = await snap();
  say(s.i === 4, '点第 5 行把游标移到 4', { iBefore: beforePlay.i, iAfter: s.i });
  say(/p05\.wav$/.test(s.src), '播放的是那一行对应的文件', s.src);

  console.log('\n§7 空列表：滚轮 + 滚动 + 面板内点歌单');
  /* §6 点行播放会把面板收起，这里先把「打开」状态归一化，再清空列表 */
  if (!(await js(`$('#popPl').classList.contains('show')`))) { await click('#btnPl'); await sleep(300); }
  await js(`void (() => { S.settings.playlist = []; plSave(); rebuildQueue('id'); stopPlayback(); renderPl(); })()`);
  await sleep(250);
  s = await snap();
  say(s.show && s.rows === 0 && /播放列表是空的/.test(s.bodyText), '清空后列表显示空状态', { rows: s.rows, text: s.bodyText.slice(0, 24) });
  await click('#plSelect');
  await sleep(200);
  await js(`(() => { const b = $('#plBody'); b.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true })); b.dispatchEvent(new Event('scroll')); return true; })()`);
  await sleep(150);
  s = await snap();
  say(s.view === 'pick' && s.dataI.length === 0 && s.dataSrc.length > 0, '空列表下滚轮与滚动都不会换掉选择面板', { view: s.view, dataI: s.dataI, dataSrc: s.dataSrc });
  await click('#plBody [data-src="0"]');
  await sleep(250);
  const ask2 = await js(`({ ask: $('#plAsk').textContent.trim().slice(0, 60), view: PL.view, paused: audio.paused, i: S.i, qLen: S.q.length })`);
  say(/覆盖播放列表/.test(ask2.ask) && ask2.view === 'list', '面板内点歌单 → 回列表并给出覆盖确认', ask2);
  say(ask2.paused && ask2.i === -1 && ask2.qLen === 0, '空列表点歌单不会自己开始播放', ask2);
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  app.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE CRASH', e && e.stack || e); app.exit(2); });
