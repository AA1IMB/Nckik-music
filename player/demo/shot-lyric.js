'use strict';
/**
 * 截图脚本：逐字填充条 + 间奏「…」占位（不属于项目代码）
 * ---------------------------------------------------------------------------
 * 造一首「第 1 句很短、第 2 句很晚」的本地曲目：
 *   第 1 句 5 个字，单字时长被 MAX_CH(1.4s) 截断 → 7.0s 就唱完，第 2 句 10.0s 才来，
 *   中间 3 秒空档正好展示「…」；第 2 句有 19 个字，用来展示字与字之间的填充差异。
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
process.env.NCKIK_SKIP_MIGRATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ymp-shotlyr-'));
app.setPath('userData', tmp);

const media = path.join(tmp, 'media');
fs.mkdirSync(media, { recursive: true });
const wav = path.join(media, 'lyric.wav');
fs.copyFileSync(path.join(root, 'demo', 'demo.wav'), wav);
// 同名封面：没有封面时主色会退成中性灰，填充色与未填色几乎一样，截图看不出效果
fs.copyFileSync(path.join(root, 'demo', 'demo.png'), path.join(media, 'lyric.png'));
fs.writeFileSync(path.join(media, 'lyric.lrc'), [
  '[ti:逐字填充]',
  '[00:00.00]这一句很短',
  '[00:10.00]第二句出现得很晚用来验证占位',
  '[00:30.00]最后一句'
].join('\n'), 'utf8');
const st = fs.statSync(wav);
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify([{
  path: wav, title: '逐字填充', artist: '本地', album: '演示', duration: 42,
  codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 1411200, lossless: true,
  hasCover: false, hasLyric: true, mtime: st.mtimeMs, size: st.size, addedAt: Date.now()
}], null, 2));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ theme: 'dark', volume: 0, muted: true, repeat: 'all', globalKeys: false }));

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

  const shot = async (t, file, note) => {
    await js(`(() => { audio.pause(); audio.currentTime = ${t}; })()`);
    await sleep(700);
    const info = await js(`(() => {
      const i = S.lastLy, n = i >= 0 ? S.lnNodes[i] : null;
      return {
        t: +audio.currentTime.toFixed(2), i,
        waiting: !!(n && n.classList.contains('waiting')),
        ps: n ? [...n.querySelectorAll('.ch')].map(s => Math.round(parseFloat(s.style.getPropertyValue('--p')) || 0)) : []
      };
    })()`);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(root, 'demo', file), img.toPNG());
    log(note, JSON.stringify(info));
  };

  // 第 2 句里第 6 个字唱到一半
  const mid = await js(`(() => {
    const c = S.lyrics[1].chars[5];
    return +(c.t0 + (c.t1 - c.t0) * 0.55).toFixed(3);
  })()`);
  await shot(mid, 'shot-lyric-fill.png', 'fill');

  // 第 1 句唱完、第 2 句还没来
  await shot(8.2, 'shot-lyric-gap.png', 'gap');

  app.quit();
})().catch(e => { console.error('SHOT CRASH', e); app.quit(); });
