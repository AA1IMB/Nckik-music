'use strict';
/**
 * 探针：逐字歌词进度 + 无进度时「…」占位（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 验三件事：
 *   1. 数据层：每行都能摊出「每字一个 { c, t0, t1 }」，时间单调、单字不超过上限；
 *      yrc（网易云逐字）与行内 <mm:ss.xx> 的真实时间要原样保留；
 *   2. 渲染层：把播放时钟设到某个字的中间，只有它自己的 --p 是 0~100，
 *      它前面的字是 100%、后面的字是 0% —— 不允许整行一条渐变扫过去；
 *   3. 空档：间奏里当前句挂上 .waiting（"…" 可见且有缩放动画），
 *      进度恢复后 .waiting 消失。
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

/* 造一首「本地曲目 + 同名 .lrc」：第 1 句唱完到第 2 句有 6 秒空档，
 * 正好用来验「…」占位；句子长短不同，用来验逐字速度不跟整行长度挂钩。 */
const media = path.join(tmp, 'media');
fs.mkdirSync(media, { recursive: true });
fs.copyFileSync(path.join(root, 'demo', 'demo.wav'), path.join(media, 'lyr.wav'));
fs.writeFileSync(path.join(media, 'lyr.lrc'), [
  '[ti:逐字测试]',
  '[00:00.00]短句',
  '[00:06.00]间奏之后的第二句歌词',
  '[00:10.00]第三句更长一些用来验证字与字之间的速度是不同的',
  '[00:16.00]末句'
].join('\n'), 'utf8');
const wav = path.join(media, 'lyr.wav');
const st = fs.statSync(wav);
/* library.json 就是 Track 数组本身（main.js 的 library:get 直接 readJSON(libraryPath, [])） */
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify([{
  path: wav, title: '逐字测试', artist: '探针', album: '探针', duration: 42,
  codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true,
  hasCover: false, hasLyric: true, mtime: st.mtimeMs, size: st.size, addedAt: Date.now()
}], null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ theme: 'dark', volume: 0, muted: true }));

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

