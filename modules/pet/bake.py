#!/usr/bin/env python3
"""Bake the VR pet: pose a skinned glTF cat per animation frame and write one
static SteamVR render model (OBJ + one texture) per frame.

usage: bake.py toon_cat.glb tuxedo.gltf out-dir height-m fps

(glTF reading, quaternions, rigs, skinning and OBJ writing: rig.py.)

SteamVR render models are static, so every frame of every clip is its own OBJ
(vertices skinned on the CPU here, at build time). The clips (clips() below)
come from three kinds of sources:

  native      the Toon Cat's own animation (its in-place walk)
  retargeted  Tuxedo Cat Animated 2.0's clips, transferred bone by bone:
              body bones take the world-space rotation change (relative to
              the rest pose) of the corresponding source bone (7-bone spine
              -> 3 + neck), tail/ears the per-joint bend in the bone's own
              frame (4-bone tail spread over 5 bones), root motion scaled by
              hip height
  hand-keyed  key poses (per-joint bends in the body frame, "aim" a bone at a
              world direction, whole-body rotation) interpolated with
              smoothstep, plus procedural breathing / sway on top

Clips: walk (native); sitdown, sit, standup (retargeted); idle, walkstart,
liedown, lie, curl, sleep, dangle, and for interaction fall, land (squash),
shake, stretch (play bow), startle (arched back, puffed tail), groom (paw
licking, sitting), purr / sitpurr / liepurr with purrin / sitpurrin /
liepurrin into them (petted: eyes closed, head tilted into the hand) (all
hand-keyed). One-shot clips start and end in their pose's rest key.

Every frame except the dangle is put on the floor (lowest vertex at y = 0);
the dangle hangs from the scruff (the origin is the back of the neck).

Output: out-dir/<clip>_<i>.obj, cat.mtl, cat.png, frames.json
  {"height": m, "vertices": n, "walkSpeed": m/s of the walk at its fps,
   "zones": {scruff|head|back|chin|tailBase: [x, y, z] on the standing cat},
   "poseZones": {pose: zones in that pose's rest frame (stand, sit, lie,
                 sleep, fall; dangle relative to the scruff)},
   "clips": {clip: {"frames": n, "fps": f, "loop": bool,
                    "source": "native|retargeted|hand-keyed"}}}
The cat faces +Z, centred on x/z (rest pose), standing on y = 0; the dangle
frames have the scruff at the origin instead.
"""
import json, math, os, sys
import numpy as np
from rig import (QI, Rig, Skinned, mat_q, qbetween, qeuler, qinv, qmul, qnorm, qrot, qscale, slerp, smooth,
                 png_from, walk_speed as gait_speed, write_mtl, write_obj)

# ------------------------------------------------------------- the cat ----


