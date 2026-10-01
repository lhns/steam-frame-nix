#!/usr/bin/env python3
"""Checks of the built model catalog (index.py, skin.py).
usage: models.test.py <catalog dir> <base dir: bake.py's output> <test catalog dir>   (exit 1 on failure)
(the test catalog: the same models plus tests/models/, a model folder added
without any other change)
Run by the flake check `pet` (package.nix `tests`).
"""
import base64
import io
import json
import os
import sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import index  # noqa: E402
import skin  # noqa: E402
from bake_gltf import FACE_MAX  # noqa: E402

catalog, base, test_catalog = sys.argv[1:4]
base_dir = base
failed = 0


def test(name):
    def run(f):
        global failed
        try:
            f()
            print(f'ok   {name}')
        except AssertionError as e:
            failed += 1
            print(f'FAIL {name}: {e}')
    return run


idx = json.load(open(os.path.join(catalog, 'models.json')))
objs = sorted(f for f in os.listdir(base) if f.endswith('.obj'))
tex = lambda d: np.asarray(Image.open(os.path.join(d, 'cat.png')).convert('RGB')).astype(int)


@test('index: default, order, the five cats, one frame set, 48 px thumbs')
def _():
    assert idx['default'] in idx['models'], idx['default']
    assert idx['order'][0] == 'ginger' and set(idx['order']) == set(idx['models']), idx['order']
    names = [idx['models'][k]['name'] for k in idx['order']]
    for n in ['Ginger', 'Tuxedo', 'Blue', 'Cream', 'Snow']:
        assert n in names, f'{n} missing ({names})'
    for k, m in idx['models'].items():
        assert m['frames'] in idx['frameSets'], f'{k}: frame set {m["frames"]}'
        assert m['thumb'].startswith('data:image/png;base64,'), f'{k}: thumb'
        im = Image.open(io.BytesIO(base64.b64decode(m['thumb'].split(',', 1)[1])))
        assert im.size == (48, 48) and im.mode == 'RGBA', f'{k}: thumb {im.size} {im.mode}'
    assert idx['models']['ginger']['dir'] == base and idx['models']['ginger']['sub'] is None, 'ginger: the baked frames'


@test('model dirs: own cat.png + cat.mtl, every frame a plain copy of the base\'s')
def _():
    for k, m in idx['models'].items():
        if m['kind'] not in ('recolor', 'texture'):   # (the coats; an animal has frames of its own)
            continue
        d = m['dir']
        assert d == os.path.join(catalog, m['sub']), f'{k}: dir {d}'
        for f in ['cat.png', 'cat.mtl']:
            p = os.path.join(d, f)
            assert os.path.isfile(p) and not os.path.islink(p), f'{k}: own {f}'
        assert open(os.path.join(d, 'cat.mtl')).read() == open(os.path.join(base, 'cat.mtl')).read(), f'{k}: mtl'
        assert 'map_Kd cat.png' in open(os.path.join(d, 'cat.mtl')).read(), f'{k}: mtl names cat.png'
        for f in objs + ['frames.json']:
            p = os.path.join(d, f)
            assert not os.path.islink(p) and os.path.isfile(p), f'{k}: {f} not a plain file'
        for f in objs[::25] + ['frames.json']:
            assert open(os.path.join(d, f), 'rb').read() == open(os.path.join(base, f), 'rb').read(), f'{k}: {f} differs'
        first = open(os.path.join(d, objs[0])).readline().strip()
        assert first == 'mtllib cat.mtl', f'{k}: relative mtllib ({first})'


@test('recolours: >= 90 % of the fur texels changed, nothing else')
def _():
    b = tex(base)
    fur = skin.fur_mask(b.astype(float) / 255)
    for k, m in idx['models'].items():
        if m['kind'] != 'recolor':
            continue
        t = tex(m['dir'])
        changed = (t != b).any(-1)
        assert changed[fur].mean() >= 0.9, f'{k}: {changed[fur].mean():.2f} of the fur changed'
        assert not changed[~fur].any(), f'{k}: {changed[~fur].sum()} other texels changed'


