from PIL import Image, ImageDraw
import os

OLD1 = r"C:\Users\Administrator\.workbuddy\clipboard-images\clipboard-2026-09-05T13-57-05-673Z-7c121db9.png"
OLD2 = r"C:\Users\Administrator\.workbuddy\clipboard-images\clipboard-2026-09-05T13-57-05-674Z-e9630a70.png"
NEW_LOGO = r"C:\Users\Administrator\Documents\WeChat Files\wxid_i2ncebmowr2221\FileStorage\Temp\adb62ca1a3074e1037cbbf8cb21cb2f.jpg"
OUT_DIR = r"C:\Users\Administrator\WorkBuddy\2026-08-06-14-10-07\blog-site\outputs"

os.makedirs(OUT_DIR, exist_ok=True)


def is_orangeish(r, g, b):
    """检测近似 logo 橙/棕色调（排除白/灰/黑）"""
    return (
        r > 160 and g > 80 and b < 180
        and r > g > b * 0.5
        and max(r, g, b) - min(r, g, b) > 30
    )


def find_logo_box(img):
    """返回 logo 区域 bounding box (left, top, right, bottom)"""
    px = img.load()
    w, h = img.size
    left, top, right, bottom = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            if is_orangeish(r, g, b):
                left = min(left, x)
                top = min(top, y)
                right = max(right, x)
                bottom = max(bottom, y)
    if right <= left or bottom <= top:
        return None
    return (left, top, right + 1, bottom + 1)


def make_circle_mask(size):
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size[0] - 1, size[1] - 1), fill=255)
    return mask


def make_rounded_mask(size, radius_ratio=0.22):
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    r = int(min(size) * radius_ratio)
    draw.rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=r, fill=255)
    return mask


def sample_bg_color(img, left, top, right, bottom, margin=6):
    """取 logo 区域四周 margin 处的背景色平均值"""
    px = img.load()
    w, h = img.size
    samples = []
    for y in range(max(0, top - margin), min(h, bottom + margin)):
        for x in [max(0, left - margin), min(w - 1, right + margin - 1)]:
            samples.append(px[x, y][:3])
    for x in range(max(0, left - margin), min(w, right + margin)):
        for y in [max(0, top - margin), min(h - 1, bottom + margin - 1)]:
            samples.append(px[x, y][:3])
    if not samples:
        return (255, 255, 255)
    r = int(sum(c[0] for c in samples) / len(samples))
    g = int(sum(c[1] for c in samples) / len(samples))
    b = int(sum(c[2] for c in samples) / len(samples))
    return (r, g, b)


def replace_logo(base_path, logo_path, out_path, shape="circle"):
    base = Image.open(base_path).convert("RGBA")
    logo = Image.open(logo_path).convert("RGBA")

    box = find_logo_box(base)
    if not box:
        raise ValueError(f"未在 {base_path} 找到橙色 logo 区域")
    left, top, right, bottom = box
    bw, bh = right - left, bottom - top
    print(f"[{os.path.basename(base_path)}] logo box={box} size=({bw},{bh})")

    # 先把原 logo 区域（含边缘 2px）用背景色覆盖，避免旧 logo 抗锯齿边缘露出来
    bg = sample_bg_color(base, left, top, right, bottom, margin=4)
    clear_left = max(0, left - 2)
    clear_top = max(0, top - 2)
    clear_right = min(base.width, right + 2)
    clear_bottom = min(base.height, bottom + 2)
    result = base.copy()
    draw = ImageDraw.Draw(result)
    draw.rectangle((clear_left, clear_top, clear_right, clear_bottom), fill=bg + (255,))

    # 新 logo 大小比原区域略大 5%，刚好盖住旧边缘
    expand = 1.05
    ew, eh = int(bw * expand), int(bh * expand)
    ew = min(ew, base.width)
    eh = min(eh, base.height)
    ex = max(0, left - (ew - bw) // 2)
    ey = max(0, top - (eh - bh) // 2)
    if ex + ew > base.width:
        ex = base.width - ew
    if ey + eh > base.height:
        ey = base.height - eh

    target_w = ew
    target_h = eh
    logo.thumbnail((target_w, target_h), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (ew, eh), (0, 0, 0, 0))
    lw, lh = logo.size
    lx = (ew - lw) // 2
    ly = (eh - lh) // 2
    canvas.paste(logo, (lx, ly), logo)

    if shape == "circle":
        mask = make_circle_mask((ew, eh))
    else:
        mask = make_rounded_mask((ew, eh))

    result.paste(canvas, (ex, ey), mask)

    result.save(out_path)
    print(f"已保存: {out_path}")
    return out_path


if __name__ == "__main__":
    out1 = os.path.join(OUT_DIR, "logo_replaced_1.png")
    out2 = os.path.join(OUT_DIR, "logo_replaced_2.png")
    replace_logo(OLD1, NEW_LOGO, out1, shape="circle")
    replace_logo(OLD2, NEW_LOGO, out2, shape="rounded")
