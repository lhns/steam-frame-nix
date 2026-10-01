#!/usr/bin/env python3
"""Build the VR pet's model catalog: one directory per model and the index
(models.json) that the SteamVR patch embeds (package.nix `catalog`).

usage: index.py spec.json base-dir out-dir
       index.py --icons spec.json catalog-dir icons-dir [px]
         (the "+" menu icons: icons-dir/<id>.png, px square (256), the
         same pictures as the thumbs; icons-dir/default.txt: the default's
         id; package.nix `icons`)

spec.json (package.nix: every models/<id>/model.json and steamFrame.pet.extraModels,
their files resolved to store paths; a gltf model's "baked": bake_gltf.py's
output):
  { "default": id | null, "models": [ { "id", "name", "kind", ... }, ... ] }
The kinds and fields: docs/pet-models.md. An invalid spec fails the build
with a message naming the model and the field (validate()).

The coats (recolor, texture) get out-dir/<id>/ with their own cat.png and
cat.mtl and copies of the base's frames (*.obj, frames.json): an OBJ's
`mtllib cat.mtl` is looked up next to the OBJ, so the same frames load with
that model's texture. Copies, not symlinks: whether SteamVR's loader
resolves a symlinked OBJ's mtllib next to the link or next to its target
could not be checked (the headset in standby loads nothing), and a copy
works either way; the store's auto-optimise hardlinks the identical copies,
so they cost no space. An animal's directory is its bake (out-dir/<id> a
link to it, for the preview); its frames are a frame set of their own.

out-dir/models.json:
  { "default": id, "order": [ids],
    "frameSets": { name: <frames.json> },
    "models": { id: { "name", "kind", "group", "dir", "sub", "frames", "private", "thumb" } } }
  dir: the model's directory (absolute); sub: its name under out-dir (null
  for the base); frames: its frame set (the base's id for the cat and its
  coats, the animal's id for an animal); group: "coats" or "animals" (the
  menu puts a line between groups); private: the spec's "private" (personal
  use only: a model of a character someone else owns, whose "rights" says
  so; extraModels only, never a built-in model); thumb: a
  48 px render of the sitting animal (thumb.py; standing without a sit; an
  animal's "thumbFrame", e.g. "idle_0", when that shows it better) or the
  spec's own "thumb", as a data: URI.
"""
import base64
import io
import json
import os
import re
import shutil
import sys
import tempfile
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import skin   # noqa: E402
import thumb  # noqa: E402

THUMB_PX = 48
ICON_PX = 256   # the "+" menu icons (icons())
KINDS = ('base', 'recolor', 'texture', 'gltf')
HEX = re.compile(r'^#[0-9a-fA-F]{6}$')


class SpecError(SystemExit):
    pass


def validate(specs, default=None):
    """The specs (list) and the chosen default: a list of problems, each
    naming the model and the field ([] when fine)."""
    errs = []
    ids = [m.get('id') for m in specs]
    for i in sorted({i for i in ids if ids.count(i) > 1}):
        errs.append(f'{i}: two models with this id')
    for m in specs:
        mid = m.get('id')
        e = lambda msg: errs.append(f'{mid}: {msg}')
        if not isinstance(mid, str) or not re.match(r'^[A-Za-z0-9_-]+$', mid or ''):
            e('the id (folder name) must be letters, digits, - or _')
        if not isinstance(m.get('name'), str) or not m['name'].strip():
            e('"name" (the menu\'s text) is missing')
        kind = m.get('kind')
        if kind not in KINDS:
            e(f'"kind" must be one of {", ".join(KINDS)} (is {kind!r})')
        if 'order' in m and not isinstance(m['order'], (int, float)):
            e('"order" must be a number')
        if 'default' in m and not isinstance(m['default'], bool):
            e('"default" must be true or false')
        if 'private' in m and not isinstance(m['private'], bool):
            e('"private" must be true or false')
        if 'rights' in m and m.get('private') is not True:
            e('"rights" (a character someone else owns) needs "private": true (personal use only, never published)')
        if kind == 'recolor':
            fur = m.get('fur')
            if not (isinstance(fur, list) and len(fur) == 2 and all(isinstance(c, str) and HEX.match(c) for c in fur)):
                e('"fur" must be two colours ["#rrggbb" (dark), "#rrggbb" (light)]')
            for w in m.get('white', []):
                if w not in skin.PATTERNS:
                    e(f'"white": unknown marking {w!r} (known: {", ".join(skin.PATTERNS)})')
        if kind == 'texture' and not (isinstance(m.get('png'), str) and os.path.isfile(m['png'])):
            e('"png" must be a PNG file (its path in the model\'s folder)')
        if kind == 'gltf':
            b = m.get('baked')
            if not (isinstance(b, str) and os.path.isfile(os.path.join(b, 'frames.json'))):
                e('no baked frames (bake_gltf.py)')
            if not isinstance(m.get('height'), (int, float)) or not 0.05 <= m['height'] <= 2:
                e('"height" (m, standing) must be a number between 0.05 and 2')
            tf = m.get('thumbFrame')
            if tf is not None and not (isinstance(b, str) and isinstance(tf, str) and os.path.isfile(os.path.join(b, tf + '.obj'))):
                e(f'"thumbFrame": no baked frame {tf!r} (a clip and its frame number, e.g. "idle_0")')
    bases = [m['id'] for m in specs if m.get('kind') == 'base']
    if len(bases) > 1:
        errs.append(f'more than one kind "base": {", ".join(bases)}')
    if any(m.get('kind') in ('recolor', 'texture') for m in specs) and not bases:
        errs.append('coats (kind recolor / texture) need the base model (kind "base")')
    flagged = [m['id'] for m in specs if m.get('default') is True]
    if default is None:
        if len(flagged) != 1:
            errs.append(f'exactly one model needs "default": true (found {len(flagged)}: {", ".join(flagged) or "none"}; '
                        'or set steamFrame.pet.defaultModel)')
    elif default not in ids:
        errs.append(f'steamFrame.pet.defaultModel {default!r} is not a model ({", ".join(i for i in ids if i)})')
    return errs


