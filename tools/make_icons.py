#!/usr/bin/env python3
"""Generate the app icons with no external dependencies (stdlib only).

Run (containers only):
  make icons

Output: source/icons/icon.png (80x80), source/icons/largeIcon.png (130x130).
webOS TV expects exactly these sizes for appinfo.json.
"""
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "source", "icons")

BG_TOP = (16, 24, 40)
BG_BOTTOM = (8, 11, 18)
ACCENT = (27, 142, 242)
WHITE = (242, 245, 249)

SS = 4  # supersampling factor for antialiasing


def rounded_rect(x, y, w, h, r):
    def inside(px, py):
        cx = min(max(px, x + r), x + w - r)
        cy = min(max(py, y + r), y + h - r)
        if x + r <= px <= x + w - r or y + r <= py <= y + h - r:
            return x <= px <= x + w and y <= py <= y + h
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
    return inside


def draw(size):
    n = size * SS
    acc = [[[0.0, 0.0, 0.0] for _ in range(size)] for _ in range(size)]

    box = rounded_rect(0, 0, n, n, n * 0.22)
    cx = cy = n / 2.0
    ring_r = n * 0.26
    ring_w = n * 0.075
    hub_r = n * 0.10
    teeth = 8
    tooth_len = n * 0.09
    tooth_w = n * 0.055

    def pixel(px, py):
        if not box(px, py):
            return None  # transparent corner
        dx, dy = px - cx, py - cy
        d = math.hypot(dx, dy)

        # gear teeth
        ang = math.atan2(dy, dx)
        step = 2 * math.pi / teeth
        k = round(ang / step)
        ta = k * step
        # coordinates in the frame rotated by ta
        rx = dx * math.cos(-ta) - dy * math.sin(-ta)
        ry = dx * math.sin(-ta) + dy * math.cos(-ta)
        in_tooth = (ring_r - ring_w * 0.4 <= rx <= ring_r + tooth_len) and abs(ry) <= tooth_w / 2

        in_ring = abs(d - ring_r) <= ring_w / 2
        in_hub = d <= hub_r

        if in_ring or in_tooth or in_hub:
            return WHITE if (in_ring or in_tooth) else ACCENT

        t = py / float(n)
        return tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))

    alpha = [[0.0] * size for _ in range(size)]
    for y in range(n):
        oy = y // SS
        for x in range(n):
            c = pixel(x + 0.5, y + 0.5)
            ox = x // SS
            if c is None:
                continue
            alpha[oy][ox] += 1.0
            a = acc[oy][ox]
            a[0] += c[0]
            a[1] += c[1]
            a[2] += c[2]

    rows = []
    per = float(SS * SS)
    for y in range(size):
        row = bytearray()
        for x in range(size):
            cnt = alpha[y][x]
            if cnt == 0:
                row += bytes((0, 0, 0, 0))
                continue
            a = acc[y][x]
            row += bytes((
                int(a[0] / cnt), int(a[1] / cnt), int(a[2] / cnt),
                int(255 * cnt / per),
            ))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    print("written %s (%dx%d, %d bytes)" % (path, size, size, len(png)))


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, size in (("icon.png", 80), ("largeIcon.png", 130)):
        write_png(os.path.join(OUT, name), draw(size), size)


if __name__ == "__main__":
    main()
