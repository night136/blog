// 守护头像素材的「位图级」不变量：**图案必须居中、底圈必须等宽**。
//
// 为什么需要它
// ------------
// 2026-09-16 线上实测：首页两个头像四周的奶油底圈明显不匀（72px 时上 6.4 / 下 14.4，
// 下方是上方的 2.3 倍）。原因是素材 `assets/logo-*.png` 是一张 183×130 的**非正方形**
// 图，图案（94px 圆盘）在其中偏上偏右，而 CSS 是 `object-fit: cover` + `border-radius:50%`
// —— cover 会左右裁掉、上下不裁，偏移就被原样带进了圆盒。
//
// 这类问题**任何「查 CSS 里有没有写对」的断言都抓不到**：样式完全正确，错的是位图内容。
// 所以这里必须真的解码 PNG、量图案的实际包围盒。Node 没有内置图像解码，本文件内置了
// 一个最小 PNG 解码器（zlib + 反滤波），保持零依赖。
//
// 断言的是**不变量**（居中、等宽、正方形），不是设计选择：
// 底圈该多宽是审美问题（改 `--disc-ratio` 即可），所以只做「区间」断言，不钉死数值。
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? "  ← " + detail : ""}`); }
};

// ── 最小 PNG 解码器（8bit，colorType 0/2/3/6，非隔行）─────────────────────────
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(path) {
  const buf = readFileSync(path);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("不是 PNG（签名不符）");
  let off = 8, ihdr = null, plte = null, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], color: data[9], interlace: data[12],
      };
    } else if (type === "PLTE") plte = Buffer.from(data);
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error("缺少 IHDR");
  if (ihdr.interlace) throw new Error("不支持隔行 PNG");
  if (ihdr.depth !== 8) throw new Error(`只支持 8bit/通道，当前 ${ihdr.depth}bit`);
  const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color];
  if (!CH) throw new Error(`不支持的颜色类型 ${ihdr.color}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * CH;
  const out = Buffer.alloc(stride * ihdr.height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.height; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= CH ? cur[i - CH] : 0;
      const b = prev[i];
      const c = i >= CH ? prev[i - CH] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (ft !== 0) throw new Error(`未知滤波类型 ${ft}`);
      cur[i] = v & 0xff;
    }
    prev = cur;
  }

  // 统一展开成 RGB
  const rgb = Buffer.alloc(ihdr.width * ihdr.height * 3);
  for (let i = 0, n = ihdr.width * ihdr.height; i < n; i++) {
    const s = i * CH;
    let r, g, b;
    if (ihdr.color === 0 || ihdr.color === 4) { r = g = b = out[s]; }
    else if (ihdr.color === 2 || ihdr.color === 6) { r = out[s]; g = out[s + 1]; b = out[s + 2]; }
    else { const p = out[s] * 3; r = plte[p]; g = plte[p + 1]; b = plte[p + 2]; }
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
  }
  return { width: ihdr.width, height: ihdr.height, rgb };
}

// ── 图案包围盒：与底色差得够远的像素 ─────────────────────────────────────────
// TOL=18 的来历：素材底圈的奶油色 (253,245,236) 与圆环外的白 (254,254,254) 只差 18，
// 所以圆环外那 1px 白边不会被算成「图案」——正好只框住真正的图案（黑环）。
const TOL = 18;

export function contentBBox(img) {
  const { width: w, height: h, rgb } = img;
  const px = (x, y) => [rgb[(y * w + x) * 3], rgb[(y * w + x) * 3 + 1], rgb[(y * w + x) * 3 + 2]];
  const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
  // 四角众数色当底色（防某一角有杂点）
  const key = (c) => c.join(",");
  const count = new Map();
  for (const c of corners) count.set(key(c), (count.get(key(c)) || 0) + 1);
  const bg = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
  let l = w, t = h, r = -1, b = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3;
      const d = Math.max(Math.abs(rgb[s] - bg[0]), Math.abs(rgb[s + 1] - bg[1]), Math.abs(rgb[s + 2] - bg[2]));
      if (d > TOL) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; }
    }
  }
  return { bg, l, t, r: r + 1, b: b + 1, found: r >= 0 };
}

/** 判定「图案居中且底圈等宽」。返回量出来的数字，供断言与报告共用。 */
export function geometry(img) {
  const bb = contentBBox(img);
  if (!bb.found) return { ok: false, reason: "整张图都是底色，没找到图案", bb };
  const gaps = {
    left: bb.l, top: bb.t,
    right: img.width - bb.r, bottom: img.height - bb.b,
  };
  const disc = { w: bb.r - bb.l, h: bb.b - bb.t };
  const cx = (bb.l + bb.r) / 2, cy = (bb.t + bb.b) / 2;
  return {
    ok: true, bb, gaps, disc,
    square: img.width === img.height,
    offset: { x: cx - img.width / 2, y: cy - img.height / 2 },
    asym: {
      lr: Math.abs(gaps.left - gaps.right),
      tb: Math.abs(gaps.top - gaps.bottom),
    },
    discRatio: (disc.w / img.width + disc.h / img.height) / 2,
    gapMean: (gaps.left + gaps.top + gaps.right + gaps.bottom) / 4,
  };
}

// 允许的偏差：包围盒按整数像素取，且图案边缘有抗锯齿，1~2px 的量化误差属正常。
const CENTER_TOL = 2;      // 「图案中心 vs 画布中心」偏移上限（px）
const ASYM_TOL = 3;        // 「对边留白之差」上限（px）

