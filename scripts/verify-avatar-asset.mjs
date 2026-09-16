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
// 断言的是**不变量**（居中、等宽、正方形、不透明），不是设计选择：
// 底圈该多宽是审美问题（改 `--disc-ratio` 即可），所以只做「区间」断言，不钉死数值。
//
// ⚠️ 2026-09-16 第二个病历：透明度会让测量变成**虚构**。
// 旧素材 `logo-*.png` 其实是 **RGBA（透明底 + 软边）**。第一版解码器只展开 RGB、把 alpha 丢了，
// 于是量到「图案 94px、底圈 上6.1/下13.8」，而浏览器实际只画 **39×39**（合成到奶油卡片上后
// 软边整片消失）。差 36% —— 数字看着很精确，其实一半是透明像素的原始 RGB。
// 所以：① 解码器显式读 alpha，遇 tRNS 直接报错；② 量之前必须先 `compositeOver`；
//       ③ 素材**必须不透明**（否则底圈颜色随页面底色变，暗色模式糊成一团）。
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
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
  let off = 8, ihdr = null, plte = null, idat = [], trns = false;
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
    else if (type === "tRNS") trns = true;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  // ⚠️ 调色板 / 灰度 / RGB 的 tRNS 也是透明度，但不在 alpha 通道里。
  // 宁可显式拒绝，也不能静默忽略——**忽略透明度 = 量到的数字是「透明像素的原始 RGB」，纯属虚构**
  // （本轮真踩过：旧 logo 是 RGBA 透明底，旧版解码器丢掉 alpha 后量出「图案 106px」，
  //   而浏览器实际只画 78px，差 36%；据此写出的「底圈 6px」结论整条是错的）。
  if (trns) throw new Error("PNG 含 tRNS 透明chunk（本解码器只认 alpha 通道，请先转成不透明素材）");
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

  // 统一展开成 RGB + alpha（alpha 缺失时全 255）
  const n = ihdr.width * ihdr.height;
  const hasAlpha = ihdr.color === 4 || ihdr.color === 6;
  const rgb = Buffer.alloc(n * 3);
  const alpha = hasAlpha ? Buffer.alloc(n, 255) : null;
  for (let i = 0; i < n; i++) {
    const s = i * CH;
    let r, g, b;
    if (ihdr.color === 0 || ihdr.color === 4) { r = g = b = out[s]; }
    else if (ihdr.color === 2 || ihdr.color === 6) { r = out[s]; g = out[s + 1]; b = out[s + 2]; }
    else { const p = out[s] * 3; r = plte[p]; g = plte[p + 1]; b = plte[p + 2]; }
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
    if (alpha) alpha[i] = out[s + CH - 1];
  }
  return { width: ihdr.width, height: ihdr.height, rgb, alpha, colorType: ihdr.color };
}

/** 把素材按 alpha 合成到给定底色上 —— 这才是浏览器实际画出来的像素。 */
export function compositeOver(img, bg) {
  if (!img.alpha) return { width: img.width, height: img.height, rgb: img.rgb };
  const n = img.width * img.height;
  const rgb = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const a = img.alpha[i] / 255;
    for (let k = 0; k < 3; k++) rgb[i * 3 + k] = Math.round(img.rgb[i * 3 + k] * a + bg[k] * (1 - a));
  }
  return { width: img.width, height: img.height, rgb };
}

/** 四角众数色 —— 当作「底色」。 */
export function cornerMode(img) {
  const { width: w, height: h, rgb } = img;
  const px = (x, y) => [rgb[(y * w + x) * 3], rgb[(y * w + x) * 3 + 1], rgb[(y * w + x) * 3 + 2]];
  const count = new Map();
  for (const c of [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)]) {
    const k = c.join(",");
    count.set(k, (count.get(k) || 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
}

// ── 图案包围盒：与底色差得够远的像素 ─────────────────────────────────────────
// TOL=18 的来历：素材底圈的奶油色 (253,245,236) 与圆环外的白 (254,254,254) 只差 18，
// 所以圆环外那 1px 白边不会被算成「图案」——正好只框住真正的图案（黑环）。
const TOL = 18;

export function contentBBox(img, bgArg) {
  // ⚠️ 必须先按 alpha 合成再量。透明像素的「原始 RGB」不是屏幕上能看到的颜色，
  // 直接拿它量会得到一个现实中不存在的包围盒（本轮实测差 36%）。
  const bg = bgArg || cornerMode(img);
  const { width: w, height: h, rgb } = compositeOver(img, bg);
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
  let transparent = 0;
  if (img.alpha) for (let i = 0; i < img.alpha.length; i++) if (img.alpha[i] < 255) transparent++;
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
    alpha: { transparent, ratio: transparent / (img.width * img.height) },
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
  // 素材必须不透明：透明处的颜色由页面底色决定 —— 暗色模式下底圈会变成深色，
  // 深墨图案会和它糊在一起；而且「透明像素的原始 RGB」会让任何位图测量失真。
  if (g.alpha.transparent > 0) {
    why.push(`含 ${g.alpha.transparent} 个透明/半透明像素（占 ${(100 * g.alpha.ratio).toFixed(1)}%）`
      + `—— 素材必须不透明，否则底圈颜色随页面底色变`);
  }
  return { pass: why.length === 0, g, why };
}

// ── 合成样本：证明判据不是「恒绿」也不是「恒红」─────────────────────────────
export function synth({ w = 120, h = w, disc = 86, offsetX = 0, offsetY = 0, bg = [253, 245, 236], fg = [20, 20, 20], opaque = true } = {}) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = bg[0]; rgb[i * 3 + 1] = bg[1]; rgb[i * 3 + 2] = bg[2]; }
  const alpha = opaque ? null : Buffer.alloc(w * h, 0); // 不透明样本：底色区域 alpha=0
  const x0 = Math.round((w - disc) / 2 + offsetX), y0 = Math.round((h - disc) / 2 + offsetY);
  for (let y = y0; y < y0 + disc; y++)
    for (let x = x0; x < x0 + disc; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const s = (y * w + x) * 3;
      rgb[s] = fg[0]; rgb[s + 1] = fg[1]; rgb[s + 2] = fg[2];
      if (alpha) alpha[y * w + x] = 255;
    }
  return { width: w, height: h, rgb, alpha };
}

