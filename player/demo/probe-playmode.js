'use strict';
/**
 * 探针：播放列表作为唯一播放源 + 单一「播放模式」按键（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 验六组事：
 *   1. 启动：不出声、播放头停在上次那首（没有记录就停第一首）；队列 = 列表顺序；
 *   2. 顺序模式：next/prev 走相邻一首，到末尾不回绕、播完自动停；
 *   3. 单曲循环：播完重播当前；next 照常切下一首；
 *   4. 随机模式：不重复抽同一首、池空重洗继续、prev 沿着走过的历史回退；
 *   5. 一键循环：seq→one→shuffle→seq，图标/文案跟着变，切换不打断播放；
 *   6. 边界与持久化：切模式不动音频、重排保播、空列表、非法配置回落、
 *      播放进度落盘并在 reload 后恢复到原来的秒数、虚拟滚动只画少量行。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-pm-'));
app.setPath('userData', tmp);

const N = 6;
const media = path.join(tmp, 'media');
fs.mkdirSync(media, { recursive: true });
const srcWav = path.join(root, 'demo', 'demo.wav');
const st0 = fs.statSync(srcWav);
const tracks = [];
for (let i = 1; i <= N; i++) {
  const name = `pm-${String(i).padStart(2, '0')}.wav`;
  const p = path.join(media, name);
  fs.copyFileSync(srcWav, p);
  tracks.push({
    path: p, title: 'M' + String(i).padStart(2, '0'), artist: '探针', album: '模式',
    duration: 42, codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true,
    hasCover: false, hasLyric: false, mtime: st0.mtimeMs, size: st0.size, addedAt: Date.now()
  });
}
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(tracks, null, 2));
const playlist = tracks.map(t => ({ id: t.path, title: t.title, artist: t.artist, duration: t.duration }));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false, playlist, playMode: 'seq'
}));

const logPath = path.join(root, 'demo', 'probe-playmode.log');
fs.writeFileSync(logPath, '');
const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
  try { console.log(line); } catch {}
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    if (lvl >= 2 && !/Autofill|DevTools|Electron Security|快捷键冲突/.test(msg)) errors.push(msg);
  });
});
const js = code => win.webContents.executeJavaScript(code, true);

function waitForWin() {
  return new Promise(res => {
    const t = setInterval(() => {
      if (win && !win.webContents.isLoading()) { clearInterval(t); win.showInactive(); res(); }
    }, 80);
  });
}
async function waitFor(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}

/* 一次读全：队列、下标、模式按钮、音频、提示 */
const snap = `(() => {
  const btn = document.querySelector('#btnMode');
  const icons = ['icSeq','icOne','icShuffle'].map(id => {
    const el = document.getElementById(id);
    return el ? (el.style.display === 'none' ? 0 : 1) : -1;
  });
  const cur = S.i >= 0 && S.q[S.i] ? S.q[S.i].id : '';
  return {
    mode: S.settings.playMode,
    qLen: S.q.length, i: S.i,
    q: S.q.map(x => String(x.id).substring(String(x.id).lastIndexOf('\\\\') + 1)),
    cur: String(cur).substring(String(cur).lastIndexOf('\\\\') + 1),
    title: document.querySelector('#npT').textContent,
    paused: audio.paused, ct: +audio.currentTime.toFixed(2), src: String(audio.src || ''),
    icons, btnTitle: btn ? btn.title : '', btnOn: btn ? btn.classList.contains('on') : null,
    setMode: (document.querySelector('#setMode') || {}).textContent || '',
    toast: document.querySelector('#toast').textContent,
    playing: S.playing, badge: document.querySelector('#plNum').textContent,
    pos: S.settings.playPos
  };
})()`;

const clickLib = i => js(`(() => {
  const el = document.querySelector('#libList .item[data-i="${i}"]');
  if (!el) return 'no-row';
  el.click(); return 'ok';
})()`);

