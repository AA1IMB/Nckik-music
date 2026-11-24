'use strict';
/**
 * 探针：逐字歌词进度 + 空档的「…」（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 验四件事：
 *   1. 数据层：每行都能摊出「每字一个 { c, t0, t1 }」，时间单调、单字不超过上限；
 *      yrc（网易云逐字）与行内 <mm:ss.xx> 的真实时间要原样保留；
 *   2. 渲染层：把播放时钟设到某个字的中间，只有它自己的 --p 是 0~100，
 *      它前面的字是 100%、后面的字是 0% —— 不允许整行一条渐变扫过去；
 *   3. 空档：「…」算一句，跟着时间轴匀速填、下一句开口前 0.5s 填满，再渐隐收尾；
 *      不做放大缩小的循环动画；空档不到 3s 时不出现；
 *   4. 边界：前奏、末尾、无时间戳歌词。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const realData = path.join(app.getPath('appData'), 'NckiksMusic');
process.env.NCKIK_SKIP_MIGRATION = '1';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-lyr-'));
app.setPath('userData', tmp);

/* 造一首「本地曲目 + 同名 .lrc」，三个关键空档用来验阈值与节奏：
 *   0s「短句」唱到 2.8s → 6s 下一句：空档 3.2s，超过 3s 阈值，该出现「…」；
 *   6s 那句正好唱到 12s（首尾相接，不该出现「…」）；
 *   12s「第三句」唱到 16.2s → 18s：空档 1.8s，不够 3s，也不该出现「…」。 */
const media = path.join(tmp, 'media');
fs.mkdirSync(media, { recursive: true });
fs.copyFileSync(path.join(root, 'demo', 'demo.wav'), path.join(media, 'lyr.wav'));
fs.writeFileSync(path.join(media, 'lyr.lrc'), [
  '[ti:逐字测试]',
  '[00:00.00]短句',
  '[00:06.00]间奏之后的第二句歌词',
  '[00:12.00]第三句',
  '[00:18.00]末句'
].join('\n'), 'utf8');
const wav = path.join(media, 'lyr.wav');
const st = fs.statSync(wav);
/* library.json 就是 Track 数组本身（main.js 的 library:get 直接 readJSON(libraryPath, [])） */
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify([{
  path: wav, title: '逐字测试', artist: '探针', album: '探针', duration: 42,
  codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true,
  hasCover: false, hasLyric: true, mtime: st.mtimeMs, size: st.size, addedAt: Date.now()
}], null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ theme: 'dark', volume: 0, muted: true, globalKeys: false }));

const logPath = path.join(root, 'demo', 'probe-lyric.log');
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

/* 读当前行每个字的状态，以及「…」的填充比例 / 外层透明度 / 内层呼吸 */
const chSnap = `(() => {
  const i = S.lastLy;
  const host = i >= 0 ? (S.lyrics[i].prevTimed ?? -1) : -1;
  const node = host >= 0 ? S.lnNodes[host] : null;
  const g = node ? node.querySelector('.gap') : null;
  const t = g ? g.querySelector('.gap-t') : null;
  const cs = g ? getComputedStyle(g) : null;
  const ts = t ? getComputedStyle(t) : null;
  const an = t ? t.getAnimations()[0] : null;
  return {
    i, host,
    op: cs ? +(+cs.opacity).toFixed(3) : null,
    p: g ? +(parseFloat(g.style.getPropertyValue('--p')) || 0) : null,
    animOuter: g ? g.getAnimations().length : null,
    ongap: !!(g && g.classList.contains('ongap')),
    breathe: ts ? +(+ts.opacity).toFixed(3) : null,
    animName: an ? an.animationName : null,
    animDur: an ? an.effect.getTiming().duration : null,
    animIter: an ? an.effect.getTiming().iterations : null,
    animState: an ? an.playState : null,
    transform: cs ? cs.transform : null,
    bg: ts ? String(ts.backgroundImage).slice(0, 60) : null,
    chars: node ? [...node.querySelectorAll('.ch')].map(s => ({ c: s.textContent, p: parseFloat(s.style.getPropertyValue('--p')) || 0 })) : []
  };
})()`;