@test('the coats: Tuxedo dark with white chest / muzzle / paws; Blue blue-grey; Cream warm pale; Snow near white')
def _():
    b = tex(base)
    fur = skin.fur_mask(b.astype(float) / 255)
    mean = lambda k, mask: tex(idx['models'][k]['dir'])[mask].mean(0)
    marks = np.zeros(fur.shape, bool)
    for name in ['chest', 'muzzle', 'paws']:
        for x0, x1, y0, y1 in skin.PATTERNS[name]:
            marks[y0:y1 + 1, x0:x1 + 1] = True
    marks &= fur
    body = fur & ~marks
    t = mean('tuxedo', body)
    assert t.max() < 60, f'tuxedo body dark ({t})'
    w = mean('tuxedo', marks)
    assert w.min() > 220 and w.max() - w.min() < 10, f'tuxedo marks white ({w})'
    bl = mean('blue', fur)
    assert bl[2] > bl[0] + 10 and 90 < bl.mean() < 190, f'blue-grey ({bl})'
    c = mean('cream', fur)
    assert c[0] > c[2] + 25 and c.mean() > 170, f'cream ({c})'
    s = mean('snow', fur)
    assert s.min() > 215 and s.max() - s.min() < 15, f'snow ({s})'


@test('animals: frames of their own, <= 3000 triangles per frame, one texture, zones per pose')
def _():
    animals = [k for k, m in idx['models'].items() if m['kind'] == 'gltf']
    assert {'shiba', 'fox'} <= set(animals), animals
    for k in animals:
        m = idx['models'][k]
        d, fs = m['dir'], idx['frameSets'][m['frames']]
        assert m['frames'] == k and m['group'] == 'animals', f'{k}: frames {m["frames"]}, group {m["group"]}'
        assert os.path.realpath(os.path.join(catalog, m['sub'])) == os.path.realpath(d), f'{k}: {m["sub"]} -> {d}'
        assert json.load(open(os.path.join(d, 'frames.json'))) == fs, f'{k}: frame set = its frames.json'
        mtl = open(os.path.join(d, 'cat.mtl')).read()
        assert mtl.count('map_Kd') == 1 and 'map_Kd cat.png' in mtl and os.path.isfile(os.path.join(d, 'cat.png')), f'{k}: one texture'
        objs = sorted(f for f in os.listdir(d) if f.endswith('.obj'))
        assert len(objs) == sum(c['frames'] for c in fs['clips'].values()), f'{k}: {len(objs)} OBJs'
        worst = 0
        for f in objs:
            lines = open(os.path.join(d, f)).read().split('\n')
            assert lines[0] == 'mtllib cat.mtl', f'{k}/{f}: {lines[0]}'
            assert sum(ln.startswith('usemtl ') for ln in lines) == 1, f'{k}/{f}: one material'
            worst = max(worst, sum(ln.startswith('f ') for ln in lines))
        assert 0 < worst <= FACE_MAX, f'{k}: {worst} triangles in a frame'
        for name, c in fs['clips'].items():
            for i in range(c['frames']):
                assert os.path.isfile(os.path.join(d, f'{name}_{i}.obj')), f'{k}: {name}_{i}.obj'
        loops = {'stand': 'idle', 'sit': 'sit', 'lie': 'lie', 'sleep': 'sleep', 'fall': 'fall', 'dangle': 'dangle'}
        for pose, clip in loops.items():
            if clip in fs['clips']:
                z = fs['poseZones'].get(pose, {})
                assert all(n in z for n in ('scruff', 'head', 'back')), f'{k}: zones of {pose} ({z})'
        assert 0.2 <= fs['height'] <= 0.6 and fs['walkSpeed'] > 0.05, f'{k}: height {fs["height"]}, walk {fs["walkSpeed"]}'
        print(f'     {k}: {worst} triangles, {len(objs)} frames, {len(fs["clips"])} clips')


def extent(d, frame):
    v = np.array([[float(x) for x in ln.split()[1:4]] for ln in open(os.path.join(d, frame)) if ln.startswith('v ')])
    return v.max(0) - v.min(0)


@test('the Dachshund: the Shiba\'s clips and species ("extends"), long and low, black and tan')
def _():
    dm, sm = idx['models']['dachshund'], idx['models']['shiba']
    df, sf = idx['frameSets']['dachshund'], idx['frameSets']['shiba']
    assert dm['name'] == 'Dachshund' and dm['group'] == 'animals', dm
    assert set(df['clips']) == set(sf['clips']), sorted(set(df['clips']) ^ set(sf['clips']))
    assert df.get('species') == sf.get('species'), 'species'
    assert idx['order'].index('dachshund') > idx['order'].index('shiba'), idx['order']
    de, se = extent(dm['dir'], 'idle_0.obj'), extent(sm['dir'], 'idle_0.obj')
    dr, sr = de[2] / de[1], se[2] / se[1]   # length / height, standing
    assert dr > 1.4 * sr, f'length / height {dr:.2f} (the Shiba {sr:.2f})'
    assert abs(de[1] - 0.27) < 0.005, f'height {de[1]:.3f}'
    t = tex(dm['dir']).reshape(-1, 3)
    for c in ['#3a2b24', '#c07236']:
        want = np.array([int(c[i:i + 2], 16) for i in (1, 3, 5)])
        assert np.abs(t - want).max(1).min() <= 2, f'{c} not in the palette'
    print(f'     dachshund: length / height {dr:.2f} (shiba {sr:.2f}), walk {df["walkSpeed"]} m/s')