(async () => {
  require(path.join(root, 'main.js'));
  await waitForWin();
  await waitFor(async () => (await js('S.tracks.length')) > 0, 8000);
  await sleep(1200);

  /* ---------- 1. 启动状态 ---------- */
  log('=== 1. 启动：不自动出声，播放头摆好 ===');
  let s = await js(snap);
  log('  ' + JSON.stringify({ i: s.i, qLen: s.qLen, cur: s.cur, mode: s.mode, paused: s.paused, badge: s.badge }));
  ok('播放列表是唯一播放源（队列长度 = 列表长度）', s.qLen === N, `${s.qLen} vs ${N}`);
  ok('队列顺序与列表一致', JSON.stringify(s.q) === JSON.stringify(playlist.map(x => path.basename(x.id))), s.q.join(','));
  ok('启动不自动播放', s.paused === true && s.playing === false);
  ok('播放头停在第一首（没有进度记录时）', s.i === 0 && s.cur === 'pm-01.wav', `i=${s.i} cur=${s.cur}`);
  ok('模式默认顺序播放', s.mode === 'seq' && s.icons[0] === 1 && s.icons[1] === 0 && s.icons[2] === 0);
  ok('入口角标 = 列表长度', s.badge === String(N), s.badge);

  /* ---------- 2. 顺序模式 ---------- */
  log('=== 2. 顺序模式推进 ===');
  await js(`audio.play()`);
  ok('点播放能出声', await waitFor(async () => !(await js('audio.paused')), 4000));
  let pre = await js(snap);
  await js(`next()`);
  await waitFor(async () => (await js('S.i')) === 1, 4000);
  s = await js(snap);
  ok('next 走到下一首', s.i === 1 && s.cur === 'pm-02.wav', `i=${s.i} cur=${s.cur}`);
  ok('切歌确实换了音源', s.src !== pre.src);
  await js(`audio.currentTime = 0; prev()`);
  await waitFor(async () => (await js('S.i')) === 0, 4000);
  s = await js(snap);
  ok('prev 回到上一首（播放头 >3s 时才归零）', s.i === 0 && s.cur === 'pm-01.wav', `i=${s.i}`);
  // 到末尾：跳到最后一首再点 next，应保持不动并提示
  await js(`playAt(S.q.length - 1)`);
  await waitFor(async () => (await js('S.i')) === N - 1, 5000);
  await sleep(300);
  await js(`next()`);
  await sleep(400);
  s = await js(snap);
  ok('顺序模式到末尾不回绕', s.i === N - 1 && s.cur === 'pm-06.wav', `i=${s.i}`);
  ok('到末尾给提示', /最后一首/.test(s.toast), s.toast);
  // 播完自动停：把播放头放到最后一个字附近
  await js(`(async () => { audio.currentTime = Math.max(0, audio.duration - 0.08); await audio.play(); })()`);
  await waitFor(async () => await js('audio.ended || audio.paused'), 6000);
  s = await js(snap);
  ok('顺序模式播完自动停下', s.playing === false && s.paused === true, `playing=${s.playing}`);

  /* ---------- 3. 单曲循环 ---------- */
  log('=== 3. 单曲循环 ===');
  await js(`cycleMode()`);                    // seq → one
  s = await js(snap);
  ok('一键切到单曲循环', s.mode === 'one' && s.icons[1] === 1 && s.icons[0] === 0);
  ok('提示与设置页文案同步', /单曲循环/.test(s.toast) && s.setMode === '单曲循环', `${s.toast} / ${s.setMode}`);
  const beforeOne = await js('S.i');
  await js(`(async () => { audio.currentTime = Math.max(0, audio.duration - 0.08); await audio.play(); })()`);
  await waitFor(async () => (await js('audio.currentTime')) < 1.2, 6000);
  s = await js(snap);
  ok('播完重播同一首（不切歌）', s.i === beforeOne, `i ${beforeOne}→${s.i}`);
  ok('单曲循环下确实在放', s.playing === true || s.paused === false);
  await js(`next()`);
  await waitFor(async () => (await js('S.i')) === N - 1, 5000);
  s = await js(snap);
  ok('单曲循环下 next 照常切下一首', s.i === N - 1, `i=${s.i}`);

  /* ---------- 4. 随机模式 ---------- */
  log('=== 4. 随机模式 ===');
  await js(`cycleMode()`);                    // one → shuffle
  s = await js(snap);
  ok('一键切到随机播放', s.mode === 'shuffle' && s.icons[2] === 1 && s.icons[1] === 0);
  const picks = [];
  for (let k = 0; k < 4; k++) {
    const from = await js('S.i');
    await js(`next()`);
    await waitFor(async () => (await js('S.i')) !== from, 3000);
    picks.push(await js(`S.i`));
  }
  log('  随机序列：' + JSON.stringify(picks));
  ok('随机不重复抽到同一首（4 次互不相同）', new Set(picks).size === picks.length, JSON.stringify(picks));
  const prevFrom = await js('S.i');
  await js(`audio.currentTime = 0; prev()`);
  await sleep(500);
  s = await js(snap);
  ok('随机模式 prev 沿历史回退（不是又抽一次）', s.i !== prevFrom && picks.slice(0, -1).includes(s.i),
    `${prevFrom} → ${s.i}`);
  // 池空重洗：把池抽干后仍应有下一首
  await js(`(() => { S.shufPool.clear(); return S.shufPool.size; })()`);
  const beforePool = await js('S.i');
  await js(`next()`);
  await waitFor(async () => (await js('S.i')) !== beforePool, 3000);
  s = await js(snap);
  ok('随机池空了自动重洗（不会停）', s.i >= 0 && s.i !== beforePool, `i=${s.i}`);

  /* ---------- 5. 切模式不打断 ---------- */
  log('=== 5. 切模式不打断播放 ===');
  await js(`audio.play()`);
  await sleep(600);
  pre = await js(`({ src: String(audio.src), ct: audio.currentTime, i: S.i, paused: audio.paused })`);
  await js(`cycleMode()`);                    // shuffle → seq
  await sleep(500);
  s = await js(snap);
  const post = await js(`({ src: String(audio.src), ct: audio.currentTime, i: S.i, paused: audio.paused })`);
  ok('循环一圈回到顺序播放', s.mode === 'seq' && s.icons[0] === 1);
  ok('切模式不换音源、不跳曲、不停播',
    post.src === pre.src && post.i === pre.i && post.paused === false && post.ct >= pre.ct,
    `ct ${pre.ct}→${post.ct}`);
  ok('按钮状态跟着模式走（顺序=off）', s.btnOn === false && /顺序播放/.test(s.btnTitle), `${s.btnOn} ${s.btnTitle}`);
  ok('键盘 R 也能切（同一入口）', await js(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'r', bubbles: true }));
    return S.settings.playMode;
  })()`) === 'one');

  /* ---------- 6. 重排、空列表、非法配置 ---------- */
  log('=== 6. 边界：重排 / 空列表 / 脏配置 ===');
  await js(`S.settings.playMode = 'seq'; syncModeBtn();`);
  await js(`playAt(2)`);
  await waitFor(async () => (await js('S.i')) === 2, 4000);
  const mvBefore = await js(`({ cur: S.q[2].id, src: String(audio.src) })`);
  await js(`plMove(2, 1)`);                    // 当前曲下移一位
  await sleep(300);
  s = await js(snap);
  const mvAfter = await js(`({ i: S.i, cur: S.q[S.i].id, src: String(audio.src), q: S.q.map(x => String(x.id).split('\\\\').pop()) })`);
  ok('重排后当前曲目靠 id 保位', mvAfter.cur === mvBefore.cur && s.cur === 'pm-03.wav', `i=${mvAfter.i} cur=${s.cur}`);
  ok('重排后队列顺序确实变了', mvAfter.q[2] === 'pm-04.wav' && mvAfter.q[3] === 'pm-03.wav', mvAfter.q.join(','));
  ok('重排不动音频', mvAfter.src === mvBefore.src);

  const dirty = await js(`({ a: migratePlayMode({ shuffle: true, repeat: 'off' }),
    b: migratePlayMode({ repeat: 'one' }), c: migratePlayMode({ repeat: 'all' }),
    d: migratePlayMode({ playMode: 'nope' }), e: migratePlayMode({}) })`);
  log('  迁移结果 ' + JSON.stringify(dirty));
  ok('旧配置 shuffle:true → 随机', dirty.a === 'shuffle');
  ok('旧配置 repeat:one → 单曲循环', dirty.b === 'one');
  ok('旧配置 repeat:all → 顺序（行为变化：末尾停）', dirty.c === 'seq');
  ok('非法 playMode 回落顺序', dirty.d === 'seq' && dirty.e === 'seq');
  ok('非法值进入 syncModeBtn 后被纠正', await js(`(() => { S.settings.playMode = 'zzz'; syncModeBtn(); return S.settings.playMode; })()`) === 'seq');

  /* ---------- 7. 播放进度持久化 + reload 恢复 ---------- */
  log('=== 7. 进度持久化与重启恢复 ===');
  await js(`(() => { const qi = S.q.findIndex(x => String(x.id).endsWith('pm-04.wav')); return playAt(qi); })()`);
  await waitFor(async () => /pm-04/.test(await js('S.q[S.i] ? S.q[S.i].id : ""')), 4000);
  await js(`audio.currentTime = 12; audio.pause(); persistPos(true)`);
  await sleep(800);
  const disk1 = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
  ok('settings.json 落了 playPos', !!disk1.playPos && /pm-04/.test(String(disk1.playPos.id)) && disk1.playPos.t >= 11,
    JSON.stringify(disk1.playPos && { t: Math.round(disk1.playPos.t) }));
  ok('落盘也记下了播放模式', disk1.playMode === 'seq', String(disk1.playMode));

  win.webContents.reload();
  await waitFor(async () => { try { return (await js('typeof S !== "undefined" && S.q.length')) > 0; } catch { return false; } }, 12000);
  await sleep(1500);
  s = await js(snap);
  ok('reload 后恢复到上次那首', s.cur === 'pm-04.wav', `${s.cur} i=${s.i}`);
  ok('reload 后进度回到 ~12s', s.ct >= 11 && s.ct <= 13.5, `ct=${s.ct}`);
  ok('reload 后仍然不自动出声', s.paused === true, `paused=${s.paused}`);

  /* ---------- 8. 虚拟滚动 ---------- */
  log('=== 8. 长列表虚拟滚动 ===');
  const many = await js(`(() => {
    const list = [];
    for (let i = 0; i < 3000; i++) list.push({ id: 'fake-' + i, title: 'T' + i, artist: 'X', duration: 10 });
    S.settings.playlist = list;
    rebuildQueue();
    PL.view = 'list';
    openPop(document.querySelector('#popPl'), document.querySelector('#btnPl'));
    renderPl();
    const body = document.querySelector('#plBody');
    return { rows: body.querySelectorAll('.pl-row').length, sh: Math.round(body.scrollHeight),
      ch: Math.round(body.clientHeight), pads: body.querySelectorAll('.pl-pad').length };
  })()`);
  log('  ' + JSON.stringify(many));
  ok('3000 首只渲染可视窗口的行（< 40）', many.rows > 0 && many.rows < 40, `rows=${many.rows}`);
  ok('滚动高度按总行数撑开', many.sh > 3000 * 46 * 0.9, `scrollHeight=${many.sh}`);
  ok('上下各有一个撑高的 spacer', many.pads === 2);
  const scrolled = await js(`(() => {
    const body = document.querySelector('#plBody');
    body.scrollTop = 1000 * 46;
    renderPlRows();
    const rows = [...body.querySelectorAll('.pl-row')];
    return { first: rows.length ? rows[0].dataset.i : -1, rows: rows.length };
  })()`);
  ok('滚动后重画的是对应窗口', scrolled.first >= 990 && scrolled.first <= 1005, JSON.stringify(scrolled));

  /* ---------- 9. 曲库行点击 + 空列表 ---------- */
  log('=== 9. 曲库点击两分支 / 空列表 ===');
  await js(`(() => {
    S.settings.playlist = [{ id: S.tracks[4].path, title: 'M05', artist: '探针', duration: 42 }];
    plSave(); rebuildQueue(); renderPl();
    return playAt(0);
  })()`);
  await waitFor(async () => /pm-05/.test(await js('S.q[S.i] ? S.q[S.i].id : ""')), 4000);
  await js(`audio.play()`);
  await sleep(300);
  const libClick = await clickLib(2);               // pm-03：不在列表里
  await waitFor(async () => /pm-03/.test(await js('S.q[S.i] ? S.q[S.i].id : ""')), 5000);
  s = await js(snap);
  ok('点不在列表里的曲库行：插到当前曲之后并播放',
    libClick === 'ok' && s.qLen === 2 && s.q[1] === 'pm-03.wav' && s.cur === 'pm-03.wav',
    s.q.join(','));
  ok('插入后确实在出声', s.paused === false);
  const jump = await clickLib(4);                   // pm-05：已在列表里
  await waitFor(async () => /pm-05/.test(await js('S.q[S.i] ? S.q[S.i].id : ""')), 5000);
  s = await js(snap);
  ok('点已在列表里的曲库行：直接跳过去，不重复插入',
    jump === 'ok' && s.qLen === 2 && s.cur === 'pm-05.wav', `${s.qLen} 首 / ${s.cur}`);

  await js(`(() => { S.settings.playlist = []; plSave(); rebuildQueue(); stopPlayback(); })()`);
  await sleep(200);
  s = await js(snap);
  ok('清空后队列为空、播放头失效、音源已卸掉',
    s.qLen === 0 && s.i === -1 && s.src === '' && s.paused === true,
    `q=${s.qLen} i=${s.i} src=${s.src ? 'yes' : 'empty'}`);
  await js(`document.querySelector('#btnPlay').click()`);
  await sleep(300);
  s = await js(snap);
  ok('空列表点播放给提示而不是静默', /播放列表是空的|都不在曲库/.test(s.toast), s.toast);

  /* ---------- 汇总 ---------- */
  log('');
  log('=== 渲染层报错 ===');
  log(errors.length ? errors.join('\n') : '  （无）');
  log('');
  log('----------------------------------------');
  log(`通过 ${pass} 项，失败 ${fail} 项`);
  setTimeout(() => app.quit(), 200);
})().catch(e => {
  log('PROBE CRASH ' + ((e && e.stack) || e));
  setTimeout(() => app.quit(), 200);
});
