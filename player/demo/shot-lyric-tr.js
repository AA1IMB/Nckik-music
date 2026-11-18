'use strict';
/**
 * 截图脚本：歌词中文翻译（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 造一首「英文原文 + 旁挂 .zh.lrc 译文」的本地曲目，第三句故意很长，
 * 用来同时看：译文在原文下方的次级样式、长句换行、以及关掉开关后的样子。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-shotlyrtr-'));
app.setPath('userData', tmp);

const media = path.join(tmp, 'media');
fs.mkdirSync(media, { recursive: true });
const wav = path.join(media, 'translate.wav');
fs.copyFileSync(path.join(root, 'demo', 'demo.wav'), wav);
// 同名封面：主色由封面取，没封面会退成中性灰，填充对比看不出来
fs.copyFileSync(path.join(root, 'demo', 'demo.png'), path.join(media, 'translate.png'));
fs.writeFileSync(path.join(media, 'translate.lrc'), [
  '[ti:Translation]',
  '[00:00.00]I keep the light on',
  '[00:09.00]And the city keeps on breathing without me',
  '[00:20.00]Short',
  '[00:30.00]Last line'
].join('\n'), 'utf8');
fs.writeFileSync(path.join(media, 'translate.zh.lrc'), [
  '[00:00.00]我一直留着那盏灯',
  '[00:09.00]整座城市在我之外继续呼吸，而我只是站在窗前听着远处的车流声',
  '[00:20.00]短',
  '[00:30.00]最后一句'
].join('\n'), 'utf8');
const st = fs.statSync(wav);
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify([{
  path: wav, title: 'Translation', artist: '本地', album: '演示', duration: 42,
  codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true,
  hasCover: false, hasLyric: true, mtime: st.mtimeMs, size: st.size, addedAt: Date.now()
}], null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'),
  JSON.stringify({ theme: 'dark', volume: 0, muted: true, repeat: 'all', globalKeys: false, lyricTrans: true }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));

let win = null;
app.on('browser-window-created', (_e, w) => { win = w; });
const js = c => win.webContents.executeJavaScript(c, true);

(async () => {
  require(path.join(root, 'main.js'));
  while (!win || win.webContents.isLoading()) await sleep(100);
  for (let i = 0; i < 100 && !(await js('S.tracks.length')); i++) await sleep(100);
  await js('playIndex(0)');
  for (let i = 0; i < 150 && !(await js('S.lyrics.length')); i++) await sleep(100);
  await sleep(500);

  const info = `(() => {
    const i = S.lastLy;
    const n = i >= 0 ? S.lnNodes[i] : null;
    const tr = n ? n.querySelector('.tr') : null;
    return {
      t: +audio.currentTime.toFixed(2),
      i,
      text: i >= 0 ? S.lyrics[i].text : null,
      tr: tr ? tr.textContent : null,
      trH: tr ? tr.offsetHeight : null,
      noTr: document.body.classList.contains('no-tr'),
      ps: n ? [...n.querySelectorAll('.ch')].map(s => Math.round(parseFloat(s.style.getPropertyValue('--p')) || 0)) : []
    };
  })()`;

  const shot = async (t, file) => {
    await js(`(() => { audio.pause(); audio.currentTime = ${t}; })()`);
    await sleep(700);
    const d = await js(info);
    fs.writeFileSync(path.join(root, 'demo', file), (await win.webContents.capturePage()).toPNG());
    log(file.replace('.png', ''), JSON.stringify(d));
  };

  // 第二句唱到一半：原文在逐字填，译文整行已经显示
  const mid = await js(`(() => {
    const c = S.lyrics[1].chars[12];
    return +(c.t0 + (c.t1 - c.t0) * 0.5).toFixed(3);
  })()`);
  await shot(mid, 'shot-lyric-tr.png');

  // 同一个位置把翻译关掉：译文消失，原文与进度不受影响
  await js(`document.querySelector('#swTr').click()`);
  await sleep(500);
  await shot(mid, 'shot-lyric-tr-off.png');

  app.quit();
})().catch(e => { console.error('SHOT CRASH', e); app.quit(); });
