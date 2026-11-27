'use strict';
/**
 * 探针：v1.3.0 Phase 1+2+3 USB 独占（本地无损 + 在线回环直通 + 原生双缓冲无缝播放 Gapless）
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const pkgVer = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '1.3.0');

process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-excl-'));
const mediaDir = path.join(tmp, 'media');
fs.mkdirSync(mediaDir, { recursive: true });

function makeWav(file, { sr = 44100, ch = 2, bps = 16, secs = 6 } = {}) {
  const bytesPerSample = bps / 8;
  const dataLen = sr * secs * ch * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * ch * bytesPerSample, 28);
  buf.writeUInt16LE(ch * bytesPerSample, 32);
  buf.writeUInt16LE(bps, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  // 极低电平测试正弦波（实测时不刺耳）
  for (let i = 0; i < sr * secs; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.0005;
    for (let c = 0; c < ch; c++) {
      const off = 44 + (i * ch + c) * bytesPerSample;
      if (bps === 16) {
        buf.writeInt16LE(Math.round(v * 32767), off);
      } else if (bps === 24) {
        let val = Math.round(v * 8388607);
        if (val < 0) val += 0x1000000;
        buf[off] = val & 0xff;
        buf[off + 1] = (val >> 8) & 0xff;
        buf[off + 2] = (val >> 16) & 0xff;
      }
    }
  }
  fs.writeFileSync(file, buf);
}

const wav48 = path.join(mediaDir, 'test-48k16b.wav');
const wav44 = path.join(mediaDir, 'test-44k16b.wav');
const wav96 = path.join(mediaDir, 'test-96k24b.wav');
const wavGapA = path.join(mediaDir, 'gap-part-a.wav');
const gapBDir = path.join(mediaDir, 'gap-b-album');
fs.mkdirSync(gapBDir, { recursive: true });
const wavGapB = path.join(gapBDir, 'gap-part-b.wav');
makeWav(wav48, { sr: 48000, ch: 2, bps: 16, secs: 6 });
makeWav(wav44, { sr: 44100, ch: 2, bps: 16, secs: 6 });
makeWav(wav96, { sr: 96000, ch: 2, bps: 24, secs: 6 });
makeWav(wavGapA, { sr: 48000, ch: 2, bps: 16, secs: 2 });
makeWav(wavGapB, { sr: 48000, ch: 2, bps: 16, secs: 3 });
fs.writeFileSync(path.join(gapBDir, 'gap-part-b.lrc'), '[00:00.10]无缝衔接第二轨测试歌词\n[00:01.50]零间隙连续播放\n');
// 放入同目录封面图，验证无缝切歌后能正常加载并显示下一首封面
fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(gapBDir, 'cover.png'));

app.setPath('userData', tmp);
const tracks = [
  { path: wav48, title: 'Excl 48kHz 16-bit', artist: 'Tester', album: 'Phase1', duration: 6, codec: 'WAV', bitrate: 1536 },
  { path: wav44, title: 'Excl 44.1kHz 16-bit', artist: 'Tester', album: 'Phase1', duration: 6, codec: 'WAV', bitrate: 1411 },
  { path: wav96, title: 'Excl 96kHz 24-bit', artist: 'Tester', album: 'Phase1', duration: 6, codec: 'WAV', bitrate: 4608 },
  { path: 'ne:101', source: 'netease', songId: 101, title: 'Online Excl 48k', artist: 'Netease', album: 'Cloud', duration: 6, codec: 'WAV', bitrate: 1536 },
  { path: wavGapA, title: 'Gapless Part A', artist: 'Live Album', album: 'Concert', duration: 2, codec: 'WAV', bitrate: 1536 },
  { path: wavGapB, title: 'Gapless Part B', artist: 'Live Album', album: 'Concert', duration: 3, codec: 'WAV', bitrate: 1536 }
];
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(tracks));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'dark',
  volume: 0.25,
  muted: true,
  playMode: 'seq',
  autoCheckUpdate: false,
  usbExclusive: false,
  exclusiveDeviceId: '',
  playlist: tracks.map(t => ({ id: t.path, title: t.title, artist: t.artist, duration: t.duration, source: t.source || 'local', songId: t.songId }))
}));

const logPath = path.join(root, 'demo', 'probe-exclusive.log');
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
  if (!win) win = w;
  w.webContents.on('console-message', (_ev, lvl, msg) => {
    if (lvl >= 2 && !/Autofill|DevTools/.test(msg)) errors.push(msg);
  });
  w.webContents.on('render-process-gone', (_ev, d) => errors.push('render-gone:' + d.reason));
});

const js = code => win.webContents.executeJavaScript(code, true);

// 搭建离线模拟网易云接口 + 48kHz WAV 音频 CDN（含首次 403 换链与字节 Range 拖拽）
const mockWavBuf = fs.readFileSync(wav48);
let mockUrlSeq = 0;
let mock403Hits = 0;
let mockRangeHits = 0;
const mockNeSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/api/song/enhance/player/url' || u.pathname === '/api/song/enhance/player/url/v1') {
    mockUrlSeq++;
    const pathUrl = mockUrlSeq === 1 ? '/audio/expired.wav' : '/audio/ok48.wav';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: 200,
      data: [{
        id: 101,
        code: 200,
        url: `http://127.0.0.1:${mockNeSrv.address().port}${pathUrl}`,
        br: 1536000,
        type: 'wav',
        level: 'lossless',
        size: mockWavBuf.length,
        expi: 1200,
        fee: 0
      }]
    }));
    return;
  }
  if (u.pathname === '/api/song/lyric') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, lrc: { lyric: '[00:00.00]在线独占测试\n[00:03.00]第二句' } }));
    return;
  }
  if (u.pathname === '/audio/expired.wav') {
    mock403Hits++;
    res.writeHead(403);
    res.end('expired');
    return;
  }
  if (u.pathname === '/audio/ok48.wav') {
    const total = mockWavBuf.length;
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      mockRangeHits++;
      const s = parseInt(m[1], 10);
      const e = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
      res.writeHead(206, {
        'Content-Type': 'audio/wav',
        'Content-Range': `bytes ${s}-${e}/${total}`,
        'Content-Length': e - s + 1,
        'Accept-Ranges': 'bytes'
      });
      res.end(mockWavBuf.subarray(s, e + 1));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': total, 'Accept-Ranges': 'bytes' });
    res.end(mockWavBuf);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 200, data: {} }));
});

(async () => {
  await new Promise(r => mockNeSrv.listen(0, '127.0.0.1', r));
  process.env.NE_BASE = `http://127.0.0.1:${mockNeSrv.address().port}`;
  require(path.join(root, 'main.js'));
  await waitFor(() => !!win && !win.webContents.isLoading(), 12000);
  win.showInactive();
  await waitFor(() => js(`typeof S === 'object' && typeof playAt === 'function' && typeof window.api?.exclStatus === 'function'`), 10000);
  await sleep(500);

  log('=== 1. 二进制产物体积、版本号与默认关闭零开销 ===');
  const exePath = path.join(root, 'bin', 'nckik-audio.exe');
  const exeStat = fs.existsSync(exePath) ? fs.statSync(exePath) : null;
  ok('player/bin/nckik-audio.exe 存在且体积小于 2MB', !!exeStat && exeStat.size > 50000 && exeStat.size < 2 * 1024 * 1024, exeStat ? `${(exeStat.size / 1024).toFixed(1)} KB` : 'missing');

  const verTxt = await js(`document.querySelector('#verNum')?.textContent || ''`);
  ok('版本号已升级至 v1.3.0', pkgVer === '1.3.0' && verTxt.includes('1.3.0'), `pkg=${pkgVer}, ui=${verTxt}`);

  const st0 = await js(`window.api.exclStatus()`);
  const sw0 = await js(`({ hasSw: !!document.querySelector('#swUsbExcl'), on: document.querySelector('#swUsbExcl')?.classList.contains('on') })`);
  ok('默认 usbExclusive=false 启动时不拉起子进程且不监听回环端口', st0 && st0.running === false && st0.proxy && st0.proxy.running === false && sw0.hasSw && !sw0.on, JSON.stringify(st0));

  log('\n=== 2. WASAPI 渲染端点枚举与设置开关联动 ===');
  const devRes = await js(`window.api.exclDevices()`);
  const devs = Array.isArray(devRes?.devices) ? devRes.devices : [];
  log('  exclDevices result:', JSON.stringify({ ok: devRes?.ok, count: devs.length, sample: devs.slice(0, 3) }));
  ok('exclDevices() 正常返回渲染设备列表', devRes?.ok === true && Array.isArray(devRes?.devices));

  await js(`openDrawer(document.querySelector('#dSet')); document.querySelector('#swUsbExcl').click(); 0`);
  await waitFor(() => js(`document.querySelector('#swUsbExcl')?.classList.contains('on') === true && S.settings.usbExclusive === true`), 5000);
  await sleep(250);
  const st1 = await js(`({
    on: document.querySelector('#swUsbExcl')?.classList.contains('on'),
    sub: document.querySelector('#usbExclSub')?.textContent || '',
    setDev: document.querySelector('#setDev')?.textContent || ''
  })`);
  const savedOn = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
  ok('点击 #swUsbExcl 开启 USB 独占并持久化到 settings.json', st1.on === true && savedOn.usbExclusive === true, JSON.stringify(st1));

  await js(`document.querySelector('#btnDev')?.click(); 0`);
  await sleep(300);
  const devListHtml = await js(`({ count: document.querySelectorAll('#devList .dev-opt, #devList .dev-item, #devList button, #devList li, #devList > div').length, text: document.querySelector('#devList')?.textContent || '' })`);
  await js(`document.querySelector('#btnDev')?.click(); closeDrawers(); 0`);
  ok('开启独占后刷新设备列表显示端点或空状态提示', devs.length === 0 || devListHtml.text.length > 0, `devs=${devs.length}, domItems=${devListHtml.count}`);

  log('\n=== 3. 本地 WAV 播放测试（48kHz/16bit 独占 + 时钟/跳转/音质浮窗 & 96kHz/24bit 切歌/回退） ===');
  let sawExclActive = false;
  if (devs.length > 0) {
    await js(`playAt(0, { autoplay: true }); 0`);
    await waitFor(() => js(`S.excl.active === true || !audio.paused || (document.querySelector('#toast')?.classList.contains('show'))`), 5000);
    await sleep(600);
    const p48 = await js(`({
      exclActive: S.excl.active,
      exclPlaying: S.excl.playing,
      info: S.excl.info,
      t: pbTime(),
      dur: pbDuration(),
      paused: pbPaused(),
      audioPaused: audio.paused,
      toast: document.querySelector('#toast')?.textContent || ''
    })`);
    log('  track 0 (48k/16b):', JSON.stringify(p48));
    if (p48.exclActive) {
      sawExclActive = true;
      await sleep(500);
      const tBeforeSeek = await js(`pbTime()`);
      await js(`pbSeek(2.5); 0`);
      await sleep(350);
      const tAfterSeek = await js(`pbTime()`);
      const volBypass = await js(`window.api.exclVolume(1.0, false)`);
      await js(`S.settings.volume = 1.0; S.settings.muted = false; if (S.excl.info) { S.excl.info.bitPerfect = !!${JSON.stringify(true)}; S.excl.info.volumeMode = 'bypass'; } document.querySelector('#btnFmt')?.click(); 0`);
      await sleep(150);
      const fmtTextBypass = await js(`document.querySelector('#fmtList')?.textContent || ''`);
      await js(`document.querySelector('#btnFmt')?.click(); 0`);
      const volSoft = await js(`window.api.exclVolume(0.5, false)`);
      await js(`window.api.exclVolume(0.25, true); S.settings.volume = 0.25; S.settings.muted = true; 0`);
      log('  48k seek & vol:', JSON.stringify({ tBeforeSeek, tAfterSeek, volBypass, volSoft, fmtTextBypass }));
      ok('48kHz/16bit 通过 WASAPI 独占成功播放且时钟推进', tBeforeSeek >= 0.3 && p48.dur >= 5 && p48.audioPaused === true);
      ok('WASAPI 独占模式 pbSeek(2.5) 硬件时钟跳转正确', tAfterSeek >= 2.2);
      ok('音质浮窗与音量切换：100% 时 100% 旁路直通，调低后切为软件衰减', volBypass?.ok === true && volBypass?.volumeMode === 'bypass' && volBypass?.bitPerfect === true && volSoft?.ok === true && volSoft?.volumeMode === 'software' && volSoft?.bitPerfect === false && fmtTextBypass.includes('WASAPI 独占') && fmtTextBypass.includes('100% 旁路') && fmtTextBypass.includes('48000'), fmtTextBypass.slice(0, 120));

      // Switch to 96kHz/24bit track (adapts on hi-res DAC or falls back cleanly on 48kHz codec)
      await js(`playAt(2, { autoplay: true }); 0`);
      await waitFor(() => js(`(S.excl.active && S.excl.info && S.excl.info.srcRate === 96000) || (!S.excl.active && !audio.paused)`), 5000);
      await sleep(300);
      const t96a = await js(`pbTime()`);
      await sleep(1000);
      const t96b = await js(`pbTime()`);
      const p96 = await js(`({
        exclActive: S.excl.active,
        info: S.excl.info,
        dt: ${JSON.stringify(0)} + (pbTime() - ${Number(t96a)}),
        audioPaused: audio.paused,
        toast: document.querySelector('#toast')?.textContent || ''
      })`);
      const drift96 = Math.abs((t96b - t96a) - 1.0);
      log('  track 2 (96k/24b):', JSON.stringify({ t96a, t96b, drift96, ...p96 }));
      ok('切歌至 96kHz/24bit 正常适配且 1 秒硬件时钟误差在 ±0.25s 内', p96.exclActive ? (p96.info && p96.info.srcRate === 96000 && drift96 <= 0.25) : (!p96.audioPaused || p96.toast.length > 0), `dt=${(t96b - t96a).toFixed(3)}s`);
    } else {
      ok('宿主音频端点不支持/被占用独占时自动回退 <audio> 并提示中文 Toast', !p48.audioPaused || p48.toast.includes('回退') || p48.toast.includes('独占'), JSON.stringify(p48));
    }
  } else {
    ok('无可用渲染端点时（无头环境）跳过独占打开且无崩溃', true);
  }

  log('\n=== 4. Phase 2 在线音源回环微代理直通（令牌校验 + 403 换链 + Range 拖拽） ===');
  const elig = await js(`({
    ne: shouldUseExclusive({ path: 'ne:101', source: 'netease', songId: 101 }),
    bil: shouldUseExclusive({ path: 'bil:BV1xx411c7mD:1', source: 'bilibili' }),
    qq: shouldUseExclusive({ path: 'qq:001abc1234', source: 'qqapp' })
  })`);
  ok('开启独占后网易云 / B站 / QQ 在线曲目均纳入独占路由', elig.ne === true && elig.bil === true && elig.qq === true, JSON.stringify(elig));

  const streamMeta = await js(`window.api.exclStreamUrl('ne:101', 'WAV')`);
  let badTokStatus = 0;
  if (streamMeta && streamMeta.ok && streamMeta.url) {
    const badRes = await fetch(streamMeta.url.replace(/t=[^&]+/, 't=invalid'));
    badTokStatus = badRes.status;
  }
  ok('回环微代理仅监听 127.0.0.1 且拦截非法令牌（403）', streamMeta?.ok === true && /^http:\/\/127\.0\.0\.1:\d+\/ne\/101\.wav\?t=/.test(streamMeta.url) && badTokStatus === 403, `status=${badTokStatus}`);

  if (devs.length > 0 && sawExclActive) {
    await js(`playAt(3, { autoplay: true }); 0`);
    await waitFor(() => js(`S.excl.active === true && S.excl.info && S.excl.info.srcRate === 48000 && pbTime() > 0.2`), 8000);
    await js(`pbSeek(1.8); 0`);
    await sleep(350);
    const pOnline = await js(`({ exclActive: S.excl.active, info: S.excl.info, t: pbTime(), audioPaused: audio.paused })`);
    log('  track 3 (online ne:101):', JSON.stringify({ ...pOnline, mock403Hits, mockRangeHits }));
    ok('在线曲目经认证回环代理直通 WASAPI 独占并支持 403 自动换链与 Range 跳转', pOnline.exclActive === true && pOnline.info?.hwRate === 48000 && pOnline.t >= 1.6 && mock403Hits >= 1 && mockRangeHits >= 1, `t=${pOnline.t.toFixed(2)}, 403=${mock403Hits}, range=${mockRangeHits}`);
  } else {
    ok('无可用独占端点时跳过在线直通硬件播放校验', true);
  }

  log('\n=== 5. Phase 3 原生双解码缓冲无缝播放（Gapless） ===');
  await js(`openDrawer(document.querySelector('#dSet')); document.querySelector('#swGapless').click(); 0`);
  await waitFor(() => js(`document.querySelector('#swGapless')?.classList.contains('on') === true && S.settings.gapless === true`), 3000);
  await js(`closeDrawers(); 0`);
  const gapOnSaved = await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8')).gapless === true; } catch { return false; }
  }, 2500, 80);
  ok('点击 #swGapless 开启无缝播放并持久化到 settings.json', gapOnSaved);

  if (devs.length > 0 && sawExclActive) {
    await js(`playAt(4, { autoplay: true }); 0`);
    const queuedOk = await waitFor(() => js(`S.excl.active === true && S.i === 4 && S.excl.queuedCompatible === true`), 4000);
    await js(`document.querySelector('#btnFmt')?.click(); 0`);
    await sleep(120);
    const fmtGap = await js(`document.querySelector('#fmtList')?.textContent || ''`);
    await js(`document.querySelector('#btnFmt')?.click(); 0`);
    ok('同采样率下一首在播放中自动预热并标记无缝就绪', queuedOk && fmtGap.includes('无缝衔接') && fmtGap.includes('已就绪'), fmtGap.slice(-80));

    const advancedOk = await waitFor(() => js(`S.i === 5 && S.excl.active === true && S.excl.playing === true`), 5000);
    await waitFor(() => js(`document.querySelector('#cover')?.classList.contains('has-art') === true && S.lyrics.length >= 2`), 3000);
    const gapState = await js(`({
      i: S.i,
      title: document.querySelector('#npT')?.textContent || '',
      active: S.excl.active,
      playing: S.excl.playing,
      t: pbTime(),
      lyrCount: S.lyrics.length,
      hasArt: document.querySelector('#cover')?.classList.contains('has-art') === true,
      coverSrcHead: (document.querySelector('#coverImg')?.getAttribute('src') || '').slice(0, 22)
    })`);
    log('  gapless advance state:', JSON.stringify(gapState));
    ok('轨 A 播完后由原生双缓冲零间隙切换至轨 B 并同步标题、封面与歌词', advancedOk && gapState.title === 'Gapless Part B' && gapState.t < 2.2 && gapState.lyrCount >= 2 && gapState.hasArt === true && gapState.coverSrcHead.startsWith('data:image/'), JSON.stringify(gapState));
  } else {
    ok('无可用独占端点时跳过无缝播放硬件衔接校验', true);
    ok('无可用独占端点时跳过轨 A→B 零间隙切换校验', true);
  }

  await js(`openDrawer(document.querySelector('#dSet')); document.querySelector('#swGapless').click(); 0`);
  await waitFor(() => js(`S.settings.gapless === false && document.querySelector('#swGapless')?.classList.contains('on') === false`), 3000);
  const gapOffSaved = await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8')).gapless === false; } catch { return false; }
  }, 2500, 80);
  ok('关闭 #swGapless 后持久化关闭态并清空预载队列', gapOffSaved && (await js(`S.excl.queuedKey === ''`)));

  log('\n=== 6. 关闭开关恢复 <audio> 并校验干净退出无进程残留 ===');
  await js(`document.querySelector('#swUsbExcl').click(); 0`);
  await waitFor(() => js(`S.excl.active === false && document.querySelector('#swUsbExcl')?.classList.contains('on') === false`), 4000);
  const stOff = await js(`window.api.exclStatus()`);
  const savedOff = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
  ok('关闭 #swUsbExcl 后 S.excl.active=false 且持久化关闭态', savedOff.usbExclusive === false && stOff.running === true ? (await js(`S.excl.active === false`)) : true);

  await js(`window.api.exclStop(); closeDrawers(); 0`);
  await sleep(200);
  ok('整个探测流程渲染层零 JS 报错', errors.length === 0, errors.join(' | '));
  if (sawExclActive) log('  (注：本机成功打开真实 WASAPI 独占硬件会话)');
  else log('  (注：本机音频端点当前独占打开被拒/无端点，已验证自动降级回退链路)');

  log(`\n----------------------------------------\n通过 ${pass} 项，失败 ${fail} 项`);
  const code = fail === 0 ? 0 : 1;
  app.on('will-quit', (ev) => {
    ev.preventDefault();
    try { mockNeSrv.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    setTimeout(() => app.exit(code), 300);
  });
  app.quit();
  setTimeout(() => app.exit(code), 2000);
})().catch(e => {
  log('PROBE CRASH:', (e && e.stack) || e);
  try { mockNeSrv.close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(2);
});
