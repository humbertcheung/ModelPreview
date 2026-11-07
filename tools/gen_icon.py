#!/usr/bin/env python3
"""纯 Python 生成 macOS 应用图标（等距立方体 + 圆角卡片），输出 iconset 并转 icns。"""
import math, os, struct, zlib, subprocess, sys

SIZE = 1024
# macOS 11+ 图标规范：1024 画布，内容 824，圆角 ~185
MARGIN = 100
CARD = SIZE - MARGIN * 2      # 824
RADIUS = 185
CX0, CY0 = MARGIN, MARGIN

def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(len(a)))

def rounded_rect_span(y, x0, y0, w, h, r):
    """给定行 y，返回圆角矩形的 [xmin, xmax] 区间；不在内部返回 None"""
    if y < y0 or y >= y0 + h:
        return None
    dy_top = y0 + r - y
    dy_bot = y - (y0 + h - r - 1)
    if dy_top > 0 and 0 <= dy_top <= r:      # 上圆角带
        half = math.sqrt(max(0, r * r - dy_top * dy_top))
        return (x0 + r - half, x0 + w - r + half)
    if dy_bot > 0 and 0 <= dy_bot <= r:      # 下圆角带
        half = math.sqrt(max(0, r * r - dy_bot * dy_bot))
        return (x0 + r - half, x0 + w - r + half)
    return (x0, x0 + w - 1)

def span_for_quad(y, pts):
    """凸四边形在行 y 的 [xmin,xmax]；不相关返回 None"""
    xs = []
    n = len(pts)
    for i in range(n):
        (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % n]
        if (y1 <= y < y2) or (y2 <= y < y1):
            t = (y - y1) / (y2 - y1)
            xs.append(x1 + (x2 - x1) * t)
    if len(xs) < 2:
        return None
    return (min(xs), max(xs))

def fill_row(row, y, x0f, x1f, color, alpha=1.0):
    a, b = int(math.ceil(x0f)), int(math.floor(x1f))
    for x in range(max(0, a), min(SIZE, b + 1)):
        row[x] = color

# ---- 等距立方体顶点 ----
S = 250.0
cx, cy = SIZE / 2, SIZE / 2 + 14

def proj(p):
    """isometric: y 向上"""
    x, y, z = p
    px = (x - z) * 0.866
    py = (x + z) * 0.5 - y
    return (cx + px * S, cy - py * S)

V = {}
for x in (0, 1):
    for y in (0, 1):
        for z in (0, 1):
            V[(x, y, z)] = proj((x * 2 - 1, y * 2 - 1, z * 2 - 1))

top_face = [V[(0, 1, 0)], V[(0, 1, 1)], V[(1, 1, 1)], V[(1, 1, 0)]]
right_face = [V[(1, 0, 0)], V[(1, 1, 0)], V[(1, 1, 1)], V[(1, 0, 1)]]
left_face = [V[(0, 0, 1)], V[(0, 1, 1)], V[(1, 1, 1)], V[(1, 0, 1)]]

BG_TOP = (0x26, 0x2c, 0x3d)
BG_BOT = (0x12, 0x14, 0x1c)
C_TOP = (0x5c, 0x8e, 0xf7)
C_RIGHT = (0x3a, 0x6d, 0xf0)
C_LEFT = (0x27, 0x4a, 0xbd)

rows = []
for y in range(SIZE):
    row = [None] * SIZE
    # 背景行
    t = y / (SIZE - 1)
    bg = lerp(BG_TOP, BG_BOT, t)
    # 圆角卡片
    span = rounded_rect_span(y, CX0, CY0, CARD, CARD, RADIUS)
    if span:
        for x in range(int(span[0]), int(span[1]) + 1):
            row[x] = tuple(int(c) for c in bg)
    # 立方体三个面（先左右后顶，覆盖顺序无重叠即可）
    for face, color, shade_key in (
        (left_face, C_LEFT, "left"),
        (right_face, C_RIGHT, "right"),
        (top_face, C_TOP, "top"),
    ):
        fs = span_for_quad(y, face)
        if fs:
            # 面内轻微纵向渐变
            top_y = min(p[1] for p in face)
            bot_y = max(p[1] for p in face)
            tt = 0.5
            if bot_y > top_y:
                tt = (y - top_y) / (bot_y - top_y)
            if shade_key == "top":
                col = lerp(color, tuple(c * 0.86 for c in color), tt)
            elif shade_key == "right":
                col = lerp(tuple(c * 1.06 for c in color), tuple(c * 0.82 for c in color), tt)
            else:
                col = lerp(tuple(c * 1.04 for c in color), tuple(c * 0.78 for c in color), tt)
            fill_row(row, y, fs[0], fs[1], tuple(int(c) for c in col))
    rows.append(row)

# ---- 写 PNG ----
def png_chunk(tag, data):
    c = tag + data
    return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

def write_png(path, rows):
    raw = b""
    for row in rows:
        raw += b"\x00"
        for p in row:
            if p is None:
                raw += b"\x00\x00\x00\x00"
            else:
                raw += bytes(p) + b"\xff"
    png = b"\x89PNG\r\n\x1a\n"
    png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += png_chunk(b"IDAT", zlib.compress(raw, 9))
    png += png_chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)

iconset = os.path.join(os.path.dirname(__file__), "AppIcon.iconset")
os.makedirs(iconset, exist_ok=True)
master = os.path.join(iconset, "icon_512x512@2x.png")
write_png(master, rows)

for name, size in [("16", 16), ("16@2x", 32), ("32", 32), ("32@2x", 64),
                   ("128", 128), ("128@2x", 256), ("256", 256), ("256@2x", 512),
                   ("512", 512)]:
    out = os.path.join(iconset, f"icon_{name}x{name}.png" if "@" not in name else f"icon_{name}.png")
    subprocess.run(["sips", "-z", str(size), str(size), master, "--out", out],
                   check=True, capture_output=True)

icns = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "AppIcon.icns")
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", icns], check=True)
print("icon →", icns)
