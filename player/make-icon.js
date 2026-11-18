/*
 * 生成应用图标：build/icon.png（512×512 RGBA）+ build/icon-preview.png（多尺寸预览）
 *   node make-icon.js
 *
 * 设计：白底圆角方块 + 一笔画完的红色音符。
 *   - 整枚图案只有一条连续路径：起于符尾（旗），下行成符干，再绕成符头闭环，
 *     全程不提笔，因此线宽、端点、转角处处一致；
 *   - 白底 + 单一红色（#E23A2E），无渐变、无阴影，缩到 16px 仍能认出是音符；
 *   - 端点与转角都是圆的（round cap / round join），小尺寸下不会出现尖角发虚。
 * 只依赖 zlib 手写 PNG，不引图形库。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const outDir = path.join(__dirname, 'build');
fs.mkdirSync(outDir, { recursive: true });

const RED = [0xE2, 0x3A, 0x2E];
/* 设计网格：1000×1000 的抽象坐标，路径与笔宽都在同一套单位里，
 * 最后整体（含笔宽）缩到画布上 —— 这样任何尺寸下形状比例都不变。
 * 早先是「笔宽按画布比例、路径按包围盒缩放」，结果符头的小环被笔宽糊成了实心。 */
const DESIGN_STROKE = 56;   // 设计单位下的笔宽
const BOX = 0.60;           // 图案（含笔宽）占图标边长的比例
const RADIUS = 0.225;       // 圆角半径

/* ---------------- PNG 编码（RGBA） ---------------- */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = buf => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
};
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    raw[row] = 0;                       // filter: none
    rgba.copy(raw, row + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 一笔画路径（设计单位，顺序即运笔顺序） ---------------- */
function buildStroke() {
  const pts = [];
  // 1) 符尾：自右上起笔（起笔处接近水平），一路向左下扫到符干顶端
  const p0 = [672, 196], c = [586, 158], p1 = [400, 300];
  for (let i = 0; i <= 90; i++) {
    const t = i / 90, u = 1 - t;
    pts.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
      u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
  // 2) 符干：直落
  const bottom = [400, 660];
  for (let i = 1; i <= 60; i++) {
    const t = i / 60;
    pts.push([p1[0] + (bottom[0] - p1[0]) * t, p1[1] + (bottom[1] - p1[1]) * t]);
  }
  // 3) 符头：圆弧经过符干末端，圆心在末端的「左下」（屏幕坐标 y 向下，故 +sin）。
  //    从末端那一点起顺时针绕满一圈，全程不抬笔。
  //    圆心方向很关键：放到右上方，符头的环会挂在符干右侧，整枚图案立刻读成「b/6」。
  const R = 106;
  const phi = Math.PI * 0.75;                     // 末端 → 圆心：左下 135°
  const cx = bottom[0] + R * Math.cos(phi);
  const cy = bottom[1] + R * Math.sin(phi);
  const aStart = phi - Math.PI;                   // 圆上「指回末端」的那个角度
  const steps = 180;
  for (let i = 1; i <= steps; i++) {
    const a = aStart - (Math.PI * 2 * i) / steps; // 顺时针闭环
    pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  return pts;
}

/* 等比缩放到画布中央。包围盒按「路径 + 半个笔宽」算，保证视觉重心真的居中 */
function fitStroke(pts, size) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const grow = DESIGN_STROKE / 2;
  const bw = (maxX - minX) + DESIGN_STROKE;
  const bh = (maxY - minY) + DESIGN_STROKE;
  const scale = (BOX * size) / Math.max(bw, bh);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return {
    pts: pts.map(([x, y]) => [size / 2 + (x - cx) * scale, size / 2 + (y - cy) * scale]),
    // 笔宽跟着同一比例缩放；小尺寸下不低于 1.1px，否则 16px 会整体消失
    half: Math.max(0.55, (DESIGN_STROKE * scale) / 2),
    grow
  };
}

/* 沿线每 0.35px 盖一个圆盘 = 圆头加粗笔画；天然抗锯齿，也不会出现点间缝隙 */
function stamp(cover, pts, half, size) {
  const R = half + 0.6;
  for (const [x, y] of pts) {
    const x0 = Math.max(0, Math.floor(x - R)), x1 = Math.min(size - 1, Math.ceil(x + R));
    const y0 = Math.max(0, Math.floor(y - R)), y1 = Math.min(size - 1, Math.ceil(y + R));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const a = Math.min(1, Math.max(0, R - Math.hypot(px + 0.5 - x, py + 0.5 - y)));
        const i = py * size + px;
        if (a > cover[i]) cover[i] = a;
      }
    }
  }
}