class Cat(Skinned):
    """The Toon Cat: mesh (rig.Skinned), texture, and pose solving."""
    TAIL = ['tail', 'tail.01', 'tail.02', 'tail.03', 'tail.end']
    SPINE = ['torso', 'spine.01', 'spine.02', 'neck', 'head']
    LEGS = {s: [f'thigh.B.{s}', f'leg.upper.B.{s}', f'leg.lower.B.{s}', f'foot.B.{s}'] for s in 'LR'}
    ARMS = {'L': ['leg.upper.F.L', 'leg.lower.FL', 'foot.F.L'], 'R': ['leg.upper.F.R', 'leg.lower.F.R', 'foot.F.R']}

    def __init__(self, path):
        super().__init__(path)
        j, binc = self.j, self.bin
        img = j['images'][0]
        bv = j['bufferViews'][img['bufferView']]
        self.texture = binc[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
        self.bone_dir = {i: self.rest_world[i][:3, :3] @ [0, 1, 0] for i in range(len(self.nodes))}
        self.bone_dir = {i: d / np.linalg.norm(d) for i, d in self.bone_dir.items()}
        self.joints = set(self.skin['joints'])

    # Neutral standing legs (the rest pose is mid-stride): world directions
    # of the leg bones; retargeted and standing poses are relative to these.
    NEUTRAL = {
        'thigh.B.L': [0.03, -0.97, 0.22], 'leg.upper.B.L': [0, -0.77, -0.64],
        'leg.lower.B.L': [0, -0.97, 0.25], 'foot.B.L': [0, -0.09, 1],
        'leg.upper.F.L': [0.01, -1, 0.06], 'leg.lower.FL': [0, -1, 0.1], 'foot.F.L': [0, -0.21, 0.98],
    }

    def neutral(self):
        out = {}
        for n, v in self.NEUTRAL.items():
            m = n.replace('.L', '.R').replace('FL', 'F.R')
            for name, d in ((n, v), (m, [-v[0], v[1], v[2]])):
                i = self[name]
                out[i] = qbetween(self.bone_dir[i], np.asarray(d, float))
        return out

    def solve(self, key):
        """Local TRS pose from a key: {'A': {bone: world delta from the
        neutral pose}, 'Q': {bone: bend in the parent's rest frame}, 'aim':
        {bone: world direction, or (direction, weight)}, 'scale': {bone:
        xyz}, 'body': whole-body rotation (world)}. Per joint: D = (body * A
        * neutral, or D_parent) * Q, then aimed; the joint's world rotation
        is D * rest."""
        if not hasattr(self, '_neutral'):
            self._neutral = self.neutral()
        A = {self[k]: v for k, v in key.get('A', {}).items()}
        Q = {self[k]: v for k, v in key.get('Q', {}).items()}
        AIM = {}
        for k, v in key.get('aim', {}).items():
            d, w = v if isinstance(v, tuple) else (v, 1.0)
            AIM[self[k]] = (np.asarray(d, float), w)
        SC = {self[k]: np.asarray(v, float) for k, v in key.get('scale', {}).items()}
        body = key.get('body', QI)
        pose = [list(p) for p in self.rest]
        D, R = {}, {}
        top = self['torso']
        for i in self.order:
            p = self.parent.get(i)
            if i == top or i in A:
                d = qmul(body, qmul(A.get(i, QI), self._neutral.get(i, QI)))
            elif p in D:
                d = D[p]
            else:
                continue
            d = qmul(d, Q.get(i, QI))
            if i in AIM:
                cur = qrot(qmul(d, self.rest_rot[i]), [0, 1, 0])
                aim, w = AIM[i]
                aim = aim / np.linalg.norm(aim)
                if w < 1:
                    aim = (1 - w) * cur + w * aim
                d = qmul(qbetween(cur, aim), d)
            D[i] = d
            R[i] = qmul(d, self.rest_rot[i])
            pr = R[p] if p in R else self.rest_rot[p]
            pose[i][1] = qnorm(qmul(qinv(pr), R[i]))
            if i in SC:
                pose[i][2] = self.rest[i][2] * SC[i]
        return pose

    def pose_of(self, key):
        return key['pose'] if 'pose' in key else self.solve(key)

# ------------------------------------------------------------ retarget ----


class Retarget:
    """Tuxedo Cat -> Toon Cat. Both face +Z with Y up in world space."""
    SUF = '_metarig.004'
    BODY = {   # world-space rotation change of the source bone
        'torso': 'spine.005', 'spine.01': 'spine.007', 'spine.02': 'spine.009', 'neck': 'spine.010', 'head': 'Head',
        'thigh.B.L': 'thigh.L', 'leg.upper.B.L': 'shin.L', 'leg.lower.B.L': 'foot.L', 'foot.B.L': 'toe.L',
        'thigh.B.R': 'thigh.R', 'leg.upper.B.R': 'shin.R', 'leg.lower.B.R': 'foot.R', 'foot.B.R': 'toe.R',
        'leg.upper.F.L': 'front_thigh.L', 'leg.lower.FL': 'front_shin.L', 'foot.F.L': 'front_foot.L',
        'leg.upper.F.R': 'front_thigh.R', 'leg.lower.F.R': 'front_shin.R', 'foot.F.R': 'front_foot.R',
    }
    BEND = {'ear.L': ['Ear.L'], 'ear.R': ['Ear.R']}   # bend in the bone's frame
    TAIL_SRC = ['TailBase', 'Tail2', 'Tail3', 'TailTip']

    def __init__(self, cat, src):
        self.cat, self.src = cat, src
        s = lambda n: src[n + self.SUF]
        self.s = s
        self.root = s('Root')
        self.hip_ratio = cat.rest_world[cat['torso']][1, 3] / src.rest_world[self.root][1, 3]

    def bend(self, g_rot, i):
        """Source joint bend in its own rest bone frame."""
        src = self.src
        p = src.parent[i]
        dp = qmul(g_rot[p], qinv(src.rest_rot[p]))
        di = qmul(g_rot[i], qinv(src.rest_rot[i]))
        rel = qmul(qinv(dp), di)
        return qmul(qinv(src.rest_rot[i]), qmul(rel, src.rest_rot[i]))

    def key(self, anim, t):
        src, cat, s = self.src, self.cat, self.s
        g = src.world(src.sample(anim, t))
        g_rot = [mat_q(m[:3, :3]) for m in g]
        A = {tb: qmul(g_rot[s(sb)], qinv(src.rest_rot[s(sb)])) for tb, sb in self.BODY.items()}
        Q = {}

        def to_target(bf, tb):
            r = cat.rest_rot[cat[tb]]
            return qmul(r, qmul(bf, qinv(r)))
        for tb, sbs in self.BEND.items():
            Q[tb] = to_target(self.bend(g_rot, s(sbs[0])), tb)
        bends = [self.bend(g_rot, s(n)) for n in self.TAIL_SRC]
        n = len(Cat.TAIL)
        for k, tb in enumerate(Cat.TAIL):
            x = k * (len(bends) - 1) / (n - 1)
            a = int(min(x, len(bends) - 2))
            Q[tb] = to_target(qscale(slerp(bends[a], bends[a + 1], x - a), len(bends) / n), tb)
        # Tail joints follow their parent (no A): drop the source's world
        # change there, the bends carry the motion.
        off = (g[self.root][:3, 3] - src.rest_world[self.root][:3, 3]) * self.hip_ratio
        # The Tuxedo's front legs are longer: when it sits up (torso pitched
        # up) they'd reach forward; pull them under the chest instead.
        fwd = qrot(A['torso'], [0, 0, 1])
        w = smooth(math.degrees(math.asin(max(-1.0, min(1.0, fwd[1])))) / 35)
        aim = {}
        if w > 0:
            for side, sx in (('L', 1), ('R', -1)):
                up, lo, ft = Cat.ARMS[side]
                aim.update({up: ([0.02 * sx, -1, 0.02], w), lo: ([0.02 * sx, -1, 0.08], w), ft: ([0, -0.2, 1], w)})
        return {'A': A, 'Q': Q, 'aim': aim, 'offset': off}

# ----------------------------------------------------------- hand keys ----


def blend(cat, k0, k1, u):
    """Interpolate two keys: slerp of the solved local rotations, lerp of
    scales and offsets."""
    p0, p1 = cat.pose_of(k0), cat.pose_of(k1)
    pose = [[t0, slerp(r0, r1, u), (1 - u) * np.asarray(s0) + u * np.asarray(s1)]
            for (t0, r0, s0), (_, r1, s1) in zip(p0, p1)]
    off = (1 - u) * np.asarray(k0.get('offset', [0, 0, 0]), float) + u * np.asarray(k1.get('offset', [0, 0, 0]), float)
    return {'pose': pose, 'offset': off}


def add(k, extra):
    """Layer relative bends (Q) and scales on top of a key."""
    out = dict(k)
    q = dict(k.get('Q', {}))
    for n, v in extra.get('Q', {}).items():
        q[n] = qmul(q.get(n, QI), v)
    out['Q'] = q
    sc = dict(k.get('scale', {}))
    for n, v in extra.get('scale', {}).items():
        sc[n] = np.asarray(sc.get(n, [1, 1, 1]), float) * v
    out['scale'] = sc
    return out


def breathe(t, period, depth=1.0, blink=None):
    """Breathing (chest), a little head and ear life, tail sway."""
    w = 2 * math.pi * t / period
    b = math.sin(w) * depth
    q = {
        'spine.01': qeuler(x=-1.2 * b), 'spine.02': qeuler(x=1.2 * b),
    }
    sc = {'spine.01': [1 + 0.02 * b, 1, 1 + 0.03 * b], 'spine.02': [1 + 0.025 * b, 1, 1 + 0.03 * b]}
    if blink is not None:
        sc['eye.L'] = sc['eye.R'] = [1, 1, blink]
    return {'Q': q, 'scale': sc}


LEG_BONES = [b for s in 'LR' for b in Cat.LEGS[s] + Cat.ARMS[s]]
STAND = {'A': {b: QI for b in LEG_BONES}}
# Aims are world directions (the cat faces +Z, Y up, X is its left).
DOWN = [0, -1, 0]


def loaf():
    """Lying on the belly, paws tucked under (the "loaf"), head up."""
    return {
        'offset': [0, 0, 0],
        'Q': {'torso': qeuler(x=0), 'spine.01': qeuler(x=0), 'neck': qeuler(x=-8), 'head': qeuler(x=6),
              'ear.L': qeuler(), 'ear.R': qeuler()},
        'aim': {
            'leg.upper.F.L': [0, -0.35, -1], 'leg.lower.FL': [0.05, -0.2, 1], 'foot.F.L': [0, -0.1, 1],
            'leg.upper.F.R': [0, -0.35, -1], 'leg.lower.F.R': [-0.05, -0.2, 1], 'foot.F.R': [0, -0.1, 1],
            'thigh.B.L': [0.25, -0.3, 1], 'leg.upper.B.L': [0.3, -0.2, -1], 'leg.lower.B.L': [0.1, -0.1, 1], 'foot.B.L': [0, -0.1, 1],
            'thigh.B.R': [-0.25, -0.3, 1], 'leg.upper.B.R': [-0.3, -0.2, -1], 'leg.lower.B.R': [-0.1, -0.1, 1], 'foot.B.R': [0, -0.1, 1],
            # tail on the floor, wrapped along the left side
            'tail': [0.25, -0.7, -1], 'tail.01': [0.8, -0.25, -0.5], 'tail.02': [1, -0.05, 0.2],
            'tail.03': [0.6, 0, 1], 'tail.end': [0.25, 0, 1],
        },
    }


def curled():
    """Asleep on its left side, curled up (belly in, nose to the tail),
    eyes closed."""
    c = 34   # flexion per spine joint
    return {
        'body': qeuler(z=-78),
        'Q': {'torso': qeuler(x=-10), 'spine.01': qeuler(x=c), 'spine.02': qeuler(x=c), 'neck': qeuler(x=c + 10),
              'head': qeuler(x=25, z=15),
              'tail': qeuler(x=70), 'tail.01': qeuler(x=40), 'tail.02': qeuler(x=40), 'tail.03': qeuler(x=35),
              'tail.end': qeuler(x=25),
              'ear.L': qeuler(x=15), 'ear.R': qeuler(x=15),
              'leg.upper.F.L': qeuler(x=-30, z=8), 'leg.lower.FL': qeuler(x=110), 'foot.F.L': qeuler(x=30),
              'leg.upper.F.R': qeuler(x=-20, z=-8), 'leg.lower.F.R': qeuler(x=115), 'foot.F.R': qeuler(x=30),
              'thigh.B.L': qeuler(x=-95, z=6), 'leg.upper.B.L': qeuler(x=70), 'leg.lower.B.L': qeuler(x=-50),
              'thigh.B.R': qeuler(x=-85, z=-6), 'leg.upper.B.R': qeuler(x=70), 'leg.lower.B.R': qeuler(x=-50)},
        'scale': {'eye.L': [1, 0.15, 1], 'eye.R': [1, 0.15, 1]},
    }


def dangle(t=0.0):
    """Held by the scruff: body hangs down, legs limp, spine slightly curled,
    tail down, head up. Swings a little."""
    sw = math.sin(2 * math.pi * t / 2.0)
    limp = lambda s: [0.02 * s, -1, 0.12]
    return {
        'body': qmul(qeuler(z=4 * sw), qeuler(x=-72)),
        'Q': {'spine.01': qeuler(x=6), 'spine.02': qeuler(x=6), 'neck': qeuler(x=0),
              'ear.L': qeuler(x=-15), 'ear.R': qeuler(x=-15),
              'tail': qeuler(x=0)},
        'aim': {
            'leg.upper.F.L': limp(1), 'leg.lower.FL': limp(1), 'foot.F.L': [0, -1, 0.5],
            'leg.upper.F.R': limp(-1), 'leg.lower.F.R': limp(-1), 'foot.F.R': [0, -1, 0.5],
            'thigh.B.L': [0.1, -1, 0.35], 'leg.upper.B.L': limp(1), 'leg.lower.B.L': limp(1), 'foot.B.L': [0, -1, 0.5],
            'thigh.B.R': [-0.1, -1, 0.35], 'leg.upper.B.R': limp(-1), 'leg.lower.B.R': limp(-1), 'foot.B.R': [0, -1, 0.5],
            'neck': [0, 0.85, 0.5], 'head': [0, 0.85, 0.5],   # face forward
            'tail': [0.05 * sw, -1, -0.15], 'tail.01': [0.1 * sw, -1, -0.05], 'tail.02': [0.15 * sw, -1, 0.05],
            'tail.03': [0.2 * sw, -1, 0.15], 'tail.end': [0.2 * sw, -0.8, 0.3],
        },
    }


def legs(front=None, back=None, sides='LR'):
    """Aims for both front legs (upper, lower, foot) and/or both back legs
    (thigh, upper, lower, foot), given for the left side (x mirrored)."""
    out = {}
    for s in sides:
        m = 1 if s == 'L' else -1
        mir = lambda v: [v[0] * m, v[1], v[2]]
        if front:
            for bone, v in zip(Cat.ARMS[s], front):
                out[bone] = mir(v)
        if back:
            for bone, v in zip(Cat.LEGS[s], back):
                out[bone] = mir(v)
    return out


def crouch():
    """Landing squash: legs folded, body low, head down, ears back."""
    return {
        'A': {b: QI for b in LEG_BONES},
        'Q': {'neck': qeuler(x=12), 'head': qeuler(x=6), 'ear.L': qeuler(x=-25, z=20), 'ear.R': qeuler(x=-25, z=-20),
              'tail': qeuler(x=-10)},
        'aim': legs(front=[[0.08, -0.5, -0.87], [0, -0.75, 0.66], [0, -0.1, 1]],
                    back=[[0.08, -0.45, 0.9], [0, -0.3, -0.95], [0, -0.85, 0.5], [0, -0.1, 1]]),
    }


def fall_key(t):
    """Falling (let go): legs stretched down to the floor, tail up for
    balance, ears back; the legs paddle a little."""
    w = math.sin(2 * math.pi * t / 0.5)
    return {
        'A': {b: QI for b in LEG_BONES},
        'Q': {'neck': qeuler(x=-8), 'head': qeuler(x=-6), 'ear.L': qeuler(x=-30, z=25), 'ear.R': qeuler(x=-30, z=-25)},
        'aim': {**legs(front=[[0.12, -0.9, 0.35 + 0.08 * w], [0.05, -0.9, 0.3], [0, -0.6, 0.8]],
                       back=[[0.1, -0.9, 0.25 - 0.08 * w], [0.05, -0.95, -0.2], [0, -1, 0.15], [0, -0.6, 0.8]]),
                'tail': [0, 0.5, -1], 'tail.01': [0, 0.9, -0.5], 'tail.02': [0, 1, -0.1],
                'tail.03': [0, 0.8, 0.4], 'tail.end': [0, 0.5, 0.8]},
    }


def stretch_key():
    """Play-bow stretch: front legs out in front, chest down, rear up, head
    up, tail up."""
    return {
        'body': qeuler(x=22),
        'Q': {'neck': qeuler(x=-30), 'head': qeuler(x=-18), 'ear.L': qeuler(x=-10), 'ear.R': qeuler(x=-10), 'mouth': qeuler(x=18)},
        'aim': {**legs(front=[[0.1, -0.3, 1], [0.05, -0.2, 1], [0, -0.1, 1]],
                       back=[[0.05, -0.97, 0.2], [0, -0.8, -0.6], [0, -0.97, 0.2], [0, -0.1, 1]]),
                'tail': [0, 0.6, -1], 'tail.01': [0, 0.95, -0.3], 'tail.02': [0, 1, 0.1], 'tail.03': [0, 0.8, 0.5],
                'tail.end': [0, 0.4, 0.9]},
        'scale': {'eye.L': [1, 0.25, 1], 'eye.R': [1, 0.25, 1]},
    }


def startle_key():
    """Startled: back arched, legs stiff, ears flat, tail puffed up."""
    return {
        'A': {b: QI for b in LEG_BONES},
        'Q': {'torso': qeuler(x=-28), 'spine.01': qeuler(x=22), 'spine.02': qeuler(x=38), 'neck': qeuler(x=-34),
              'head': qeuler(x=-6), 'ear.L': qeuler(x=-45, z=35), 'ear.R': qeuler(x=-45, z=-35)},
        'aim': {**legs(front=[[0.05, -1, 0.15], [0, -1, 0.1], [0, -0.2, 1]],
                       back=[[0.05, -0.95, -0.2], [0, -0.9, -0.4], [0, -1, 0.1], [0, -0.1, 1]]),
                'tail': [0, 0.9, -0.4], 'tail.01': [0, 1, -0.1], 'tail.02': [0, 1, 0], 'tail.03': [0, 1, 0.1],
                'tail.end': [0, 1, 0.1]},
        'scale': {'tail': [1.7, 1, 1.7], 'eye.L': [1.15, 1.15, 1], 'eye.R': [1.15, 1.15, 1]},
    }


def purr_mods(t, T, sway=1.0):
    """Being petted: eyes closed, head raised and tilted into the hand,
    rubbing slowly (layer on a base key with add())."""
    w = 2 * math.pi * t / T
    return {'Q': {'neck': qeuler(x=-10, y=5 * math.sin(w) * sway), 'head': qeuler(x=-10, z=12 + 4 * math.sin(w), y=6 * math.sin(w) * sway),
                  'ear.L': qeuler(x=-8), 'ear.R': qeuler(x=-8)},
            'scale': {'eye.L': [1, 0.12, 1], 'eye.R': [1, 0.12, 1]}}


def idle_key(t):
    """Standing, breathing; looks around a little, ears twitch, tail sways."""
    T = 4.0
    w = 2 * math.pi * t / T
    k = add(STAND, breathe(t, T / 2))
    look = math.sin(w) * 10
    k['Q'].update({
        'neck': qmul(k['Q'].get('neck', QI), qeuler(y=look * 0.5, x=2 * math.sin(2 * w))),
        'head': qeuler(y=look * 0.6, z=4 * math.sin(w + 1)),
        'tail': qeuler(y=8 * math.sin(w)), 'tail.01': qeuler(y=8 * math.sin(w - 0.6)),
        'tail.02': qeuler(y=10 * math.sin(w - 1.2)), 'tail.03': qeuler(y=12 * math.sin(w - 1.8)),
        'tail.end': qeuler(y=14 * math.sin(w - 2.4)),
    })
    tw = max(0.0, math.sin(4 * w)) ** 8   # quick ear twitch
    k['Q']['ear.L'] = qeuler(z=-12 * tw * (math.sin(w) > 0))
    k['Q']['ear.R'] = qeuler(z=12 * tw * (math.sin(w) <= 0))
    blink = 1 - 0.85 * max(0.0, 1 - abs(t - 2.6) / 0.12)
    k['scale']['eye.L'] = k['scale']['eye.R'] = [1, blink, 1]
    return k

# ----------------------------------------------------------------- bake ----


class Baker:
    def __init__(self, cat_path, tux_path, height, fps):
        self.cat = Cat(cat_path)
        self.tux = Rig(tux_path)
        self.rt = Retarget(self.cat, self.tux)
        self.fps = fps
        rest, _, g = self.cat.skinned(self.cat.rest)
        lo, hi = rest.min(axis=0), rest.max(axis=0)
        self.s = height / (hi[1] - lo[1])
        self.o = np.array([(lo[0] + hi[0]) / 2, 0.0, (lo[2] + hi[2]) / 2])
        self.height = height
        # Scruff: back of the neck, the top of the skin the neck bone moves.
        cat = self.cat
        k = cat.skin['joints'].index(cat['neck'])
        mine = rest[cat.J[np.arange(len(cat.J)), cat.W.argmax(axis=1)] == k]
        self.scruff = mine[mine[:, 1].argmax()].copy()
        self.scruff[0] = g[cat['neck']][0, 3]   # on the midline

    def mesh(self, key, ground=True):
        """Key -> (positions, normals) in metres."""
        cat = self.cat
        pose = cat.pose_of(key)
        p, n, g = cat.skinned(pose)
        p = p + np.asarray(key.get('offset', [0, 0, 0]), float)
        if ground:
            p = (p - self.o) * self.s
            p[:, 1] -= p[:, 1].min()
        else:   # hangs from the scruff (moved with the body)
            p = (p - self.scruff_now(g)) * self.s
        return p, n

    def zones(self, key=None, ground=True):
        """Points on the cat in `key`'s pose (default: standing; metres, in
        the frame's space as mesh() writes it) for interaction: scruff (where
        the dangle hangs from), head top, back, chin, tail base."""
        cat = self.cat
        key = STAND if key is None else key
        p, _, g = cat.skinned(cat.pose_of(key))
        off = np.asarray(key.get('offset', [0, 0, 0]), float)
        p = p + off

        def top_of(joint, r=0.1):
            j = g[cat[joint]][:3, 3] + off
            near = p[np.linalg.norm(p[:, [0, 2]] - j[[0, 2]], axis=1) < r * self.height / self.s]
            return np.array([j[0], near[:, 1].max(), j[2]]) if len(near) else j

        pts = {'scruff': self.scruff_now(g) + off, 'head': top_of('head', 0.08), 'back': top_of('spine.01'),
               'chin': g[cat['mouth']][:3, 3] + off, 'tailBase': g[cat['tail']][:3, 3] + off}
        if ground:
            lift = -((p - self.o) * self.s)[:, 1].min()
            conv = lambda v: (v - self.o) * self.s + [0, lift, 0]
        else:
            sc = self.scruff_now(g) + off
            conv = lambda v: (v - sc) * self.s
        return {k: [round(float(x), 4) for x in conv(v)] for k, v in pts.items()}

    def scruff_now(self, g):
        """Scruff point carried by the neck joint."""
        cat = self.cat
        i = cat['neck']
        local = np.linalg.inv(cat.rest_world[i]) @ np.array([*self.scruff, 1])
        return (g[i] @ local)[:3]


def clips(b):
    """name -> (list of keys, fps, loop, source, ground)."""
    cat, tux, rt, fps = b.cat, b.tux, b.rt, b.fps
    out = {}

    def frames(dur, f=fps):
        return max(1, int(round(dur * f)))

    # Slow loops (breathing) at fewer frames per second: fewer frames to keep
    # mounted in SteamVR's scene graph and fewer scene graph updates.
    slow, sleepy = fps / 2, fps / 3

    # native walk
    an = cat.clip(cat.j['animations'][0]['name'])
    d = cat.duration(an)
    n = frames(d)
    out['walk'] = ([{'pose': cat.sample(an, i * d / n)} for i in range(n)], n / d, True, 'native', True)

    # into / out of the walk (the walk loop starts mid-stride)
    n = max(4, frames(0.3))
    out['walkstart'] = ([blend(cat, STAND, out['walk'][0][0], smooth(i / (n - 1))) for i in range(n)], fps, False,
                        'hand-keyed', True)

    # retargeted Tuxedo clips
    def retarget(name, loop, f=fps):
        a = tux.clip(name)
        d = tux.duration(a)
        n = frames(d, f)
        ks = [rt.key(a, i * d / (n if loop else n - 1)) for i in range(n)]
        return ks, (n if loop else n - 1) / d
    for name, src, loop in [('sitdown', 'SitDown', False), ('sit', 'IdleSit', True), ('standup', 'StandUp', False)]:
        ks, f = retarget(src, loop, slow if loop else fps)
        out[name] = (ks, f, loop, 'retargeted', True)

    # hand-keyed
    T = 4.0
    n = frames(T, slow)
    out['idle'] = ([idle_key(i * T / n) for i in range(n)], n / T, True, 'hand-keyed', True)

    lie = loaf()
    n = frames(1.2)
    out['liedown'] = ([blend(cat, STAND, lie, smooth(i / (n - 1))) for i in range(n)], fps, False, 'hand-keyed', True)
    T = 3.0
    n = frames(T, slow)
    out['lie'] = ([add(lie, breathe(i * T / n, T)) for i in range(n)], n / T, True, 'hand-keyed', True)
    cu = curled()
    n = frames(1.5)
    out['curl'] = ([blend(cat, lie, cu, smooth(i / (n - 1))) for i in range(n)], fps, False, 'hand-keyed', True)
    T = 4.0
    n = frames(T, sleepy)
    out['sleep'] = ([add(cu, breathe(i * T / n, T, 1.4)) for i in range(n)], n / T, True, 'hand-keyed', True)
    T = 2.0
    n = frames(T, slow)
    out['dangle'] = ([dangle(i * T / n) for i in range(n)], n / T, True, 'hand-keyed', False)

    # Dropped, petted, startled, idle life. One-shot actions start and end in their pose's rest key (STAND, or the
    # sit loop's first key for the groom); pose loops' first keys likewise.
    def seq(keys, dur, f=fps):
        """Keyed sequence [(time 0..1, key)] -> frames (smoothstep between)."""
        n = frames(dur, f)
        out = []
        for i in range(n):
            u = i / (n - 1)
            k = next(j for j in range(len(keys) - 1) if keys[j + 1][0] >= u)
            (t0, k0), (t1, k1) = keys[k], keys[k + 1]
            out.append(blend(cat, k0, k1, smooth((u - t0) / max(1e-6, t1 - t0))))
        return out, (n - 1) / dur

    T = 0.5
    n = frames(T, slow)
    out['fall'] = ([fall_key(i * T / n) for i in range(n)], n / T, True, 'hand-keyed', True)

    cr = crouch()
    ks, f = seq([(0, cr), (0.25, cr), (1, STAND)], 0.6)
    out['land'] = (ks, f, False, 'hand-keyed', True)

    def shake(t, T=1.0):
        env = math.sin(math.pi * min(1.0, t / T)) ** 1.5
        w = 2 * math.pi * 5.5 * t
        a = 14 * env * math.sin(w)
        k = {'A': {b: QI for b in LEG_BONES},
             'Q': {'torso': qeuler(z=0.4 * a), 'spine.01': qeuler(z=0.6 * a), 'spine.02': qeuler(z=0.8 * a),
                   'neck': qeuler(z=1.2 * a), 'head': qeuler(z=1.6 * a, x=-4 * env),
                   'ear.L': qeuler(z=-1.5 * a), 'ear.R': qeuler(z=-1.5 * a),
                   'tail': qeuler(y=-a), 'tail.01': qeuler(y=-a), 'tail.02': qeuler(y=-a)},
             'scale': {'eye.L': [1, 1 - 0.6 * env, 1], 'eye.R': [1, 1 - 0.6 * env, 1]}}
        return k
    n = frames(1.0)
    out['shake'] = ([shake(i / (n - 1)) for i in range(n)], (n - 1) / 1.0, False, 'hand-keyed', True)

    st = stretch_key()
    ks, f = seq([(0, STAND), (0.3, st), (0.7, st), (1, STAND)], 3.0, slow)
    out['stretch'] = (ks, f, False, 'hand-keyed', True)

    sk = startle_key()
    ks, f = seq([(0, STAND), (0.15, sk), (0.7, sk), (1, STAND)], 1.0)
    out['startle'] = (ks, f, False, 'hand-keyed', True)

    # Grooming while sitting: right front paw up to the mouth, licked (head
    # bobs), then down again.
    sitk = rt.key(tux.clip('IdleSit'), 0)

    def groom_key(bob):
        k = add(sitk, {'Q': {'neck': qeuler(x=26 + 10 * bob, y=-14), 'head': qeuler(x=10 + 8 * bob, z=-10),
                             'ear.L': qeuler(x=-6), 'ear.R': qeuler(x=-6)},
                       'scale': {'eye.L': [1, 0.35, 1], 'eye.R': [1, 0.35, 1]}})
        k['aim'] = {**k.get('aim', {}), 'leg.upper.F.R': [-0.12, 0.05, 1], 'leg.lower.F.R': [0.1, 1, 0.15],
                    'foot.F.R': [0.35, 0.2, -0.9]}
        return k
    g0, g1 = groom_key(0), groom_key(1)
    ks, f = seq([(0, sitk), (0.15, g0), (0.25, g1), (0.35, g0), (0.45, g1), (0.55, g0), (0.65, g1), (0.75, g0),
                 (0.85, g0), (1, sitk)], 4.0, slow)
    out['groom'] = (ks, f, False, 'hand-keyed', True)

    # Petted: purr poses (loops) on the standing, sitting and lying cat, and
    # the short transitions into them.
    T = 3.0
    happy = {**STAND, 'aim': {'tail': [0, 0.7, -0.7], 'tail.01': [0, 1, -0.15], 'tail.02': [0, 1, 0.1],
                              'tail.03': [0, 0.85, 0.5], 'tail.end': [0, 0.3, 1]}}   # tail up: a happy cat
    for name, base, pose in (('purr', happy, STAND), ('sitpurr', sitk, sitk), ('liepurr', lie, lie)):
        n = frames(T, sleepy)
        loop = [add(base, add(purr_mods(i * T / n, T), breathe(i * T / n, T / 2, 0.8))) for i in range(n)]
        out[name] = (loop, n / T, True, 'hand-keyed', True)
        m = max(4, frames(0.4))
        out[name + 'in'] = ([blend(cat, pose, loop[0], smooth(i / (m - 1))) for i in range(m)], fps, False, 'hand-keyed', True)
    return out


def pose_keys(b):
    """pose -> (its rest key, grounded): where the core looks for zones."""
    return {'stand': (STAND, True), 'sit': (b.rt.key(b.tux.clip('IdleSit'), 0), True), 'lie': (loaf(), True),
            'sleep': (curled(), True), 'fall': (fall_key(0), True), 'dangle': (dangle(0), False)}


def walk_speed(b):
    """Ground speed of the native walk (m/s at its own fps)."""
    return gait_speed(b.cat, b.cat.j['animations'][0], ('foot.F.L', 'foot.B.L', 'foot.F.R', 'foot.B.R'), b.s)


def main():
    cat_path, tux_path, out, height, fps = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5])
    os.makedirs(out, exist_ok=True)
    b = Baker(cat_path, tux_path, height, fps)
    open(os.path.join(out, 'cat.png'), 'wb').write(png_from(b.cat.texture))
    write_mtl(out)
    uv = np.stack([b.cat.UV[:, 0], 1 - b.cat.UV[:, 1]], axis=1)
    meta = {}
    for name, (keys, f, loop, source, ground) in clips(b).items():
        for i, k in enumerate(keys):
            p, n = b.mesh(k, ground)
            write_obj(os.path.join(out, f'{name}_{i}.obj'), p, n, uv, b.cat.F)
        meta[name] = {'frames': len(keys), 'fps': round(f, 4), 'loop': loop, 'source': source}
    json.dump({'height': height, 'vertices': len(b.cat.P), 'walkSpeed': round(walk_speed(b), 3),
               'zones': b.zones(), 'poseZones': {k: b.zones(key, ground) for k, (key, ground) in pose_keys(b).items()},
               'clips': meta}, open(os.path.join(out, 'frames.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()