def thumb_png(m, d, px):
    """PNG bytes of model m's picture, px square: the spec's own "thumb"
    (scaled, centred) or thumb.py's render of its sitting frame in d (its
    "thumbFrame", else sit_0, else idle_0)."""
    if m.get('thumb'):
        im = Image.open(m['thumb']).convert('RGBA')
        im.thumbnail((px, px), Image.LANCZOS)
        sq = Image.new('RGBA', (px, px), (0, 0, 0, 0))
        sq.alpha_composite(im, ((px - im.width) // 2, (px - im.height) // 2))
        buf = io.BytesIO()
        sq.save(buf, 'PNG', optimize=True)
        return buf.getvalue()
    pose = next(f for f in (m.get('thumbFrame', '') + '.obj', 'sit_0.obj', 'idle_0.obj') if os.path.isfile(os.path.join(d, f)))
    with tempfile.TemporaryDirectory() as t:
        out = os.path.join(t, 't.png')
        thumb.render(os.path.join(d, pose), os.path.join(d, 'cat.png'), out, px)
        return open(out, 'rb').read()


def thumb_uri(m, d):
    return 'data:image/png;base64,' + base64.b64encode(thumb_png(m, d, THUMB_PX)).decode()


def icons(spec_path, catalog, out, px=ICON_PX):
    """The "+" menu icons: out/<id>.png (px square, as the thumbs) for every
    model of the catalog built from spec_path, and out/default.txt (the
    default model's id)."""
    spec = json.load(open(spec_path))
    index = json.load(open(os.path.join(catalog, 'models.json')))
    os.makedirs(out, exist_ok=True)
    for m in spec['models']:
        with open(os.path.join(out, m['id'] + '.png'), 'wb') as f:
            f.write(thumb_png(m, index['models'][m['id']]['dir'], px))
    with open(os.path.join(out, 'default.txt'), 'w') as f:
        f.write(index['default'] + '\n')


def main(spec_path, base, out):
    spec = json.load(open(spec_path))
    errs = validate(spec['models'], spec.get('default'))
    if errs:
        raise SpecError('invalid VR pet model spec (docs/pet-models.md):\n  ' + '\n  '.join(errs))
    default = spec.get('default') or next(m['id'] for m in spec['models'] if m.get('default') is True)
    os.makedirs(out, exist_ok=True)
    base_id = next((m['id'] for m in spec['models'] if m['kind'] == 'base'), None)
    frame_sets = {}
    if base_id:
        frame_sets[base_id] = json.load(open(os.path.join(base, 'frames.json')))
        shared = sorted(f for f in os.listdir(base) if f.endswith('.obj')) + ['frames.json']
    models, order = {}, []
    for m in sorted(spec['models'], key=lambda m: (m.get('order', 100), m['name'])):
        mid, kind = m['id'], m['kind']
        if kind == 'base':
            d, sub, frames = base, None, base_id
        elif kind == 'gltf':
            d, sub, frames = m['baked'], mid, mid
            os.symlink(d, os.path.join(out, mid))
            frame_sets[mid] = json.load(open(os.path.join(d, 'frames.json')))
        else:
            d, sub, frames = os.path.join(out, mid), mid, base_id
            os.makedirs(d)
            png = os.path.join(d, 'cat.png')
            if kind == 'recolor':
                img, _ = skin.recolor(Image.open(os.path.join(base, 'cat.png')), m)
                img.save(png, optimize=True)
            else:
                Image.open(m['png']).convert('RGB').save(png, optimize=True)
            shutil.copyfile(os.path.join(base, 'cat.mtl'), os.path.join(d, 'cat.mtl'))
            for f in shared:
                shutil.copyfile(os.path.join(base, f), os.path.join(d, f))
        models[mid] = {'name': m['name'], 'kind': kind, 'group': m.get('group', 'animals' if kind == 'gltf' else 'coats'),
                       'dir': d, 'sub': sub, 'frames': frames, 'private': m.get('private', False),
                       'thumb': thumb_uri(m, d)}
        order.append(mid)
    json.dump({'default': default, 'order': order, 'frameSets': frame_sets, 'models': models},
              open(os.path.join(out, 'models.json'), 'w'), separators=(',', ':'))


if __name__ == '__main__':
    if sys.argv[1] == '--icons':
        icons(*sys.argv[2:5], *[int(a) for a in sys.argv[5:6]])
    else:
        main(*sys.argv[1:4])
