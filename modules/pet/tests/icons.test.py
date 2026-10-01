#!/usr/bin/env python3
"""The "+" menu icons (package.nix `icons`): one per model folder, 256 px
square, transparent around a visible animal, and default.txt naming one.

usage: icons.test.py models-dir icons-dir
"""
import os
import sys
from PIL import Image

models, icons = sys.argv[1:3]
ids = sorted(d for d in os.listdir(models) if os.path.isdir(os.path.join(models, d)))
pngs = sorted(f[:-4] for f in os.listdir(icons) if f.endswith('.png'))
assert pngs == ids, f'icons {pngs} != model folders {ids}'
for i in ids:
    im = Image.open(os.path.join(icons, i + '.png'))
    assert im.size == (256, 256) and im.mode == 'RGBA', f'{i}: {im.size} {im.mode}'
    a = im.getchannel('A')
    assert a.getpixel((0, 0)) == 0, f'{i}: corner not transparent'
    assert sum(a.histogram()[129:]) > 256 * 256 // 10, f'{i}: hardly anything drawn'
default = open(os.path.join(icons, 'default.txt')).read().strip()
assert default in ids, f'default.txt: {default!r}'
print(f'ok  icons: {len(ids)} ({", ".join(ids)}), 256 px; default {default}')
