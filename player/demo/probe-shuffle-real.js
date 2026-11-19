'use strict';
/**
 * 探针：用「用户真实的网易云歌单」复现随机播放的两个症状
 * ---------------------------------------------------------------------------
 * 现场：随机播放会抽到已经播过的歌；有时在两三首之间来回跳。
 * 这个探针不改任何东西，只把「下一次会落到哪一首」算出来看轨迹：
 *   1. stepIndex(1) 抽出下标；
 *   2. 那一行如果是坏行（曲库里没有这首），playAt 会走 skipDead 按列表顺序往后找，
 *      这里用同一段逻辑算出真正会播的那首。
 * 因为整段不依赖网络（只算下标），所以能稳定复现。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const appData = process.env.APPDATA;
const realDir = path.join(appData, 'NckiksMusic');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-shuf-'));
app.setPath('userData', tmp);

/* 这台机器上没有真实曲库（换机器 / 全新环境）就跳过：这个探针的意义就是「用本人的歌单复现」，
 * 没有真实数据时不该报红。 */
if (!fs.existsSync(path.join(realDir, 'settings.json'))) {
  console.log('跳过：没有找到真实曲库 ' + realDir + '（这个探针需要本机已有的网易云歌单）');
  app.exit(0);
  return;
}
for (const f of ['library.json', 'settings.json']) {
  fs.copyFileSync(path.join(realDir, f), path.join(tmp, f));
}
const settings = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
const playlist = Array.isArray(settings.playlist) ? settings.playlist : [];
console.log(`真实歌单 ${playlist.length} 首，曲库 ${JSON.parse(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8')).length} 首`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let win = null;
app.on('browser-window-created', (_e, w) => { win = w; });
const js = c => win.webContents.executeJavaScript(c, true);

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  for (let i = 0; i < 300 && !(await js('S.tracks.length')); i++) await sleep(100);

  const info = await js(`(() => {
    S.settings.playMode = 'shuffle';
    syncModeBtn();
    rebuildQueue();
    let live = 0;
    for (let i = 0; i < S.q.length; i++) if (qTrack(i)) live++;
    return { q: S.q.length, playable: live, pool: S.shufPool.size, tracks: S.tracks.length };
  })()`);
  console.log('队列:', JSON.stringify(info));

  /* 与 skipDead 相同的判定：挑中的行能不能播（qTrack 会现造网易云曲目，别再直接看 row.t） */
  const walk = `(() => {
    const n = S.q.length;
    const pick = stepIndex(1);
    if (pick < 0) return { pick: -1 };
    const dead = !qTrack(pick);
    let at = pick;
    if (dead) {
      at = -1;
      for (let s = 1; s <= n; s++) { const c = (pick + s) % n; if (qTrack(c)) { at = c; break; } }
    }
    if (at < 0) return { pick, dead, at: -1 };
    S.i = at;
    const it = S.q[at].item;
    return { pick, dead, at, title: it.title, artist: it.artist,
             pickedTitle: S.q[pick].item.title, done: S.shufDone.size, pool: S.shufPool.size };
  })()`;

  const trace = [];
  for (let i = 0; i < 40; i++) {
    const r = await js(walk);
    if (r.pick < 0) { trace.push({ stop: true, at: i }); break; }
    trace.push(r);
  }

  const titles = trace.filter(x => x.at >= 0).map(x => x.title + ' · ' + x.artist);
  const ghosts = trace.filter(x => x.dead).length;
  console.log(`\n40 次随机取歌：抽到坏行 ${ghosts} 次`);
  trace.slice(0, 20).forEach((x, i) => {
    if (x.stop) return console.log(`  #${i} 停住（没有下一首）`);
    console.log(`  #${String(i).padStart(2)} 抽中「${x.pickedTitle}」${x.dead ? ' ← 坏行，按列表顺序跳到' : ' →'}「${x.title}」 pool=${x.pool} done=${x.done}`);
  });

  /* 重复与来回跳 */
  const seen = new Map();
  const dup = [];
  titles.forEach((t, i) => { if (seen.has(t)) dup.push({ t, first: seen.get(t), again: i }); else seen.set(t, i); });
  const bounce = [];
  for (let i = 2; i < titles.length; i++) if (titles[i] === titles[i - 2]) bounce.push({ i, t: titles[i] });
  console.log(`\n去重后 ${new Set(titles).size} / 共播 ${titles.length} 次`);
  console.log('重复播放:', JSON.stringify(dup.slice(0, 8), null, 0));
  console.log('两首来回跳（A→B→A）:', JSON.stringify(bounce.slice(0, 8), null, 0));
  console.log('\n轨迹:', JSON.stringify(titles, null, 0));

  /* 完整一轮：176 首必须全部各不相同，第 177 次才允许重洗 */
  await js(`(() => { S.i = -1; S.shufDone = new Set(); resetShufPool(false); return 1; })()`);
  const round = [];
  for (let i = 0; i < info.q + 3; i++) {
    const r = await js(`(() => { const q = stepIndex(1); if (q < 0) return null; S.i = q; return S.q[q].item.title + ' · ' + S.q[q].item.artist; })()`);
    if (r === null) break;
    round.push(r);
  }
  /* 一轮的容量是「队列长度 − 1」：当前曲不进池（否则一抽就抽回自己），
   * 所以第 176 次落在新一轮里、抽回最开始那首是正常的。 */
  const perRound = Math.max(1, info.q - 1);
  const head = round.slice(0, perRound);
  const uniq = new Set(head).size;
  console.log(`\n完整一轮：队列 ${info.q} 首，本轮容量 ${perRound} → 取到 ${head.length} 首，其中不重复 ${uniq} 首`);
  const firstRepeatAt = (() => { const s = new Set(); for (let i = 0; i < round.length; i++) { if (s.has(round[i])) return i; s.add(round[i]); } return -1; })();
  console.log('第一次重复出现的位置:', firstRepeatAt, `（本轮容量 ${perRound}；≥ 该值即「整轮播完才重洗」）`);
  const ok = uniq === head.length && (firstRepeatAt < 0 || firstRepeatAt >= perRound);
  console.log(ok ? 'PASS 一轮内不重复，只有整轮播完才重洗' : 'FAIL 一轮内有重复');
  app.exit(ok ? 0 : 1);
})().catch(e => { console.error('PROBE CRASH', e); app.exit(2); });
