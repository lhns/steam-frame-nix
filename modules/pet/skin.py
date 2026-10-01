#!/usr/bin/env python3
"""Recolour the Toon Cat's texture (bake.py's cat.png) into another coat.

usage: skin.py base.png model.json out.png

model.json (models/<id>/model.json, kind "recolor"):
  { "name": "Tuxedo", "kind": "recolor",
    "fur": ["#18181c", "#55555e"],          dark and light end of the coat
    "white": ["chest", "muzzle", "paws"] }  optional white markings

The texture is a gradient atlas (64 x 64): each vertex samples one texel,
and the body's texels are laid out like a side view of the cat (columns
along its length, rows by height), each column a dark-to-light ramp that
bakes the shading in. Fur texels are the ginger ones (hue 0.03-0.14,
saturation > 0.15); each is replaced by the new coat's ramp at the same
brightness (its place between the darkest and lightest fur texel), so the
baked shading stays. White markings are texel rectangles of that side view
(PATTERNS, checked against renders of the baked frames), painted from a
white ramp at the same brightness. Everything else (eyes, nose, mouth,
whisker and inner-ear swatches) is kept as it is.
"""
import json
import sys
import numpy as np
from PIL import Image

HUE = (0.03, 0.14)
SAT = 0.15
# White markings, texel rectangles (x0, x1, y0, y1 inclusive) of the Toon
# Cat's 64 x 64 atlas: columns 0-4 face / throat, 5-6 chest and front legs,
# 9-11 hind legs; rows ~14 (floor) to ~40 (head top).
PATTERNS = {
    'muzzle': [(0, 3, 24, 45)],               # chin, mouth, muzzle and cheeks up between the eyes
    'chest': [(4, 4, 22, 34), (5, 5, 20, 33), (6, 6, 20, 30), (7, 8, 22, 29)],   # throat, chest, front legs' fronts, belly
    'paws': [(5, 6, 13, 19), (9, 11, 13, 18)],   # front and hind paws
}
WHITE = ('#dcdcdf', '#ffffff')


def rgb(c):
    c = c.lstrip('#')
    return np.array([int(c[i:i + 2], 16) for i in (0, 2, 4)], dtype=float) / 255


def hsv(a):
    mx, mn = a.max(-1), a.min(-1)
    d = mx - mn
    s = np.where(mx > 0, d / np.maximum(mx, 1e-9), 0)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    dd = np.maximum(d, 1e-9)
    h = np.where(mx == r, ((g - b) / dd) % 6, np.where(mx == g, (b - r) / dd + 2, (r - g) / dd + 4)) / 6
    return np.where(d > 0, h, 0), s, mx


def luma(a):
    return a @ np.array([0.2126, 0.7152, 0.0722])


def fur_mask(a):
    h, s, _ = hsv(a)
    return (h >= HUE[0]) & (h <= HUE[1]) & (s > SAT)


def recolor(base, spec):
    a = np.asarray(base.convert('RGB')).astype(float) / 255
    fur = fur_mask(a)
    lum = luma(a)
    lo, hi = lum[fur].min(), lum[fur].max()
    t = np.clip((lum - lo) / (hi - lo), 0, 1)[..., None]
    dark, light = (rgb(c) for c in spec['fur'])
    out = a.copy()
    out[fur] = (dark + (light - dark) * t)[fur]
    marks = np.zeros(fur.shape, bool)
    for name in spec.get('white', []):
        for x0, x1, y0, y1 in PATTERNS[name]:
            marks[y0:y1 + 1, x0:x1 + 1] = True
    marks &= fur
    wd, wl = (rgb(c) for c in WHITE)
    out[marks] = (wd + (wl - wd) * t)[marks]
    return Image.fromarray((np.clip(out, 0, 1) * 255).round().astype(np.uint8), 'RGB'), fur


if __name__ == '__main__':
    base, spec_path, out = sys.argv[1:4]
    spec = json.load(open(spec_path))
    img, _ = recolor(Image.open(base), spec)
    img.save(out, optimize=True)
