'use strict';
/**
 * 探针：左下角播放列表面板（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 验六件事：
 *   1. 入口：原「音质文字标签」已被按钮替换，位置在左下、尺寸与那一行文字同量级；
 *   2. 空列表：面板给空状态，且整块面板压在控制栏之上（不盖播放键/进度条）、不出窗口；
 *   3. 插入：从候选里挑一首追加到末尾、按 id 去重、给轻提示，不动正在播放的音频；
 *   4. 选择：整单覆盖（先出确认条，确认前不改数据；确认后旧内容清空而不是追加）；
 *   5. 删除：只动本列表不动曲库；删的正好是当前曲目就按顺序切下一首；
 *   6. 持久化 + 长列表：写进 settings.json，面板内部滚动而不撑破容器。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-pl-'));
app.setPath('userData', tmp);

/* 14 份同样的音频：够让面板出现内部滚动，也够验「覆盖 vs 追加」 */
const media = path.join(tmp, 'media');
fs.mkdirSync(media, { recursive: true });
const srcWav = path.join(root, 'demo', 'demo.wav');
const st0 = fs.statSync(srcWav);
const tracks = [];
for (let i = 1; i <= 14; i++) {
  const name = `pl-${String(i).padStart(2, '0')}.wav`;
  const p = path.join(media, name);
  fs.copyFileSync(srcWav, p);
  tracks.push({
    path: p, title: 'P' + String(i).padStart(2, '0'), artist: '探针', album: '播放列表',
    duration: 42, codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true,
    hasCover: false, hasLyric: false, mtime: st0.mtimeMs, size: st0.size, addedAt: Date.now()
  });
}
/* library.json 就是 Track 数组本身（main.js 的 library:get 直接 readJSON(libraryPath, [])） */
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(tracks, null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false, playlist: []
}));

const logPath = path.join(root, 'demo', 'probe-playlist.log');
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
async function waitFor(fn, ms = 8000, step = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}

/* 面板 + 入口 + 播放器的一次性快照 */
const snap = `(() => {
  const pop = document.querySelector('#popPl');
  const btn = document.querySelector('#btnPl');
  const body = document.querySelector('#plBody');
  const ctrl = document.querySelector('.ctrl');
  const pr = pop.getBoundingClientRect(), br = btn.getBoundingClientRect();
  const cr = ctrl.getBoundingClientRect(), bd = body.getBoundingClientRect();
  const k = S.i >= 0 ? S.tracks[S.i] : null;
  return {
    show: pop.classList.contains('show'),
    view: PL.view,
    ask: PL.ask ? PL.ask.text : '',
    btn: { left: Math.round(br.left), top: Math.round(br.top), w: Math.round(br.width), h: Math.round(br.height) },
    pop: { left: Math.round(pr.left), top: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height), bottom: Math.round(pr.bottom) },
    ctrlTop: Math.round(cr.top),
    vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight,
    badge: document.querySelector('#plNum').textContent,
    count: document.querySelector('#plCount').textContent,
    rows: [...document.querySelectorAll('#plBody .pl-row')].length,
    dels: [...document.querySelectorAll('#plBody [data-del]')].length,
    adds: [...document.querySelectorAll('#plBody [data-add]')].length,
    srcs: [...document.querySelectorAll('#plBody [data-src]')].length,
    empty: !!document.querySelector('#plBody .pl-empty'),
    askBox: !!document.querySelector('#plBody .pl-ask'),
    list: plItems().map(x => x.id.substring(x.id.lastIndexOf('\\\\') + 1)),
    libLen: S.tracks.length,
    cur: k ? k.path.substring(k.path.lastIndexOf('\\\\') + 1) : '',
    curTitle: document.querySelector('#npT').textContent,
    paused: audio.paused, ct: +audio.currentTime.toFixed(2), src: String(audio.src || ''),
    toast: document.querySelector('#toast').textContent,
    scroll: { h: Math.round(body.scrollHeight), ch: Math.round(body.clientHeight), bodyTop: Math.round(bd.top), bodyBottom: Math.round(bd.bottom) },
    note: document.querySelector('#plNote').textContent,
    back: !!document.querySelector('#plBody .pl-back'),
    fmtTag: !!document.querySelector('#fmtTag')
  };
})()`;

