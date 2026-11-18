'use strict';
/**
 * 探针：导入歌单后「随机重复」「顺序错位」两条路径
 * ---------------------------------------------------------------------------
 * 现场：把另一个歌单整体覆盖进播放列表之后
 *   ① 随机播放还会抽到刚才已经播过的歌；
 *   ② 顺序播放不是从新列表的第一首开始，而是接着旧下标往下走（前面几首被跳过）。
 * 这里只用本地 wav，不依赖网络，方便反复跑。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-qorder-'));
app.setPath('userData', tmp);

/* A 组 10 首（原列表）与 B 组 8 首（导入的列表）；B 组故意包含 A 组的两首，
 * 用来验证「导入后随机还抽不抽得到刚播过的那些」。 */
const media = path.join(tmp, 'media');
fs.mkdirSync(media, { recursive: true });
const srcWav = path.join(root, 'demo', 'demo.wav');
const mk = (name, title) => {
  const f = path.join(media, name + '.wav');
  fs.copyFileSync(srcWav, f);
  return { path: f, title, artist: '探针', album: '', duration: 42,
    codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true };
};
const A = Array.from({ length: 10 }, (_, i) => mk('a' + String(i + 1).padStart(2, '0'), 'A' + (i + 1)));
const B = [
  A[0], A[1],                                              // 沿用 A 的两首（已播过）
  ...Array.from({ length: 6 }, (_, i) => mk('b' + String(i + 1).padStart(2, '0'), 'B' + (i + 1)))
];
const lib = [...A, ...B.filter(t => !A.includes(t))];
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(lib, null, 2));
const initSettings = {
  theme: 'dark', volume: 0, muted: true, globalKeys: false,
  playMode: 'seq',
  playlist: A.map(t => ({ id: t.path, title: t.title, artist: t.artist, duration: t.duration }))
};
const settingsFile = path.join(tmp, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify(initSettings, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0; let fail = 0;
const say = (ok, name, detail) => {
  if (ok) pass++; else fail++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
};
const waitFor = async (fn, ms = 12000, step = 150) => {
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

/* 直接把新列表写进设置并走应用真实的导入路径（plSelectSource 的 run 分支做的事）。
 * 导入后应用会异步 playAt(0)（当前曲不在新列表时），所以等游标落位再读快照。 */
const doImport = async (list, label) => {
  const r = await js(`(() => {
    const wasPlaying = !audio.paused;
    S.settings.playlist = ${JSON.stringify(list.map(t => ({ id: t.path, title: t.title, artist: t.artist, duration: t.duration })))};
    plSave();
    const kept = rebuildQueue('id');
    renderPl();
    if (!S.q.length) { stopPlayback(); return { kept, i: S.i, qLen: 0 }; }
    if (kept) {
      if (S.settings.playMode === 'shuffle' && curTrack()) {
        S.shufDone.add(curTrack().path);
        S.shufPool.delete(curTrack().path);
      }
    } else {
      void playAt(0, { autoplay: wasPlaying });
    }
    return { kept, i0: S.i, qLen: S.q.length };
  })()`);
  await waitFor(async () => { const s = await state(); return s.i >= 0 || s.qLen === 0; }, 8000);
  const s = await state();
  return { ...r, i: s.i, qLen: s.qLen, cur: s.cur };
};

const state = () => js(`({
  i: S.i, qLen: S.q.length, mode: S.settings.playMode,
  cur: curTrack() ? curTrack().title : null,
  src: (() => { const m = /p=([^&]+)/.exec(audio.src || ''); return m ? decodeURIComponent(m[1]).split('\\\\').pop() : ''; })(),
  paused: audio.paused,
  done: [...S.shufDone], pool: [...S.shufPool].map(id => (S.q.find(r => r.id === id) || {}).item ? S.q.find(r => r.id === id).item.title : id)
})`);

const next = async () => { await js('void next()'); await sleep(450); return state(); };

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  for (let i = 0; i < 200 && !(await js('S.tracks.length')); i++) await sleep(100);

  console.log('\n=== A. 顺序播放：播到第 4 首后导入 8 首新歌单 ===');
  await js('void playIndex(0)');
  await waitFor(async () => (await state()).paused === false);
  for (let k = 0; k < 3; k++) await next();
  const before = await state();
  say(before.i === 3 && before.cur === 'A4', '导入前：下标 3、正在放 A4', before);

  const imported = await doImport(B, 'B');
  const after = await state();
  console.log('   导入后:', JSON.stringify({ i: imported.i, qLen: imported.qLen, cur: imported.cur, kept: imported.kept, playingSrc: after.src, paused: after.paused }));
  /* 期望：当前曲 A4 不在新列表里 → 游标落到新列表第一首（A1），播放头跟着走 */
  say(after.i === 0 && after.cur === 'A1', '导入后游标落到新列表第一首（不是留在旧下标）', { i: after.i, cur: after.cur });
  say(after.paused === false, '导入前在放 → 导入后继续出声', { paused: after.paused, src: after.src });

  const n1 = await next();
  console.log('   导入后第一次 next:', JSON.stringify({ i: n1.i, cur: n1.cur }));
  say(n1.i === 1 && n1.cur === 'A2', '顺序：导入后按新列表顺序推进（0 → 1）', { i: n1.i, cur: n1.cur });

  console.log('\n=== B. 随机播放：播过 5 首后导入含重叠曲目的歌单 ===');
  await js("S.settings.playMode = 'shuffle'; syncModeBtn()");
  const restored = await doImport(A, 'A');
  const st0 = await state();
  say(st0.mode === 'shuffle', '模式仍是随机', st0.mode);
  await js('void playIndex(0)');
  await waitFor(async () => (await state()).paused === false);
  const played = ['A1'];
  for (let k = 0; k < 4; k++) { const s = await next(); played.push(s.cur); }
  const doneBefore = await state();
  console.log('   已播 5 首:', JSON.stringify(played), 'done=', doneBefore.done.length);
  say(new Set(played).size === 5, '随机一轮内前 5 首不重复', played);

  const imp2 = await doImport(B, 'B');
  const st2 = await state();
  console.log('   导入 B 后:', JSON.stringify({ i: imp2.i, qLen: imp2.qLen, cur: imp2.cur, kept: imp2.kept, done: st2.done.length, pool: st2.pool.length }));
  const again = [];
  for (let k = 0; k < 4; k++) { const s = await next(); again.push(s.cur); }
  const repeat = again.filter(t => played.includes(t));
  console.log('   导入后再抽 4 首:', JSON.stringify(again));
  say(repeat.length === 0, '导入后随机不再抽到刚播过的歌', { again, repeat });

  console.log('\n=== C. 列表增删后顺序不断档 ===');
  await js("S.settings.playMode = 'seq'; syncModeBtn()");
  await doImport(A, 'A');
  await js('void playIndex(0)');
  await waitFor(async () => (await state()).paused === false);
  for (let k = 0; k < 4; k++) await next();       // 走到 A5
  const at5 = await state();
  say(at5.cur === 'A5', '先走到 A5', at5.cur);
  // 删掉列表第 2 项（A2），当前曲 A5 应保位
  const afterDel = await js(`(() => { const list = plItems(); list.splice(1, 1); S.settings.playlist = list; plSave(); rebuildQueue('id'); renderPl(); return { i: S.i, cur: curTrack().title, qLen: S.q.length }; })()`);
  say(afterDel.cur === 'A5' && afterDel.i === 3, '删除前面的歌后当前曲保位（A5 变成第 4 项）', afterDel);
  const nDel = await next();
  say(nDel.cur === 'A6', '删除后 next 仍按列表顺序（A5 → A6）', nDel.cur);

  console.log('\n=== 报错 ===');
  console.log('  （见上方渲染层输出）');
  console.log('\n----------------------------------------');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  app.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE CRASH', e); app.exit(2); });