@test('invalid specs: the build fails naming the model and the field')
def _():
    good = {'id': 'x', 'name': 'X', 'kind': 'recolor', 'fur': ['#000000', '#ffffff']}
    base = {'id': 'b', 'name': 'B', 'kind': 'base', 'default': True}
    assert index.validate([base, good]) == [], index.validate([base, good])
    cases = [
        ({**good, 'kind': 'dragon'}, 'x: "kind"'),
        ({**good, 'name': ''}, 'x: "name"'),
        ({**good, 'fur': ['red', '#ffffff']}, 'x: "fur"'),
        ({**good, 'white': ['stripes']}, "x: \"white\": unknown marking 'stripes'"),
        ({**good, 'kind': 'texture'}, 'x: "png"'),
        ({**good, 'kind': 'gltf', 'height': 0.3}, 'x: no baked frames'),
        ({**good, 'kind': 'gltf', 'height': 0.3, 'thumbFrame': 'nope_0'}, "x: \"thumbFrame\": no baked frame 'nope_0'"),
        ({**good, 'id': 'a b'}, 'the id (folder name)'),
        ({**good, 'private': 'yes'}, 'x: "private" must be true or false'),
        ({**good, 'rights': 'Someone else'}, 'x: "rights" (a character someone else owns) needs "private": true'),
        ({**good, 'rights': 'Someone else', 'private': False}, 'x: "rights"'),
    ]
    for spec, want in cases:
        errs = index.validate([base, spec])
        assert any(want in e for e in errs), f'{want!r} not in {errs}'
    assert index.validate([base, {**good, 'rights': 'Someone else', 'private': True}]) == []
    assert any('exactly one model needs "default": true' in e for e in index.validate([{**base, 'default': False}, good]))
    assert any('two models with this id' in e for e in index.validate([base, good, good]))
    assert any("defaultModel 'nope'" in e for e in index.validate([base, good], 'nope'))
    # the build step itself: exit != 0 with the message
    import subprocess
    import tempfile
    with tempfile.TemporaryDirectory() as t:
        p = os.path.join(t, 'spec.json')
        json.dump({'default': None, 'models': [base, {**good, 'fur': ['#000']}]}, open(p, 'w'))
        r = subprocess.run([sys.executable, index.__file__, p, base_dir, os.path.join(t, 'out')], capture_output=True, text=True)
        assert r.returncode != 0 and 'x: "fur" must be two colours' in r.stderr, (r.returncode, r.stderr)


@test('built-in models: none private (package.nix refuses one), every model of the catalog public')
def _():
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models')
    for d in sorted(os.listdir(root)):
        spec = json.load(open(os.path.join(root, d, 'model.json')))
        assert spec.get('private', False) is False and 'rights' not in spec, f'{d}: private'
    assert all(m['private'] is False for m in idx['models'].values()), [k for k, m in idx['models'].items() if m['private']]


@test('model folders added (tests/models: testcoat, testprivate) show up in the index, nothing else changed')
def _():
    t = json.load(open(os.path.join(test_catalog, 'models.json')))
    assert set(t['models']) == set(idx['models']) | {'testcoat', 'testprivate'}, sorted(t['models'])
    m = t['models']['testcoat']
    assert m['name'] == 'Test Coat' and m['kind'] == 'texture' and m['group'] == 'coats', m
    assert t['order'].index('testcoat') > t['order'].index('snow') and t['order'].index('testcoat') < t['order'].index('shiba'), t['order']
    im = Image.open(io.BytesIO(base64.b64decode(m['thumb'].split(',', 1)[1])))
    assert im.size == (48, 48), im.size
    assert t['default'] == idx['default'] and t['frameSets'].keys() == idx['frameSets'].keys()
    got = np.asarray(Image.open(os.path.join(m['dir'], 'cat.png')).convert('RGB'))
    assert got.shape == (64, 64, 3), got.shape
    assert m['private'] is False, m


@test('a private model added like an extraModels folder (tests/models/testprivate) builds and is marked private')
def _():
    t = json.load(open(os.path.join(test_catalog, 'models.json')))
    m = t['models']['testprivate']
    assert m['private'] is True and m['kind'] == 'recolor' and m['group'] == 'coats', m
    assert os.path.isfile(os.path.join(m['dir'], 'cat.png')), m['dir']


if failed:
    print(f'{failed} failed')
    sys.exit(1)
print('all passed')
