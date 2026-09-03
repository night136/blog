// 生成默认 OG 分享封面图 assets/og-default.png（1200x630，社交平台标准尺寸）
// 纯 Node 实现（zlib + 手写 PNG 编码），零依赖、不消耗任何额度。
// 风格对齐博客：暖米色底 + 橙色点缀 + 便签卡片，2x 超采样抗锯齿。
//
// 用法：node scripts/generate-og-image.mjs
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const W = 1200, H = 630, SS = 2; // SS = 超采样倍数
const w = W * SS, h = H * SS;

const px = Buffer.alloc(w * h * 3);
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

const BG = hex("#FAF6EF");
const C_BIG = hex("#F3E3CE");
const C_ORANGE = hex("#E89B4C");
const C_LIGHT = hex("#FFD9A8");
const C_CARD = hex("#FFFDF8");
const C_EDGE = hex("#E4D7C3");

function set(x, y, c) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 3;
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
}
function fill(c) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, c);
}
function circle(cx, cy, r, c) {
  const r2 = r * r;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) set(x, y, c);
    }
  }
}
function roundRect(x0, y0, x1, y1, r, c) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      const dx = Math.min(x - x0, x1 - x);
      const dy = Math.min(y - y0, y1 - y);
      if (dx < r && dy < r) {
        const ex = r - dx, ey = r - dy;
        if (ex * ex + ey * ey > r * r) continue;
      }
      set(x, y, c);
    }
  }
}
function ringRect(x0, y0, x1, y1, r, c, t) {
  roundRect(x0, y0, x1, y1, r, c);
  roundRect(x0 + t, y0 + t, x1 - t, y1 - t, Math.max(0, r - t), [0, 0, 0]);
}

fill(BG);

// 右下大圆（浅橙）
circle(1120 * SS / SS * SS, 600 * SS / SS * SS, 300 * SS, C_BIG);
// 右上橙圆
circle(1010 * SS, 105 * SS, 130 * SS, C_ORANGE);
// 左上小浅橙圆
circle(150 * SS, 96 * SS, 54 * SS, C_LIGHT);
// 底部一条橙色横带（视觉压边）
roundRect(0, (H - 14) * SS, W * SS, H * SS, 0, C_ORANGE);

// 三张"便签卡片"（呼应留言墙），带描边
const cards = [
  [150, 235, 420, 500],
  [452, 268, 690, 500],
  [722, 215, 985, 500],
];
cards.forEach(([x0, y0, x1, y1]) => {
  ringRect(x0 * SS, y0 * SS, x1 * SS, y1 * SS, 16 * SS, C_EDGE, 2 * SS);
  roundRect((x0 + 2) * SS, (y0 + 2) * SS, (x1 - 2) * SS, (y1 - 2) * SS, 14 * SS, C_CARD);
});

// 卡片上的"文字横线"（示意内容，不是真文字，避免字体渲染）
const lineColor = hex("#E0D3BE");
cards.forEach(([x0, y0, x1], i) => {
  const rows = [0, 1, 2, 3].slice(0, 4 - (i % 2));
  rows.forEach((r) => {
    const ly = (y0 + 46 + r * 46) * SS;
    const lw = ((x1 - x0 - 74) * (r % 2 ? 0.72 : 1)) * SS;
    roundRect((x0 + 34) * SS, ly, (x0 + 34) * SS + lw, ly + 12 * SS, 6 * SS, lineColor);
  });
  // 卡片顶部小圆点（模拟图钉）
  circle(((x0 + x1) / 2) * SS, (y0 + 22) * SS, 9 * SS, C_ORANGE);
});

// ---- 下采样（2x 平均）----
const out = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const i = ((y * SS + dy) * w + (x * SS + dx)) * 3;
        r += px[i]; g += px[i + 1]; b += px[i + 2];
      }
    }
    const n = SS * SS;
    const o = (y * W + x) * 3;
    out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
  }
}

// ---- PNG 编码 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit RGB
const raw = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0; // filter: None
  out.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(here, "..", "assets", "og-default.png");
fs.writeFileSync(dest, png);
console.log(`✅ 已生成 ${dest}  (${W}x${H}, ${(png.length / 1024).toFixed(1)} KB)`);
