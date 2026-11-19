'use strict';
/**
 * 探针：全屏切换的「旧画面淡出、新画面淡入」遮罩（不属于项目代码）
 * ---------------------------------------------------------------------------
 * B 方案的观感只能靠帧序列判断，这里采样遮罩本身的四个状态：
 *   1. `.fs-cover` 是否挂上了 `on`（遮罩在切换瞬间就位）；
 *   2. 里面有没有图（dataURL 抓到了没）；
 *   3. 有没有出现 `out`（淡出真的开始了）；
 *   4. 收尾时 `on/out` 都摘掉、`src` 清空（不把几 MB 的位图留在内存里）。
 * 顺带复查 A 方案没被破坏：切换结束后当前句仍在中轴上。
 *
 * 走的是真实路径（点标题栏的全屏按钮 / 点全屏里的「退出全屏」），
 * 所以 `setFullscreen()` 里的「先抓图再切窗口」也会被测到。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-fscov-'));
app.setPath('userData', tmp);

const media = path.join(tmp, 'media');
fs.mkdirSync(media, { recursive: true });
const wav = path.join(media, 'cov.wav');
fs.copyFileSync(path.join(root, 'demo', 'demo.wav'), wav);
fs.copyFileSync(path.join(root, 'demo', 'demo.png'), path.join(media, 'cov.png'));
fs.writeFileSync(path.join(media, 'cov.lrc'), [
  '[00:00.00]第一句用来观察换版',
  '[00:06.00]第二句长一点，切换时最容易看出硬切',
  '[00:14.00]第三句',
  '[00:20.00]最后一句'
].join('\n'), 'utf8');
const st = fs.statSync(wav);
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify([{
  path: wav, title: '换版遮罩', artist: '本地', album: '演示', duration: 42,
  codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true,
  hasCover: false, hasLyric: true, mtime: st.mtimeMs, size: st.size, addedAt: Date.now()
}], null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, playMode: 'seq', globalKeys: false
}));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const log = (...a) => console.log(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
const say = (ok, name, extra) => {
  if (ok) pass++; else fail++;
  log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`, extra === undefined ? '' : extra);
};

let win = null;
app.on('browser-window-created', (_e, w) => { win = w; });
const js = c => win.webContents.executeJavaScript(c, true);

/* 每 40ms 采一帧遮罩状态 + 当前句偏差，采满 ms 毫秒返回 */
const SAMPLE = ms => `(() => new Promise(res => {
  const box = document.querySelector('#fsCover');
  const img = document.querySelector('#fsCoverImg');
  const col = document.querySelector('.lyrcol');
  const out = [];
  const t0 = performance.now();
  const tick = () => {
    const on = document.querySelector('.ln.on') || document.querySelector('#lnInner .ln');
    const cr = col.getBoundingClientRect();
    const lr = on ? on.getBoundingClientRect() : null;
    const cs = box ? getComputedStyle(box) : null;
    out.push({
      t: +(performance.now() - t0).toFixed(0),
      on: !!(box && box.classList.contains('on')),
      out: !!(box && box.classList.contains('out')),
      op: cs ? +parseFloat(cs.opacity).toFixed(3) : null,
      src: !!(img && img.getAttribute('src')),
      pe: cs ? cs.pointerEvents : null,
      z: cs ? cs.zIndex : null,
      dev: lr ? +((lr.top + lr.height / 2) - (cr.top + cr.height / 2)).toFixed(2) : null
    });
    if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick); else res(out);
  };
  requestAnimationFrame(tick);
}))()`;

