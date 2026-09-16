#!/usr/bin/env python3
"""从高清原图重建头像素材：图案**居中**、底圈**等宽**的正方形 PNG。

问题背景（2026-09-16 实测）
--------------------------
线上 `assets/logo-*.png` 是 183×130 的**非正方形**图，图案（一个圆环 + 太极 + 人物）
在整图里偏上偏右。而 CSS 用 `object-fit: cover` + `border-radius: 50%`：

  - `cover` 把宽图按高缩放后**左右各裁掉 26.5px**，**上下不裁**；
  - 于是图案在圆盒里既不居中、四周留白也不相等。

实测（72px 尺寸下，圆盘边缘到盒子边缘）：
    上 6.4  下 14.4  左 12.0  右 8.0   ⇒ 下方是上方的 2.3 倍
亮色主题下这圈底色的合成色与卡片几乎同色（差≤6）看不见，暗色主题才暴露成一条
明显不均匀的亮环 —— 这就是「头像周围的空区域没对齐」。

根因可以追到原图本身：原图 1133×1080，而图案圆环的圆心是 (561.3, 553.3)，
**不是图片中心 (566.5, 540)**（偏 -5.2, +13.3）。当年按图心裁切，偏移就被带进来了。

本脚本做什么
------------
1. 从原图**拟合出圆环的圆心与半径**（720 个角度向外扫描取外沿点，再迭代最小二乘
   剔除箭头造成的离群点）——不靠单行/单列估算，也不写死坐标；
2. 以该圆心为中心裁一个正方形，半径 = 圆环半径 + margin；
3. 缩放后**居中**贴进正方形画布，四周是等宽的奶油底圈。

底圈比例沿用改造前的观感：圆盘占盒子 `94/130 = 72.3%`（72px 时约 10px 底圈），
所以「只是变匀了」，不是变粗或变细。

依赖：仅 Pillow（不依赖 numpy —— 这是个提交进仓库的构建脚本，降低使用门槛）。
用法：
  python scripts/build-avatar-asset.py                 # 重建两个 logo
  python scripts/build-avatar-asset.py --check         # 只报几何，不写盘
  python scripts/build-avatar-asset.py --ring-ratio 0.90   # 换成细底圈
"""
import argparse
import math
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SRC_DEFAULT = os.path.join(ROOT, "assets", "src", "logo-original.jpg")
TARGETS_DEFAULT = [os.path.join(ROOT, "assets", "logo-avatar.png"),
                   os.path.join(ROOT, "assets", "logo-hero.png")]

# 与改造前完全一致的圆盘占比（旧素材 94px 圆盘 / 130px 盒子）
DISC_RATIO = 94 / 130
# 画布边长（源像素）。头像最大显示尺寸是 72 CSS px（首页 hero），高 dpr 屏 3x 需
# 216 设备像素 —— 288 覆盖到 dpr 4，足够；再大只是徒增首页字节（384 时 PNG 会到 98KB）。
CANVAS = 288
# 调色板色数。画面是平色插画（只有太极的渐变是连续调），256 色量化后与原 RGB 版
# 逐像素差异中位数 0、p99 11，肉眼不可辨，但体积从 63KB 降到 27KB。
COLORS = 256
# 圆环外的额外留白（源像素）。留一点点是为了让圆形遮罩切在白底上、不切在圆环的
# 抗锯齿边缘上。1px 换算到 72px 显示只有 0.08px，肉眼不可见，所以取最小值。
MARGIN = 1.0
# 底色：旧素材背景的众数色，保持亮色主题下与卡片「几乎同色」的既有观感
CREAM = (253, 245, 236)
# 「暗于这个亮度」就算图案（圆环是纯黑，白底 255，阈值取中间偏保守）
DARK = 110
# 拟合用的采样角度数与迭代轮数
ANGLES = 720
ROUNDS = 4


