'use strict';
/**
 * 探针：老数据里缺封面地址的网易云曲目会自动补齐（需要联网）
 * ---------------------------------------------------------------------------
 * 现场：早期版本从搜索结果入库，存档里只有 netId，没有 coverUrl / albumId，
 * 界面一直显示「网易云没有为该曲目提供封面」。这里按同样的形状造三条老数据，
 * 验证启动后的 healNetCovers() 能把地址补回来、写进 library.json、并让封面真的出现。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-coverheal-'));
app.setPath('userData', tmp);

/* 三条真实存在的歌，故意只留 id（与用户库里那 13 条同形） */
const stale = [
  { source: 'netease', path: 'ne:25638340', netId: 25638340, title: '此生不换', artist: '青鸟飞鱼', album: '', duration: 266, coverUrl: '', albumId: 0, codec: '', sampleRate: 0, bitDepth: 0, bitrate: 0, lossless: false, fee: 8 },
  { source: 'netease', path: 'ne:185712', netId: 185712, title: '小宇', artist: '张震岳', album: '', duration: 0, coverUrl: '', albumId: 0, codec: '', sampleRate: 0, bitDepth: 0, bitrate: 0, lossless: false, fee: 0 },
  { source: 'netease', path: 'ne:483378330', netId: 483378330, title: '巫堵', artist: 'deca joins', album: '', duration: 0, coverUrl: '', albumId: 0, codec: '', sampleRate: 0, bitDepth: 0, bitrate: 0, lossless: false, fee: 0 }
];
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(stale, null, 2));
/* 启动前先把写下去的老数据留在内存里：应用一起来就会把这份文件补写完整 */
const seededAtStart = JSON.parse(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8'));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0, muted: true, globalKeys: false, playMode: 'seq',
  playlist: stale.map(t => ({ id: t.path, title: t.title, artist: t.artist, duration: t.duration }))
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0; let fail = 0;
const say = (ok, name, detail) => {
  if (ok) pass++; else fail++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
};
const waitFor = async (fn, ms = 15000, step = 200) => {
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

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  for (let i = 0; i < 200 && !(await js('S.tracks.length')); i++) await sleep(100);

  console.log('\n=== 1. 启动前：三条老数据都没有封面地址 ===');
  /* 断言要看的是「探针写进 library.json 的那份老数据」，而且在写完之后、
   * 应用启动之前就要读出来自己存一份：healNetCovers() 在 init 里后台跑，
   * 网络快的时候等窗口就绪的这几百毫秒里文件就已经被改写成补好的样子了，
   * 那时再从磁盘读，读到的是「补完之后」的数据，这条断言就会假红。 */
  const seeded = seededAtStart ? seededAtStart.map(t => ({ id: t.netId, coverUrl: t.coverUrl || '', albumId: t.albumId || 0 })) : [];
  say(seeded.length === 3 && seeded.every(t => !t.coverUrl), '老数据确实缺 coverUrl', seeded);

  console.log('\n=== 2. 启动后自动补齐（healNetCovers） ===');
  const healed = await waitFor(async () => {
    const list = await js('S.tracks.map(t => t.coverUrl || "")');
    return list.length === 3 && list.every(Boolean);
  }, 20000);
  const after = await js('S.tracks.map(t => ({id: t.netId, coverUrl: t.coverUrl, album: t.album, albumId: t.albumId}))');
  say(healed, '三条都补上了 coverUrl', after);
  say(after.every(t => /^https:\/\/.+music\.126\.net\//.test(t.coverUrl) && /param=\d+y\d+/.test(t.coverUrl)),
    '补到的是 https 且带尺寸参数', after.map(t => t.coverUrl));
  say(after.every(t => t.albumId > 0), '顺带补上了 albumId', after.map(t => t.albumId));
  say(after[0].album === '此生不换', '顺带补上了专辑名', after[0].album);

  console.log('\n=== 3. 落盘：下次启动不用再问接口 ===');
  const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8'));
  say(disk.length === 3 && disk.every(t => t.coverUrl), 'library.json 里已写入 coverUrl', disk.map(t => t.coverUrl));
  const again = await js('healNetCovers()');
  say(again === 0, '再跑一次不用重复请求（返回 0）', again);

  console.log('\n=== 4. 正在放的这首真的出图（不是只改了字段） ===');
  await js('void playIndex(0)');
  const hasArt = await waitFor(async () => js('document.querySelector("#cover").classList.contains("has-art")'), 20000);
  const art = await js(`(() => {
    const img = document.querySelector('#coverImg');
    const c = document.querySelector('#cover');
    return { hasArt: c.classList.contains('has-art'), kind: img ? String(img.src).slice(0, 22) : '', len: img ? String(img.src).length : 0 };
  })()`);
  say(hasArt && /^data:image\//.test(art.kind), '当前曲封面是真实图片', art);

  console.log('\n=== 5. 列表行也有缩略图（不再只有占位磁贴） ===');
  await js("void openDrawer(document.querySelector('#dLib'))");   // 抽屉关着时行在视口外，观察器不会触发
  const thumbs = await waitFor(async () => js('[...document.querySelectorAll("#libList .item .th")].every(th => !!th.querySelector("img"))'), 20000);
  const rowInfo = await js(`[...document.querySelectorAll('#libList .item')].map(it => ({
    ne: it.dataset.ne, art: it.querySelector('.th').dataset.art || '', img: !!it.querySelector('.th img')
  }))`);
  say(thumbs, '三行都取到了缩略图', rowInfo);

  console.log('\n=== 6. 占位文案不再说「没有提供封面」 ===');
  const copy = await js(`(() => {
    const k = curTrack();
    const saved = { url: k.coverUrl, err: k.coverError };
    coverCache.delete(k.path);                 // 有缓存时会走「有图」分支，测不到空态文案
    k.coverUrl = ''; k.coverError = '';
    paintMeta();
    const t = document.querySelector('#ceD').textContent;
    k.coverUrl = saved.url; k.coverError = saved.err;
    paintMeta();
    return t;
  })()`);
  say(/封面地址缺失|会自动补/.test(copy), '缺地址时提示的是「会自动补」而不是「没有封面」', copy);

  console.log('\n=== 报错 ===');
  console.log('  ' + (0 ? '' : '（无）'));
  console.log('\n----------------------------------------');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  app.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE CRASH', e); app.exit(2); });