const summary = rows => ({
  frames: rows.length,
  onFrames: rows.filter(r => r.on).length,
  firstOn: (rows.find(r => r.on) || {}).t,
  outFrames: rows.filter(r => r.out).length,
  lastOn: (rows.filter(r => r.on).slice(-1)[0] || {}).t,
  maxDev: Math.max(...rows.map(r => Math.abs(r.dev === null ? 0 : r.dev))),
  endOn: rows[rows.length - 1].on,
  endOut: rows[rows.length - 1].out,
  endSrc: rows[rows.length - 1].src,
  pe: rows[0].pe,
  z: rows[0].z
});

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  for (let i = 0; i < 100 && !(await js('S.tracks.length')); i++) await sleep(100);
  await js('audio.pause(); audio.currentTime = 8;');
  await sleep(900);
  win.setContentSize(1100, 700);
  await sleep(400);

  console.log('\n=== 1. 平时不挂遮罩 ===');
  const idle = await js(`(() => {
    const box = document.querySelector('#fsCover');
    const cs = getComputedStyle(box);
    return { on: box.classList.contains('on'), display: cs.display, pe: cs.pointerEvents, z: cs.zIndex,
             src: !!document.querySelector('#fsCoverImg').getAttribute('src') };
  })()`);
  log(idle);
  say(!idle.on && idle.display === 'none', '没切换时遮罩是隐藏的', { display: idle.display });
  say(!idle.src, '没切换时遮罩里没有位图', { src: idle.src });
  say(idle.pe === 'none', '遮罩不吃鼠标事件', { pe: idle.pe });
  say(Number(idle.z) >= 60, '遮罩盖在内容之上', { z: idle.z });

  console.log('\n=== 2. 进全屏：先顶旧画面，再淡出 ===');
  const p1 = js(SAMPLE(3000));
  await sleep(60);
  await js(`document.querySelector('#wFs').click()`);
  const rows1 = await p1;
  const s1 = summary(rows1);
  log('to-fullscreen', s1);
  say(s1.onFrames > 0 && s1.firstOn <= 500, '切换瞬间遮罩就位', { firstOn: s1.firstOn, frames: s1.onFrames });
  say(rows1.some(r => r.on && r.src), '遮罩里是切换前的真实画面', { src: true });
  /* 顶住的时间要够长：淡出必须发生在「新排版到位」之后。
   * 曾经按「resize 安静 180ms」判静，结果系统全屏动画里两次 resize 隔了 600ms，
   * 遮罩 240ms 就撤了，剩下的硬切照样看得见。 */
  say(s1.lastOn - s1.firstOn >= 500, '遮罩顶到新排版就位才淡出', { hold: s1.lastOn - s1.firstOn });
  say(s1.outFrames > 0, '新排版到位后遮罩开始淡出', { faded: s1.outFrames });
  say(!s1.endOn && !s1.endOut, '淡出结束后遮罩已摘掉', { on: s1.endOn, out: s1.endOut });
  say(!s1.endSrc, '位图已释放', { src: s1.endSrc });
  say(s1.maxDev <= 3, '进全屏过程中歌词没有跑偏', { maxDev: s1.maxDev });

  console.log('\n=== 3. 回窗口：同样先顶后淡 ===');
  const p2 = js(SAMPLE(3000));
  await sleep(60);
  await js(`document.querySelector('#fsExit').click()`);
  const rows2 = await p2;
  const s2 = summary(rows2);
  log('to-window', s2);
  say(s2.onFrames > 0 && s2.firstOn <= 500, '退出全屏时遮罩就位', { firstOn: s2.firstOn });
  say(s2.outFrames > 0, '回窗口后遮罩淡出', { faded: s2.outFrames });
  say(!s2.endOn && !s2.endSrc, '回窗口后遮罩与位图都收掉', { on: s2.endOn, src: s2.endSrc });
  say(s2.maxDev <= 3, '回窗口过程中歌词没有跑偏', { maxDev: s2.maxDev });

  console.log('\n=== 4. 连点两次（进→退）不留残影 ===');
  const p3 = js(SAMPLE(3600));
  await sleep(40);
  await js(`document.querySelector('#wFs').click()`);
  await sleep(160);
  await js(`document.querySelector('#fsExit').click()`);
  const rows3 = await p3;
  const s3 = summary(rows3);
  log('burst', s3);
  say(!s3.endOn && !s3.endOut && !s3.endSrc, '连点之后没有残留遮罩/位图', { on: s3.endOn, out: s3.endOut, src: s3.endSrc });
  say(s3.maxDev <= 3, '连点过程中歌词没有跑偏', { maxDev: s3.maxDev });
  const settled = await js(`(() => {
    const col = document.querySelector('.lyrcol').getBoundingClientRect();
    const on = document.querySelector('.ln.on');
    if (!on) return null;
    const lr = on.getBoundingClientRect();
    return +((lr.top + lr.height / 2) - (col.top + col.height / 2)).toFixed(2);
  })()`);
  say(settled !== null && Math.abs(settled) <= 1, '收尾时当前句回到中轴', { dev: settled });

  log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  app.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('PROBE CRASH', e); app.exit(2); });
setTimeout(() => { console.error('PROBE TIMEOUT'); app.exit(3); }, 120000);