/** 对任意 RGB 位图跑同一套判据，便于用合成样本做正/负向自证。 */
export function judge(img) {
  const g = geometry(img);
  if (!g.ok) return { pass: false, g, why: g.reason };
  const why = [];
  if (!g.square) why.push(`不是正方形（${img.width}×${img.height}）—— cover 会单方向裁切`);
  if (Math.abs(g.offset.x) > CENTER_TOL || Math.abs(g.offset.y) > CENTER_TOL) {
    why.push(`图案中心偏离画布中心 (${g.offset.x.toFixed(1)}, ${g.offset.y.toFixed(1)})px`);
  }
  if (g.asym.lr > ASYM_TOL || g.asym.tb > ASYM_TOL) {
    why.push(`底圈不等宽（左右差 ${g.asym.lr}px，上下差 ${g.asym.tb}px）`);
  }
  if (g.gapMean < 3) why.push(`底圈几乎没有留白（平均 ${g.gapMean.toFixed(1)}px），图案贴边`);
  if (g.discRatio < 0.5 || g.discRatio > 0.98) why.push(`图案占盒 ${(100 * g.discRatio).toFixed(1)}%，超出合理区间`);
  return { pass: why.length === 0, g, why };
}

// ── 合成样本：证明判据不是「恒绿」也不是「恒红」─────────────────────────────
export function synth({ w = 120, h = w, disc = 86, offsetX = 0, offsetY = 0, bg = [253, 245, 236], fg = [20, 20, 20] } = {}) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = bg[0]; rgb[i * 3 + 1] = bg[1]; rgb[i * 3 + 2] = bg[2]; }
  const x0 = Math.round((w - disc) / 2 + offsetX), y0 = Math.round((h - disc) / 2 + offsetY);
  for (let y = y0; y < y0 + disc; y++)
    for (let x = x0; x < x0 + disc; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const s = (y * w + x) * 3;
      rgb[s] = fg[0]; rgb[s + 1] = fg[1]; rgb[s + 2] = fg[2];
    }
  return { width: w, height: h, rgb };
}

function main() {
  console.log("[1] 素材不变量：正方形 + 图案居中 + 底圈等宽");
  const files = ["assets/logo-avatar.png", "assets/logo-hero.png"];
  for (const rel of files) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) { check(`${rel} 存在`, false, "文件缺失"); continue; }
    let img, j;
    try { img = decodePng(abs); j = judge(img); }
    catch (e) { check(`${rel} 可解码`, false, e.message); continue; }
    const g = j.g;
    const detail = j.pass ? "" :
      `${j.why.join("；")}  →  重新生成：python scripts/build-avatar-asset.py`;
    check(`${rel} ${img.width}×${img.height}  图案居中（偏移 ${g.offset.x.toFixed(1)}, ${g.offset.y.toFixed(1)}px）`
      + `  底圈 ${g.gaps.left}/${g.gaps.top}/${g.gaps.right}/${g.gaps.bottom}px`
      + `  图案占盒 ${(100 * g.discRatio).toFixed(1)}%`, j.pass, detail);
  }

  console.log("\n[2] 判据自证：合成样本必须正负分明（不是恒真/恒假）");
  check("自证：正方画布 + 居中图案 + 等宽底圈 → 判绿",
    judge(synth()).pass === true);
  check("负向自检：图案**居中但画布非正方形**必须判红（这正是旧素材 183×130 的病历）",
    judge(synth({ w: 150, h: 120, disc: 86 })).pass === false);
  check("负向自检：图案横向偏移 6px 必须判红（cover 会把偏移原样带进圆盒）",
    judge(synth({ offsetX: 6 })).pass === false);
  check("负向自检：图案纵向偏移 6px 必须判红",
    judge(synth({ offsetY: 6 })).pass === false);
  check("负向自检：图案贴边（无底圈）必须判红",
    judge(synth({ w: 120, h: 120, disc: 119 })).pass === false);

  console.log("\n[3] 换图后必须能刷掉缓存（/assets/* 是 max-age=86400 + swr=604800）");
  const bm = readFileSync(join(ROOT, "build.mjs"), "utf8");
  check("build.mjs 的 hashAssets() 给两个 logo 都加了 ?v=",
    /logo-avatar\.png/.test(bm) && /logo-hero\.png/.test(bm) && /assets\/\$\{name\}\?v=/.test(bm),
    "没注入 ?v= 的话，用户会继续看到旧头像（最长一天）");
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  check("index.html 用固定文件名引用 logo（不玩哈希文件名，避免陈旧外壳 404）",
    /src="assets\/logo-avatar\.png(\?v=[a-z0-9]+)?"/.test(html)
    && /src="assets\/logo-hero\.png(\?v=[a-z0-9]+)?"/.test(html));

  console.log("\n[4] 母版保留（微信临时文件曾消失过，丢了就没法重建）");
  check("高清母版 assets/src/logo-original.jpg 在仓库里",
    existsSync(join(ROOT, "assets/src/logo-original.jpg")));
  check("生成脚本 scripts/build-avatar-asset.py 在仓库里",
    existsSync(join(ROOT, "scripts/build-avatar-asset.py")));

  console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
  process.exit(fail === 0 ? 0 : 1);
}

// 只在「直接运行时」执行主流程，被 import 时只暴露解码/判定函数
const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === selfPath) main();
