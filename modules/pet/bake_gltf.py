#!/usr/bin/env python3
"""Bake another animal for the VR pet from a rigged, animated glTF: the same
output as bake.py (one static OBJ per frame, cat.png, cat.mtl, frames.json),
driven by the model's spec (models/<id>/model.json, kind "gltf").

usage: bake_gltf.py model.json model.glb out-dir fps

The spec's fields (clips, keys, layers, hang, lift, proportions, colors,
texture, zones, follow, feet) and how they map: docs/pet-models.md.

Fails (with a message) on an unknown clip or bone, and when a frame has more
than FACE_MAX triangles (vrcompositor draws every mounted frame).
"""
import base64, io, json, math, os, sys
import numpy as np
from PIL import Image
from rig import QI, Rig, accessor, mat_q, qbetween, qeuler, qinv, qmat, qmul, qnorm, slerp, smooth, walk_speed, write_mtl, write_obj

FACE_MAX = 3000
# The core's pose loops (core.js LOOP): a glTF clip under one of these names loops.
LOOPS = {'idle', 'walk', 'sit', 'lie', 'sleep', 'purr', 'sitpurr', 'liepurr', 'dangle', 'fall'}
# Grounded rest frames of the core's poses (poseZones): pose -> its loop clip.
POSES = {'stand': 'idle', 'sit': 'sit', 'lie': 'lie', 'sleep': 'sleep', 'fall': 'fall', 'dangle': 'dangle'}
SHADE = (0.72, 1.0)   # palette ramp: floor .. top of the standing animal


def fail(msg):
    raise SystemExit(f'bake_gltf: {msg}')