(async () => {
  require(path.join(root, 'main.js'));
  await waitForWin();
  await waitFor(async () => (await js('S.tracks.length')) > 0, 8000);
  await sleep(800);

  /* ---------- 1. 数据层：按行摊字 ---------- */
  log('=== 1. 按行时间戳摊到字（本地 LRC，无逐字数据） ===');
  const d1 = await js(`(() => {
    const ls = buildLyrics({ text: ${JSON.stringify('[00:00.00]短句\n[00:02.00]一二三四五六七八九十\n[00:04.00]结束')} });
    return ls.map(l => ({
      t: +l.t.toFixed(3), text: l.text, n: l.chars.length,
      first: l.chars.length ? +l.chars[0].t0.toFixed(3) : null,
      lastEnd: l.chars.length ? +l.chars[l.chars.length - 1].t1.toFixed(3) : null,
      maxDur: l.chars.length ? +Math.max(...l.chars.map(c => c.t1 - c.t0)).toFixed(3) : null,
      mono: l.chars.every((c, i) => i === 0 || c.t0 >= l.chars[i - 1].t1 - 1e-9)
    }));
  })()`);
  log('  ' + JSON.stringify(d1));
  ok('每行的字数与文字长度一致', d1[0].n === 2 && d1[1].n === 10, `n=${d1.map(x => x.n)}`);
  ok('字的时间首尾相接、单调不回退', d1.every(x => x.mono));
  ok('单字时长不超过上限 1.4s', d1.every(x => x.maxDur <= 1.4001), `max=${d1.map(x => x.maxDur)}`);
  ok('第二行从 2.0s 起、按到下一行(4.0s)的 2s 摊 10 个字（约 0.2s/字）',
    Math.abs(d1[1].first - 2.0) < 0.02 && Math.abs(d1[1].lastEnd - 4.0) < 0.02
    && Math.abs(d1[1].maxDur - 0.2) < 0.02,
    `first=${d1[1].first} end=${d1[1].lastEnd} max=${d1[1].maxDur}`);

  /* ---------- 2. 数据层：yrc / 行内标签的真实时间 ---------- */
  log('=== 2. 逐字数据源 ===');
  const d2 = await js(`(() => {
    const y = parseYRC('[1000,800](1000,400,0)你(1400,400,0)好\\n[3000,600](3000,600,0)再见');
    const w = buildLyrics({ text: '[00:01.00]<00:01.00>逐<00:01.60>字<00:02.40>测试' });
    return {
      y: y.map(l => ({ t: l.t, text: l.text, chars: l.chars.map(c => [+c.t0.toFixed(3), +c.t1.toFixed(3)]) })),
      w: w.map(l => ({ text: l.text, chars: l.chars.map(c => [+c.t0.toFixed(3), +c.t1.toFixed(3)]) }))
    };
  })()`);
  log('  yrc ' + JSON.stringify(d2.y));
  log('  标签 ' + JSON.stringify(d2.w));
  ok('yrc 解析出每字真实起止', d2.y.length === 2 && d2.y[0].chars.length === 2
    && Math.abs(d2.y[0].chars[0][0] - 1.0) < 0.001 && Math.abs(d2.y[0].chars[1][0] - 1.4) < 0.001);
  ok('yrc 第二行从 3.0s 起', d2.y[1] && Math.abs(d2.y[1].chars[0][0] - 3.0) < 0.001);
  ok('行内 <mm:ss.xx> 标签被当成字起点且不留在正文里',
    d2.w[0].text === '逐字测试'
    && Math.abs(d2.w[0].chars[0][0] - 1.0) < 0.001
    && Math.abs(d2.w[0].chars[1][0] - 1.6) < 0.001
    && Math.abs(d2.w[0].chars[2][0] - 2.4) < 0.001);

  /* ---------- 3. 渲染层：推进到某个字中间 ---------- */
  log('=== 3. 逐字填充（把时钟放到某字中间） ===');
  await js(`document.querySelector('#libList .item[data-i="0"]').click()`);
  const up = await waitFor(async () => (await js('S.lyrics.length')) > 0, 12000);
  ok('本地曲目加载出歌词', up, `行数=${await js('S.lyrics.length')}`);
  const rendered = await js(`(() => {
    const bad = [];
    S.lyrics.forEach((l, i) => {
      const spans = S.lnChars[i];
      if (!spans) bad.push(i + ':no-spans');
      else if (spans.length !== l.chars.length) bad.push(i + ':' + spans.length + '/' + l.chars.length);
    });
    return {
      lines: S.lyrics.length, bad,
      hasGap: S.lnNodes.every(n => !!n.querySelector('.gap')),
      nexts: S.lyrics.map(l => ({ to: l.nextT, prev: l.prevTimed }))
    };
  })()`);
  log('  ' + JSON.stringify(rendered));
  ok('每行一个字一个 span', rendered.bad.length === 0, rendered.bad.join(','));
  ok('每行都带「…」节点', rendered.hasGap === true);
  ok('行间链好了 nextT / prevTimed（空档判定不用每帧往后扫）',
    rendered.nexts[0].to === 6 && rendered.nexts[1].to === 12
    && rendered.nexts[2].to === 18 && rendered.nexts[3].to === Infinity
    && rendered.nexts[3].prev === 3,
    JSON.stringify(rendered.nexts));

  // 反复把时钟放到不同字里，验证「已填的是前缀，当前字在中间」
  const probes = [
    { line: 1, ch: 0 }, { line: 1, ch: 3 }, { line: 1, ch: 6 }, { line: 2, ch: 1 }, { line: 3, ch: 1 }
  ];
  for (const pr of probes) {
    const r = await js(`(() => {
      const l = S.lyrics[${pr.line}], c = l.chars[${pr.ch}];
      const t = c.t0 + (c.t1 - c.t0) * 0.5;
      updateLyric(t);
      const node = S.lnNodes[${pr.line}];
      const ps = [...node.querySelectorAll('.ch')].map(s => parseFloat(s.style.getPropertyValue('--p')) || 0);
      const prefix = ps.slice(0, ${pr.ch}).every(p => p >= 99.9);
      const after = ps.slice(${pr.ch} + 1).every(p => p <= 0.1);
      const cur = ps[${pr.ch}];
      return { ps, prefix, after, cur: +cur.toFixed(2), t: +t.toFixed(2), on: node.classList.contains('on') };
    })()`);
    ok(`第 ${pr.line + 1} 行第 ${pr.ch + 1} 个字：只有它在填，前面满、后面空`,
      r.prefix && r.after && r.cur > 20 && r.cur < 80,
      `cur=${r.cur}% on=${r.on}`);
    if (!(r.prefix && r.after)) log('    ' + JSON.stringify(r.ps));
  }

  /* ---------- 4. 空档：「…」当成一句来唱 ---------- */
  log('=== 4. 空档：「…」当成一句来唱 ===');
  const gapInfo = await js(`(() => {
    const l = S.lyrics[0];
    const from = l.chars[l.chars.length - 1].t1;
    const l2 = S.lyrics[2];
    const from2 = l2.chars[l2.chars.length - 1].t1;
    return {
      from: +from.toFixed(3), to: l.nextT, dur: +(l.nextT - from).toFixed(3),
      smallFrom: +from2.toFixed(3), smallTo: l2.nextT, smallDur: +(l2.nextT - from2).toFixed(3)
    };
  })()`);
  log('  ' + JSON.stringify(gapInfo));
  ok('第一个空档 3.2s（在 3s 阈值之上）', Math.abs(gapInfo.dur - 3.2) < 0.05, `dur=${gapInfo.dur}`);
  ok('第二个空档 1.8s（在 3s 阈值之下）', Math.abs(gapInfo.smallDur - 1.8) < 0.05, `dur=${gapInfo.smallDur}`);

  /* 用真实播放头驱动：暂停后把 currentTime 停在空档里。
   * 只调 updateLyric() 不行 —— 逐帧循环的下一帧就会用真实时钟把它覆盖回去。 */
  await js(`(() => { audio.pause(); audio.currentTime = 3.2; })()`);
  await sleep(400);
  const gap = await js(`(${chSnap})`);
  log('  ' + JSON.stringify({
    op: gap.op, p: gap.p, ongap: gap.ongap, breathe: gap.breathe,
    animName: gap.animName, animDur: gap.animDur, animIter: gap.animIter,
    animOuter: gap.animOuter, transform: gap.transform, bg: gap.bg,
    chars: gap.chars.map(c => c.p)
  }));
  ok('空档里这一句先补满（不留半句）',
    gap.chars.length > 0 && gap.chars.every(c => c.p >= 99.9),
    JSON.stringify(gap.chars.map(c => c.p)));
  ok('空档 >3 秒时「…」可见', gap.op > 0.5, `op=${gap.op}`);
  ok('外层没有动画、也没有缩放（只由 JS 写 opacity / --p）',
    gap.animOuter === 0 && gap.transform === 'none', `${gap.animOuter} / ${gap.transform}`);
  ok('「…」由 --p 驱动渐变填充', /linear-gradient/.test(gap.bg || ''), String(gap.bg));
  ok('呼吸动画挂在空档期间（.ongap 生效）', gap.ongap === true && gap.animName === 'gapBreathe',
    `ongap=${gap.ongap} anim=${gap.animName}`);

  /* 呼吸：整周期 4s（单程 2s）、无限循环、正弦式缓动，opacity 在 0.35~1 之间往复。
   * 这里按真实时间采样 3s，覆盖「最暗 → 最亮 → 回落」的完整半程以上。 */
  ok('呼吸周期 4s、无限循环、正弦缓动',
    gap.animDur === 4000 && gap.animIter === Infinity && gap.animState === 'running',
    `dur=${gap.animDur} iter=${gap.animIter} state=${gap.animState}`);

  const breathe = await js(`(async () => {
    const g = S.lnNodes[0].querySelector('.gap');
    const t = g.querySelector('.gap-t');
    const a = t.getAnimations()[0];
    const kf = a ? a.effect.getKeyframes().map(k => String(k.opacity)) : [];
    const easing = a ? getComputedStyle(t).animationTimingFunction : '';
    const ops = [];
    const scales = [];
    const chBefore = S.curCh;
    const readScale = () => {
      const m = new RegExp('matrix\\\\(([\\\\d.eE+-]+)').exec(getComputedStyle(t).transform || '');
      return m ? +(+m[1]).toFixed(3) : 1;
    };
    for (let k = 0; k < 13; k++) {
      ops.push(+(+getComputedStyle(t).opacity).toFixed(3));
      scales.push(readScale());
      await new Promise(r => setTimeout(r, 250));
    }
    return {
      ops, scales, kf, easing,
      min: Math.min(...ops), max: Math.max(...ops),
      minS: Math.min(...scales), maxS: Math.max(...scales),
      chStable: S.curCh === chBefore,
      pAfter: +(parseFloat(g.style.getPropertyValue('--p')) || 0)
    };
  })()`);
  log('  呼吸采样：' + JSON.stringify(breathe.ops));
  log('  缩放采样：' + JSON.stringify(breathe.scales));
  log('  关键帧：' + JSON.stringify(breathe.kf) + '  缓动：' + breathe.easing);
  ok('呼吸下限约 0.35', breathe.min <= 0.45, `min=${breathe.min}`);
  ok('呼吸上限约 1（单程 2s 处最亮）', breathe.max >= 0.9, `max=${breathe.max}`);
  ok('opacity 始终在 0.3~1.05 之间（不过冲、不消失）',
    breathe.ops.every(o => o >= 0.3 && o <= 1.05), JSON.stringify(breathe.ops));
  ok('内层「…」随呼吸柔和缩放（0.88 ↔ 1.14）',
    breathe.minS <= 0.93 && breathe.maxS >= 1.09 && breathe.scales.every(s => s >= 0.85 && s <= 1.18),
    `minS=${breathe.minS} maxS=${breathe.maxS}`);
  ok('呼吸不碰填充进度（curCh 不变）', breathe.chStable === true);

  /* 匀速：把播放头放在填充窗口的 20% / 50% / 80%，比例应该正好是 20 / 50 / 80。
   * 同步调用 updateLyric 后立刻读样式 —— 中间不让出事件循环，rAF 插不进来。 */
  const lin = await js(`(() => {
    const host = S.lyrics[0];
    const from = host.chars[host.chars.length - 1].t1;
    const to = host.nextT;
    const end = to - 0.5;
    const g = S.lnNodes[0].querySelector('.gap');
    const at = f => { updateLyric(from + (end - from) * f); return +(parseFloat(g.style.getPropertyValue('--p')) || 0); };
    const p20 = at(0.2), p50 = at(0.5), p80 = at(0.8);
    updateLyric(end);
    const pEnd = +(parseFloat(g.style.getPropertyValue('--p')) || 0);
    const opEnd = +(+getComputedStyle(g).opacity).toFixed(3);
    return { p20, p50, p80, pEnd, opEnd, end: +end.toFixed(3) };
  })()`);
  log('  ' + JSON.stringify(lin));
  ok('填充是匀速的：20% / 50% / 80% 处比例分别是 20 / 50 / 80',
    Math.abs(lin.p20 - 20) < 2 && Math.abs(lin.p50 - 50) < 2 && Math.abs(lin.p80 - 80) < 2,
    `${lin.p20}/${lin.p50}/${lin.p80}`);
  ok('下一句开口前 0.5s 正好填满（100%、还不透明）',
    lin.pEnd >= 99.9 && lin.opEnd >= 0.99, `p=${lin.pEnd} op=${lin.opEnd} end=${lin.end}`);

  /* 渐隐：填满之后到下一句开口，opacity 由 1 平滑落到 0 */
  const fade = await js(`(() => {
    const host = S.lyrics[0];
    const to = host.nextT;
    const g = S.lnNodes[0].querySelector('.gap');
    const read = t => { updateLyric(t); return +(+getComputedStyle(g).opacity).toFixed(3); };
    const full = read(to - 0.5), quarter = read(to - 0.375), mid = read(to - 0.25), late = read(to - 0.02), off = read(to + 0.01);
    return { full, quarter, mid, late, off };
  })()`);
  log('  ' + JSON.stringify(fade));
  ok('渐隐从「刚填满」开始（不透明度 1）', fade.full >= 0.99, String(fade.full));
  ok('渐隐是单调下降的（1 → 0.5 → 近 0）',
    fade.quarter > fade.mid && fade.mid > fade.late && Math.abs(fade.mid - 0.5) < 0.08,
    JSON.stringify(fade));
  ok('下一句开口前几乎看不见了', fade.late < 0.1, String(fade.late));
  ok('下一句开口后「…」收掉（opacity 0）', fade.off === 0, String(fade.off));

  /* 空档不到 3s：不该出现「…」，这一句保持填满 */
  await js(`(() => { audio.currentTime = ${gapInfo.smallFrom + 0.9}; })()`);
  await sleep(400);
  const small = await js(`(${chSnap})`);
  log('  ' + JSON.stringify({ op: small.op, p: small.p, chars: small.chars.map(c => c.p) }));
  ok('空档只有 1.8s 时不显示「…」（阈值 3s）', small.op === 0, `op=${small.op}`);
  ok('短空档里这一句保持填满', small.chars.length > 0 && small.chars.every(c => c.p >= 99.9),
    JSON.stringify(small.chars.map(c => c.p)));

  /* 播放头走进第 2 句：「…」收起、填充条接上 */
  const backAt = await js(`(() => { const c = S.lyrics[1].chars[0]; return +(c.t0 + (c.t1 - c.t0) * 0.4).toFixed(3); })()`);
  await js(`audio.currentTime = ${backAt}`);
  await sleep(400);
  const back = await js(`(${chSnap})`);
  log('  ' + JSON.stringify({ op: back.op, ongap: back.ongap, animName: back.animName, chars: back.chars.slice(0, 3) }));
  ok('进入下一句后「…」收掉', back.op === 0, `op=${back.op}`);
  ok('呼吸动画随空档结束一起停掉（不留常驻动画）',
    back.ongap === false && back.animName === null, `ongap=${back.ongap} anim=${back.animName}`);
  ok('下一句第一个字已在填', back.chars[0] && back.chars[0].p > 20 && back.chars[0].p < 80,
    JSON.stringify(back.chars.slice(0, 2)));

  /* ---------- 5. 前奏 / 末尾边界 ---------- */
  log('=== 5. 前奏/末尾边界 ===');
  const pre = await js(`(() => { updateLyric(-30); return ${chSnap}; })()`);
  ok('播放位置在歌词之前时不报错、不误填', pre.i < 0 || pre.chars.length === 0,
    JSON.stringify(pre).slice(0, 80));
  const post = await js(`(() => { updateLyric(500); const s = ${chSnap}; return { len: s.chars.length, ps: s.chars.map(c => c.p), op: s.op }; })()`);
  ok('越过最后一句后整句填满、无残留半字', post.ps.every(p => p >= 99.9), JSON.stringify(post.ps));
  ok('最后一句后面没有空档、不挂「…」', post.op === 0 || post.op === null, `op=${post.op}`);

  /* ---------- 6. 没有时间戳的歌词 ---------- */
  log('=== 6. 无时间戳 / 空歌词 ===');
  const empty = await js(`(() => ({
    plain: buildLyrics({ text: '只有一句版权信息，没有时间轴' }).length,
    none: buildLyrics({ text: '' }).length,
    // 纯 yrc（没有 lrc）也要能用
    yrcOnly: buildLyrics({ text: '', yrc: '[500,400](500,400,0)无' }).length
  }))()`);
  log('  ' + JSON.stringify(empty));
  ok('无时间戳的纯文本不生成歌词行', empty.plain === 0);
  ok('空歌词不生成行', empty.none === 0);
  ok('只有 yrc 时也能出歌词', empty.yrcOnly === 1);

  /* ---------- 7. 真实曲目：网易云 yrc 是否可用 ---------- */
  log('=== 7. 网易云真实曲目 ===');
  const neIds = await js(`(() => {
    const extra = S.tracks.filter(t => /^ne:/.test(t.path)).slice(0, 3).map(t => t.path);
    return extra;
  })()`);
  log('  候选：' + JSON.stringify(neIds));
  if (neIds.length) {
    for (const p of neIds.slice(0, 2)) {
      const r = await js(`window.api.trackLyric(${JSON.stringify(p)}).then(x => ({
        keys: Object.keys(x), src: x.source, note: x.note || '',
        yrcLen: (x.yrc || '').length, lrcLen: (x.text || '').length
      })).catch(e => ({ err: String(e && e.message || e) }))`);
      log(`  ${p} → ${JSON.stringify(r)}`);
      ok(`曲目 ${p.slice(3)} 能取到带时间轴的歌词`, r.lrcLen > 0 || r.yrcLen > 0, JSON.stringify(r).slice(0, 120));
    }
  } else {
    log('  （隔离曲库里没有网易云曲目，跳过）');
  }

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