(async () => {
  require(path.join(root, 'main.js'));
  await waitForWin();
  await waitFor(async () => (await js('S.tracks.length')) > 0, 8000);
  await sleep(1200);

  /* ---------- 1. 入口 ---------- */
  log('=== 1. 入口替换 ===');
  let s = await js(snap);
  log('  ' + JSON.stringify(s.btn) + ' vw=' + s.vw + ' vh=' + s.vh);
  ok('原音质文字标签已移除', s.fmtTag === false);
  ok('入口按钮在左下角', s.btn.left < s.vw * 0.25 && s.btn.top > s.vh * 0.8,
    `left=${s.btn.left} top=${s.btn.top}`);
  ok('尺寸与原 11px 文字标签同量级（高 ≤ 26）', s.btn.h <= 26 && s.btn.h >= 20, `h=${s.btn.h}`);
  ok('角标就是列表长度 0', s.badge === '0', s.badge);

  /* ---------- 2. 空列表 + 面板位置 ---------- */
  log('=== 2. 空状态与面板定位 ===');
  await js(`document.querySelector('#btnPl').click()`);
  await sleep(320);
  s = await js(snap);
  log('  ' + JSON.stringify({ pop: s.pop, ctrlTop: s.ctrlTop, empty: s.empty }));
  ok('点入口展开面板', s.show === true);
  ok('空列表显示空状态占位', s.empty === true);
  ok('面板不盖住控制栏', s.pop.bottom <= s.ctrlTop, `bottom=${s.pop.bottom} ctrlTop=${s.ctrlTop}`);
  ok('面板完整在窗口内', s.pop.left >= 0 && s.pop.left + s.pop.w <= s.vw && s.pop.top >= 0);

  /* ---------- 3. 插入 ---------- */
  log('=== 3. 插入（追加 + 去重） ===');
  const before = await js(`({ ct: audio.currentTime, src: String(audio.src), paused: audio.paused })`);
  await js(`document.querySelector('#plInsert').click()`);
  await sleep(200);
  s = await js(snap);
  ok('切到挑歌页且有候选', s.view === 'add' && s.adds > 0, `adds=${s.adds}`);
  ok('挑歌页有返回列表的入口', s.back === true);
  ok('挑歌页底部提示换成插入说明', /追加到末尾/.test(s.note), s.note);
  await js(`document.querySelector('#plBody [data-add]').click()`);
  await sleep(220);
  s = await js(snap);
  ok('追加到末尾 1 首', s.list.length === 1, JSON.stringify(s.list));
  ok('角标同步为 1', s.badge === '1', s.badge);
  ok('给了轻提示', /已加入播放列表/.test(s.toast), s.toast);
  await js(`document.querySelector('#plBody [data-add]').click()`);   // 同一首再点一次
  await sleep(220);
  s = await js(snap);
  ok('按 id 去重（仍 1 首）', s.list.length === 1, JSON.stringify(s.list));
  ok('重复时提示已在列表', /已在播放列表/.test(s.toast), s.toast);
  const after = await js(`({ ct: audio.currentTime, src: String(audio.src), paused: audio.paused })`);
  ok('插入不动播放（src 不变、继续播）',
    after.src === before.src && after.paused === false && after.ct >= before.ct,
    `ct ${before.ct}→${after.ct}`);

  /* ---------- 4. 选择：覆盖 ---------- */
  log('=== 4. 选择歌单（覆盖前确认） ===');
  const preSel = await js(`({ ct: audio.currentTime, src: String(audio.src), paused: audio.paused })`);
  await js(`document.querySelector('#plSelect').click()`);
  await sleep(200);
  s = await js(snap);
  ok('切到选歌单页且列出来源', s.view === 'pick' && s.srcs > 0, `srcs=${s.srcs}`);
  ok('选歌单页有返回列表的入口', s.back === true);
  ok('选歌单页底部提示换成覆盖说明', /整体覆盖/.test(s.note), s.note);
  // 返回列表：视图切回、入口提示复位、已选内容不变
  await js(`document.querySelector('#plBody .pl-back').click()`);
  await sleep(200);
  s = await js(snap);
  ok('点返回列表回到列表视图', s.view === 'list' && s.back === false, s.view);
  ok('返回列表后条目还在', s.list.length === 1, JSON.stringify(s.list));
  ok('返回列表后底部提示复位', /只从本列表移除/.test(s.note), s.note);
  await js(`document.querySelector('#plSelect').click()`);
  await js(`document.querySelector('#plBody [data-src="0"]').click()`);
  await sleep(260);
  s = await js(snap);
  ok('覆盖前先出确认条', s.askBox === true && /覆盖播放列表/.test(s.ask), s.ask.slice(0, 40));
  ok('确认前不改数据（仍 1 首）', s.list.length === 1, JSON.stringify(s.list));
  await js(`document.querySelector('#plBody [data-pl="yes"]').click()`);
  await sleep(320);
  s = await js(snap);
  ok('确认后整单覆盖为 14 首', s.list.length === 14, String(s.list.length));
  ok('是覆盖不是追加（旧的那首不在首尾重复）',
    new Set(s.list).size === 14 && s.list[0] === 'pl-01.wav' && s.list[13] === 'pl-14.wav',
    JSON.stringify(s.list.slice(0, 2)) + '…' + s.list[13]);
  ok('载入后有提示', /已载入 14 首/.test(s.toast), s.toast);
  const postSel = await js(`({ ct: audio.currentTime, src: String(audio.src), paused: audio.paused })`);
  ok('覆盖不动播放（不重载音频、不打断）',
    postSel.src === preSel.src && postSel.paused === false && postSel.ct >= preSel.ct,
    `ct ${preSel.ct}→${postSel.ct}`);

  /* ---------- 5-a. 删除非当前曲目 ---------- */
  log('=== 5a. 删除非当前曲目 ===');
  s = await js(snap);
  log('  当前播放：' + s.cur + '（' + s.curTitle + '）');
  const curIdx = s.list.indexOf(s.cur);
  const delIdx = curIdx === 3 ? 4 : 3;             // 挑一个不是当前曲目的下标
  const curBefore = s.cur;
  const preDel = await js(`({ ct: audio.currentTime, src: String(audio.src), lib: S.tracks.length, i: S.i })`);
  await js(`document.querySelector('#plBody [data-del="${delIdx}"]').click()`);
  await sleep(280);
  s = await js(snap);
  ok('只从列表移除（14→13）', s.list.length === 13, String(s.list.length));
  ok('曲库没被改动', s.libLen === preDel.lib, `${preDel.lib}→${s.libLen}`);
  ok('当前曲目与音频都没被影响',
    s.cur === curBefore && s.paused === false && s.ct >= preDel.ct,
    `cur=${s.cur} ct ${preDel.ct}→${s.ct}`);

  /* ---------- 5-b. 删除正在播放的曲目 ---------- */
  log('=== 5b. 删除正在播放的曲目 ===');
  s = await js(snap);
  const nowIdx = s.list.indexOf(s.cur);
  const expectNext = s.list[nowIdx + 1] || s.list[0];
  log(`  删 ${s.cur}（下标 ${nowIdx}），期望切到 ${expectNext}`);
  await js(`document.querySelector('#plBody [data-del="${nowIdx}"]').click()`);
  await waitFor(async () => (await js(`S.tracks[S.i].path`)) !== s.list[nowIdx] , 6000);
  await sleep(500);
  const afterDel = await js(`(() => {
    const k = S.tracks[S.i];
    return { cur: k ? k.path.substring(k.path.lastIndexOf('\\\\') + 1) : '', title: document.querySelector('#npT').textContent,
      paused: audio.paused, ct: +audio.currentTime.toFixed(2), len: plItems().length, show: document.querySelector('#popPl').classList.contains('show') };
  })()`);
  log('  ' + JSON.stringify(afterDel));
  ok('删当前曲目后按顺序切到下一首', afterDel.cur === expectNext, `${afterDel.cur} vs ${expectNext}`);
  ok('切歌后正常播放', afterDel.paused === false, `ct=${afterDel.ct}`);
  ok('列表长度再 -1', afterDel.len === 12, String(afterDel.len));
  ok('播完关掉面板', afterDel.show === false);

  /* ---------- 6. 长列表滚动 + 清空 ---------- */
  log('=== 6. 长列表滚动与清空 ===');
  await js(`document.querySelector('#btnPl').click()`);
  await sleep(320);
  s = await js(snap);
  log('  ' + JSON.stringify(s.scroll));
  ok('长列表在面板内部滚动', s.scroll.h > s.scroll.ch, `${s.scroll.h} > ${s.scroll.ch}`);
  ok('滚动区仍完整落在面板与控制栏之间',
    s.scroll.bodyTop >= s.pop.top && s.scroll.bodyBottom <= s.ctrlTop + 1);
  await js(`document.querySelector('#plClear').click()`);
  await sleep(200);
  s = await js(snap);
  ok('清空也要先确认', s.askBox === true && /清空/.test(s.ask), s.ask.slice(0, 30));
  await js(`document.querySelector('#plBody [data-pl="yes"]').click()`);
  await sleep(260);
  s = await js(snap);
  ok('清空后回到空状态', s.list.length === 0 && s.empty === true && s.badge === '0', `badge=${s.badge}`);
  ok('清空不影响曲库', s.libLen === 14, String(s.libLen));

  /* ---------- 7. 持久化 ---------- */
  log('=== 7. 持久化 ===');
  await js(`(() => {
    const ts = S.tracks.slice(0, 3);
    ts.forEach(t => plAppend(t));
    return plItems().length;
  })()`);
  await sleep(700);                              // saveSettings 有 200ms 防抖
  const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
  ok('settings.json 里落了 playlist', Array.isArray(disk.playlist) && disk.playlist.length === 3,
    JSON.stringify((disk.playlist || []).map(x => x.title)));
  ok('落盘元素含 id/标题/歌手/时长',
    disk.playlist.every(x => typeof x.id === 'string' && x.id && typeof x.title === 'string'
      && typeof x.artist === 'string' && typeof x.duration === 'number'),
    JSON.stringify(disk.playlist[0]));
  const back = await js(`window.api.getSettings().then(s => (s.playlist || []).map(x => x.title))`);
  ok('重新读取设置能还原顺序', JSON.stringify(back) === JSON.stringify(['P01', 'P02', 'P03']), JSON.stringify(back));

  /* ---------- 8. 脏数据兜底 ---------- */
  log('=== 8. 脏数据兜底 ===');
  const dirty = await js(`(() => {
    const norm = plNormalize([null, 1, 'x', { id: '' }, { id: 'a', title: 'A' }, { id: 'a', title: 'dup' },
      { id: 'b', title: 42, artist: null, duration: 'abc' }]);
    return norm;
  })()`);
  log('  ' + JSON.stringify(dirty));
  ok('非对象/空 id 丢弃、重复 id 去重', dirty.length === 2 && dirty[0].id === 'a' && dirty[1].id === 'b', JSON.stringify(dirty));
  ok('标题与歌手缺失或非字符串时给安全值',
    dirty[1].title === '42' && dirty[1].artist === '' && dirty[1].duration === 0, JSON.stringify(dirty[1]));

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
