'use strict';
/**
 * 探针：逐字歌词 —— 网易云真实曲目（不属于项目代码）
 * ---------------------------------------------------------------------------
 * probe-lyric.js 用合成 LRC 验算法与渲染（30/30），这里补真实数据：
 *   1. trackLyric 是否真能拿到 yrc（每字真实起止）；
 *   2. buildLyrics 在真实 yrc 上是否产出「字 = 一个节点、时间单调」；
 *   3. 真实曲目播起来后，把播放头放到某字中间，验证只有这个字在填。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const realData = path.join(app.getPath('appData'), 'NckiksMusic');
process.env.NCKIK_SKIP_MIGRATION = '1';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-lyrne-'));
app.setPath('userData', tmp);
for (const f of ['library.json', 'settings.json', 'ne-auth.bin']) {
  const s = path.join(realData, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(tmp, f));
}

const logPath = path.join(root, 'demo', 'probe-lyric-ne.log');
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
const waitFor = async (fn, ms = 15000, step = 120) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
};

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  await waitFor(async () => (await js('S.tracks.length')) > 0, 15000);
  await sleep(600);

  const tracks = await js(`S.tracks.map(t => ({ path: t.path, title: t.title }))`);
  const ne = tracks.filter(t => /^ne:/.test(t.path)).slice(0, 4);
  log(`曲库 ${tracks.length} 首，其中网易云 ${tracks.filter(t => /^ne:/.test(t.path)).length} 首`);
  log('候选：' + JSON.stringify(ne.map(t => t.title + ' ' + t.path)));

  /* ---------- 1. 真实曲目的歌词数据 ---------- */
  log('=== 1. 网易云 trackLyric：yrc 有没有真数据 ===');
  let yrcHit = null;
  for (const t of ne) {
    const r = await js(`window.api.trackLyric(${JSON.stringify(t.path)}).then(x => ({
      keys: Object.keys(x).sort(), src: x.source || '', note: x.note || '',
      yrcLen: (x.yrc || '').length, lrcLen: (x.text || '').length,
      yrcHead: (x.yrc || '').slice(0, 90)
    })).catch(e => ({ err: String(e && e.message || e) }))`);
    log(`  ${t.title} ${t.path} → ${JSON.stringify(r)}`);
    if (!r.err && r.yrcLen > 0 && !yrcHit) yrcHit = { t, r };
  }
  if (yrcHit) {
    ok('能拿到带逐字时间轴的 yrc', true, `${yrcHit.t.title} yrc ${yrcHit.r.yrcLen} 字符`);
  } else {
    log('  （这几首都没拿到 yrc：可能是免费曲目/未登录/网络受限，走行级摊字兜底）');
  }

  /* ---------- 2. buildLyrics 在真实 yrc 上的产出 ---------- */
  if (yrcHit) {
    log('=== 2. 真实 yrc → 逐字节点 ===');
    const yrc = await js(`window.api.trackLyric(${JSON.stringify(yrcHit.t.path)}).then(x => x.yrc)`);
    const stats = await js(`(() => {
      const ls = buildLyrics({ text: '', yrc: ${JSON.stringify(yrc)} });
      const lens = ls.map(l => ({ t: +l.t.toFixed(2), n: l.chars.length, txt: l.text.length }));
      const flat = ls.flatMap(l => l.chars);
      const mono = flat.every((c, i) => i === 0 || c.t0 >= flat[i - 1].t0 - 1e-9);
      const pos = flat.every((c, i) => i === 0 || c.t0 >= flat[i - 1].t1 - 1e-9);
      const neg = flat.filter(c => c.t1 < c.t0).length;
      const durMin = Math.min(...flat.map(c => c.t1 - c.t0));
      return {
        lines: ls.length, chars: flat.length,
        lenMatch: lens.every(x => x.n === x.txt),
        mono, pos, neg, durMin: +durMin.toFixed(3),
        first: +flat[0].t0.toFixed(3), last: +flat[flat.length - 1].t1.toFixed(3),
        sample: lens.slice(0, 3)
      };
    })()`);
    log('  ' + JSON.stringify(stats));
    ok('每个字一个节点，且与行文字数一致', stats.lenMatch === true, `chars=${stats.chars}`);
    ok('字的时间单调不回退、不重叠', stats.mono && stats.pos, `mono=${stats.mono} pos=${stats.pos}`);
    ok('没有倒挂（t1 < t0）的字', stats.neg === 0, `neg=${stats.neg}`);
    ok('首字不早于 0、末字在歌里', stats.first >= 0 && stats.last > 10, `${stats.first}s ~ ${stats.last}s`);
  }

  /* ---------- 3. 真实曲目：播放后按字填充 ---------- */
  log('=== 3. 真实曲目播起来后的逐字填充 ===');
  const idx = tracks.findIndex(t => t.path === (yrcHit ? yrcHit.t.path : (ne[0] && ne[0].path)));
  log(`  播放第 ${idx + 1} 首`);
  await js(`playIndex(${idx})`);
  const gotLyrics = await waitFor(async () => (await js('S.lyrics.length')) > 0, 20000);
  ok('真实曲目加载出歌词节点', gotLyrics, `行数=${await js('S.lyrics.length')}`);
  if (gotLyrics) {
    const probe = await js(`(async () => {
      audio.pause();
      // 挑一句字数 >= 6 的，把播放头放到第 4 个字的中间
      let li = S.lyrics.map((l, i) => ({ i, n: l.chars.length })).filter(x => x.n >= 6)[2];
      if (!li) li = S.lyrics.map((l, i) => ({ i, n: l.chars.length })).filter(x => x.n >= 3)[0];
      if (!li) return { err: 'no-line' };
      const line = S.lyrics[li.i], c = line.chars[3] || line.chars[1];
      const at = c.t0 + (c.t1 - c.t0) * 0.5;
      audio.currentTime = at;
      await new Promise(r => setTimeout(r, 450));
      const node = S.lnNodes[li.i];
      const ps = [...node.querySelectorAll('.ch')].map(s => parseFloat(s.style.getPropertyValue('--p')) || 0);
      const k = line.chars.indexOf(c);
      return {
        line: li.i + 1, at: +at.toFixed(2), k, total: ps.length,
        prefix: ps.slice(0, k).every(p => p >= 99.9),
        suffix: ps.slice(k + 1).every(p => p <= 0.1),
        cur: +ps[k].toFixed(1),
        on: node.classList.contains('on'),
        text: line.text.slice(0, 20)
      };
    })()`);
    log('  ' + JSON.stringify(probe));
    ok('播放头落在某字中间时，只有这个字在填（前面满、后面空）',
      probe.prefix === true && probe.suffix === true && probe.cur > 20 && probe.cur < 80,
      `cur=${probe.cur}% 第${probe.k + 1}/${probe.total}字`);
    ok('该行是当前句（.on）', probe.on === true);
  }

  log('');
  log('=== 渲染层报错 ===');
  log(errors.length ? errors.join('\n') : '  （无）');
  log('');
  log('----------------------------------------');
  log(`通过 ${pass} 项，失败 ${fail} 项`);
  setTimeout(() => app.quit(), 300);
})().catch(e => {
  log('PROBE CRASH ' + ((e && e.stack) || e));
  setTimeout(() => app.quit(), 300);
});
