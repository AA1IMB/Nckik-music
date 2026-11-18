const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const dir = path.join(__dirname, 'demo');
fs.mkdirSync(dir, { recursive: true });

/* ---------- 1. WAV ---------- */
function writeWav(file, seconds = 42, sr = 44100) {
  const n = sr * seconds;
  const data = Buffer.alloc(n * 2);
  const notes = [110, 164.81, 220, 277.18, 329.63];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    notes.forEach((f, k) => {
      s += Math.sin(2 * Math.PI * f * t + k) * (0.30 / (1 + k * 0.9));
      s += Math.sin(2 * Math.PI * f * 2 * t) * (0.03 / (1 + k));
    });
    const env = Math.min(1, t / 2.5) * Math.min(1, (seconds - t) / 3.5);
    const trem = 0.62 + 0.38 * Math.sin(2 * Math.PI * 0.11 * t);
    s = Math.tanh(s * 1.6) * env * trem * 0.62;
    data.writeInt16LE(Math.max(-32000, Math.min(32000, Math.round(s * 32000))), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sr, 24);
  head.writeUInt32LE(sr * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
  console.log('wav', file, (36 + data.length) / 1048576, 'MB');
}

/* ---------- 2. PNG（无依赖编码器） ---------- */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function writePng(file, w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      const o = row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
  console.log('png', file, (png.length / 1024).toFixed(0) + 'KB');
}

const W = 600, H = 600;
const lerp = (a, b, t) => a + (b - a) * t;
function px(x, y) {
  const u = x / W, v = y / H;
  const t = Math.min(1, Math.max(0, (u * 0.62 + v * 0.78)));
  let r = lerp(0x7a, 0x2a, t), g = lerp(0x56, 0x1b, t), b = lerp(0xff, 0x7a, t);
  // 左上大圆
  const d1 = Math.hypot(x - W * 0.26, y - H * 0.34) / (W * 0.44);
  if (d1 < 1) {
    const a = (1 - d1) * 0.30;
    r = lerp(r, 246, a); g = lerp(g, 240, a); b = lerp(b, 255, a);
  }
  // 右下小圆
  const d2 = Math.hypot(x - W * 0.78, y - H * 0.74) / (W * 0.30);
  if (d2 < 1) {
    const a = (1 - d2) * 0.34;
    r = lerp(r, 26, a); g = lerp(g, 16, a); b = lerp(b, 64, a);
  }
  // 顶部高光
  const d3 = Math.hypot(x - W * 0.18, y - H * 0.06) / (W * 0.62);
  if (d3 < 1) {
    const a = (1 - d3) * 0.16;
    r = lerp(r, 255, a); g = lerp(g, 255, a); b = lerp(b, 255, a);
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
}

writePng(path.join(dir, 'demo.png'), W, H, px);
writeWav(path.join(dir, 'demo.wav'));

/* ---------- 3. LRC ---------- */
const lrc = `[ti:示例音轨]
[ar:本地生成]
[al:演示素材]
[offset:0]
[00:01.20]这是一段本地生成的测试音频
[00:08.60]用来验证进度条与歌词同步
[00:15.80]你可以把真实音乐拖进这个窗口
[00:23.00]同目录放一个同名 .lrc 就会自动加载
[00:30.40]封面放在同目录 cover.jpg 也能识别
[00:37.00]点歌词任意一行可以直接跳转
`;
fs.writeFileSync(path.join(dir, 'demo.lrc'), lrc, 'utf8');

/* ---------- 4. 预置曲库 ---------- */
const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
const userDir = path.join(appData, 'yun-music-player');
fs.mkdirSync(userDir, { recursive: true });
const wavPath = path.join(dir, 'demo.wav').replace(/\\/g, '\\');
fs.writeFileSync(path.join(userDir, 'library.json'), JSON.stringify([{
  path: path.join(dir, 'demo.wav'),
  title: '示例音轨', artist: '本地生成', album: '演示素材',
  duration: 42, codec: 'WAV', sampleRate: 44100, bitDepth: 16, bitrate: 705600, lossless: true
}], null, 2), 'utf8');
fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify({
  theme: 'dark', volume: 0.78, shuffle: false, repeat: 'all', sinkId: '', muted: false,
  lat: 31.2304, lon: 121.4737, city: '上海', globalKeys: true
}, null, 2), 'utf8');
console.log('seeded', userDir);
