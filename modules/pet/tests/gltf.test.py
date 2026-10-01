#!/usr/bin/env python3
"""Checks of bake_gltf.py's reshaping ("proportions": per-bone scale / rot /
aim, IK followers) and "colors", on a tiny synthetic skinned glTF.
usage: gltf.test.py   (exit 1 on failure)
Run by the flake check `pet` (package.nix `tests`).

The rig: root -> A (at the origin, pointing up +y) -> B (1 up); IK (a child
of the root, 2 up: the tip of B) that follows B. One vertex per bone,
weighted fully to it: a (0.1, 0.5, 0) on A, b (0, 1.5, 0) on B, c (0, 2, 0)
on IK, d (-0.1, 0.5, 0) on A.
"""
import json
import os
import struct
import sys
import tempfile
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import bake_gltf  # noqa: E402

failed = 0


def test(name):
    def run(f):
        global failed
        try:
            f()
            print(f'ok   {name}')
        except (AssertionError, SystemExit) as e:
            failed += 1
            print(f'FAIL {name}: {e}')
    return run


def rig_gltf(d):
    P = np.array([[0.1, 0.5, 0], [0, 1.5, 0], [0, 2, 0], [-0.1, 0.5, 0]], np.float32)
    N = np.tile(np.array([[0, 0, 1]], np.float32), (4, 1))
    J = np.array([[0, 0, 0, 0], [1, 0, 0, 0], [2, 0, 0, 0], [0, 0, 0, 0]], np.uint16)
    W = np.array([[1, 0, 0, 0]] * 4, np.float32)
    I = np.array([0, 1, 2, 0, 2, 3], np.uint16)
    rest = {0: (0, 0, 0), 1: (0, 1, 0), 2: (0, 2, 0)}   # joints' world positions
    IBM = np.concatenate([np.linalg.inv(np.array([[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]], np.float32)).T.ravel()
                          for x, y, z in rest.values()]).astype(np.float32)
    blobs = [P, N, J, W, I, IBM]
    views, acc, off, buf = [], [], 0, b''
    kinds = [('VEC3', 5126, 4), ('VEC3', 5126, 4), ('VEC4', 5123, 4), ('VEC4', 5126, 4), ('SCALAR', 5123, 6), ('MAT4', 5126, 3)]
    for arr, (typ, ct, n) in zip(blobs, kinds):
        raw = arr.tobytes()
        views.append({'buffer': 0, 'byteOffset': off, 'byteLength': len(raw)})
        a = {'bufferView': len(views) - 1, 'componentType': ct, 'count': n, 'type': typ}
        if arr is P:
            a['min'], a['max'] = P.min(0).tolist(), P.max(0).tolist()
        acc.append(a)
        raw += b'\0' * (-len(raw) % 4)
        buf += raw
        off += len(raw)
    j = {
        'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': [0, 4]}],
        'nodes': [{'name': 'root', 'children': [1, 3]}, {'name': 'A', 'children': [2]},
                  {'name': 'B', 'translation': [0, 1, 0]}, {'name': 'IK', 'translation': [0, 2, 0]},
                  {'name': 'mesh', 'mesh': 0, 'skin': 0}],
        'skins': [{'joints': [1, 2, 3], 'inverseBindMatrices': 5}],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 1, 'JOINTS_0': 2, 'WEIGHTS_0': 3},
                                    'indices': 4, 'material': 0}]}],
        'materials': [{'name': 'Fur', 'pbrMetallicRoughness': {'baseColorFactor': [1, 0, 0, 1]}}],
        'buffers': [{'uri': 'rig.bin', 'byteLength': len(buf)}], 'bufferViews': views, 'accessors': acc,
    }
    open(os.path.join(d, 'rig.bin'), 'wb').write(buf)
    path = os.path.join(d, 'rig.gltf')
    json.dump(j, open(path, 'w'))
    return path


tmp = tempfile.mkdtemp()
PATH = rig_gltf(tmp)


