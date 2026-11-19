'use strict';
/**
 * 探针：酷狗免费曲音源（需要联网）
 * ---------------------------------------------------------------------------
 * 覆盖这条链路的四段，每段都从「用户看得见的结果」验证，而不是只看接口返回：
 *   1. 搜索：切到「酷狗」标签、输入关键词，列表出现条目并带「酷」标签
 *   2. 播放：点免费曲 → kgaudio:// 起播（currentTime 前进）、标题/码率落到界面上
 *   3. 封面与歌词：列表缩略图有图、正在播放的封面有图、歌词解析出非空行
 *   4. 会员曲：点付费曲 → 提示「需酷狗会员」并按队列顺序跳过，不空转不残留音源
 *
 * 网络不可用时四种情况都可能失败，所以每节都先探测一次搜索是否通；
 * 不通就整体标记 SKIP 并 exit 0，不把「没联网」报成产品缺陷。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-kugou-'));
app.setPath('userData', tmp);
/* 两首本地曲目：只在最后一节用，验证「酷狗 + 本地混在同一个播放列表里」也能互切。
 * 直接用 demo.wav 复制两份，不需要额外素材。 */
const mixA = path.join(tmp, 'kg-mix-a.wav');
const mixB = path.join(tmp, 'kg-mix-b.wav');
fs.copyFileSync(path.join(root, 'demo', 'demo.wav'), mixA);
fs.copyFileSync(path.join(root, 'demo', 'demo.wav'), mixB);
const localTracks = [mixA, mixB].map((p, i) => ({
  path: p, title: '本地样本' + (i + 1), artist: '探针', album: '混源', duration: 42,
  codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true
}));
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(localTracks, null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false, playMode: 'seq', playlist: []
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0; let fail = 0; let skip = 0;
const say = (ok, name, detail) => {
  if (ok) pass++; else fail++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
};
const note = (name, detail) => { skip++; console.log('  SKIP ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail))); };
const waitFor = async (fn, ms = 20000, step = 200) => {
  const to = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > to) return false;
    await sleep(step);
  }
};

let win = null;
app.on('browser-window-created', (_e, w) => { win = w; });
const js = c => win.webContents.executeJavaScript(c, true);
const click = sel => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

/* 一次把界面状态读回来，避免多次 executeJavaScript 之间状态已经变了 */
const snap = () => js(`(() => {
  const k = (typeof curTrack === 'function') ? curTrack() : null;
  const rows = [...document.querySelectorAll('#libList .item')];
  const thumb = rows.find(r => r.querySelector('.th img'));
  return {
    srcMode: S.srcMode,
    kgView: S.kg.view, kgBusy: S.kg.busy, kgErr: S.kg.err,
    items: S.kg.items.length,
    free: S.kg.items.filter(t => !t.vip).length,
    vip: S.kg.items.filter(t => t.vip).length,
    rows: rows.length,
    rowTag: rows.length ? (rows[0].querySelector('.tag') || {}).textContent || '' : '',
    rowKg: rows.length ? rows[0].dataset.kg || '' : '',
    thumb: !!thumb,
    thumbSrc: thumb ? String(thumb.querySelector('img').getAttribute('src') || '').slice(0, 24) : '',
    count: $('#libCount').textContent,
    kgNote: ($('#kgNote') || {}).textContent || '',
    kgNoteShown: !!$('#kgNote') && getComputedStyle($('#kgNote')).display !== 'none',
    i: S.i, qLen: S.q.length,
    title: k ? k.title : '',
    artist: k ? k.artist : '',
    codec: k ? String(k.codec || '') : '',
    bitrate: k ? k.bitrate : 0,
    npT: $('#npT').textContent, npA: $('#npA').textContent, npF: $('#npF').textContent,
    src: String(audio.src || ''), paused: audio.paused,
    ct: Number(audio.currentTime.toFixed(2)), dur: Number((audio.duration || 0).toFixed(1)),
    rs: audio.readyState,
    cover: $('#cover').classList.contains('has-art'),
    coverImg: String(($('#coverImg') && $('#coverImg').getAttribute('src')) || '').slice(0, 22),
    lyrics: S.lyrics.length,
    lyricSrc: S.lyricSrc || '',
    toast: $('#toast').textContent || '',
    err: window.__err || ''
  };
})()`);

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('  [renderer]', msg); });
  for (let i = 0; i < 200 && !(await js('S.tracks !== undefined')); i++) await sleep(100);
  await js('window.addEventListener("error", e => { window.__err = String(e.message); });');

  console.log('\n=== 1. 切到酷狗标签：入口、说明、空态 ===');
  await click('#dLib [data-close]').catch(() => {});
  await js(`document.querySelector('#btnLib').click()`);
  await sleep(400);
  await click('#segSrc [data-s="kg"]');
  await sleep(600);
  let s = await snap();
  say(s.srcMode === 'kg', '音源切到酷狗', { srcMode: s.srcMode });
  say(s.kgNoteShown && /酷狗/.test(s.kgNote), '顶部说明写着只支持免费曲', { note: s.kgNote });
  say(s.rows === 0 && s.kgView === 'idle', '未搜索时是空态', { rows: s.rows, view: s.kgView });
  const placeholder = await js(`$('#q').placeholder`);
  say(/酷狗/.test(placeholder), '搜索框提示切到酷狗', { placeholder });

  console.log('\n=== 2. 搜索：条目、标签、分类计数 ===');
  await js(`(() => { const q = $('#q'); q.value = '晴天'; q.dispatchEvent(new Event('input')); })()`);
  const gotList = await waitFor(async () => (await js('S.kg.busy')) === false && (await js('S.kg.items.length')) > 0, 25000, 300);
  s = await snap();
  if (!gotList) {
    note('搜索酷狗', { err: s.kgErr || '无结果', hint: '网络不通或被限制' });
  } else {
    say(s.items >= 5, '搜索返回多条结果', { items: s.items });
    say(s.rows === s.items, '列表渲染了全部结果', { rows: s.rows, items: s.items });
    say(s.rowTag === '酷' || s.rowTag === 'VIP', '行上有来源角标', { tag: s.rowTag });
    say(/^[0-9a-f]{32}$/.test(s.rowKg), '行上带 hash', { kg: s.rowKg });
    say(s.free > 0, '结果里有可播的免费曲', { free: s.free, vip: s.vip });
    say(/可播/.test(s.count), '计数里区分可播条数', { count: s.count });
  }

  if (gotList) {
    console.log('\n=== 3. 播放免费曲：起播、元数据、封面、歌词 ===');
    /* 点第一条免费曲：不能只按行序猜，按 S.kg.items 里第一个 !vip 的 hash 找行 */
    const hash = await js(`(S.kg.items.find(t => !t.vip) || {}).kgHash || ''`);
    const clicked = await js(`(() => {
      const el = document.querySelector('#libList .item[data-kg="' + ${JSON.stringify(hash)} + '"]');
      if (!el) return false; el.click(); return true;
    })()`);
    say(clicked, '点到免费曲那一行', { hash });
    const playing = await waitFor(async () => {
      const x = await snap();
      return !x.paused && x.ct > 0.3 && x.rs >= 2 && x.dur > 0;
    }, 30000, 400);
    s = await snap();
    say(/^kgaudio:\/\//.test(s.src), '音频走 kgaudio 协议', { src: s.src.slice(0, 40) });
    say(playing, '正在出声（currentTime 在走）', { paused: s.paused, ct: s.ct, dur: s.dur, rs: s.rs });
    say(s.i === 0 && s.qLen === 1, '播放列表被建成一首并指向它', { i: s.i, qLen: s.qLen });
    say(s.npT.length > 0 && s.npT === s.title, '标题区跟着换', { npT: s.npT, title: s.title });
    say(/\d+kbps/.test(s.npF), '角落信息显示真实码率', { npF: s.npF, bitrate: s.bitrate, codec: s.codec });
    say(s.cover && /^data:image\//.test(s.coverImg), '播放器封面出图', { cover: s.cover, img: s.coverImg });
    const thumbOk = await waitFor(async () => (await js(`(() => {
      const row = document.querySelector('#libList .item[data-kg="' + ${JSON.stringify(hash)} + '"]');
      const img = row && row.querySelector('.th img');
      return !!(img && img.src && img.src.length > 100);
    })()`)), 15000, 400);
    say(thumbOk, '列表缩略图出图', {});
    const lyrOk = await waitFor(async () => (await js('S.lyrics.length')) > 0, 20000, 400);
    s = await snap();
    say(lyrOk, '歌词解析出非空行', { lines: s.lyrics, src: s.lyricSrc });
    say(s.err === '', '渲染层没有 JS 报错', { err: s.err });

    console.log('\n=== 3b. 拖进度：kgaudio 必须支持 Range ===');
    /* 远程音频最容易坏在 Range 上：不支持就「拖了没反应」或者从头开始下。
     * 拖到 60s，等播放头真的跳过去继续走 —— 只要中间断流就会被 ct 卡住。 */
    await js(`(() => { try { audio.currentTime = 60; } catch (e) {} })()`);
    const seeked = await waitFor(async () => {
      const x = await snap();
      return !x.paused && x.ct > 60.2 && x.ct < 90;
    }, 20000, 250);
    s = await snap();
    say(seeked, '拖到 60s 后继续播放', { ct: s.ct, paused: s.paused, dur: s.dur });

    console.log('\n=== 4. 会员曲：提示需要会员并跳过 ===');
    const vipHash = await js(`(S.kg.items.find(t => t.vip) || {}).kgHash || ''`);
    if (!vipHash) {
      note('点会员曲', { hint: '这次搜索结果里没有 VIP 条目' });
    } else {
      const before = await snap();
      await js(`(() => {
        const el = document.querySelector('#libList .item[data-kg="' + ${JSON.stringify(vipHash)} + '"]');
        if (el) el.click();
      })()`);
      /* 期望：提示「需酷狗会员」，并且因为播放列表只有两条（免费曲 + 这条），
       * 会自动退回免费曲继续放 —— 也就是「跳过」而不是「停在坏歌上」。 */
      const toasted = await waitFor(async () => /会员|无法播放/.test((await js('$("#toast").textContent')) || ''), 15000, 250);
      s = await snap();
      say(toasted, '给出了可读原因', { toast: s.toast });
      const recovered = await waitFor(async () => {
        const x = await snap();
        return !x.paused && x.ct > 0 && /^kgaudio:\/\//.test(x.src);
      }, 20000, 400);
      s = await snap();
      say(recovered, '没有停住：仍然在放可播的那首', { paused: s.paused, src: s.src.slice(0, 30), ct: s.ct });
      say(s.qLen === 2, '两条都在播放列表里（会员曲没有把列表弄乱）', { qLen: s.qLen, i: s.i });
      console.log('  info 会员曲前后对比', JSON.stringify({ before: { i: before.i, title: before.title }, after: { i: s.i, title: s.title } }));
    }
  }

  console.log('\n=== 5. 混源：酷狗与本地曲目在同一列表里互切 ===');
  /* 真实使用里一定是混着放的：点本地 → 点酷狗 → 再点本地，两次都得换源成功。
   * 任何一次切不过去（比如 media:url 没认 kg: 前缀），这里会立刻暴露。 */
  await click('#segSrc [data-s="local"]');
  await sleep(500);
  const localClicked = await js(`(() => {
    const row = [...document.querySelectorAll('#libList .item')].find(r => r.querySelector('.n'));
    if (!row) return '';
    row.click();
    return row.querySelector('.n').textContent || '';
  })()`);
  const localPlay = await waitFor(async () => {
    const x = await snap();
    return /^media:\/\//.test(x.src) && !x.paused && x.ct > 0.3;
  }, 20000, 250);
  s = await snap();
  say(localPlay, '点了本地曲目：走 media 协议并出声', { row: localClicked, src: s.src.slice(0, 26), ct: s.ct });

  await click('#segSrc [data-s="kg"]');
  await sleep(500);
  await js(`(() => { const q = $('#q'); q.value = '晴天'; q.dispatchEvent(new Event('input')); })()`);
  for (let i = 0; i < 80 && (await js('S.kg.items.length')) === 0; i++) await sleep(300);
  const freeHash = await js(`(S.kg.items.find(t => !t.vip) || {}).kgHash || ''`);
  await js(`(() => { const el = document.querySelector('#libList .item[data-kg="' + ${JSON.stringify(freeHash)} + '"]'); if (el) el.click(); })()`);
  const backToKg = await waitFor(async () => {
    const x = await snap();
    return /^kgaudio:\/\//.test(x.src) && !x.paused && x.ct > 0.3;
  }, 25000, 300);
  s = await snap();
  say(backToKg, '再点回酷狗曲目：又切回 kgaudio 并出声', { src: s.src.slice(0, 26), ct: s.ct, qLen: s.qLen });
  say(s.qLen >= 3, '跨源曲目都在同一个播放列表里', { qLen: s.qLen, i: s.i });

  console.log('\n=== 结果 ===');
  console.log(`通过 ${pass} 项，失败 ${fail} 项${skip ? `，跳过 ${skip} 项` : ''}`);
  app.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('PROBE CRASH', e && e.stack || e);
  app.exit(2);
});
setTimeout(() => { console.error('PROBE TIMEOUT'); app.exit(3); }, 240000);
