#!/usr/bin/env python3
"""glTF rigs for the VR pet's bakes (bake.py: the Toon Cat; bake_gltf.py: other
animals): reading glTF / GLB (accessors), quaternions, node hierarchies
posed from their animation clips (Rig), skinning on the CPU (Skinned),
writing a posed frame as a static OBJ (write_obj, write_mtl), the ground
speed of a walk clip (walk_speed) and smoothstep (smooth).
"""
import io, json, math, os, struct
import numpy as np

# ---------------------------------------------------------------- glTF ----

COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def load(path):
    b = open(path, 'rb').read()
    if b[:4] == b'glTF':
        off, j, binc = 12, None, None
        while off < len(b):
            ln, typ = struct.unpack('<II', b[off:off + 8])
            chunk = b[off + 8:off + 8 + ln]
            if typ == 0x4E4F534A:
                j = json.loads(chunk)
            elif typ == 0x004E4942:
                binc = chunk
            off += 8 + ln
        return j, binc
    j = json.loads(b)
    return j, open(os.path.join(os.path.dirname(path), j['buffers'][0]['uri']), 'rb').read()


def accessor(j, binc, i):
    a = j['accessors'][i]
    bv = j['bufferViews'][a['bufferView']]
    dt = np.dtype(COMP[a['componentType']])
    n, c = a['count'], NCOMP[a['type']]
    start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride') or dt.itemsize * c
    raw = np.frombuffer(binc, dtype=np.uint8, count=stride * (n - 1) + dt.itemsize * c, offset=start)
    rows = np.lib.stride_tricks.as_strided(raw, shape=(n, dt.itemsize * c), strides=(stride, 1))
    out = np.ascontiguousarray(rows).view(dt).reshape(n, c).astype(np.float64)
    if a.get('normalized') and dt != np.float32:
        out /= np.iinfo(dt).max
    return out

# ---------------------------------------------------------- quaternions ----
# (x, y, z, w), as glTF.

QI = np.array([0.0, 0.0, 0.0, 1.0])


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array([aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw,
                     aw * bw - ax * bx - ay * by - az * bz])


def qinv(q):
    return np.array([-q[0], -q[1], -q[2], q[3]])


def qnorm(q):
    return q / np.linalg.norm(q)