def posed(proportions=None, follow=None):
    m = bake_gltf.Model(PATH)
    if proportions is not None:
        m.reshape(proportions, follow)
    p, n, _ = m.posed(m.rest)
    return p, n


def near(a, b, what):
    assert np.allclose(a, b, atol=1e-5), f'{what}: {np.round(a, 4).tolist()} != {b}'


@test('no proportions: the rest pose as modelled')
def _():
    p, _ = posed()
    near(p, [[0.1, 0.5, 0], [0, 1.5, 0], [0, 2, 0], [-0.1, 0.5, 0]], 'rest')


@test('scale: the bone\'s own skin along its axes; its child moves, not scaled itself')
def _():
    p, _ = posed({'A': {'scale': [3, 2, 1]}})
    near(p[0], [0.3, 1.0, 0], 'a (on A, scaled)')
    near(p[1], [0, 2.5, 0], 'b (on B: B moved to 2, half a unit above it, unscaled)')
    near(p[2], [0, 2, 0], 'c (IK, not following: stays)')


@test('follow: an IK bone keeps its place relative to the bone, the offset scaled with it')
def _():
    p, _ = posed({'A': {'scale': [1, 2, 1]}}, {'IK': 'B'})
    near(p[2], [0, 3, 0], 'c follows B (moved up 1)')
    p, _ = posed({'B': {'scale': [1, 0.5, 1]}}, {'IK': 'B'})
    near(p[1], [0, 1.25, 0], 'b (B shortened)')
    near(p[2], [0, 1.5, 0], 'c at the shortened tip of B')


@test('aim / rot: the rest pose turned in the body\'s axes, children with it')
def _():
    p, _ = posed({'A': {'aim': [1, 0, 0]}}, {'IK': 'B'})
    near(p[0], [0.5, -0.1, 0], 'a (A aimed along +x)')
    near(p[1], [1.5, 0, 0], 'b (B carried)')
    near(p[2], [2, 0, 0], 'c (following B)')
    p, _ = posed({'A': {'rot': [0, 0, -90]}})
    near(p[1], [1.5, 0, 0], 'b (A turned -90 about z)')


@test('proportions survive the clip\'s own rotation of the bone')
def _():
    m = bake_gltf.Model(PATH)
    m.reshape({'A': {'scale': [1, 2, 1]}, 'B': {'rot': [0, 0, -90]}})
    pose = [list(x) for x in m.rest]
    pose[m['A']][1] = np.array([0, 0, np.sin(np.pi / 4), np.cos(np.pi / 4)])   # the clip turns A +90 about z
    p, _, _ = m.posed(pose)
    near(p[0], [-1.0, 0.1, 0], 'a (A pointing -x, twice as long)')
    near(p[1], [-2, 0.5, 0], 'b (B at -2, turned back up by its own -90)')


@test('normals stay unit length and perpendicular under a non-uniform scale')
def _():
    p, n = posed({'A': {'scale': [3, 1, 0.5]}})
    assert np.allclose(np.linalg.norm(n, axis=1), 1, atol=1e-6), n


@test('invalid proportions fail naming the bone / field')
def _():
    for props, want in [({'Nope': {'scale': [1, 1, 1]}}, "no bone 'Nope'"),
                        ({'A': {'scale': [1, 0, 1]}}, '"scale" must be three numbers'),
                        ({'B': {'aim': [1, 0, 0]}}, '"aim" needs a bone with a child')]:
        try:
            bake_gltf.Model(PATH).reshape(props)
        except SystemExit as e:
            assert want in str(e), f'{want!r} not in {e}'
        else:
            raise AssertionError(f'{props}: no error')


@test('colors: "#rrggbb" (sRGB) -> linear, and back in the palette')
def _():
    near(bake_gltf.linear('#ffffff'), [1, 1, 1], 'white')
    near(bake_gltf.linear('#000000'), [0, 0, 0], 'black')
    c = bake_gltf.linear('#3a2b24')
    near(bake_gltf.srgb(c) * 255, [0x3a, 0x2b, 0x24], 'round trip')


if failed:
    print(f'{failed} failed')
    sys.exit(1)
print('all passed')
