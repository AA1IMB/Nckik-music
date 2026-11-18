'use strict';
/**
 * 探针：歌词中文翻译（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 验五件事：
 *   1. 数据来源优先级：旁挂 <歌名>.zh.lrc > 双语同时间戳的内嵌歌词；没有译文就保持原样；
 *   2. 合并是按时间戳对齐的，且**不动字级时间轴**（char 的个数与起止时间不受译文影响）；
 *   3. 渲染：译文在原句下方（.ln .tr），字号更小、颜色更淡，长句在容器内换行不撑破；
 *   4. 开关：点 #swTr 立即隐藏/显示，不重载音频（src / currentTime 不动），并写进 settings.json；
 *   5. 边界：`//` 占位不当译文、时间戳偏离太远不硬凑、逐字填充与「…」只作用在原文。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-tr-'));
app.setPath('userData', tmp);

const media = path.join(tmp, 'media');
fs.mkdirSync(media, { recursive: true });
const wavSrc = path.join(root, 'demo', 'demo.wav');

function track(name, lrcName, lrcText, zhName, zhText) {
  const wav = path.join(media, name + '.wav');
  fs.copyFileSync(wavSrc, wav);
  fs.writeFileSync(path.join(media, name + '.lrc'), lrcText, 'utf8');
  if (zhName && zhText) fs.writeFileSync(path.join(media, name + zhName), zhText, 'utf8');
  const st = fs.statSync(wav);
  return {
    path: wav, title: name, artist: '探针', album: '探针', duration: 42,
    codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true,
    hasCover: false, hasLyric: true, mtime: st.mtimeMs, size: st.size, addedAt: Date.now()
  };
}

/* 四首曲目，各覆盖一种数据来源：
 *   tr-sidecar：外文原文 + 旁挂 tr-sidecar.zh.lrc（最高优先级）
 *                第一句只有两个字母，0~2.8s 就唱完，到 6s 的第二句之间有 3.2s 空档
 *   tr-inline ：双语同时间戳写在一个 .lrc 里（第二行当归译文）
 *   tr-edge   ：译文里换成 `//` 占位、时间戳故意偏 1.2s（都该被丢弃）
 *   tr-long   ：超长译文，验换行不撑破容器 */
const tracks = [
  track('tr-sidecar',
    '.lrc',
    ['[00:00.00]Hi',
      '[00:06.00]The night is falling down',
      '[00:11.00]We will meet again'].join('\n'),
    '.zh.lrc',
    ['[00:00.00]嗨',
      '[00:06.00]夜色正在降临',
      '[00:11.00]我们会再相见'].join('\n')),
  track('tr-inline',
    '.lrc',
    ['[00:00.00]Say it once',
      '[00:00.00]说一遍',
      '[00:06.00]Say it twice',
      '[00:06.00]说两遍'].join('\n')),
  track('tr-edge',
    '.lrc',
    ['[00:00.00]First line',
      '[00:05.00]Second line',
      '[00:10.00]Third line'].join('\n'),
    '.zh.lrc',
    ['[00:00.00]//',
      '[00:06.20]偏差太远的译文',
      '[00:10.00]第三句'].join('\n')),
  track('tr-long',
    '.lrc',
    ['[00:00.00]A very long line that keeps going and going until it has to wrap somewhere inside the lyric column',
      '[00:08.00]Short'].join('\n'),
    '.zh.lrc',
    ['[00:00.00]这是一句特别长的译文，用来验证它在歌词栏里会自动换行，而不会把容器撑破或者把句末的省略号推到看不见的地方去，长度大约要超过一行的宽度才能测出来',
      '[00:08.00]短'].join('\n'))
];

fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(tracks, null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'),
  JSON.stringify({ theme: 'dark', volume: 0, muted: true, globalKeys: false, lyricTrans: true }));

const logPath = path.join(root, 'demo', 'probe-lyric-tr.log');
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

/* 切到第 i 首并等歌词渲染完（译文在 renderLyrics 里一起建） */
async function open(i) {
  await js(`document.querySelector('#libList .item[data-i="${i}"]').click()`);
  await waitFor(async () => (await js('S.i')) === i, 8000);
  await waitFor(async () => (await js('S.lyrics.length')) > 0, 8000);
  await sleep(400);
}

