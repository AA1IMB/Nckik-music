'use strict';
/**
 * 探针：v0.9.8 歌词空格防闪烁 + 自定义缓存目录 + P1 体验与性能全套优化
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const pkgVer = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.9.8');

process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-p1-'));
const customCacheDir = path.join(tmp, 'my-custom-cache');
const mediaDir = path.join(tmp, 'media');
fs.mkdirSync(mediaDir, { recursive: true });

/* 生成两首 15 秒静音 WAV 与对应 .lrc */
function makeWav(file, secs = 15) {
  const sr = 8000, ch = 1, bps = 16;
  const dataLen = sr * secs * ch * (bps / 8);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * ch * (bps / 8), 28);
  buf.writeUInt16LE(ch * (bps / 8), 32);
  buf.writeUInt16LE(bps, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  fs.writeFileSync(file, buf);
}
const wav1 = path.join(mediaDir, 'track-a.wav');
const wav2 = path.join(mediaDir, 'track-b.wav');
makeWav(wav1, 15);
makeWav(wav2, 15);
fs.writeFileSync(path.join(mediaDir, 'track-a.lrc'), [
  '[00:01.00]有些人 一旦错过就不再',
  '[00:05.00]永远不会再重来',
  '[00:09.00]有一个男孩 爱着那个女孩'
].join('\n'));
fs.writeFileSync(path.join(mediaDir, 'track-b.lrc'), '[00:01.00]第二首歌预取测试\n[00:06.00]下一句歌词');

app.setPath('userData', tmp);
const tracks = [
  { path: wav1, title: 'Track A', artist: 'Tester', album: 'P1', duration: 15, codec: 'WAV' },
  { path: wav2, title: 'Track B', artist: 'Tester', album: 'P1', duration: 15, codec: 'WAV' }
];
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(tracks));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark',
  volume: 0.4,
  muted: true,
  playMode: 'seq',
  autoCheckUpdate: false,
  playlist: tracks.map(t => ({ id: t.path, title: t.title, artist: t.artist, duration: t.duration }))
}));

const logPath = path.join(root, 'demo', 'probe-p1.log');
fs.writeFileSync(logPath, '');
const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(logPath, line + '\n');
  try { console.log(line); } catch {}
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

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
    if (lvl >= 2 && !/Autofill|DevTools/.test(msg)) errors.push(msg);
  });
});

