'use strict';
/**
 * 探针：自查用的边界压力测试（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 专挑新播放模型里最容易出错的地方下手：
 *   1. 空列表下把每个入口都点一遍（不能抛、不能静默、不能留音源）
 *   2. playPos 越界 / 指向已删除的 id
 *   3. 删到只剩一首、删正在播的最后一首
 *   4. 重排边界（第一行上移、最后一行下移）
 *   5. 连点 next 不等落定
 *   6. 播放中导入曲目（mergeTracks 不许打乱队列）
 *   7. 双击曲库行（不许重复插入）
 *   8. 随机模式下删歌（随机池里不能留已删的 id）
 *   9. 单曲循环下删当前曲
 *  10. 面板开着删到空、滚到底删最后一行
 *  11. 队列里的失效行（曲库里没有）自动跳过
 *  12. autoplay:false 之后按播放，要接着放
 *  13. 关译文不重载音频
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-audit-'));
app.setPath('userData', tmp);

const media = path.join(tmp, 'media');
fs.mkdirSync(media, { recursive: true });
const srcWav = path.join(root, 'demo', 'demo.wav');
const st = fs.statSync(srcWav);
const tracks = [];
for (let i = 1; i <= 30; i++) {
  const name = `au-${String(i).padStart(2, '0')}.wav`;
  const p = path.join(media, name);
  fs.copyFileSync(srcWav, p);
  tracks.push({
    path: p, title: 'A' + i, artist: '审计', album: '边界', duration: 42,
    codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true,
    hasCover: false, hasLyric: false, mtime: st.mtimeMs, size: st.size, addedAt: Date.now()
  });
}
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(tracks, null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false, playMode: 'seq',
  playlist: tracks.slice(0, 4).map(t => ({ id: t.path, title: t.title, artist: t.artist, duration: t.duration }))
}));

const logPath = path.join(root, 'demo', 'probe-audit.log');
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
async function waitFor(fn, ms = 6000, step = 110) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}

/* 每次都重新读一遍全量状态，避免各节互相看到旧快照 */
const snap = `(() => {
  const k = S.i >= 0 ? curTrack() : null;
  const short = p => String(p || '').substring(String(p).lastIndexOf('\\\\') + 1);
  const pop = document.querySelector('#popPl');
  const body = document.querySelector('#plBody');
  return {
    q: S.q.length, i: S.i, mode: S.settings.playMode,
    cur: k ? short(k.path) : '', src: String(audio.src || ''),
    paused: audio.paused, ct: +audio.currentTime.toFixed(2),
    list: plItems().map(x => short(x.id)),
    lib: S.tracks.length,
    qIds: S.q.map(x => short(x.id)),
    qResolved: S.q.map(x => !!x.t),
    pool: S.shufPool ? S.shufPool.size : -1,
    hist: S.hist.length,
    badge: document.querySelector('#plNum').textContent,
    empty: !!document.querySelector('#plBody .pl-empty'),
    rows: document.querySelectorAll('#plBody .pl-row').length,
    onRows: document.querySelectorAll('#plBody .pl-row.on').length,
    scrollTop: Math.round(body.scrollTop), scrollMax: Math.round(body.scrollHeight - body.clientHeight),
    toast: document.querySelector('#toast').textContent,
    playPos: S.settings.playPos ? { id: short(S.settings.playPos.id), t: Math.round(S.settings.playPos.t) } : null
  };
})()`;

/* 把一段代码包起来跑，返回 {ok} 或 {err}：用来验「不许抛」 */
const safe = code => js(`(() => { try { ${code}; return { ok: true }; }
  catch (e) { return { ok: false, err: String(e && e.message || e) }; } })()`);

async function setMode(m) {
  await js(`(() => { S.settings.playMode = '${m}'; syncModeBtn(); })()`);
  await sleep(120);
}