def linear(hexc):
    """'#rrggbb' (sRGB, as a colour picker shows it) -> linear RGB (glTF's baseColorFactor)."""
    if not (isinstance(hexc, str) and len(hexc) == 7 and hexc[0] == '#'):
        fail(f'colors: {hexc!r} is not "#rrggbb"')
    c = np.array([int(hexc[i:i + 2], 16) / 255 for i in (1, 3, 5)])
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(c):
    c = np.clip(np.asarray(c, float), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


class Model(Rig):
    """Every mesh of the glTF's scene: skinned (JOINTS_0 / WEIGHTS_0 and the
    node's skin) or carried rigidly by its node; per vertex its material."""

    def __init__(self, path):
        self.own, self.turn, self.follow = {}, {}, {}   # (reshape)
        super().__init__(path)
        j, binc = self.j, self.bin
        scene = j['scenes'][j.get('scene', 0)]
        under = set()

        def visit(i):
            under.add(i)
            for c in self.nodes[i].get('children', []):
                visit(c)
        for i in scene['nodes']:
            visit(i)
        self.parts, base, F = [], 0, []
        for ni in sorted(under):
            n = self.nodes[ni]
            if 'mesh' not in n:
                continue
            skin = j['skins'][n['skin']] if 'skin' in n else None
            ibm = accessor(j, binc, skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1) if skin else None
            for prim in j['meshes'][n['mesh']]['primitives']:
                if prim.get('mode', 4) != 4:
                    continue
                at = prim['attributes']
                P = accessor(j, binc, at['POSITION'])
                if 'NORMAL' not in at:
                    fail(f'mesh {n["mesh"]}: no normals')
                idx = accessor(j, binc, prim['indices']).astype(int).reshape(-1, 3) if 'indices' in prim else np.arange(len(P)).reshape(-1, 3)
                part = {'node': ni, 'skin': skin, 'ibm': ibm, 'P': P, 'N': accessor(j, binc, at['NORMAL']),
                        'UV': accessor(j, binc, at['TEXCOORD_0']) if 'TEXCOORD_0' in at else None,
                        'mat': prim.get('material')}
                if skin:
                    part['J'] = accessor(j, binc, at['JOINTS_0']).astype(int)
                    W = accessor(j, binc, at['WEIGHTS_0'])
                    part['W'] = W / W.sum(axis=1, keepdims=True)
                part['dom'] = np.array(skin['joints'])[part['J'][np.arange(len(P)), part['W'].argmax(axis=1)]] if skin else np.full(len(P), ni)
                self.parts.append(part)
                F.append(idx + base)
                base += len(P)
        if not self.parts:
            fail('no triangle meshes in the scene')
        self.F = np.concatenate(F)
        self.nverts = base
        self.dom = np.concatenate([pt['dom'] for pt in self.parts])   # per vertex: the node that moves it most

    def reshape(self, proportions, follow=None):
        """Change the animal's build for every pose (the spec's
        "proportions": {bone: {"scale": [x, y, z], "rot": [x, y, z],
        "aim": [x, y, z]}}):
          scale  the skin the bone moves, in the bone's own axes (y: along
                 the bone), from its joint; its children's joints move with
                 it, but they are not scaled themselves (so a long back
                 does not make long legs)
          rot / aim  the bone's rest pose turned (degrees about the body's
                 axes) or aimed, as in a key (a floppy ear, a straight tail);
                 kept in every clip, on top of the clip's own motion
        Bones outside the chains ("follow": IK targets the feet are skinned
        to) stay where they were relative to the bone they follow, the
        offset scaled with it (shorter legs keep their paws), turned as in
        the clip (a paw stays flat on the floor). A reshaped walk's speed
        counts only the feet moving back (rig.walk_speed back_only)."""
        for name, p in proportions.items():
            if name not in self.idx:
                fail(f'proportions: no bone {name!r} in the rig')
            if 'scale' in p:
                sc = p['scale']
                if not (isinstance(sc, list) and len(sc) == 3 and all(isinstance(x, (int, float)) and 0 < x <= 10 for x in sc)):
                    fail(f'proportions: {name}: "scale" must be three numbers > 0')
                self.own[self[name]] = np.asarray(sc, float)
        self.follow = {self[k]: self[v] for k, v in (follow or {}).items()}
        # Rest offsets, parents first (a child turns with its parent), in
        # the body's axes as a key's (Baker.turned).
        rest = [list(p) for p in self.rest]
        for i in self.order:
            p = proportions.get(self.nodes[i].get('name'))
            if not p or ('rot' not in p and 'aim' not in p):
                continue
            g = Rig.world(self, rest)
            wp = mat_q(g[self.parent[i]][:3, :3]) if i in self.parent else QI
            if 'rot' in p:
                e = qeuler(*p['rot'])
                rest[i][1] = qnorm(qmul(qinv(wp), qmul(e, qmul(wp, rest[i][1]))))
            if 'aim' in p:
                g = Rig.world(self, rest)
                kids = self.nodes[i].get('children', [])
                if not kids:
                    fail(f'proportions: {self.nodes[i].get("name")}: "aim" needs a bone with a child')
                e = qbetween(g[kids[0]][:3, 3] - g[i][:3, 3], np.asarray(p['aim'], float))
                rest[i][1] = qnorm(qmul(qinv(wp), qmul(e, qmul(wp, rest[i][1]))))
            self.turn[i] = qnorm(qmul(qinv(self.rest[i][1]), rest[i][1]))
        # A follower after the bone it follows (and its children after it).
        order, seen = [], set()

        def visit(i):
            if i in seen:
                return
            seen.add(i)
            for d in (self.parent.get(i), self.follow.get(i)):
                if d is not None:
                    visit(d)
            order.append(i)
        for i in self.order:
            visit(i)
        self.order = order

    def world(self, pose):
        """World matrices of the joints (reshaped: see reshape; a joint's
        own scale is not in them, posed() adds it)."""
        if not (self.own or self.turn):
            return super().world(pose)
        return self.chain(pose, super().world(pose) if self.follow else None)

    def chain(self, pose, orig):
        out = [None] * len(self.nodes)
        for i in self.order:
            t, r, s = pose[i]
            p = self.parent.get(i)
            t = np.asarray(t, float) * self.own[p] if p in self.own else t
            if i in self.turn:
                r = qmul(r, self.turn[i])
            m = np.eye(4)
            m[:3, :3] = qmat(r) * s
            m[:3, 3] = t
            out[i] = out[p] @ m if p is not None else m
            if i in self.follow:
                f = self.follow[i]
                x = np.linalg.inv(orig[f]) @ orig[i]
                if f in self.own:
                    x[:3, 3] *= self.own[f]
                out[i] = orig[i].copy()   # (turned as in the clip: a paw stays flat)
                out[i][:3, 3] = (out[f] @ x)[:3, 3]
        return out

    def posed(self, pose):
        """Positions and normals of every vertex in `pose` (glTF units)."""
        g = self.world(pose)
        if self.own:
            g = list(g)
            for i, sc in self.own.items():
                g[i] = g[i] @ np.diag([*sc, 1.0])
        Ps, Ns = [], []
        for pt in self.parts:
            if pt['skin']:
                jm = np.array([g[jt] @ pt['ibm'][k] for k, jt in enumerate(pt['skin']['joints'])])
                m = np.einsum('vk,vkij->vij', pt['W'], jm[pt['J']])
                p = np.einsum('vij,vj->vi', m[:, :3, :3], pt['P']) + m[:, :3, 3]
                # (normals: the inverse transpose, for the non-uniform scales)
                nm = np.linalg.inv(m[:, :3, :3]).transpose(0, 2, 1) if self.own else m[:, :3, :3]
                n = np.einsum('vij,vj->vi', nm, pt['N'])
            else:
                m = g[pt['node']]
                p = pt['P'] @ m[:3, :3].T + m[:3, 3]
                n = pt['N'] @ m[:3, :3].T
            Ps.append(p)
            Ns.append(n / (np.linalg.norm(n, axis=1, keepdims=True) + 1e-12))
        return np.concatenate(Ps), np.concatenate(Ns), g


def lifted(u):
    """A one-shot's height above the floor (share of its "lift") at u = 0..1."""
    return smooth(u / 0.25) * smooth((1 - u) / 0.25)


def lerp_pose(a, b, u):
    return [[(1 - u) * np.asarray(ta) + u * np.asarray(tb), slerp(ra, rb, u), (1 - u) * np.asarray(sa) + u * np.asarray(sb)]
            for (ta, ra, sa), (tb, rb, sb) in zip(a, b)]


class Baker:
    def __init__(self, spec, path, fps):
        self.spec, self.fps = spec, fps
        self.dir = os.path.dirname(os.path.abspath(path))
        self.m = m = Model(path)
        m.reshape(spec.get('proportions', {}), spec.get('follow', {}))
        self.anims = {a.get('name'): a for a in m.j['animations']}
        for k, v in spec['clips'].items():
            for name in self.sources(v):
                if name not in self.anims and name not in spec.get('keys', {}) and name not in spec['clips']:
                    fail(f'clip {k}: no clip or key {name!r} (the glTF has: {", ".join(sorted(self.anims))})')
        for bone in self.bones_used():
            if bone not in m.idx:
                fail(f'no bone {bone!r} in the rig')
        if 'idle' not in spec['clips'] or 'walk' not in spec['clips']:
            fail('an animal needs at least the clips idle and walk')
        self.keys, self.memo = {}, {}
        self.stand = self.pose('idle')
        p, _, g = m.posed(self.stand)
        lo, hi = p.min(axis=0), p.max(axis=0)
        self.s = spec['height'] / (hi[1] - lo[1])
        self.o = np.array([(lo[0] + hi[0]) / 2, 0.0, (lo[2] + hi[2]) / 2])
        self.y0 = lo[1]
        self.shade = np.clip((p[:, 1] - lo[1]) / (hi[1] - lo[1]), 0, 1)   # per vertex: height in the standing pose
        z = spec['zones']
        # The scruff: the top of the skin its bone moves (on the midline), carried by the bone.
        sb = m[z['scruff'] if isinstance(z['scruff'], str) else z['scruff']['bone']]
        mine = p[m.dom == sb]
        if not len(mine):
            fail(f'the scruff bone {m.nodes[sb].get("name")} moves no vertices')
        top = mine[mine[:, 1].argmax()].copy()
        top[0] = g[sb][0, 3]
        self.scruff = (sb, np.linalg.inv(g[sb]) @ np.array([*top, 1]))

    @staticmethod
    def sources(v):
        if isinstance(v, str):
            return [v]
        return [x for x in [v.get('clip'), v.get('key'), v.get('reverse')] + list(v.get('blend', [])) if x]

    def bones_used(self):
        s = self.spec
        out = [b for k in s.get('keys', {}).values() for b in [*k.get('rot', {}), *k.get('aim', {})]]
        out += [lay['bone'] for v in s['clips'].values() if isinstance(v, dict) for lay in v.get('layers', [])]
        out += [z if isinstance(z, str) else z['bone'] for z in s['zones'].values()] + list(s.get('proportions', {}))
        return out + s.get('feet', []) + [b for kv in s.get('follow', {}).items() for b in kv]

    # ---- poses ----
    def sample(self, name, t):
        return self.m.sample(self.anims[name], t)

    def turned(self, pose, rot, aim=None):
        """`pose` with bones turned about the body's axes and / or aimed (see
        the header), parents first."""
        m, aim = self.m, aim or {}
        out = [list(p) for p in pose]
        for i in m.order:
            name = m.nodes[i].get('name')
            if name not in rot and name not in aim:
                continue
            g = m.world(out)
            wp = mat_q(g[m.parent[i]][:3, :3]) if i in m.parent else QI
            if name in rot:
                e = qeuler(*rot[name])
            if name in aim:
                if name in rot:
                    out[i][1] = qnorm(qmul(qinv(wp), qmul(e, qmul(wp, out[i][1]))))
                    g = m.world(out)
                c = m.nodes[i]['children'][0]
                cur = g[c][:3, 3] - g[i][:3, 3]
                e = qbetween(cur, np.asarray(aim[name], float))
            out[i][1] = qnorm(qmul(qinv(wp), qmul(e, qmul(wp, out[i][1]))))
        # Bones outside the chains (IK targets the feet are skinned to) move
        # with the bone they follow.
        # (Unreshaped: reshape() moves them with their reshaped bone.)
        follow = self.spec.get('follow', {})
        if follow and (rot or aim):
            g0, g1 = Rig.world(m, pose), Rig.world(m, out)
            for ik, bone in follow.items():
                i, b = m[ik], m[bone]
                w = g1[b] @ np.linalg.inv(g0[b]) @ g0[i]
                local = np.linalg.inv(g1[m.parent[i]]) @ w if i in m.parent else w
                sc = np.linalg.norm(local[:3, :3], axis=0)
                out[i] = [local[:3, 3].copy(), mat_q(local[:3, :3]), sc]
        return out

    def key(self, name):
        if name not in self.keys:
            k = self.spec['keys'][name]
            self.keys[name] = self.turned(self.sample(k['from'], k.get('at', 0)), k.get('rot', {}), k.get('aim', {}))
        return self.keys[name]

    def pose(self, name):
        """The first frame of a clip or key of the spec."""
        if name in self.spec.get('keys', {}) and name not in self.spec['clips']:
            return self.key(name)
        return self.frames(name)[0][0]

    def frames(self, name):
        """name -> ([pose per frame], fps, loop, source)."""
        if name in self.memo:
            return self.memo[name]
        v = self.spec['clips'][name]
        if isinstance(v, str):
            v = {'clip': v}
        loop = v.get('loop', name in LOOPS)
        fps = self.fps
        if 'blend' in v:
            a, b = (self.pose(x) for x in v['blend'])
            n = max(4, round(v.get('seconds', 0.6) * fps))
            out = ([lerp_pose(a, b, smooth(i / (n - 1))) for i in range(n)], fps, False, 'hand-keyed')
        elif 'reverse' in v:
            ps, f, _, src = self.frames(v['reverse'])
            out = (ps[::-1], f, False, src)
        elif 'key' in v or 'hold' in v:
            if 'key' in v:
                base, src = self.key(v['key']), 'hand-keyed'
            else:
                a = self.anims[v['clip']]
                t = self.m.duration(a) if v['hold'] == 'last' else float(v['hold'])
                base, src = self.sample(v['clip'], t), 'gltf'
            T = v.get('seconds', 3.0)
            lay = v.get('layers', [])
            n = max(1, round(T * v.get('fps', fps / 2))) if lay else 1   # slow loops at half the fps (as the cat's)
            out = ([self.layered(base, lay, i * T / n) for i in range(n)], n / T, True, src)
        else:
            a = self.anims[v['clip']]
            t0, t1 = v.get('start', 0.0), v.get('end', self.m.duration(a))
            d = t1 - t0
            n = max(1, round(d * v.get('fps', fps)))
            div = n if loop else max(1, n - 1)
            out = ([self.layered(self.sample(v['clip'], t0 + i * d / div), v.get('layers', []), i * d / div) for i in range(n)],
                   div / d, loop, 'gltf')
        self.memo[name] = out
        return out

    def layered(self, pose, layers, t):
        if not layers:
            return pose
        rot, out = {}, [list(p) for p in pose]
        for lay in layers:
            w = math.sin(2 * math.pi * (t / lay.get('period', 1.0) + lay.get('phase', 0)))
            if 'rot' in lay:
                rot[lay['bone']] = [a * w for a in lay['rot']]
            if 'scale' in lay:
                i = self.m[lay['bone']]
                out[i][2] = np.asarray(out[i][2]) * (1 + w * np.asarray(lay['scale'], float))
        return self.turned(out, rot)

    # ---- geometry ----
    def top(self, p, g, bone, r=0.1):
        """The top of the skin above a joint (within r x the height on the floor plane)."""
        j = g[bone][:3, 3]
        rr = r * (p[:, 1].max() - p[:, 1].min())
        near = p[np.linalg.norm(p[:, [0, 2]] - j[[0, 2]], axis=1) < rr]
        return np.array([j[0], near[:, 1].max(), j[2]]) if len(near) else j

    def mesh(self, pose, hang=False):
        """Pose -> (positions (m), normals, bones' world matrices, origin (glTF units))."""
        p, n, g = self.m.posed(pose)
        if hang:
            b, local = self.scruff
            org = (g[b] @ local)[:3]
            return (p - org) * self.s, n, g, org
        org = np.array([self.o[0], p[:, 1].min(), self.o[2]])
        return (p - org) * self.s, n, g, org

    def zones(self, pose, hang=False):
        p, _, g = self.m.posed(pose)
        _, _, _, org = self.mesh(pose, hang)
        out = {}
        for k, z in self.spec['zones'].items():
            bone = self.m[z if isinstance(z, str) else z['bone']]
            if k == 'scruff':
                v = (g[self.scruff[0]] @ self.scruff[1])[:3]
            elif isinstance(z, dict) and z.get('at') == 'joint':
                v = g[bone][:3, 3]
            else:
                v = self.top(p, g, bone)
            out[k] = [round(float(x), 4) for x in (v - org) * self.s]
        return out

    # ---- texture ----
    def atlas(self):
        """-> (PNG image, per-vertex UVs): the palette (flat colours, shaded
        by height) with the materials' base colour textures stacked below."""
        j, m = self.m.j, self.m
        mats = j.get('materials', [])
        colors = {k: linear(v) for k, v in self.spec.get('colors', {}).items()}
        for k in colors:
            if k not in [x.get('name') for x in mats]:
                fail(f'colors: no material {k!r} (the glTF has: {", ".join(str(x.get("name")) for x in mats)})')
        used = sorted({pt['mat'] for pt in m.parts}, key=lambda x: -1 if x is None else x)
        flat, tex = [], []
        for mi in used:
            pbr = mats[mi].get('pbrMetallicRoughness', {}) if mi is not None else {}
            if 'baseColorTexture' in pbr:
                tex.append(mi)
            else:
                flat.append(mi)
        cw, rows = 8, 64
        W = max(64, 1 << math.ceil(math.log2(max(1, len(flat)) * cw)))
        tiles, uv = [], {}
        pal = np.zeros((rows, W, 3))
        for k, mi in enumerate(flat):
            c = mats[mi].get('pbrMetallicRoughness', {}).get('baseColorFactor', [0.8, 0.8, 0.8, 1]) if mi is not None else [0.8] * 4
            if mi is not None and mats[mi].get('name') in colors:
                c = colors[mats[mi]['name']]
            ramp = np.linspace(SHADE[1], SHADE[0], rows)[:, None] * np.asarray(c[:3])   # row 0 (top of the image): lit
            pal[:, k * cw:(k + 1) * cw] = srgb(ramp)[:, None, :]
            uv[mi] = ('flat', (k * cw + cw / 2) / W)
        tiles.append(Image.fromarray((pal * 255).round().astype(np.uint8), 'RGB'))
        for mi in tex:
            pbr = mats[mi]['pbrMetallicRoughness']
            im = self.image(j['textures'][pbr['baseColorTexture']['index']]['source']).convert('RGB')
            tw = int(self.spec.get('texture', 256))   # px wide in the atlas
            im = im.resize((tw, max(1, round(im.height * tw / im.width))), Image.LANCZOS)
            f = srgb(np.asarray(pbr.get('baseColorFactor', [1, 1, 1, 1])[:3]))
            tiles.append(Image.fromarray((np.asarray(im) * f).round().astype(np.uint8), 'RGB'))
            uv[mi] = ('tex', len(tiles) - 1)
        TW = max(t.width for t in tiles)
        TH = sum(t.height for t in tiles)
        img = Image.new('RGB', (TW, TH))
        y0s, y = [], 0
        for t in tiles:
            img.paste(t.resize((TW, t.height), Image.NEAREST) if t.width != TW else t, (0, y))
            y0s.append(y)
            y += t.height
        UV, base = np.zeros((m.nverts, 2)), 0
        for pt in m.parts:
            n = len(pt['P'])
            kind, x = uv[pt['mat']]
            if kind == 'flat':
                h = self.shade[base:base + n]
                v_img = (0.5 + (1 - h) * (rows - 1)) / TH   # from the image's top
                UV[base:base + n] = np.stack([np.full(n, x), 1 - v_img], axis=1)
            else:
                if pt['UV'] is None:
                    fail(f'material {pt["mat"]}: a texture but no TEXCOORD_0')
                t = tiles[x]
                u = np.clip(pt['UV'][:, 0], 0, 1)
                v_img = (y0s[x] + np.clip(pt['UV'][:, 1], 0, 1) * t.height) / TH
                UV[base:base + n] = np.stack([u, 1 - v_img], axis=1)
            base += n
        return img, UV

    def image(self, i):
        im = self.m.j['images'][i]
        if 'bufferView' in im:
            bv = self.m.j['bufferViews'][im['bufferView']]
            return Image.open(io.BytesIO(self.m.bin[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]))
        if im['uri'].startswith('data:'):
            return Image.open(io.BytesIO(base64.b64decode(im['uri'].split(',', 1)[1])))
        return Image.open(os.path.join(self.dir, im['uri']))


def main():
    spec_path, glb, out, fps = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
    spec = json.load(open(spec_path))
    b = Baker(spec, glb, fps)
    faces = len(b.m.F)
    if faces > FACE_MAX:
        fail(f'{faces} triangles per frame, more than {FACE_MAX}: decimate the model first (e.g. Blender\'s Decimate modifier)')
    os.makedirs(out, exist_ok=True)
    img, uv = b.atlas()
    img.save(os.path.join(out, 'cat.png'), optimize=True)
    write_mtl(out)
    meta = {}
    for name, v in spec['clips'].items():
        poses, f, loop, source = b.frames(name)
        hang = isinstance(v, dict) and v.get('hang', False)
        lift = v.get('lift', 0) if isinstance(v, dict) else 0
        for i, pose in enumerate(poses):
            p, n, _, _ = b.mesh(pose, hang)
            if lift:
                p[:, 1] += lift * (1.0 if loop else lifted(i / max(1, len(poses) - 1)))
            write_obj(os.path.join(out, f'{name}_{i}.obj'), p, n, uv, b.m.F)
        meta[name] = {'frames': len(poses), 'fps': round(f, 4), 'loop': loop, 'source': source}
    walk = spec['clips']['walk']
    walk = walk if isinstance(walk, str) else walk['clip']
    hang = lambda c: isinstance(spec['clips'][c], dict) and spec['clips'][c].get('hang', False)
    frames = {
        'height': spec['height'], 'vertices': b.m.nverts, 'faces': faces,
        'walkSpeed': round(walk_speed(b.m, b.anims[walk], spec['feet'], b.s, back_only=bool(b.m.own)), 3),
        'zones': b.zones(b.stand),
        'poseZones': {p: b.zones(b.frames(c)[0][0], hang(c)) for p, c in POSES.items() if c in spec['clips']},
        'clips': meta,
    }
    if 'species' in spec:
        frames['species'] = spec['species']
    json.dump(frames, open(os.path.join(out, 'frames.json'), 'w'), indent=1)
    print(f'{spec.get("name", "?")}: {faces} triangles, {b.m.nverts} vertices per frame, '
          f'{sum(c["frames"] for c in meta.values())} frames, walk {frames["walkSpeed"]} m/s')


if __name__ == '__main__':
    main()