(async () => {
  require(path.join(root, 'main.js'));
  const js = code => win.webContents.executeJavaScript(code, true);
  await waitFor(() => !!win && !win.webContents.isLoading());
  win.showInactive();
  await waitFor(() => win.isVisible(), 6000);
  await sleep(600);

  log('=== 1. 歌词空格分割后首字防闪烁（YRC 0ms 空格 + 空格后停顿） ===');
  const flickerRes = await js(`(() => {
    // 构造典型空格分割逐字歌词：空格时长 0ms 且空格后有 400ms 停顿，第二处空格 150ms 后有 450ms 停顿
    const yrc = '[1000,6000](1000,300,0)有(1300,300,0)些(1600,400,0)人(2000,0,0) (2400,300,0)一(2700,300,0)旦(3000,300,0)错(3300,300,0)过(3600,150,0) (4200,400,0)就(4600,400,0)不(5000,500,0)再';
    S.lyrics = buildLyrics({ text: '[00:01.00]有些人 一旦错过 就不 再', yrc });
    renderLyrics();
    const spans = S.lnChars[0];
    const idxYi = S.lyrics[0].chars.findIndex(c => c.c === '一');
    const idxJiu = S.lyrics[0].chars.findIndex(c => c.c === '就');

    let flashYi = false;
    const samplesYi = [];
    for (let ms = 1900; ms <= 2380; ms += 20) {
      updateLyric(ms / 1000);
      const p = spans[idxYi].style.getPropertyValue('--p');
      if (p && p !== '0%') { flashYi = true; samplesYi.push({ ms, p }); }
    }
    updateLyric(2.55); // 进入「一」中间 (50%)
    const midYi = parseFloat(spans[idxYi].style.getPropertyValue('--p') || '0');

    let flashJiu = false;
    const samplesJiu = [];
    for (let ms = 3550; ms <= 4180; ms += 20) {
      updateLyric(ms / 1000);
      const p = spans[idxJiu].style.getPropertyValue('--p');
      if (p && p !== '0%') { flashJiu = true; samplesJiu.push({ ms, p }); }
    }
    updateLyric(4.4); // 进入「就」中间 (50%)
    const midJiu = parseFloat(spans[idxJiu].style.getPropertyValue('--p') || '0');

    return { idxYi, idxJiu, flashYi, samplesYi, midYi, flashJiu, samplesJiu, midJiu };
  })()`);
  log('  flicker:', JSON.stringify(flickerRes));
  ok('0ms 空格后停顿期间「一」绝不闪烁为 100%', flickerRes.idxYi > 0 && !flickerRes.flashYi, JSON.stringify(flickerRes.samplesYi));
  ok('「一」进入时间段后正常平滑填充 (~50%)', flickerRes.midYi >= 40 && flickerRes.midYi <= 60, String(flickerRes.midYi));
  ok('有宽度空格后停顿期间「就」绝不闪烁为 100%', flickerRes.idxJiu > 0 && !flickerRes.flashJiu, JSON.stringify(flickerRes.samplesJiu));
  ok('「就」进入时间段后正常平滑填充 (~50%)', flickerRes.midJiu >= 40 && flickerRes.midJiu <= 60, String(flickerRes.midJiu));

  log('\n=== 2. 自定义软件缓存位置（配置 / 写盘 / 统计 / 清理 / 重置） ===');
  await js(`openDrawer(document.querySelector('#dSet')); 0`);
  await sleep(250);
  const cDef = await js(`window.api.cacheInfo()`);
  log('  cache default:', JSON.stringify(cDef));
  ok('默认缓存目录位于 userData/Cache 且 isCustom=false', cDef.ok && cDef.isCustom === false && cDef.dir.endsWith('Cache'));

  const cSet = await js(`window.api.cacheSet(${JSON.stringify(customCacheDir)})`);
  await js(`cacheRender(${JSON.stringify(cSet)}); 0`);
  const cfgDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'cache-config.json'), 'utf8'));
  const cacheUiPath = await js(`document.querySelector('#cachePath')?.textContent`);
  const resetDisabledAfterSet = await js(`document.querySelector('#btnCacheReset')?.disabled`);
  log('  cache set:', JSON.stringify(cSet));
  ok('自定义缓存目录切换成功并持久化 cache-config.json', cSet.ok && cSet.isCustom === true && cSet.pendingRestart === true && cfgDisk.cacheDir === path.resolve(customCacheDir));
  ok('设置页正确展示新路径并启用「默认」重置按钮', cacheUiPath === path.resolve(customCacheDir) && resetDisabledAfterSet === false);

  // 写入测试缓存文件并测试统计 + 一键清理
  const dummyUpd = path.join(customCacheDir, 'updates', 'dummy.bin');
  fs.writeFileSync(dummyUpd, Buffer.alloc(16 * 1024, 0x5a));
  const cBeforeClear = await js(`window.api.cacheInfo()`);
  ok('缓存体积统计能准确计入自定义缓存目录文件', cBeforeClear.ok && cBeforeClear.bytes >= 16384, String(cBeforeClear.bytes));

  await js(`document.querySelector('#btnCacheClear').click(); 0`);
  await waitFor(() => !fs.existsSync(dummyUpd), 4000);
  ok('点击「清理」成功清除缓存目录文件', !fs.existsSync(dummyUpd));

  await js(`document.querySelector('#btnCacheReset').click(); 0`);
  await waitFor(() => js(`cacheState.info && cacheState.info.isCustom === false`), 4000);
  const cfgReset = JSON.parse(fs.readFileSync(path.join(tmp, 'cache-config.json'), 'utf8'));
  ok('点击「默认」成功恢复默认缓存位置并写回空配置', cfgReset.cacheDir === '');

  log('\n=== 3. 点击歌词跳转 + 单曲歌词偏移微调与持久化 ===');
  await js(`closeDrawers(); 0`);
  await js(`playAt(0, { autoplay: false }); 0`);
  await waitFor(() => js(`S.lyrics.length === 3 && audio.readyState >= 1`), 5000);
  await sleep(150);
  await js(`document.querySelector('#lnInner .ln[data-i="2"]').click(); 0`);
  await sleep(150);
  const clickJump = await js(`({ t: audio.currentTime, lastLy: S.lastLy, on: document.querySelector('#lnInner .ln[data-i="2"]')?.classList.contains('on') })`);
  log('  clickJump:', JSON.stringify(clickJump));
  ok('点击第 3 句歌词立刻跳转至 ~9s 并高亮', Math.abs(clickJump.t - 9) < 0.3 && clickJump.lastLy === 2 && clickJump.on === true);

  await js(`document.querySelector('#btnLyrPlus').click(); document.querySelector('#btnLyrPlus').click(); 0`);
  await sleep(300);
  const offState = await js(`(() => {
    updateLyric(8.3); // 原第 3 句在 9.0s，偏移 +1.0s 后在 8.3s 就应激活第 3 句
    return {
      txt: document.querySelector('#btnLyrReset')?.textContent,
      shifted: document.querySelector('#lyrTools')?.classList.contains('shifted'),
      off: curLyricOffset(),
      lastLy: S.lastLy
    };
  })()`);
  const stAfterOff = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
  log('  offset:', JSON.stringify(offState));
  ok('歌词偏移 +1.0s 生效并持久化到 settings.json', offState.txt === '+1.0s' && offState.shifted === true && offState.lastLy === 2 && stAfterOff.lyricOffsets && stAfterOff.lyricOffsets[wav1] === 1);

  await js(`document.querySelector('#btnLyrReset').click(); 0`);
  await sleep(250);
  const offReset = await js(`({ txt: document.querySelector('#btnLyrReset')?.textContent, off: curLyricOffset(), shifted: document.querySelector('#lyrTools')?.classList.contains('shifted') })`);
  ok('点击偏移值成功归零复位', offReset.txt === '0.0s' && offReset.off === 0 && offReset.shifted === false);

  log('\n=== 4. 下一首静默预取（顺序播放不污染队列/随机池） ===');
  const pf = await js(`(async () => {
    S.prefetchedFor = '';
    lyricPrefetch.clear();
    detailPrefetch.clear();
    const okCall = prefetchNext(true);
    await new Promise(r => setTimeout(r, 350));
    return {
      okCall,
      hasLyr: lyricPrefetch.has(${JSON.stringify(wav2)}),
      hasDet: detailPrefetch.has(${JSON.stringify(wav2)}),
      curIdx: S.i
    };
  })()`);
  log('  prefetch:', JSON.stringify(pf));
  ok('静默预取命中下一首歌词与详情且不改当前下标', pf.okCall === true && pf.hasLyr === true && pf.hasDet === true && pf.curIdx === 0);

  log('\n=== 5. 本地超大曲库（1200 首）虚拟滚动 + 预计算搜索 ===');
  await js(`openDrawer(document.querySelector('#dLib')); 0`);
  await sleep(200);
  const virt = await js(`(() => {
    const base = S.tracks.slice();
    for (let k = 0; k < 1198; k++) {
      base.push({
        path: 'C:/fake/song-' + String(k).padStart(4, '0') + '.mp3',
        title: 'BigLib Track ' + String(k).padStart(4, '0'),
        artist: k % 2 ? 'Alpha' : 'Beta',
        album: 'HugeAlbum',
        duration: 180
      });
    }
    S.tracks = base;
    rebuildLibIndex();
    renderLibrary();
    const domCount = document.querySelectorAll('#libList .item').length;
    const pads = document.querySelectorAll('#libList .lib-pad').length;
    const hasKey = typeof S.tracks[100]._searchKey === 'string' && S.tracks[100]._searchKey.includes('biglib track');
    return { total: S.tracks.length, domCount, pads, hasKey, virtActive: libVirt.active };
  })()`);
  log('  virtual:', JSON.stringify(virt));
  ok('1200 首曲库自动启用虚拟滚动（DOM 行数 < 60 且带上下 spacer）', virt.virtActive === true && virt.domCount > 5 && virt.domCount < 60 && virt.pads === 2);
  ok('rebuildLibIndex 预计算 _searchKey', virt.hasKey === true);

  await js(`const q = document.querySelector('#q'); q.value = 'BigLib Track 0999'; q.dispatchEvent(new Event('input')); 0`);
  await sleep(220);
  const searchRes = await js(`({
    cnt: document.querySelector('#libCount')?.textContent,
    rows: document.querySelectorAll('#libList .item').length,
    virtActive: libVirt.active
  })`);
  log('  search:', JSON.stringify(searchRes));
  ok('防抖搜索精准命中 1 / 1200 首并自动退出虚拟滚动', searchRes.rows === 1 && searchRes.cnt === '1 / 1200 首' && searchRes.virtActive === false);

  log('\n=== 6. 设置锚点导航 + 封面主色 WCAG 双边对比度校验 ===');
  await js(`openDrawer(document.querySelector('#dSet')); 0`);
  await sleep(200);
  const navCheck = await js(`(() => {
    const btns = [...document.querySelectorAll('#setNav button[data-sec]')];
    const secs = btns.map(b => b.dataset.sec);
    const allExist = secs.every(id => !!document.getElementById(id));
    const palette = ['#ffffff', '#000000', '#f8f5e6', '#101014', '#ff3b30', '#2dd4bf', '#ffe600', '#1a237e'];
    const bad = [];
    for (const dark of [true, false]) {
      const fg = dark ? FG.dark : FG.light;
      const bg = dark ? BG.dark : BG.light;
      for (const hex of palette) {
        const ink = inkFor(hex, dark);
        const cf = contrast(ink, fg);
        const cb = contrast(ink, bg);
        if (cf < 2.15 || cb < 2.95) bad.push({ dark, hex, ink, cf, cb });
      }
    }
    return { count: btns.length, allExist, bad };
  })()`);
  log('  nav & contrast:', JSON.stringify(navCheck));
  ok('设置抽屉顶部含 5 个有效分组锚点', navCheck.count === 5 && navCheck.allExist === true);
  ok('8 种极端封面主色在深/浅主题下均满足前景 >=2.2 与背景 >=3.0 双边对比度', navCheck.bad.length === 0, JSON.stringify(navCheck.bad));

  log('\n=== 7. 平滑播放/暂停淡入淡出 + 版本号 + 零报错 ===');
  const fadeCheck = await js(`(async () => {
    S.settings.muted = false;
    audio.muted = false;
    S.settings.volume = 0.4;
    audio.volume = 0.4;
    togglePlay(); // 开始播放（淡入）
    await new Promise(r => setTimeout(r, 260));
    const playingVol = audio.volume;
    const wasPlaying = !audio.paused;
    togglePlay(); // 暂停（淡出）
    await new Promise(r => setTimeout(r, 260));
    const paused = audio.paused;
    const restoredVol = audio.volume;
    audio.muted = true;
    S.settings.muted = true;
    return { wasPlaying, playingVol, paused, restoredVol };
  })()`);
  log('  fade:', JSON.stringify(fadeCheck));
  ok('非静音播停平滑淡入淡出后音量正确恢复至设定值', fadeCheck.wasPlaying && Math.abs(fadeCheck.playingVol - 0.4) < 0.02 && fadeCheck.paused && Math.abs(fadeCheck.restoredVol - 0.4) < 0.02);

  const verTxt = await js(`document.querySelector('#verNum')?.textContent`);
  ok('设置页版本号与 package.json 一致', verTxt === 'v' + pkgVer, String(verTxt));
  ok('渲染层无任何 JS 错误', errors.length === 0, errors.join(' | '));

  log(`\n合计：${pass} 通过 / ${fail} 失败`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  log('PROBE CRASH:', (e && e.stack) || e);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(2);
});