async function playRow(listIdx) {
  await js(`(() => { const b = document.querySelector('#plBody');
    b.scrollTop = Math.max(0, ${listIdx} * 46 - 80); })()`);
  await sleep(120);
  return js(`(() => {
    const r = document.querySelector('#plBody .pl-row[data-i="${listIdx}"]');
    if (!r) return 'no-row';
    r.click(); return 'ok';
  })()`);
}

async function delRow(listIdx) {
  await js(`(() => { const b = document.querySelector('#plBody');
    b.scrollTop = Math.max(0, ${listIdx} * 46 - 80); })()`);
  await sleep(120);
  return js(`(() => {
    const r = document.querySelector('#plBody .pl-row[data-i="${listIdx}"]');
    if (!r) return 'no-row';
    const b = r.querySelector('[data-del]');
    if (!b) return 'no-btn';
    b.click(); return 'ok';
  })()`);
}

async function openPl() {
  const shown = await js(`document.querySelector('#popPl').classList.contains('show')`);
  if (!shown) { await js(`document.querySelector('#btnPl').click()`); await sleep(300); }
}
async function closePl() {
  const shown = await js(`document.querySelector('#popPl').classList.contains('show')`);
  if (shown) { await js(`closePops()`); await sleep(200); }
}

(async () => {
  require(path.join(root, 'main.js'));
  await waitForWin();
  await waitFor(async () => (await js('S.tracks.length')) > 0, 8000);
  await sleep(1200);

  /* ---------- 1. playPos 越界与失效 id ---------- */
  log('=== 1. playPos 越界 / 失效 id ===');
  let s = await js(snap);
  log('  启动：' + JSON.stringify({ q: s.q, i: s.i, cur: s.cur, paused: s.paused, playPos: s.playPos }));
  ok('启动不自动出声', s.paused === true);
  ok('队列与列表等长', s.q === s.list.length, `${s.q} vs ${s.list.length}`);

  await js(`(() => { S.settings.playPos = { id: S.tracks[2].path, t: 9999 }; restorePos(); })()`);
  await waitFor(async () => (await js(`Number.isFinite(audio.duration)`)) === true, 6000);
  await sleep(400);
  s = await js(snap);
  const dur = await js('audio.duration');
  log('  越界恢复：' + JSON.stringify({ i: s.i, cur: s.cur, ct: s.ct, dur }));
  ok('越界进度被夹住（不会跳过整首）', s.ct < dur, `ct=${s.ct} dur=${dur}`);
  ok('越界后仍停在那首歌上', s.cur === 'au-03.wav', s.cur);
  ok('恢复后依然不出声', s.paused === true);

  await js(`(() => { S.settings.playPos = { id: 'D:\\\\nope\\\\gone.wav', t: 12 }; restorePos(); })()`);
  await sleep(500);
  s = await js(snap);
  log('  失效 id 恢复：' + JSON.stringify({ i: s.i, cur: s.cur, paused: s.paused }));
  ok('playPos 指向不在列表里的歌：不崩、下标合法', s.i >= -1 && s.i < Math.max(1, s.q), `i=${s.i}`);

  /* ---------- 2. 空列表：每个入口都点一遍 ---------- */
  log('=== 2. 空列表下的所有入口 ===');
  await js(`(() => { stopPlayback(); S.settings.playlist = []; plSave(); rebuildQueue(); renderPl(); })()`);
  await sleep(300);
  s = await js(snap);
  ok('清空后队列为空、播放头失效', s.q === 0 && s.i === -1, `q=${s.q} i=${s.i}`);
  ok('清空后音源已卸掉', s.src === '', s.src ? 'still-src' : 'empty');

  for (const [name, code] of [
    ['next', 'next()'], ['prev', 'prev()'], ['togglePlay', 'togglePlay()'],
    ['seek', 'seek(5)'], ['cycleMode', 'cycleMode()'], ['stopPlayback', 'stopPlayback()'],
    ['renderPl', 'renderPl()'], ['renderMediaSession', 'renderMediaSession()'],
    ['paintMeta', 'paintMeta()'], ['updateLyric', 'updateLyric(3)'],
    ['markCurrent', 'markCurrent()'], ['plSyncBadge', 'plSyncBadge()']
  ]) {
    const r = await safe(code);
    ok(`空列表下 ${name}() 不抛`, r.ok === true, r.err || '');
    if (name === 'togglePlay') {
      // 只看这一下的提示：后面的 cycleMode 会把 toast 覆盖掉
      const t = await js(`document.querySelector('#toast').textContent`);
      ok('空列表下点播放给出提示', /播放列表是空的|先/.test(t), t);
    }
  }
  s = await js(snap);
  ok('空列表时不留下音源', s.src === '');

  /* ---------- 3. 从曲库起播 + 双击不重复插 ---------- */
  log('=== 3. 曲库行单击 / 双击 ===');
  await js(`(() => { document.querySelector('#libList .item[data-i="0"]').click(); })()`);
  await waitFor(async () => !(await js('audio.paused')), 6000);
  s = await js(snap);
  ok('空列表点曲库：插入并播放', s.q === 1 && s.cur === 'au-01.wav' && s.paused === false, `${s.q} ${s.cur}`);

  await js(`(() => { const el = document.querySelector('#libList .item[data-i="1"]');
    el.click(); el.click(); el.click(); })()`);
  await sleep(1500);
  s = await js(snap);
  log('  连点三次：' + JSON.stringify({ q: s.q, list: s.list, cur: s.cur }));
  ok('连点同一首不会重复插入', s.q === 2, `q=${s.q}`);
  ok('连点后停在点的那首歌上', s.cur === 'au-02.wav', s.cur);

  /* ---------- 4. 连点 next / 到末尾 ---------- */
  log('=== 4. 连点 next 与末尾 ===');
  await js(`(() => { next(); next(); next(); })()`);
  await sleep(1200);
  s = await js(snap);
  ok('连点 next 不会越界', s.i >= 0 && s.i < s.q, `i=${s.i}/${s.q}`);
  ok('末尾再 next 给提示且不崩', /最后一首|播放列表/.test(s.toast) || s.i === s.q - 1, s.toast);

  /* ---------- 5. 重排边界 ---------- */
  log('=== 5. 重排边界 ===');
  await openPl();
  s = await js(snap);
  const orderBefore = s.list.join(',');
  const curBefore = s.cur;
  const srcBefore = s.src;
  await js(`(() => { plMove(0, -1); })()`);          // 第一行上移：应该不动
  await sleep(300);
  s = await js(snap);
  ok('第一行上移：顺序不变', s.list.join(',') === orderBefore, s.list.join(','));
  await js(`(() => { plMove(plItems().length - 1, 1); })()`);  // 最后一行下移：应该不动
  await sleep(300);
  s = await js(snap);
  ok('最后一行下移：顺序不变', s.list.join(',') === orderBefore);
  ok('重排边界操作不动当前曲与音源', s.cur === curBefore && s.src === srcBefore);

  /* ---------- 6. 播放中导入曲目 ---------- */
  log('=== 6. 播放中导入 ===');
  s = await js(snap);
  const qBefore = s.q, iBefore = s.i, listBefore = s.list.join(','), libBefore = s.lib;
  await js(`(() => { mergeTracks([S.tracks[5]], { sort: false, silent: true }); })()`);
  await sleep(500);
  s = await js(snap);
  ok('导入不改动队列长度与顺序', s.q === qBefore && s.list.join(',') === listBefore, `q ${qBefore}→${s.q}`);
  ok('导入不改动播放头', s.i === iBefore && s.cur === curBefore);
  ok('导入让曲库变长（这本就已在库里，长度不变即可）', s.lib === libBefore, `${libBefore}→${s.lib}`);
  ok('导入后队列里没有未解析的行', s.qResolved.every(Boolean), JSON.stringify(s.qResolved));

  /* ---------- 7. 随机模式删歌 ---------- */
  log('=== 7. 随机模式删歌 ===');
  await setMode('shuffle');
  await openPl();
  s = await js(snap);
  const delAt = s.list.findIndex(x => x !== s.cur);
  const delId = s.list[delAt];
  const delFull = await js(`plItems()[${delAt}].id`);
  await delRow(delAt);
  await sleep(500);
  s = await js(snap);
  ok('随机模式删歌后队列同步', !s.list.includes(delId), s.list.join(','));
  ok('随机池里没有残留已删的 id', (await js(`S.shufPool.has(${JSON.stringify(delFull)})`)) === false,
    delFull.substring(delFull.lastIndexOf('\\') + 1));
  let allValid = true;
  for (let n = 0; n < 10; n++) {
    await js('next()');
    await sleep(360);
    const t = await js(`(() => { const k = curTrack(); return k ? k.path : ''; })()`);
    if (!t) { allValid = false; break; }
  }
  ok('随机连切 10 次都落在有效曲目上', allValid);
  s = await js(snap);
  ok('随机连切后下标仍合法', s.i >= 0 && s.i < s.q, `i=${s.i}/${s.q}`);

  /* ---------- 8. 单曲循环删当前曲 ---------- */
  log('=== 8. 单曲循环删当前曲 ===');
  await setMode('one');
  await openPl();
  s = await js(snap);
  const curIdx = s.list.indexOf(s.cur);
  const expectNext = s.list[curIdx + 1] || s.list[curIdx - 1] || '';
  const r8 = await delRow(curIdx);
  await sleep(1400);
  s = await js(snap);
  log('  删当前：' + JSON.stringify({ r8, cur: s.cur, q: s.q, paused: s.paused, mode: s.mode }));
  ok('单曲循环下删当前曲不崩', r8 === 'ok' && s.q >= 0);
  ok('删完还停在一首有效曲目上（或干净地停下）',
    (s.cur !== '' && s.q > 0) || (s.q === 0 && s.cur === ''), `cur=${s.cur} q=${s.q}`);
  ok('删除不会把模式改掉', s.mode === 'one', s.mode);

  /* ---------- 9. 队列里的失效行 ---------- */
  log('=== 9. 队列里的失效行 ===');
  await setMode('seq');
  await js(`(() => {
    const ghost = { id: 'D:\\\\nope\\\\ghost.mp3', title: 'Ghost', artist: '', duration: 0 };
    S.settings.playlist = [plToItem(S.tracks[0]), ghost, plToItem(S.tracks[1])];
    plSave(); rebuildQueue('id'); renderPl();
    if (!document.querySelector('#popPl').classList.contains('show')) document.querySelector('#btnPl').click();
  })()`);
  await sleep(500);
  await openPl();
  s = await js(snap);
  log('  队列：' + JSON.stringify({ list: s.list, resolved: s.qResolved }));
  ok('幽灵行夹在中间，且标记为未解析', s.list.length === 3 && s.qResolved[1] === false, JSON.stringify(s.qResolved));
  await playRow(1);                                   // 点幽灵行
  await sleep(2500);
  const g9 = await js(`({ cur: ${'`'}${'`'}, paused: audio.paused, playing: S.playing, i: S.i,
    src: String(audio.src).slice(0, 60), rs: audio.readyState, ns: audio.networkState,
    err: audio.error && audio.error.code, dur: audio.duration, ct: +audio.currentTime.toFixed(2),
    toast: document.querySelector('#toast').textContent })`);
  log('  点幽灵行之后：' + JSON.stringify(g9));
  s = await js(snap);
  ok('点到幽灵行会跳到下一首有效曲目', s.cur === 'au-02.wav', s.cur);
  ok('跳过去之后确实在放', s.paused === false, `paused=${s.paused} rs=${g9.rs} err=${g9.err}`);

  /* ---------- 10. 面板开着删到空 ---------- */
  log('=== 10. 面板开着删到空 ===');
  await openPl();
  for (let guard = 0; guard < 12; guard++) {
    s = await js(snap);
    if (!s.q) break;
    await delRow(0);
    await sleep(320);
  }
  s = await js(snap);
  log('  删空后：' + JSON.stringify({ q: s.q, i: s.i, empty: s.empty, badge: s.badge, src: s.src, playPos: s.playPos }));
  ok('删到空：队列 0、播放头 -1', s.q === 0 && s.i === -1);
  ok('删到空：面板显示空状态', s.empty === true && s.badge === '0', `empty=${s.empty} badge=${s.badge}`);
  ok('删到空：音源卸掉、播放位置清掉', s.src === '' && s.playPos === null);
  ok('删到空：不崩、渲染层无报错', errors.length === 0, errors.join(' | '));

  /* ---------- 11. 长列表滚到底删最后一行 ---------- */
  log('=== 11. 长列表滚动边界 ===');
  await js(`(() => {
    closePops();
    S.settings.playlist = S.tracks.map(plToItem);     // 30 首，足够触发内部滚动
    plSave(); rebuildQueue('id'); renderPl();
    const btn = document.querySelector('#btnPl'), pop = document.querySelector('#popPl');
    if (!pop.classList.contains('show')) { openPop(pop, btn); btn.classList.add('open'); }
    renderPl();
  })()`);
  await sleep(500);
  await js(`(() => { const b = document.querySelector('#plBody'); b.scrollTop = b.scrollHeight; })()`);
  await sleep(400);
  s = await js(snap);
  log('  滚到底：' + JSON.stringify({ rows: s.list.length, top: s.scrollTop, max: s.scrollMax }));
  ok('列表超出面板高度（确实在内部滚动）', s.scrollMax > 0, `max=${s.scrollMax}`);
  ok('滚到底后不超出上限', s.scrollTop <= s.scrollMax + 1, `${s.scrollTop}/${s.scrollMax}`);
  ok('滚到底仍有行渲染（不是白屏）', s.rows > 0, `rows=${s.rows}`);
  await delRow(29);
  await sleep(500);
  s = await js(snap);
  ok('滚到底删最后一行：少一行、不崩', s.list.length === 29 && errors.length === 0, `n=${s.list.length}`);

  /* ---------- 12. autoplay:false 之后按播放 ---------- */
  log('=== 12. 暂停态恢复后按播放 ===');
  await js(`(() => { closePops(); playAt(0, { autoplay: false, seekTo: 10 }); })()`);
  await waitFor(async () => (await js(`Number(audio.readyState) >= 1`)) === true, 6000);
  await sleep(500);
  s = await js(snap);
  ok('autoplay:false 摆好位置且不出声', s.paused === true && s.ct > 8, `ct=${s.ct}`);
  const beforePlay = s.ct;
  await js('togglePlay()');
  await waitFor(async () => !(await js('audio.paused')), 6000);
  await sleep(600);
  s = await js(snap);
  ok('按播放后从原位置继续（不是从头）', s.paused === false && s.ct >= beforePlay, `${beforePlay}→${s.ct}`);

  /* ---------- 13. 关译文不重载音频 ---------- */
  log('=== 13. 关译文不影响播放 ===');
  const trBefore = await js(`({ src: String(audio.src), ct: +audio.currentTime.toFixed(2) })`);
  await js(`(() => { const b = document.querySelector('#swTr'); if (b) b.click(); })()`);
  await sleep(400);
  const trAfter = await js(`({ src: String(audio.src), ct: +audio.currentTime.toFixed(2),
    noTr: document.body.classList.contains('no-tr'), on: document.querySelector('#swTr').classList.contains('on') })`);
  ok('关译文：音源不变、播放不断', trAfter.src === trBefore.src && trAfter.ct >= trBefore.ct,
    `ct ${trBefore.ct}→${trAfter.ct}`);
  ok('关译文：body 带上 no-tr 且开关状态同步', trAfter.noTr === true && trAfter.on === false,
    `noTr=${trAfter.noTr} on=${trAfter.on}`);
  await js(`(() => { const b = document.querySelector('#swTr'); if (b) b.click(); })()`);   // 复原

  /* ---------- 14. 模式切换后 ended 行为仍然成立 ---------- */
  log('=== 14. 末尾 ended 与模式 ===');
  await setMode('seq');
  const lastInfo = await js(`(() => {
    closePops();
    const n = S.q.length;
    try { playAt(n - 1); return 'ok ' + n; } catch (e) { return 'ERR ' + ((e && e.message) || e); }
  })()`);
  log('  playAt(最后一行)：' + lastInfo);
  // 用 snap 读状态而不是直接 executeJavaScript('audio.paused')：
  // 后者在播放刚开始的一瞬间偶发 "Script failed to execute"（渲染层正在起播）。
  await waitFor(async () => { const x = await js(snap); return x.paused === false && Number.isFinite(x.dur); }, 6000);
  // 必须等 metadata 到位再设 currentTime：duration 还是 NaN 时写 currentTime 会抛
  // "The provided double value is non-finite"，探针自己踩过一次。
  await js(`(() => { if (!Number.isFinite(audio.duration)) return 0; audio.currentTime = Math.max(0, audio.duration - 0.4); return 1; })()`);
  await waitFor(async () => (await js(snap)).paused === true, 8000);
  await sleep(500);
  s = await js(snap);
  ok('顺序模式播到末尾自动停下', s.paused === true, `paused=${s.paused} i=${s.i}/${s.q}`);

  /* ---------- 15. 网易云失效行（离线） ---------- */
  log('=== 15. 网易云失效行（离线） ===');
  await setMode('seq');
  await js(`(() => {
    const ghost = { id: 'ne:999999999', title: 'NetGhost', artist: '', duration: 0 };
    S.settings.playlist = [plToItem(S.tracks[2]), ghost, plToItem(S.tracks[3])];
    plSave(); rebuildQueue('id'); closePops(); renderPl();
  })()`);
  await sleep(300);
  await openPl();
  s = await js(snap);
  log('  队列：' + JSON.stringify({ list: s.list, resolved: s.qResolved }));
  await playRow(1);                                   // 点网易云幽灵行（必然拉不到直链）
  const landed = await waitFor(async () => { const x = await js(snap); return x.i !== 1; }, 26000, 400);
  // 换行之后还要等播放器真的起播：只等 S.i 变化会抓到「刚切过去、还没出声」的那一帧
  await waitFor(async () => { const x = await js(snap); return x.paused === false; }, 8000, 200);
  s = await js(snap);
  log('  点网易云失效行之后：' + JSON.stringify({ i: s.i, cur: s.cur, paused: s.paused, toast: s.toast }));
  ok('网易云失效行：自动跳到下一首并接着放', landed && s.paused === false, `i=${s.i} cur=${s.cur}`);
  ok('网易云失效行：渲染层无报错', errors.length === 0, errors[0] || '');

  /* ---------- 16. seek 边界 ---------- */
  log('=== 16. seek 边界 ===');
  await js(`(() => { closePops(); S.settings.playlist = S.tracks.slice(0, 3).map(plToItem);
    plSave(); rebuildQueue('id'); renderPl(); playAt(0); })()`);
  await waitFor(async () => { const x = await js(snap); return x.paused === false && Number.isFinite(x.dur); }, 8000);
  await js('seek(9999)');
  await sleep(400);
  let sk = await js(`({ ct: +audio.currentTime.toFixed(2), dur: audio.duration })`);
  ok('seek(+9999) 夹到曲末不越界', Number.isFinite(sk.ct) && sk.ct <= sk.dur, JSON.stringify(sk));
  await js('seek(-9999)');
  await sleep(400);
  sk = await js(`({ ct: +audio.currentTime.toFixed(2) })`);
  ok('seek(-9999) 夹到 0 不越界', sk.ct >= 0 && sk.ct < 1, JSON.stringify(sk));

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
