'use strict';
/**
 * 探针：全屏（.app.fs）与窗口模式下的封面/歌词位置与比例是否一致（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 做法：同一首带封面和歌词的本地曲目，先在几个视口尺寸下量「窗口模式」的几何，
 * 再 applyFs(true) 量「全屏模式」的几何，把两边换算成相对视口的比例直接对照。
 *
 * 判定口径（全屏与窗口应当一致）：
 *   coverW/vw、coverH/vh、cover.left/vw、cover.top/vh、lyr.left/vw、
 *   字号/视口宽度、歌词行间距/视口高度 —— 差值超过 2% 视为「位置或比例不一致」。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-fslay-'));
app.setPath('userData', tmp);

const media = path.join(tmp, 'media');
fs.mkdirSync(media, { recursive: true });
const wav = path.join(media, 'fsl.wav');
fs.copyFileSync(path.join(root, 'demo', 'demo.wav'), wav);
fs.copyFileSync(path.join(root, 'demo', 'demo.png'), path.join(media, 'fsl.png'));
fs.writeFileSync(path.join(media, 'fsl.lrc'), [
  '[00:00.00]第一句用来量位置',
  '[00:06.00]第二句也用来量位置和比例',
  '[00:12.00]The city keeps on breathing without me',
  '[00:20.00]最后一句'
].join('\n'), 'utf8');
const st = fs.statSync(wav);
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify([{
  path: wav, title: '全屏比例', artist: '本地', album: '演示', duration: 42,
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

const MEASURE = `(() => {
  const box = el => { const b = el.getBoundingClientRect(); return { l: +b.left.toFixed(1), t: +b.top.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const q = s => document.querySelector(s);
  const fsz = el => el ? +parseFloat(getComputedStyle(el).fontSize).toFixed(1) : null;
  const inner = q('.ln-inner');
  return {
    vw: innerWidth, vh: innerHeight, fsOn: document.body.classList.contains('fs'),
    stage: box(q('.stage')), cover: box(q('.cover')), lyr: box(q('.lyrcol')),
    meta: box(q('.meta')), ctrl: box(q('.ctrl')),
    lnFs: fsz(q('.ln')), onFs: fsz(q('.ln.on')), trFs: fsz(q('.ln .tr')),
    rowGap: inner ? +parseFloat(getComputedStyle(inner).rowGap).toFixed(1) : null
  };
})()`;

const shot = async (file) => {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(file, img.toPNG());
};

const ratio = m => ({
  coverW: +(m.cover.w / m.vw * 100).toFixed(2),
  coverH: +(m.cover.h / m.vh * 100).toFixed(2),
  coverLeft: +(m.cover.l / m.vw * 100).toFixed(2),
  coverTop: +(m.cover.t / m.vh * 100).toFixed(2),
  lyrLeft: +(m.lyr.l / m.vw * 100).toFixed(2),
  lyrW: +(m.lyr.w / m.vw * 100).toFixed(2),
  lyrTop: +(m.lyr.t / m.vh * 100).toFixed(2),
  lyrH: +(m.lyr.h / m.vh * 100).toFixed(2),
  lnFs: +(m.lnFs / m.vw * 100).toFixed(2),
  onFs: +(m.onFs / m.vw * 100).toFixed(2),
  rowGap: +(m.rowGap / m.vh * 100).toFixed(2)
});

const sizes = [[860, 560], [1100, 700], [1600, 900], [1920, 1080]];
const results = [];

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  for (let i = 0; i < 100 && !(await js('S.tracks.length')); i++) await sleep(100);
  await sleep(300);
  await js('audio.pause(); audio.currentTime = 8;');   // 第 2 句（激活行 + 长句）
  await sleep(600);

  for (const [w, h] of sizes) {
    win.setContentSize(w, h);
    await sleep(500);
    const winMode = await js(MEASURE);
    results.push({ label: `window ${w}x${h}`, mode: 'window', m: winMode, r: ratio(winMode) });
    log(`window ${w}x${h}`, JSON.stringify(ratio(winMode)));
    if (w === 1100) await shot(path.join(root, 'demo', 'shot-layout-window.png'));

    await js('applyFs(true)');
    await sleep(500);
    const fsMode = await js(MEASURE);
    results.push({ label: `fullscreen ${w}x${h}`, mode: 'fs', m: fsMode, r: ratio(fsMode) });
    log(`fs     ${w}x${h}`, JSON.stringify(ratio(fsMode)));
    if (w === 1600) await shot(path.join(root, 'demo', 'shot-layout-fs.png'));
    await js('applyFs(false)');
    await sleep(400);
  }

  // 同一视口下窗口/全屏的比例差
  let bad = 0;
  for (const [w, h] of sizes) {
    const a = results.find(x => x.label === `window ${w}x${h}`);
    const b = results.find(x => x.label === `fullscreen ${w}x${h}`);
    const diffs = {};
    for (const k of Object.keys(a.r)) {
      const d = +(Math.abs(a.r[k] - b.r[k])).toFixed(2);
      diffs[k] = d;
      if (d > 2) bad++;
    }
    log(`diff @${w}x${h}`, JSON.stringify(diffs));
  }
  // 边界：封面/曲目信息不能压到页脚上（负数 = 没压到）
  let edge = 0;
  for (const x of results) {
    const m = x.m;
    const metaToCtrl = +(m.meta.t + m.meta.h - m.ctrl.t).toFixed(1);
    const coverToCtrl = +(m.cover.t + m.cover.h - m.ctrl.t).toFixed(1);
    log(`edge ${x.label}`, JSON.stringify({ metaToCtrl, coverToCtrl }));
    if (metaToCtrl > 0 || coverToCtrl > 0) edge++;
  }
  log(bad === 0 && edge === 0
    ? 'PASS 窗口/全屏位置与比例一致，且封面/曲目信息没有压到页脚'
    : `FAIL 比例差 ${bad} 项 / 重叠 ${edge} 项`);
  app.exit(bad === 0 && edge === 0 ? 0 : 1);
})().catch(e => { console.error('PROBE CRASH', e); app.exit(2); });