/* 读当前行每个字的状态：p 为 --p 的百分比数值 */
const chSnap = `(() => {
  const i = S.lastLy;
  const node = i >= 0 ? S.lnNodes[i] : null;
  if (!node) return { i, chars: [], waiting: null };
  const spans = [...node.querySelectorAll('.ch')];
  return {
    i,
    waiting: node.classList.contains('waiting'),
    gapOp: (() => { const g = node.querySelector('.gap'); return g ? +getComputedStyle(g).opacity : null; })(),
    gapAnim: (() => { const g = node.querySelector('.gap'); return g ? getComputedStyle(g).animationName : null; })(),
    chars: spans.map(s => ({ c: s.textContent, p: parseFloat(s.style.getPropertyValue('--p')) || 0 }))
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
    return { lines: S.lyrics.length, bad, hasGap: S.lnNodes.every(n => !!n.querySelector('.gap')) };
  })()`);
  log('  ' + JSON.stringify(rendered));
  ok('每行一个字一个 span', rendered.bad.length === 0, rendered.bad.join(','));
  ok('每行都带「…」占位节点', rendered.hasGap === true);

  // 反复把时钟放到不同字里，验证「已填的是前缀，当前字在中间」
  const probes = [
    { line: 1, ch: 0 }, { line: 1, ch: 3 }, { line: 1, ch: 6 }, { line: 2, ch: 2 }, { line: 2, ch: 9 }
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

  /* ---------- 4. 空档：「…」占位 ---------- */
  log('=== 4. 间奏的「…」占位 ===');
  /* 用真实播放头驱动：暂停后把 currentTime 停在第 1 句唱完(2.8s)、
   * 第 2 句还没开始(6.0s) 的位置。只调 updateLyric() 不行 ——
   * 逐帧循环的下一帧就会用真实时钟把它覆盖回去。 */
  await js(`(() => { audio.pause(); audio.currentTime = 3.2; })()`);
  await sleep(400);
  const gap = await js(`(${chSnap})`);
  log('  ' + JSON.stringify(gap));
  ok('空档里当前句挂上 .waiting', gap.waiting === true);
  ok('空档里这一句已经补满（不留半句）',
    gap.chars.length > 0 && gap.chars.every(c => c.p >= 99.9),
    JSON.stringify(gap.chars.map(c => c.p)));
  ok('「…」有缩放循环动画', gap.gapAnim === 'gapPulse', String(gap.gapAnim));

  /* 动画要真的在跑：playState=running、currentTime 在前进、
   * 连续采样的 opacity 在 0.55~1 之间来回，缩放跟着变。 */
  const anim = await js(`(async () => {
    const g = S.lnNodes[0].querySelector('.gap');
    const a = g.getAnimations()[0];
    const t1 = a ? a.currentTime : -1;
    const ops = [];
    for (let k = 0; k < 7; k++) {
      ops.push(+getComputedStyle(g).opacity);
      await new Promise(r => setTimeout(r, 110));
    }
    const a2 = g.getAnimations()[0];
    const cs = getComputedStyle(g);
    const m = new DOMMatrixReadOnly(cs.transform === 'none' ? '' : cs.transform);
    return {
      name: a2 && a2.animationName, state: a2 && a2.playState,
      dur: a2 && a2.effect.getTiming().duration,
      adv: a ? Math.round(a2.currentTime - t1) : null,
      ops: ops.map(o => +o.toFixed(3)),
      scale: +m.a.toFixed(3),
      kf: a2 ? a2.effect.getKeyframes().map(k => ({ o: k.offset, op: k.opacity, tr: k.transform })) : null
    };
  })()`);
  log('  动画：' + JSON.stringify({ name: anim.name, state: anim.state, dur: anim.dur, adv: anim.adv, ops: anim.ops, scale: anim.scale }));
  log('  关键帧：' + JSON.stringify(anim.kf));
  ok('「…」上有 gapPulse 1.5s 循环动画且处于 running',
    anim.name === 'gapPulse' && anim.dur === 1500 && anim.state === 'running', `${anim.name}/${anim.dur}/${anim.state}`);
  ok('动画时钟在前进（不是停在第一帧）', anim.adv > 500, `adv=${anim.adv}ms`);
  ok('「…」始终可见（采样 opacity 都 > 0.5）', anim.ops.every(o => o > 0.5), JSON.stringify(anim.ops));
  ok('「…」明暗在起伏（opacity 有 >0.15 的波动）',
    Math.max(...anim.ops) - Math.min(...anim.ops) > 0.15,
    `range=${(Math.max(...anim.ops) - Math.min(...anim.ops)).toFixed(3)}`);
  ok('关键帧是「放大→缩小」往复（scale .86 ↔ 1.14、opacity .55 ↔ 1）',
    Array.isArray(anim.kf) && anim.kf.length === 3
    && /scale\(0\.86\)/.test(anim.kf[0].tr) && /scale\(1\.14\)/.test(anim.kf[1].tr) && /scale\(0\.86\)/.test(anim.kf[2].tr)
    && parseFloat(anim.kf[0].op) === 0.55 && parseFloat(anim.kf[1].op) === 1,
    JSON.stringify(anim.kf && anim.kf.map(k => k.tr + '@' + k.op)));

  /* 播放头走进第 2 句：.waiting 要撤掉、「…」淡出、填充条接上 */
  const backAt = await js(`(() => { const c = S.lyrics[1].chars[0]; return +(c.t0 + (c.t1 - c.t0) * 0.4).toFixed(3); })()`);
  await js(`audio.currentTime = ${backAt}`);
  await sleep(400);
  const back = await js(`(${chSnap})`);
  log('  ' + JSON.stringify({ waiting: back.waiting, gapOp: back.gapOp, chars: back.chars.slice(0, 3) }));
  ok('进度恢复后 .waiting 消失（平滑切回填充条）', back.waiting === false);
  ok('恢复后第一个字已在填', back.chars[0] && back.chars[0].p > 20 && back.chars[0].p < 80);

  /* ---------- 5. 前奏：还没有当前句 ---------- */
  log('=== 5. 前奏/末尾边界 ===');
  const pre = await js(`(() => { updateLyric(-30); return ${chSnap}; })()`);
  ok('播放位置在歌词之前时不报错、不误填', pre.chars.length > 0 || pre.i < 0, JSON.stringify(pre).slice(0, 80));
  const post = await js(`(() => { updateLyric(500); const s = ${chSnap}; return { len: s.chars.length, ps: s.chars.map(c => c.p) }; })()`);
  ok('越过最后一句后整句填满、无残留半字', post.ps.every(p => p >= 99.9), JSON.stringify(post.ps));

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
