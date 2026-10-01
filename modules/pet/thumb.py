#!/usr/bin/env python3
"""Render the VR pet's app icon: one baked frame (OBJ + texture from bake.py)
as a three-quarter view from slightly above, lit, depth-buffered, on a
transparent background; rendered at SS x the size, downscaled, cropped to
the cat and centred on a square.

usage: thumb.py frame.obj texture.png out.png [size]

Software rasterizer (numpy): perspective camera, per-pixel barycentric
interpolation of UVs and normals, a warm key light, a cool fill, ambient and
a rim light, a soft contact shadow under the paws.
"""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SS = 2              # supersampling (512 px for a 256 px icon)
AZIMUTH = 32        # degrees from the cat's front (+Z) toward its left (+X)
ELEVATION = 16      # degrees above the horizon
FOV = 24            # degrees (a long lens: little distortion)
MARGIN = 0.06       # share of the icon left around the cat
OUTLINE = 1         # px (at the icon's size) of dark outline


def load_obj(path):
    v, vt, vn, f = [], [], [], []
    for line in open(path):
        p = line.split()
        if not p:
            continue
        if p[0] == 'v':
            v.append([float(x) for x in p[1:4]])
        elif p[0] == 'vt':
            vt.append([float(x) for x in p[1:3]])
        elif p[0] == 'vn':
            vn.append([float(x) for x in p[1:4]])
        elif p[0] == 'f':
            f.append([[int(i) - 1 if i else -1 for i in (c.split('/') + ['', ''])[:3]] for c in p[1:4]])
    return np.array(v), np.array(vt), np.array(vn), np.array(f)


def normalize(a):
    return a / np.maximum(np.linalg.norm(a, axis=-1, keepdims=True), 1e-9)


def look_at(eye, target):
    fwd = normalize(target - eye)
    right = normalize(np.cross(fwd, [0.0, 1.0, 0.0]))
    up = np.cross(right, fwd)
    return np.stack([right, up, -fwd])   # rows: camera x, y, z (looking along -z)


