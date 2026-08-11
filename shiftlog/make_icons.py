#!/usr/bin/env python3
"""Generate Shift Log PWA icons: #6D8CA3 background with a white EKG pulse line."""

from PIL import Image, ImageDraw

BG = "#6D8CA3"
FG = "#FFFFFF"

# EKG waveform as fractions of the icon's width/height. y grows downward,
# so a smaller y is a taller peak. Flat -> small dip -> tall spike -> flat.
WAVE = [
    (0.08, 0.50),
    (0.26, 0.50),
    (0.33, 0.42),
    (0.40, 0.58),
    (0.47, 0.16),
    (0.56, 0.84),
    (0.64, 0.50),
    (0.92, 0.50),
]


def make_icon(size, path):
    # Supersample 4x so the diagonal strokes come out smooth after downscaling.
    scale = 4
    s = size * scale
    img = Image.new("RGB", (s, s), BG)
    draw = ImageDraw.Draw(img)

    points = [(x * s, y * s) for x, y in WAVE]
    width = max(1, int(s * 0.075))

    draw.line(points, fill=FG, width=width, joint="curve")
    # Round off the stroke ends and any joints the "curve" joint misses.
    r = width / 2
    for x, y in points:
        draw.ellipse([x - r, y - r, x + r, y + r], fill=FG)

    img.resize((size, size), Image.LANCZOS).save(path, "PNG")
    print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    make_icon(192, "web/icon-192.png")
    make_icon(512, "web/icon-512.png")