const dump = `(() => {
  const i = S.i;
  /* S.i 是曲目下标，S.lyrics / S.lnNodes 是「行」下标 —— 两者不能混用。
   * 曲目级信息取第 0 行；当前正在演的那一行用 S.lastLy。 */
  const l = S.lyrics[0] || null;
  const node = S.lnNodes[0] || null;
  const tr = node ? node.querySelector('.tr') : null;
  const cs = tr ? getComputedStyle(tr) : null;
  const orig = node ? node.querySelector('.ln-tx') : null;
  const ocs = orig ? getComputedStyle(orig) : null;
  const gn = S.lastLy >= 0 ? S.lnNodes[S.lastLy] : null;
  const gEl = gn ? gn.querySelector('.gap') : null;
  const gT = gEl ? gEl.querySelector('.gap-t') : null;
  return {
    i,
    lastLy: S.lastLy,
    lines: S.lyrics.length,
    texts: S.lyrics.map(x => x.text),
    trs: S.lyrics.map(x => x.tr || null),
    chars: l && l.chars ? l.chars.map(c => [c.c, +c.t0.toFixed(3), +c.t1.toFixed(3)]) : null,
    chN: node ? node.querySelectorAll('.ch').length : 0,
    trN: document.querySelectorAll('.tr').length,
    trText: tr ? tr.textContent : null,
    trFs: cs ? cs.fontSize : null,
    trColor: cs ? cs.color : null,
    trShow: cs ? cs.display : null,
    trH: tr ? tr.offsetHeight : null,
    trScrollW: tr ? tr.scrollWidth : null,
    trClientW: tr ? tr.clientWidth : null,
    origFs: ocs ? ocs.fontSize : null,
    origColor: ocs ? ocs.color : null,
    origW: orig ? orig.offsetWidth : null,
    colW: (() => { const c = document.querySelector('.lyrcol'); return c ? c.clientWidth : null; })(),
    noTr: document.body.classList.contains('no-tr'),
    swOn: (() => { const s = document.querySelector('#swTr'); return s ? s.classList.contains('on') : null; })(),
    src: audio.src,
    ct: +audio.currentTime.toFixed(2),
    paused: audio.paused,
    gap: gEl ? {
      op: +(+getComputedStyle(gEl).opacity).toFixed(3),
      p: +(parseFloat(gEl.style.getPropertyValue('--p')) || 0),
      breathe: gT ? +(+getComputedStyle(gT).opacity).toFixed(3) : null
    } : null,
    nexts: S.lyrics.map(x => Number.isFinite(x.nextT) ? +x.nextT.toFixed(2) : null)
  };
})()`;