def qmat(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def mat_q(m):
    m = m / np.linalg.norm(m, axis=0)   # drop (uniform) scale
    t = np.trace(m)
    if t > 0:
        s = math.sqrt(t + 1) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, s / 4]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [s / 4, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, s / 4, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = math.sqrt(1 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, s / 4, (m[1, 0] - m[0, 1]) / s]
    return qnorm(np.array(q))


def qaxis(axis, deg):
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    h = math.radians(deg) / 2
    return np.array([*(a * math.sin(h)), math.cos(h)])


def qeuler(x=0.0, y=0.0, z=0.0):
    """Degrees about the body axes X (left, pitch: + = nose down), Y (up,
    yaw: + = turn left), Z (forward, roll), applied Z, then X, then Y."""
    return qmul(qaxis([0, 1, 0], y), qmul(qaxis([1, 0, 0], x), qaxis([0, 0, 1], z)))


def qrot(q, v):
    return qmat(q) @ v


def qbetween(a, b):
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    c = np.cross(a, b)
    d = float(np.dot(a, b))
    if d < -0.999999:
        ax = np.cross(a, [1, 0, 0])
        if np.linalg.norm(ax) < 1e-6:
            ax = np.cross(a, [0, 1, 0])
        return qaxis(ax, 180)
    return qnorm(np.array([*c, 1 + d]))


def slerp(a, b, u):
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = float(np.dot(a, b))
    if d < 0:
        b, d = -b, -d
    if d > 0.9995:
        return qnorm(a + u * (b - a))
    th = math.acos(d)
    return qnorm((math.sin((1 - u) * th) * a + math.sin(u * th) * b) / math.sin(th))


def qscale(q, s):   # s times the rotation angle
    return slerp(QI, q, s)


def smooth(u):
    """Smoothstep of u, clamped to 0..1."""
    u = min(1.0, max(0.0, u))
    return u * u * (3 - 2 * u)

# ---------------------------------------------------------------- rigs ----


class Rig:
    def __init__(self, path):
        self.j, self.bin = j, binc = load(path)
        self.nodes = j['nodes']
        self.parent = {c: i for i, n in enumerate(self.nodes) for c in n.get('children', [])}
        self.idx = {}
        for i, n in enumerate(self.nodes):
            self.idx.setdefault(n.get('name', ''), i)
            self.idx.setdefault(n.get('name', '').rsplit('_', 1)[0], i)   # "spine.01_012" -> "spine.01"
        self.order = []
        seen = set()

        def visit(i):
            if i in seen:
                return
            if i in self.parent:
                visit(self.parent[i])
            seen.add(i)
            self.order.append(i)
        for i in range(len(self.nodes)):
            visit(i)
        self.rest = [self.trs(n) for n in self.nodes]
        self.rest_world = self.world(self.rest)
        self.rest_rot = [mat_q(m[:3, :3]) for m in self.rest_world]

    @staticmethod
    def trs(n):
        if 'matrix' in n:
            m = np.array(n['matrix']).reshape(4, 4).T
            s = np.linalg.norm(m[:3, :3], axis=0)
            return (m[:3, 3].copy(), mat_q(m[:3, :3]), s)
        return (np.array(n.get('translation', [0, 0, 0]), float), np.array(n.get('rotation', [0, 0, 0, 1]), float),
                np.array(n.get('scale', [1, 1, 1]), float))

    def world(self, pose):
        out = [None] * len(self.nodes)
        for i in self.order:
            t, r, s = pose[i]
            m = np.eye(4)
            m[:3, :3] = qmat(r) * s
            m[:3, 3] = t
            out[i] = out[self.parent[i]] @ m if i in self.parent else m
        return out

    def __getitem__(self, name):
        return self.idx[name]

    def clip(self, name):
        return next(a for a in self.j['animations'] if a.get('name') == name)

    def sample(self, anim, t):
        """Local TRS of all nodes at time t of animation `anim`."""
        pose = [list(p) for p in self.rest]
        for c in anim['channels']:
            path = c['target']['path']
            if path not in ('translation', 'rotation', 'scale'):
                continue
            s = anim['samplers'][c['sampler']]
            times = accessor(self.j, self.bin, s['input'])[:, 0]
            vals = accessor(self.j, self.bin, s['output'])
            if s.get('interpolation') == 'CUBICSPLINE':
                vals = vals[1::3]
            if t <= times[0]:
                v = vals[0]
            elif t >= times[-1]:
                v = vals[-1]
            else:
                k = int(np.searchsorted(times, t)) - 1
                u = (t - times[k]) / (times[k + 1] - times[k])
                if s.get('interpolation') == 'STEP':
                    v = vals[k]
                elif path == 'rotation':
                    v = slerp(vals[k], vals[k + 1], u)
                else:
                    v = vals[k] + u * (vals[k + 1] - vals[k])
            pose[c['target']['node']][('translation', 'rotation', 'scale').index(path)] = np.array(v)
        return pose

    def duration(self, anim):
        return max(float(accessor(self.j, self.bin, anim['samplers'][c['sampler']]['input'])[-1, 0]) for c in anim['channels'])


class Skinned(Rig):
    """A rig with one skinned mesh (the first mesh node with a skin): its
    vertices (P, N, UV (None without TEXCOORD_0), J, W), faces F and the
    skin's inverse bind matrices; skinned(pose) poses them."""

    def __init__(self, path):
        super().__init__(path)
        j, binc = self.j, self.bin
        mnode = next(i for i, n in enumerate(self.nodes) if 'mesh' in n and 'skin' in n)
        self.skin = j['skins'][self.nodes[mnode]['skin']]
        self.ibm = accessor(j, binc, self.skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
        P, N, UV, J, W, F = [], [], [], [], [], []
        base = 0
        for prim in j['meshes'][self.nodes[mnode]['mesh']]['primitives']:
            at = prim['attributes']
            p = accessor(j, binc, at['POSITION'])
            P.append(p)
            N.append(accessor(j, binc, at['NORMAL']))
            if 'TEXCOORD_0' in at:
                UV.append(accessor(j, binc, at['TEXCOORD_0']))
            J.append(accessor(j, binc, at['JOINTS_0']).astype(int))
            W.append(accessor(j, binc, at['WEIGHTS_0']))
            F.append(accessor(j, binc, prim['indices']).astype(int).reshape(-1, 3) + base)
            base += len(p)
        self.P, self.N, self.J, self.W, self.F = map(np.concatenate, (P, N, J, W, F))
        self.UV = np.concatenate(UV) if len(UV) == len(P) else None
        self.W = self.W / self.W.sum(axis=1, keepdims=True)

    def skinned(self, pose):
        g = self.world(pose)
        jm = np.array([g[jt] @ self.ibm[k] for k, jt in enumerate(self.skin['joints'])])
        m = np.einsum('vk,vkij->vij', self.W, jm[self.J])
        p = np.einsum('vij,vj->vi', m[:, :3, :3], self.P) + m[:, :3, 3]
        n = np.einsum('vij,vj->vi', m[:, :3, :3], self.N)
        n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
        return p, n, g

# ---------------------------------------------------------------- output ----


def png_from(data):
    from PIL import Image
    buf = io.BytesIO()
    Image.open(io.BytesIO(data)).convert('RGB').save(buf, 'PNG')
    return buf.getvalue()


def walk_speed(rig, anim, feet, scale, n=100, back_only=False):
    """Ground speed of a walk clip (m/s at its own speed; the rig scaled by
    `scale`): how fast the feet move backwards (-z) while on the floor
    (back_only: and only while they move back, for feet that lift off low,
    as a reshaped rig's short legs)."""
    d = rig.duration(anim)
    speeds = []
    for foot in feet:
        g = [rig.world(rig.sample(anim, i * d / n))[rig[foot]][:3, 3] * scale for i in range(n)]
        y = np.array([p[1] for p in g])
        z = np.array([p[2] for p in g])
        v = np.diff(z) / (d / n)
        low = y[:-1] < y.min() + 0.004
        if back_only:
            low &= v < 0
        speeds.append(-v[low].mean())
    return float(np.mean(speeds))


def write_mtl(out):
    """cat.mtl: the one material of every frame (`mtllib cat.mtl`), its texture cat.png."""
    with open(os.path.join(out, 'cat.mtl'), 'w') as f:
        f.write('newmtl cat\nKa 1 1 1\nKd 1 1 1\nKs 0 0 0\nillum 1\nmap_Kd cat.png\n')


def write_obj(path, p, n, uv, F):
    with open(path, 'w') as f:
        f.write('mtllib cat.mtl\no cat\n')
        f.write(''.join(f'v {a:.4f} {b:.4f} {c:.4f}\n' for a, b, c in p))
        f.write(''.join(f'vt {a:.4f} {b:.4f}\n' for a, b in uv))
        f.write(''.join(f'vn {a:.3f} {b:.3f} {c:.3f}\n' for a, b, c in n))
        f.write('usemtl cat\n')
        f.write(''.join(f'f {a}/{a}/{a} {b}/{b}/{b} {c}/{c}/{c}\n' for a, b, c in F + 1))