function main() {
  console.log("[1] 素材不变量：正方形 + 图案居中 + 底圈等宽");
  // logo-avatar.png 是**唯一被 HTML 引用的**素材；logo-hero.png 只作为「陈旧 HTML 外壳」
  // 的兜底副本保留（旧壳还引用着它，删掉就 404。见 [3]）。所以：
  //   avatar → 必须存在且合规；hero → 允许不存在（将来清掉不该判红），存在就必须合规。
  const PRIMARY = "assets/logo-avatar.png";
  const files = [PRIMARY, "assets/logo-hero.png"]
    .filter((rel) => rel === PRIMARY || existsSync(join(ROOT, rel)));
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
      + `  图案占盒 ${(100 * g.discRatio).toFixed(1)}%`
      + `  ${g.alpha.transparent === 0 ? "不透明" : `透明像素 ${g.alpha.transparent}`}`, j.pass, detail);
  }

  // 兜底副本必须与主素材**字节相同**：它存在的唯一理由是「陈旧外壳引用它时不 404」，
  // 一旦漂移就会在旧壳上画出旧头像 —— 这种「只在缓存命中时才出现的差异」最难查。
  if (existsSync(join(ROOT, "assets/logo-hero.png"))) {
    const sha = (rel) => createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex");
    const a = sha(PRIMARY), b = sha("assets/logo-hero.png");
    check("兜底副本 assets/logo-hero.png 与主素材字节相同（陈旧外壳仍会请求它）",
      a === b,
      `主 ${a.slice(0, 12)}… vs 兜底 ${b.slice(0, 12)}…  →  重新生成：python scripts/build-avatar-asset.py`);
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
  check("负向自检：**透明底素材**必须判红（旧素材的第二个病历：RGBA 透明底，浏览器只画 78/144）",
    judge(synth({ opaque: false })).pass === false,
    "透明度会让「量出来的图案」变成透明像素的原始 RGB，纯属虚构");
  // 合成不得改变几何：同一个透明样本，合成前后量到的包围盒必须一致（否则 compositeOver 有 bug）
  {
    const t = synth({ opaque: false });
    const a = contentBBox(t), b = contentBBox(compositeOver(t, cornerMode(t)));
    check("自证：compositeOver 只换颜色不改几何（透明样本合成前后包围盒一致）",
      a.l === b.l && a.t === b.t && a.r === b.r && a.b === b.b,
      `合成前 ${a.l},${a.t},${a.r},${a.b} vs 合成后 ${b.l},${b.t},${b.r},${b.b}`);
  }

  console.log("\n[3] 首屏只能下一份 logo（两个 URL ⇒ 同一张图下两次，实测 49665 B）");
  const bm = readFileSync(join(ROOT, "build.mjs"), "utf8");
  check("build.mjs 给 logo 注入 ?v=<内容哈希>（/assets/* 是 max-age=86400 + swr=604800）",
    /assets\/logo-avatar\.png\?v=\$\{logoVersion\}/.test(bm),
    "没注入 ?v= 的话，换图后用户会继续看到旧头像（最长一天）");
  check("build.mjs 把 `logo-hero.png` 的历史引用收敛回唯一 URL（防复发）",
    bm.includes("logo-(?:avatar|hero)"),
    "少了这条正则，以后有人写回两个 URL 时构建期不会收敛");
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  // 抓所有 <img src="assets/logo-*.png">（去 ?v=），断言去重后只剩一个 URL
  const logoRefs = [...html.matchAll(/src="(assets\/logo-[a-z]+\.png)(?:\?v=[a-z0-9]+)?"/g)].map((m) => m[1]);
  const uniq = [...new Set(logoRefs)];
  check(`index.html 里 ${logoRefs.length} 处 logo 引用，去重后 ${uniq.length} 个 URL`
    + (uniq.length ? `（${uniq.join(", ")}）` : ""),
    uniq.length === 1,
    uniq.length > 1
      ? `${uniq.length} 个 URL ⇒ 冷缓存首屏把同一张图下载 ${uniq.length} 次（白付 ${(uniq.length - 1) * 24.8} KB）`
      : "一处都没引用");
  check("侧边栏（56px）与首屏 hero（72px）指向同一 URL（渲染尺寸不同 ≠ 要下两份）",
    logoRefs.length === 2 && uniq[0] === "assets/logo-avatar.png",
    `实际 ${logoRefs.length} 处：${logoRefs.join(", ") || "无"}`);
  check("用固定文件名引用 logo（不玩哈希文件名，避免陈旧外壳 404）",
    /^assets\/logo-avatar\.png$/.test(uniq[0] || ""));

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
