'use strict';
/**
 * 探针：窗口 ↔ 全屏切换时，歌词是否「抽搐」（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 量三件事：
 *   1. 当前句的中心与歌词列中心的偏差（dev）—— 稳定时应接近 0；
 *   2. `.ln-inner` 的 translateY 轨迹 —— 抖动表现为反复来回改方向；
 *   3. 抖动系数 = 总行程 / 净位移，平滑时约等于 1，抽搐时会明显大于 1。
 *
 * 场景：稳定播放 → 进全屏（同时放大视口）→ 回窗口（同时缩小视口）。
 * 每个场景逐帧采样 700ms，判定：
 *   maxDev ≤ 3px、抖动系数 ≤ 1.25、切换期间 body.lyr-resize 出现过、结束后已摘掉。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-fstran-'));
app.setPath('userData', tmp);

const media = path.join(tmp, 'media');
fs.mkdirSync(media, { recursive: true });
const wav = path.join(media, 'tran.wav');
fs.copyFileSync(path.join(root, 'demo', 'demo.wav'), wav);
fs.copyFileSync(path.join(root, 'demo', 'demo.png'), path.join(media, 'tran.png'));
fs.writeFileSync(path.join(media, 'tran.lrc'), [
  '[00:00.00]第一句的量词是位置',
  '[00:06.00]第二句长一点用来观察切换时的抖动',
  '[00:14.00]第三句',
  '[00:20.00]最后一句'
].join('\n'), 'utf8');
const st = fs.statSync(wav);
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify([{
  path: wav, title: '切换过渡', artist: '本地', album: '演示', duration: 42,
  codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true,
  hasCover: false, hasLyric: true, mtime: st.mtimeMs, size: st.size, addedAt: Date.now()
}], null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, playMode: 'seq', globalKeys: false
}));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));

let win = null;
app.on('browser-window-created', (_e, w) => { win = w; });
const js = c => win.webContents.executeJavaScript(c, true);

/* 在页面里连续采 700ms，返回每帧的偏差与 translateY */
const SAMPLE = `(() => new Promise(res => {
  const col = document.querySelector('.lyrcol');
  const inner = document.querySelector('#lnInner');
  const stage = document.querySelector('.stage');
  const out = [];
  const t0 = performance.now();
  const tick = () => {
    const on = document.querySelector('.ln.on') || document.querySelector('#lnInner .ln');
    const cr = col.getBoundingClientRect();
    const colMid = cr.top + cr.height / 2;
    const lr = on ? on.getBoundingClientRect() : null;
    const dev = lr ? (lr.top + lr.height / 2) - colMid : null;
    const tr = /translateY\\((-?[\\d.]+)px\\)/.exec(inner.style.transform || '');
    const sc = getComputedStyle(stage);
    out.push({
      t: +(performance.now() - t0).toFixed(0),
      dev: dev === null ? null : +dev.toFixed(2),
      y: tr ? +tr[1] : 0,
      fs: on ? +parseFloat(getComputedStyle(on).fontSize).toFixed(2) : null,
      op: +parseFloat(sc.opacity).toFixed(3),
      lock: document.body.classList.contains('lyr-resize'),
      morph: document.body.classList.contains('fs-swap'),
      dur: getComputedStyle(inner).transitionDuration
    });
    if (performance.now() - t0 < 700) requestAnimationFrame(tick); else res(out);
  };
  requestAnimationFrame(tick);
}))()`;

const metrics = (rows, label) => {
  const devs = rows.map(r => r.dev).filter(v => v !== null);
  const ys = rows.map(r => r.y);
  const maxDev = devs.length ? Math.max(...devs.map(Math.abs)) : null;
  let travel = 0, reversals = 0, prevDir = 0;
  for (let i = 1; i < ys.length; i++) {
    const d = ys[i] - ys[i - 1];
    travel += Math.abs(d);
    if (Math.abs(d) > 0.5) {
      const dir = Math.sign(d);
      if (prevDir && dir !== prevDir) reversals++;
      prevDir = dir;
    }
  }
  const net = Math.abs(ys[ys.length - 1] - ys[0]);
  const wobble = net > 1 ? +(travel / net).toFixed(2) : (travel > 1 ? 999 : 1);
  const lockFrames = rows.filter(r => r.lock).length;
  const durZero = rows.filter(r => r.lock && (r.dur === '0s')).length;
  /* 字号的中间值个数：过渡生效时会有一串中间尺寸，直接跳变只有 2 个端点 */
  const fsSet = new Set(rows.map(r => r.fs).filter(v => v !== null));
  /* 舞台淡入：透明度离开 1 的帧数（软化动画真的跑了） */
  const ops = rows.map(r => r.op).filter(v => v !== null);
  const stageFade = ops.filter(v => v < 0.995).length;
  const m = {
    frames: rows.length, maxDev, travel: +travel.toFixed(1), net: +net.toFixed(1),
    wobble, reversals, lockFrames, lockDurZero: durZero,
    morphFrames: rows.filter(r => r.morph).length,
    fsSteps: fsSet.size,
    stageFade,
    minOp: ops.length ? +Math.min(...ops).toFixed(3) : null,
    lockAfter: rows[rows.length - 1].lock
  };
  log(label, JSON.stringify(m));
  return m;
};