function densify(pts, stepPx) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / stepPx));
    for (let k = 1; k <= n; k++) out.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
  }
  return out;
}

/* 画一枚图标，返回 RGBA buffer（不做 PNG 编码，预览图直接用） */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = RADIUS * size;

  // 1) 白底圆角方块 + 极淡描边（纯白无边界，贴在白色窗口上会「消失」）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.abs(x + 0.5 - size / 2) - (size / 2 - r);
      const dy = Math.abs(y + 0.5 - size / 2) - (size / 2 - r);
      const sd = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
      const a = Math.min(1, Math.max(0, 0.5 - sd));
      const edge = sd > -Math.max(1, size * 0.006) ? 0.07 : 0;
      const v = Math.round(255 * (1 - edge));
      const i = (y * size + x) * 4;
      rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v;
      rgba[i + 3] = Math.round(255 * a);
    }
  }

  // 2) 红色笔画
  const fit = fitStroke(buildStroke(), size);
  const cover = new Float32Array(size * size);
  // 采样步长跟着缩放走：画布越小，点越稀，但仍保证点间无缝
  stamp(cover, densify(fit.pts, Math.max(0.25, fit.half / 12)), fit.half, size);
  for (let i = 0; i < size * size; i++) {
    const a = Math.min(1, cover[i]);
    if (a <= 0) continue;
    const o = i * 4;
    if (rgba[o + 3] === 0) continue;                 // 圆角外不着色
    rgba[o] = Math.round(rgba[o] * (1 - a) + RED[0] * a);
    rgba[o + 1] = Math.round(rgba[o + 1] * (1 - a) + RED[1] * a);
    rgba[o + 2] = Math.round(rgba[o + 2] * (1 - a) + RED[2] * a);
  }
  return rgba;
}

/* ---------------- 输出 ---------------- */
fs.writeFileSync(path.join(outDir, 'icon.png'), encodePng(512, 512, drawIcon(512)));
console.log('icon    →', path.join(outDir, 'icon.png'));

/* 多尺寸预览：16 / 24 / 32 / 48 / 64 / 96 / 128 / 256 排成一行，底对齐 */
const sizes = [16, 24, 32, 48, 64, 96, 128, 256];
const pad = 18, H = 256 + pad * 2;
const W = sizes.reduce((s, v) => s + v + pad, pad);
const canvas = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  canvas[i * 4] = 0xf1; canvas[i * 4 + 1] = 0xf1; canvas[i * 4 + 2] = 0xf5; canvas[i * 4 + 3] = 255;
}
let cursor = pad;
for (const s of sizes) {
  const src = drawIcon(s);
  const oy = pad + (256 - s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const si = (y * s + x) * 4, di = ((oy + y) * W + cursor + x) * 4;
      const a = src[si + 3] / 255;
      for (let k = 0; k < 3; k++) canvas[di + k] = Math.round(canvas[di + k] * (1 - a) + src[si + k] * a);
    }
  }
  cursor += s + pad;
}
fs.writeFileSync(path.join(outDir, 'icon-preview.png'), encodePng(W, H, canvas));
console.log('preview →', path.join(outDir, 'icon-preview.png'));