def fit_ring_circle(im):
    """拟合圆环外沿的圆心与半径，返回 (cx, cy, r, 内点数, 离群点数)。

    做法：从外向内沿半径扫描，第一个「够暗」的像素即外沿点。箭头会在少数角度上
    把外沿推得更远（离群），所以用代数最小二乘 + 迭代剔除离群点，让结果只由
    圆环本体的上千个点决定。
    """
    px = im.convert("RGB").load()
    w, h = im.size

    def lum(x, y):
        r, g, b = px[x, y]
        return 0.2126 * r + 0.7152 * g + 0.0722 * b

    pts_in = pts = []
    cx, cy, r = None, None, None
    big = int(math.hypot(w, h) / 2)                 # 足够大的扫描半径，靠边界检查兜住
    for _ in range(ROUNDS):
        if cx is None:                              # 初值：图片中心，后面靠迭代纠正
            sx, sy, srmax, smin = w / 2.0, h / 2.0, big, int(min(w, h) * 0.1)
        else:                                       # 收敛后只在圆环附近细扫
            sx, sy, srmax, smin = cx, cy, int(r * 1.25), int(r * 0.7)
        pts = []
        for i in range(ANGLES):
            th = 2 * math.pi * i / ANGLES
            dx, dy = math.cos(th), math.sin(th)
            for rr in range(srmax, smin, -1):          # 由外向内
                x, y = int(round(sx + dx * rr)), int(round(sy + dy * rr))
                if 0 <= x < w and 0 <= y < h and lum(x, y) < DARK:
                    pts.append((x, y))
                    break
        if len(pts) < 50:
            raise SystemExit("✗ 扫到的圆环外沿点太少，原图可能不是「白底 + 深色圆环」")
        cx, cy, r = _fit(pts)
        # 迭代剔除离群点：箭头尖端比圆环本体远、圆环缺口处会扫到更靠内的图案，
        # 两者残差都远大于圆环本体，会被这一轮清掉。
        res = [abs(math.hypot(p[0] - cx, p[1] - cy) - r) for p in pts]
        thr = max(6.0, sorted(res)[len(res) // 2] * 4)
        pts_in = [p for p, d in zip(pts, res) if d <= thr]
        if len(pts_in) >= 50:
            cx, cy, r = _fit(pts_in)
    return cx, cy, r, len(pts_in), len(pts) - len(pts_in)


def _fit(pts):
    """代数圆拟合（Kåsa）：把 x²+y² = 2cx·x + 2cy·y + d 当线性模型解最小二乘。

    手写正规方程 + 3×3 高斯消元，避免为了一个 3×3 线性系统给构建脚本引入 numpy。
    """
    n = len(pts)
    sxx = sxy = syy = sx = sy = 0.0
    sxxx = sxyy = syyy = syxx = 0.0
    for x, y in pts:
        sxx += x * x
        sxy += x * y
        syy += y * y
        sx += x
        sy += y
        sxxx += x * x * x
        sxyy += x * y * y
        syyy += y * y * y
        syxx += y * x * x
    # 未知量 (a, b, d) = (2cx, 2cy, r²-cx²-cy²)，右端项 z = x²+y²
    M = [[sxx, sxy, sx],
         [sxy, syy, sy],
         [sx, sy, float(n)]]
    v = [sxxx + sxyy, syyy + syxx, sxx + syy]
    a2, b2, d = _solve3(M, v)
    cx, cy = a2 / 2.0, b2 / 2.0
    r = math.sqrt(max(0.0, d + cx * cx + cy * cy))
    return cx, cy, r


def _solve3(M, v):
    """3×3 线性方程组，高斯消元（带部分主元）。"""
    A = [row[:] + [v[i]] for i, row in enumerate(M)]
    for col in range(3):
        piv = max(range(col, 3), key=lambda k: abs(A[k][col]))
        if abs(A[piv][col]) < 1e-9:
            raise SystemExit("✗ 圆拟合的方程退化（点共线？）")
        A[col], A[piv] = A[piv], A[col]
        for k in range(col + 1, 3):
            f = A[k][col] / A[col][col]
            for j in range(col, 4):
                A[k][j] -= f * A[col][j]
    x = [0.0, 0.0, 0.0]
    for i in (2, 1, 0):
        s = A[i][3] - sum(A[i][j] * x[j] for j in range(i + 1, 3))
        x[i] = s / A[i][i]
    return x


def build(im, ring_ratio=DISC_RATIO, canvas=CANVAS, margin=MARGIN):
    cx, cy, r, nin, nout = fit_ring_circle(im)
    side = canvas
    disc_px = int(round(side * ring_ratio))
    # ⚠️ 裁切框必须**严格正方形**：一旦宽高差 1px，缩放后圆就变成椭圆
    #    （实测 899×898 会让 72px 头像的左右留白比上下多 0.25px）。所以先定边长，
    #    再让四条边都用同一个半边长，而不是各自 round(cx±r)。
    half = r + margin
    crop_side = int(round(half * 2))
    x0 = int(round(cx - crop_side / 2.0))
    y0 = int(round(cy - crop_side / 2.0))
    box = (x0, y0, x0 + crop_side, y0 + crop_side)
    disc = im.crop(box).resize((disc_px, disc_px), Image.LANCZOS)

    # 圆形遮罩：4x 超采样再缩回，得到抗锯齿边缘
    ss = 4
    m = Image.new("L", (disc_px * ss, disc_px * ss), 0)
    ImageDraw.Draw(m).ellipse((0, 0, disc_px * ss - 1, disc_px * ss - 1), fill=255)
    m = m.resize((disc_px, disc_px), Image.LANCZOS)

    out = Image.new("RGB", (side, side), CREAM)
    out.paste(disc, ((side - disc_px) // 2, (side - disc_px) // 2), m)
    info = dict(ring_cx=cx, ring_cy=cy, ring_r=r, inliers=nin, outliers=nout,
                side=side, disc=disc_px, crop_side=crop_side,
                img_cx=im.size[0] / 2.0, img_cy=im.size[1] / 2.0)
    return out, info


def ring_gaps(im, display):
    """按浏览器 `cover` 的口径算「圆盘边缘 → 盒子边缘」的四边留白（渲染 px）。"""
    px = im.convert("RGB").load()
    bg = px[0, 0]

    def far(c):
        return max(abs(c[i] - bg[i]) for i in range(3)) > 18

    w, h = im.size
    xs = [x for y in range(h) for x in range(w) if far(px[x, y])]
    ys = [y for y in range(h) for x in range(w) if far(px[x, y])]
    l, r2, t, b = min(xs), max(xs) + 1, min(ys), max(ys) + 1
    k = display / h
    dx = (w * k - display) / 2.0
    return dict(left=l * k - dx, top=t * k, right=(w - r2) * k - dx, bottom=(h - b) * k)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=SRC_DEFAULT)
    ap.add_argument("--targets", nargs="*", default=TARGETS_DEFAULT)
    ap.add_argument("--disc-ratio", type=float, default=DISC_RATIO,
                    help=f"圆盘占盒子的比例（默认 {DISC_RATIO:.4f}，与改造前观感一致）")
    ap.add_argument("--canvas", type=int, default=CANVAS)
    ap.add_argument("--colors", type=int, default=COLORS,
                    help="调色板色数（0 = 输出全彩 RGB PNG，体积约 2.4 倍）")
    ap.add_argument("--check", action="store_true", help="只报几何，不写盘")
    a = ap.parse_args()

    if not os.path.exists(a.src):
        raise SystemExit(f"✗ 找不到原图 {a.src}\n"
                         "  （它是高清母版，必须留在仓库里：微信临时文件会消失）")
    im = Image.open(a.src).convert("RGB")
    out, info = build(im, a.disc_ratio, a.canvas)

    print(f"原图 {os.path.relpath(a.src, ROOT)}  {im.size[0]}×{im.size[1]}")
    print(f"  拟合圆环：圆心 ({info['ring_cx']:.2f}, {info['ring_cy']:.2f})  半径 {info['ring_r']:.2f}"
          f"   内点 {info['inliers']}  离群(箭头) {info['outliers']}")
    print(f"  图片中心 ({info['img_cx']:.1f}, {info['img_cy']:.1f})"
          f"  ⇒ 图案相对图心偏移 ({info['ring_cx']-info['img_cx']:+.1f}, {info['ring_cy']-info['img_cy']:+.1f})")
    print(f"  输出 {info['side']}×{info['side']}  圆盘 {info['disc']}px"
          f"（占盒 {100*info['disc']/info['side']:.2f}%，改造前 72.31%）")
    gaps = ring_gaps(out, 72)
    print(f"  72px 渲染留白  左{gaps['left']:.2f} 上{gaps['top']:.2f} "
          f"右{gaps['right']:.2f} 下{gaps['bottom']:.2f}   "
          f"⇒ 上下差 {abs(gaps['bottom']-gaps['top']):.2f}  左右差 {abs(gaps['right']-gaps['left']):.2f}")
    print(f"  （改造前同一口径：左11.9 上6.1 右8.0 下13.8 ⇒ 上下差 7.8）")
    if a.check:
        return 0

    for p in a.targets:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        out_to_save = out if a.colors <= 0 else out.quantize(colors=a.colors, method=Image.MEDIANCUT)
        out_to_save.save(p, optimize=True)
        print(f"  ✓ 写入 {os.path.relpath(p, ROOT)}  {out.size[0]}×{out.size[1]}  "
              f"{os.path.getsize(p)} B"
              + ("" if a.colors <= 0 else f"（{a.colors} 色调色板）"))
    print("\n提示：换图后必须让 URL 变化，否则 /assets/* 的 max-age=86400 会让浏览器继续用旧图。")
    print("      index.html 的 ?v= 由 build.mjs 的 hashAssets() 自动注入（已含这两个 logo）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