let pass = 0, fail = 0;
const say = (ok, name, extra) => { log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(extra)); ok ? pass++ : fail++; };

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  for (let i = 0; i < 100 && !(await js('S.tracks.length')); i++) await sleep(100);
  await js('audio.pause(); audio.currentTime = 8;');
  await sleep(900);

  console.log('\n=== 1. 稳定状态（基准） ===');
  const base = metrics(await js(SAMPLE), 'base');
  say(base.maxDev !== null && base.maxDev <= 3, '稳定时当前句在歌词列中轴上', { dev: base.maxDev });
  say(!base.lockAfter, '稳定时没有挂 lyr-resize', { lock: base.lockAfter });

  console.log('\n=== 2. 进全屏（视口 1100×700 → 1707×1067） ===');
  const toFs = js(SAMPLE);
  await sleep(30);
  await js('applyFs(true)');
  win.setContentSize(1707, 1067);
  const mFs = metrics(await toFs, 'to-fullscreen');
  say(mFs.maxDev !== null && mFs.maxDev <= 3, '进全屏过程中当前句始终在中轴上', { dev: mFs.maxDev });
  say(mFs.wobble <= 1.25, '进全屏时位移没有来回抖', { wobble: mFs.wobble, reversals: mFs.reversals });
  say(mFs.lockFrames > 0, '切换期间确实挂上了 lyr-resize', { frames: mFs.lockFrames });
  say(mFs.lockDurZero === mFs.lockFrames, '锁住期间位移过渡是 0s', { zero: mFs.lockDurZero, lock: mFs.lockFrames });
  /* 选 A 方案之后：换版要有 240ms 的「推近 + 淡入」，期间舞台透明度低于 1 */
  say(mFs.morphFrames > 0, '进全屏时挂了 fs-swap（允许软化动画）', { frames: mFs.morphFrames });
  say(mFs.stageFade > 0, '舞台做了一次淡入，换版不是啪一下', { faded: mFs.stageFade, minOp: mFs.minOp });

  console.log('\n=== 3. 回到窗口（视口 1707×1067 → 1100×700） ===');
  const toWin = js(SAMPLE);
  await sleep(30);
  await js('applyFs(false)');
  win.setContentSize(1100, 700);
  const mWin = metrics(await toWin, 'to-window');
  say(mWin.maxDev !== null && mWin.maxDev <= 3, '回窗口过程中当前句始终在中轴上', { dev: mWin.maxDev });
  say(mWin.wobble <= 1.25, '回窗口时位移没有来回抖', { wobble: mWin.wobble, reversals: mWin.reversals });
  say(!mWin.lockAfter, '切换结束后 lyr-resize 已摘掉', { lock: mWin.lockAfter });

  console.log('\n=== 4. 连续快速切换三次（全屏→窗口→全屏） ===');
  const burst = js(SAMPLE);
  await sleep(20);
  for (const on of [true, false, true]) { await js(`applyFs(${on})`); win.setContentSize(on ? 1707 : 1100, on ? 1067 : 700); await sleep(90); }
  const mBurst = metrics(await burst, 'burst');
  say(mBurst.maxDev !== null && mBurst.maxDev <= 3, '连点时当前句也没跑偏', { dev: mBurst.maxDev });
  /* 连点三次 = 视口来回变三次，位移本来就该跟去跟回：
   * 总行程约等于 3 倍单程，方向反转次数等于 2。超出说明多抖了。 */
  say(mBurst.travel <= 145, '连点时位移只跟着视口走，没有额外抖动', { travel: mBurst.travel });
  say(mBurst.reversals <= 2, '连点时位移方向随视口变化，没有反复', { reversals: mBurst.reversals });
  await sleep(700);
  say(!(await js('document.body.classList.contains("lyr-resize")')), '连点之后回复正常状态');
  const settled = await js(`(() => {
    const col = document.querySelector('.lyrcol').getBoundingClientRect();
    const on = document.querySelector('.ln.on');
    if (!on) return null;
    const lr = on.getBoundingClientRect();
    return +((lr.top + lr.height / 2) - (col.top + col.height / 2)).toFixed(2);
  })()`);
  say(settled !== null && Math.abs(settled) <= 1, '连点结束后当前句回到中轴', { dev: settled });

  log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  app.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('PROBE CRASH', e); app.exit(2); });
