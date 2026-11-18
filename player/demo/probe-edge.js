'use strict';
/**
 * 探针：边界与异常处理（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 只打「坏输入」：损坏的配置文件、不存在的文件、空曲库下的操作、接口全挂、
 * 重复扫描、非法路径。判据是「不崩、不静默、给出可读说法」，并且渲染层零报错。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

const root = path.join(__dirname, '..');
// 探针必须隔离：绝不把本机旧配置搬进测试环境
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-edge-'));
app.setPath('userData', tmp);

const logPath = path.join(root, 'demo', 'probe-edge.log');
fs.writeFileSync(logPath, '');
const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
  try { console.log(line); } catch {}
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
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
  /* 0) 预置坏文件：settings.json 是半截 JSON，library.json 是乱码 */
  fs.writeFileSync(path.join(tmp, 'settings.json'), '{"theme":"light","volume":0.5');
  fs.writeFileSync(path.join(tmp, 'library.json'), 'not-json-at-all');

  /* 网易云指到一个没人监听的端口：所有接口都失败，用来验证错误路径 */
  const dead = http.createServer(() => {});
  await new Promise(r => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise(r => dead.close(r));
  process.env.NE_BASE = 'http://127.0.0.1:' + deadPort;

  require(path.join(root, 'main.js'));
  const js = code => win.webContents.executeJavaScript(code, true);
  await waitFor(() => !!win && !win.webContents.isLoading());
  win.showInactive();
  await waitFor(() => win.isVisible(), 6000);
  await sleep(600);
  await js(`(() => { const s = document.createElement('style'); s.textContent = '*{transition:none!important;animation-duration:0s!important}'; document.head.appendChild(s); })()`);

  /* 1) 坏配置不阻断启动 */
  log('\n=== 1. 损坏的本地配置 ===');
  const boot = await js(`(() => ({
    theme: document.body.dataset.theme,
    volume: Number(audio.volume.toFixed(2)),
    tracks: S.tracks.length,
    hasSettings: !!S.settings,
    q: document.querySelector('#q') ? true : false
  }))()`);
  log('  ', JSON.stringify(boot));
  ok('坏 settings.json 不阻断启动', boot.hasSettings && boot.q === true);
  ok('回落到默认值', boot.volume === 0.78, String(boot.volume));
  ok('坏 library.json 不阻断启动', boot.tracks === 0);
  const badFiles = fs.readdirSync(tmp).filter(f => f.includes('.bad-'));
  ok('坏文件被改名留档而不是静默删除', badFiles.length >= 2, badFiles.join(','));

  /* 2) 空曲库下的所有播放操作 */
  log('\n=== 2. 空曲库边界 ===');
  const empty = await js(`(() => {
    const before = { i: S.i, playing: S.playing };
    togglePlay(); next(); prev(); seek(5); seek(-5);
    $('#btnPlay').click(); $('#btnNext').click(); $('#btnPrev').click();
    return {
      before, i: S.i, playing: S.playing,
      toast: document.querySelector('#toast').textContent,
      t: audio.currentTime, dur: String(audio.duration),
      src: String(audio.src || '')
    };
  })()`);
  log('  ', JSON.stringify(empty));
  ok('空曲库播放/切歌/跳转不崩', empty.i === -1 && empty.playing === false);
  ok('给出可读提示而不是静默', /先导入/.test(empty.toast), empty.toast);
  ok('没有把 NaN 写进 currentTime', Number.isFinite(empty.t), String(empty.t));

  /* 3) 不存在的文件 / 不支持的类型 */
  log('\n=== 3. 非法导入 ===');
  const bad1 = await js(`(async () => { await addPaths([${JSON.stringify(path.join(tmp, 'nope.mp3'))}]); return document.querySelector('#toast').textContent; })()`);
  ok('不存在的文件不崩且给出结果', typeof bad1 === 'string', bad1);

  const txt = path.join(tmp, 'note.txt');
  fs.writeFileSync(txt, 'hello');
  await js(`(async () => { await addPaths([${JSON.stringify(txt)}]); })()`);
  const afterTxt = await js(`S.tracks.length`);
  ok('非音频文件被过滤掉', afterTxt === 0, 'tracks=' + afterTxt);

  /* 4) 缺文件的曲目：播放要能跳过而不是卡死 */
  log('\n=== 4. 曲目文件丢失 ===');
  const gone = path.join(tmp, 'gone.mp3');
  fs.writeFileSync(gone, Buffer.alloc(2048, 7));       // 有文件但内容是垃圾
  await js(`(async () => { await addPaths([${JSON.stringify(gone)}]); })()`);
  await sleep(1200);
  const goneState = await js(`(() => {
    const k = S.tracks[S.i] || {};
    return { n: S.tracks.length, playing: S.playing, err: !!k.error, unavailable: k.unavailable || '',
      toast: document.querySelector('#toast').textContent };
  })()`);
  log('  ', JSON.stringify(goneState));
  ok('垃圾文件进曲库但标记异常或不可播', goneState.n === 1 && (goneState.err || !!goneState.unavailable || goneState.playing === false), JSON.stringify(goneState));

  /* 5) 重复导入同一文件不产生重复行 */
  await js(`(async () => { await addPaths([${JSON.stringify(gone)}, ${JSON.stringify(gone)}]); })()`);
  const dup = await js(`S.tracks.length`);
  ok('按 path 去重', dup === 1, 'tracks=' + dup);

  /* 6) 接口全挂：网易云首页 / 搜索都要给出错误而不是空白 */
  log('\n=== 6. 接口不可达 ===');
  await js(`setSource('net')`);
  await waitFor(async () => (await js(`S.ne.home.status`)) !== 'loading', 12000);
  const netFail = await js(`(() => ({
    status: S.ne.home.status,
    err: (S.ne.home.err || '').slice(0, 60),
    note: document.querySelector('#neNote').textContent.slice(0, 40),
    rows: document.querySelectorAll('#neHome .plrow').length,
    text: document.querySelector('#neHome').textContent.replace(/\\s+/g, ' ').trim().slice(0, 120)
  }))()`);
  log('  ', JSON.stringify(netFail));
  // 未登录 + 接口全挂：首页并不是「错误态」，但推荐歌单那一段必须给出可读原因，
  // 不能只留一块空白区域
  const shown = (netFail.status === 'error' && netFail.err) || /加载失败/.test(netFail.text);
  ok('接口不可达时页面给出可读原因', !!shown, netFail.text);
  ok('不是空白页（有分区与提示）', /推荐|歌单|扫码/.test(netFail.text), netFail.text.slice(0, 60));

  const searchFail = await js(`(async () => {
    document.querySelector('#q').value = '晴天';
    await neSearch();
    return { err: S.ne.err, items: S.ne.items.length, busy: S.ne.busy,
      text: document.querySelector('#libList').textContent.trim().slice(0, 40) };
  })()`);
  log('  ', JSON.stringify(searchFail));
  ok('搜索失败有提示且不留半截结果', !!searchFail.err && searchFail.items === 0 && !searchFail.busy, searchFail.text);

  /* 7) 音质：没有曲目时切档不崩 */
  log('\n=== 7. 无曲目时切档 ===');
  const q = await js(`(async () => {
    await setQuality('standard');
    return { q: S.settings.quality, toast: document.querySelector('#toast').textContent };
  })()`);
  ok('切档不抛错', q.q === 'standard', q.toast);

  /* 8) 重复扫描：第二次进来要能给出「正在扫描」而不是空结果 */
  log('\n=== 8. 并发扫描 ===');
  const wav = path.join(root, 'demo', 'demo.wav');
  const parallel = await js(`(async () => {
    const a = window.api.scan([${JSON.stringify(wav)}], []);
    const b = window.api.scan([${JSON.stringify(wav)}], []);
    const [ra, rb] = await Promise.all([a, b]);
    return { a: ra ? ra.length : -1, b: rb ? rb.length : -1 };
  })()`);
  log('  ', JSON.stringify(parallel));
  ok('并发扫描不返回误导性的空数组', parallel.a + parallel.b >= 1, JSON.stringify(parallel));

  /* 9) 窗口最小尺寸下不溢出 */
  log('\n=== 9. 最小窗口 ===');
  win.setSize(860, 560);
  await sleep(500);
  const over = await js(`(() => {
    const de = document.documentElement;
    return { sw: de.scrollWidth, cw: de.clientWidth, sh: de.scrollHeight, ch: de.clientHeight };
  })()`);
  ok('最小窗口无横向溢出', over.sw <= over.cw + 1, JSON.stringify(over));
  ok('最小窗口无纵向溢出', over.sh <= over.ch + 1, JSON.stringify(over));

  /* 10) 渲染层零报错 */
  log('\n=== 10. 报错汇总 ===');
  ok('渲染层无 JS 报错', errors.length === 0, errors.slice(0, 4).join(' | '));

  log('\n----------------------------------------');
  log(`通过 ${pass} 项，失败 ${fail} 项`);
  app.exit(fail ? 1 : 0);
})().catch(e => {
  log('FAIL ' + (e && e.stack || e));
  app.exit(1);
});