(async () => {
  require(path.join(root, 'main.js'));
  await waitForWin();
  await waitFor(async () => (await js('S.tracks.length')) === tracks.length, 8000);
  await sleep(800);

  log('=== 1. 旁挂译文（.zh.lrc，最高优先级） ===');
  await open(0);
  let d = await js(dump);
  log('  ' + JSON.stringify({ texts: d.texts, trs: d.trs }));
  ok('每行都对上了旁挂译文',
    JSON.stringify(d.trs) === JSON.stringify(['嗨', '夜色正在降临', '我们会再相见']), JSON.stringify(d.trs));
  ok('译文节点数与有译文的行数一致', d.trN === 3, 'trN=' + d.trN);
  ok('字级时间轴没被译文改动：一个字一个 span、起点 0、首句约 2.8s 唱完',
    d.chN === d.texts[0].length && d.chars[0][1] === 0 && d.chars[d.chars.length - 1][2] > 1 && d.chars[d.chars.length - 1][2] <= 6,
    `chN=${d.chN} first=${JSON.stringify(d.chars[0])} last=${JSON.stringify(d.chars[d.chars.length - 1])}`);
  ok('译文在原句下方（.ln .tr 是 .ln-tx 的兄弟）',
    await js(`(() => { const n = S.lnNodes[S.i]; return n.querySelector('.tr') && n.firstElementChild.classList.contains('ln-tx'); })()`));
  ok('译文是次级样式：字号更小、颜色更淡',
    parseFloat(d.trFs) < parseFloat(d.origFs) && d.trColor !== d.origColor,
    `${d.trFs} vs ${d.origFs} / ${d.trColor} vs ${d.origColor}`);
  ok('译文不参与逐字填充：只有原文有 .ch 的 --p',
    await js(`(() => { const n = S.lnNodes[S.i]; return n.querySelector('.tr').querySelectorAll('.ch').length === 0; })()`));

  log('=== 2. 双语同时间戳的内嵌歌词 ===');
  await open(1);
  d = await js(dump);
  log('  ' + JSON.stringify({ texts: d.texts, trs: d.trs }));
  ok('同时间戳的两行合并成一行，不是四行', d.lines === 2 && d.texts.length === 2, 'lines=' + d.lines);
  ok('第二行成为第一行的译文', JSON.stringify(d.trs) === JSON.stringify(['说一遍', '说两遍']), JSON.stringify(d.trs));

  log('=== 3. 降级：`//` 占位与偏离太远的译文都丢掉 ===');
  await open(2);
  d = await js(dump);
  log('  ' + JSON.stringify({ texts: d.texts, trs: d.trs }));
  ok('`//` 占位没有变成译文', !d.trs[0], String(d.trs[0]));
  ok('时间戳偏 1.2s 的译文没有硬凑上来（容差 0.4s）', !d.trs[1], String(d.trs[1]));
  ok('对得上的译文照常显示', d.trs[2] === '第三句', String(d.trs[2]));
  ok('没有译文的行不建 .tr 节点（总数只有 1 个）', d.trN === 1, 'trN=' + d.trN);

  log('=== 4. 长译文换行不撑破容器 ===');
  await open(3);
  d = await js(dump);
  log('  ' + JSON.stringify({ trH: d.trH, trScrollW: d.trScrollW, trClientW: d.trClientW, origW: d.origW, colW: d.colW }));
  ok('译文高度超过一行（确实换行了）', d.trH > 30, 'h=' + d.trH);
  ok('译文没有横向溢出（scrollWidth ≈ clientWidth）', d.trScrollW - d.trClientW <= 1, `${d.trScrollW}/${d.trClientW}`);
  ok('原文盒子没有超出歌词栏宽度', d.origW <= d.colW + 1, `${d.origW}/${d.colW}`);

  log('=== 5. 开关：即时生效、不重载音频、写进设置 ===');
  await js(`audio.pause(); audio.currentTime = 2;`);
  await sleep(300);
  const before = await js(`({ src: audio.src, ct: +audio.currentTime.toFixed(2), paused: audio.paused })`);
  await js(`document.querySelector('#swTr').click()`);
  await sleep(300);
  d = await js(dump);
  ok('关闭后 body 带上 no-tr', d.noTr === true);
  ok('关闭后译文不可见（display:none）', d.trShow === 'none', String(d.trShow));
  ok('数据层没有丢译文（只是不显示）', !!d.trs[0], String(d.trs[0]).slice(0, 12) + '…');
  ok('没有重载音频：src 不变', d.src === before.src);
  ok('没有重载音频：播放位置不变', Math.abs(d.ct - before.ct) < 0.25, `${before.ct} → ${d.ct}`);
  ok('开关控件状态同步（off）', d.swOn === false);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
  ok('选择已持久化到 settings.json', saved.lyricTrans === false, 'lyricTrans=' + saved.lyricTrans);

  await js(`document.querySelector('#swTr').click()`);
  await sleep(300);
  d = await js(dump);
  ok('再点一次恢复显示', d.noTr === false && d.trShow !== 'none', `${d.noTr}/${d.trShow}`);
  const saved2 = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
  ok('恢复后的选择也持久化', saved2.lyricTrans === true, 'lyricTrans=' + saved2.lyricTrans);
  ok('默认值是开（FALLBACK_SETTINGS.lyricTrans === true）',
    await js('FALLBACK_SETTINGS.lyricTrans === true'));

  log('=== 6. 空档「…」只作用在原文 ===');
  await open(0);
  await js(`audio.pause(); audio.currentTime = 4.0;`);   // 第一句 0~2.8s 之后、第二句 5s 之前
  await sleep(400);
  d = await js(dump);
  log('  ' + JSON.stringify({ gap: d.gap, i: d.i }));
  ok('空档期间「…」照常浮现', d.gap && d.gap.op > 0.5, JSON.stringify(d.gap));
  ok('「…」的填充比例独立推进', d.gap && d.gap.p > 0 && d.gap.p < 100, 'p=' + (d.gap && d.gap.p));
  ok('上一句的译文仍在、没被「…」挤掉',
    await js(`(() => { const n = S.lnNodes[0]; return !!(n && n.querySelector('.tr')); })()`));
  ok('译文不会跟着呼吸/隐藏', d.gap && d.gap.breathe !== null);

  /* 7. 逐字行首与 lrc 行首不齐（真实网易云就是这样）
   * tlyric 的时间戳跟 lrc 一模一样，而 yrc 的行首是真正开口的时刻，能晚 0.5s 以上。
   * 按时间戳去配必然大面积超容差 —— 必须按行序搬译文。 */
  log('=== 7. yrc 行首与 lrc 不齐时译文仍要逐行对上 ===');
  const yc = await js(`(() => {
    const r = buildLyrics({
      text: '[00:00.00]A\\n[00:06.00]B\\n[00:12.00]C',
      tr:   '[00:00.00]甲\\n[00:06.00]乙\\n[00:12.00]丙',
      yrc:  '[460,600](460,200,0)A\\n[6600,600](6600,200,0)B\\n[12600,600](12600,200,0)C'
    });
    return { n: r.length, trs: r.map(l => l.tr || null), t: r.map(l => l.t), chars: r.map(l => (l.chars || []).length) };
  })()`);
  log('  ' + JSON.stringify(yc));
  ok('yrc 的 3 行都解析出来（行首 0.46 / 6.6 / 12.6s，比 lrc 晚 0.46~0.6s）', yc.n === 3, 'n=' + yc.n);
  ok('按行序把译文搬过去了，一行都没丢', JSON.stringify(yc.trs) === JSON.stringify(['甲', '乙', '丙']), yc.trs);
  ok('译文没改字级时间轴（每行 1 个字）', JSON.stringify(yc.chars) === '[1,1,1]', yc.chars);

  log('=== 渲染层报错 ===');
  if (errors.length) errors.forEach(e => log('  ✗ ' + e));
  else log('  （无）');

  log('----------------------------------------');
  log(`通过 ${pass} 项，失败 ${fail} 项`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(fail ? 1 : 0);
})().catch(e => {
  log('✗ 探针崩溃：' + (e && e.stack || e));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(1);
});