def render(obj, tex_path, out, size=256):
    V, VT, VN, F = load_obj(obj)
    tex = np.asarray(Image.open(tex_path).convert('RGBA')).astype(np.float32) / 255
    th, tw = tex.shape[:2]
    R = size * SS

    lo, hi = V.min(0), V.max(0)
    centre = (lo + hi) / 2
    radius = np.linalg.norm(hi - lo) / 2
    az, el = np.radians(AZIMUTH), np.radians(ELEVATION)
    dirn = np.array([np.sin(az) * np.cos(el), np.sin(el), np.cos(az) * np.cos(el)])
    dist = radius / np.sin(np.radians(FOV) / 2) * 1.05
    eye = centre + dirn * dist
    rot = look_at(eye, centre)
    cam = (V - eye) @ rot.T                    # camera space
    f = 1 / np.tan(np.radians(FOV) / 2)
    sx = (cam[:, 0] / -cam[:, 2] * f * 0.5 + 0.5) * R
    sy = (0.5 - cam[:, 1] / -cam[:, 2] * f * 0.5) * R
    depth = -cam[:, 2]

    # lights (world space, pointing toward the light)
    key = normalize(np.array([0.6, 0.9, 0.7]))
    fill = normalize(np.array([-0.8, 0.3, 0.4]))
    view = normalize(eye - centre)

    zbuf = np.full((R, R), np.inf)
    rgb = np.zeros((R, R, 3))
    alpha = np.zeros((R, R))
    for tri in F:
        vi, ti, ni = tri[:, 0], tri[:, 1], tri[:, 2]
        x, y, z = sx[vi], sy[vi], depth[vi]
        x0, x1 = int(max(0, np.floor(x.min()))), int(min(R - 1, np.ceil(x.max())))
        y0, y1 = int(max(0, np.floor(y.min()))), int(min(R - 1, np.ceil(y.max())))
        if x1 < x0 or y1 < y0:
            continue
        area = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0])
        if abs(area) < 1e-12:
            continue
        px, py = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        w0 = ((x[1] - px) * (y[2] - py) - (x[2] - px) * (y[1] - py)) / area
        w1 = ((x[2] - px) * (y[0] - py) - (x[0] - px) * (y[2] - py)) / area
        w2 = 1 - w0 - w1
        inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not inside.any():
            continue
        # perspective-correct weights
        iz = w0 / z[0] + w1 / z[1] + w2 / z[2]
        zz = 1 / iz
        pw = np.stack([w0 / z[0], w1 / z[1], w2 / z[2]], -1) * zz[..., None]
        sub = zbuf[y0:y1 + 1, x0:x1 + 1]
        m = inside & (zz < sub)
        if not m.any():
            continue
        w = pw[m]
        uv = w @ VT[ti] if ti[0] >= 0 else np.zeros((len(w), 2))
        n = normalize(w @ VN[ni]) if ni[0] >= 0 else np.tile(normalize(np.cross(V[vi[1]] - V[vi[0]], V[vi[2]] - V[vi[0]])), (len(w), 1))
        if (n @ view).mean() < 0:              # a back-facing normal (double-sided): flip
            n = -n
        tx = np.clip((uv[:, 0] % 1) * (tw - 1), 0, tw - 1)
        ty = np.clip((1 - uv[:, 1] % 1) * (th - 1), 0, th - 1)
        c = bilinear(tex, tx, ty)[:, :3]
        diff = np.clip(n @ key, 0, 1)
        wrap = np.clip((n @ fill + 0.3) / 1.3, 0, 1)
        rim = np.clip(1 - np.abs(n @ view), 0, 1) ** 3
        up = np.clip(n[:, 1] * 0.5 + 0.5, 0, 1)
        light = (0.30 + 0.12 * up)[:, None] * np.array([0.93, 0.96, 1.0]) \
            + (0.80 * diff)[:, None] * np.array([1.0, 0.95, 0.86]) \
            + (0.20 * wrap)[:, None] * np.array([0.75, 0.85, 1.0])
        col = c * light + (0.22 * rim)[:, None] * np.array([1.0, 0.97, 0.9])
        sub[m] = zz[m]
        rgb[y0:y1 + 1, x0:x1 + 1][m] = np.clip(col, 0, 1)
        alpha[y0:y1 + 1, x0:x1 + 1][m] = 1

    img = Image.fromarray((np.dstack([rgb, alpha]) * 255).round().astype(np.uint8), 'RGBA')
    # a thin dark outline (reads on dark and light menus)
    # (thin parts such as the whiskers opened away first: no dark blobs there)
    sil = img.getchannel('A').filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))
    sil = sil.filter(ImageFilter.MaxFilter(2 * OUTLINE * SS + 1))
    line = Image.new('RGBA', (R, R), (40, 26, 18, 0))
    line.putalpha(sil.point(lambda a: int(a * 0.85)))
    line.alpha_composite(img)
    img = line

    # contact shadow: a soft ellipse on the floor under the body
    shadow = Image.new('L', (R, R), 0)
    # (its footprint: the lower third, without the tail reaching back)
    low = V[(V[:, 1] < lo[1] + (hi[1] - lo[1]) * 0.33)]
    low = low[low[:, 2] > np.percentile(low[:, 2], 25)]
    if len(low):
        fc = (low.min(0) + low.max(0)) / 2
        rx, rz = (low.max(0) - low.min(0))[[0, 2]] * 0.62
        ring = np.array([[fc[0] + np.cos(a) * rx, lo[1], fc[2] + np.sin(a) * rz] for a in np.linspace(0, 2 * np.pi, 48)])
        rc = (ring - eye) @ rot.T
        pts = [((p[0] / -p[2] * f * 0.5 + 0.5) * R, (0.5 - p[1] / -p[2] * f * 0.5) * R) for p in rc]
        ImageDraw.Draw(shadow).polygon(pts, fill=95)
        shadow = shadow.filter(ImageFilter.GaussianBlur(R * 0.015))
    base = Image.new('RGBA', (R, R), (20, 16, 24, 0))
    base.putalpha(shadow)
    base.alpha_composite(img)
    img = base

    # crop to the cat (and shadow), centre on a square with a margin, downscale
    bbox = img.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
    img = img.crop(bbox)
    side = int(max(img.size) / (1 - 2 * MARGIN))
    sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    sq.alpha_composite(img, ((side - img.size[0]) // 2, (side - img.size[1]) // 2))
    sq.resize((size, size), Image.LANCZOS).save(out, optimize=True)


def bilinear(tex, x, y):
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    x1, y1 = np.minimum(x0 + 1, tex.shape[1] - 1), np.minimum(y0 + 1, tex.shape[0] - 1)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    return (tex[y0, x0] * (1 - fx) * (1 - fy) + tex[y0, x1] * fx * (1 - fy)
            + tex[y1, x0] * (1 - fx) * fy + tex[y1, x1] * fx * fy)


if __name__ == '__main__':
    render(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 256)
