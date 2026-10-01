// VR pet, desktop adapter: runs the same core (core.js, global VrPetCore)
// with the same baked frames (models/: OBJ per frame + cat.png +
// frames.json) in a browser with three.js, with a fake user (head = camera)
// and a debug panel. Served by `nix run .#pet-preview` (package.nix).
//
// The right hand ("hand mode", H) follows the mouse cursor on the vertical
// plane through the cat that faces the camera (wheel: nearer / farther), so
// mouse speed is hand speed: stroke slowly over the back or head to pet,
// swipe fast past the cat to startle it. Above the cat: the grip bar and,
// below it, the controls row (⋯ and X) as in SteamVR (VrPetCore.ui's sizes
// and lifts, systemui.js' looks; always shown here). Press the
// left button on the bar and move the mouse to drag the cat by the scruff
// like SteamVR's laser (the grab point stays on the mouse ray at its
// distance; wheel: nearer / farther), release to drop it. Buttons act on a
// press and a release on them (inert during a drag and 300 ms after, as in
// SteamVR): X hides the cat (no ticks), "show" brings it back by the same
// rule (core reveal(): at its spot within 3 m and in view, else summoned;
// "summon on show" forces it); ⋯ opens the menu above the bar (the coats
// from the catalog, catalog/models.json, then Summon, Sit, Lie down, Sleep),
// closed by a pick, a press elsewhere or 1 s with the pointer away. The
// model: also the "model" dropdown; kept in the session like the spot. A
// coat swaps the texture; another animal (a frame set of its own, loaded
// on first use from catalog/<id>/) gets its frames and a new core at the
// same spot, as in SteamVR (systemui.js setModel()).
import * as THREE from './three/three.module.js';

const $ = (id) => document.getElementById(id);
const config = await fetch('config.json').then((r) => r.json()).catch(() => ({ fps: 12, cat: {} }));
// The models (index.py's models.json): the cat's frames in models/, the coats
// (their textures) and the animals (their frames) in catalog/<sub>/.
const catalog = await fetch('catalog/models.json').then((r) => r.json());
const dirOf = (id) => (catalog.models[id].sub ? `catalog/${catalog.models[id].sub}` : 'models');
// A frame set's baked data and where its OBJs are (the cat's: models/).
const setOf = (id) => catalog.models[id].frames;
const setDir = (set) => dirOf(catalog.order.find((id) => setOf(id) === set && (catalog.models[id].kind === 'base' || catalog.models[id].kind === 'gltf')));
let baked;

// ---------------------------------------------------------------- scene ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2e33);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(2, 4, 1);
scene.add(sun);
const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 64).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x3b4148 }));
scene.add(floor);
const grid = new THREE.GridHelper(24, 48, 0x59616b, 0x4a5058);
grid.position.y = 0.001;
scene.add(grid);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.02, 100);
const observer = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.02, 100);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  for (const c of [camera, observer]) { c.aspect = innerWidth / innerHeight; c.updateProjectionMatrix(); }
});

// ------------------------------------------------------------- frames ----
const textures = {};
const textureOf = async (id) => {
  if (!textures[id]) {
    textures[id] = await new THREE.TextureLoader().loadAsync(`${dirOf(id)}/cat.png`);
    textures[id].colorSpace = THREE.SRGBColorSpace;
  }
  return textures[id];
};
const material = new THREE.MeshLambertMaterial({ map: null, side: THREE.DoubleSide });

function parseObj(text) {   // bake.py's OBJs: v/vt/vn share indices (f a/a/a)
  const v = [], vt = [], vn = [], idx = [];
  for (const line of text.split('\n')) {
    const p = line.split(' ');
    if (p[0] === 'v') v.push(+p[1], +p[2], +p[3]);
    else if (p[0] === 'vt') vt.push(+p[1], +p[2]);
    else if (p[0] === 'vn') vn.push(+p[1], +p[2], +p[3]);
    else if (p[0] === 'f') for (let k = 1; k <= 3; k++) idx.push(parseInt(p[k], 10) - 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(vt, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(vn, 3));
  g.setIndex(idx);
  return g;
}
// Every frame set's geometry, loaded on first use: set -> clip -> [geometry].
const geoSets = {};
let geos = {};
async function loadSet(set) {
  if (geoSets[set]) return geoSets[set];
  const bk = catalog.frameSets[set], dir = setDir(set), out = {};
  let total = 0, loaded = 0;
  for (const c of Object.values(bk.clips)) total += c.frames;
  const note = document.createElement('div');
  note.id = 'loading';
  document.body.appendChild(note);
  await Promise.all(Object.entries(bk.clips).map(async ([name, c]) => {
    out[name] = await Promise.all(Array.from({ length: c.frames }, async (_, i) => {
      const g = parseObj(await (await fetch(`${dir}/${name}_${i}.obj`)).text());
      note.textContent = `loading baked frames (${set})… ${++loaded}/${total}`;
      return g;
    }));
  }));
  note.remove();
  return (geoSets[set] = out);
}
$('loading').remove();

const catRoot = new THREE.Group();
const catMesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
catRoot.add(catMesh);
scene.add(catRoot);

// Zones (on the standing animal) and waypoints.
const zoneGroup = new THREE.Group();
const zoneColors = { scruff: 0xff4d6d, head: 0x4dabf7, back: 0x69db7c, chin: 0xffd43b, tailBase: 0xda77f2 };
const drawZones = () => {
  zoneGroup.clear();
  for (const [k, p] of Object.entries(baked.zones ?? {})) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 8), new THREE.MeshBasicMaterial({ color: zoneColors[k] ?? 0xffffff, transparent: true, opacity: 0.8, depthTest: false }));
    m.position.set(...p);
    zoneGroup.add(m);
  }
};
catRoot.add(zoneGroup);
const pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xf0a04b }));
scene.add(pathLine);
const ring = (r, color) => {
  const m = new THREE.Mesh(new THREE.RingGeometry(r - 0.01, r + 0.01, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 }));
  m.position.y = 0.003;
  scene.add(m);
  return m;
};

// ----------------------------------------- grip bar, controls and menu ----
const UI = VrPetCore.ui, { HANDLE, CONTROLS, MENU, MENU_CMDS } = UI;
const HANDLE_H = HANDLE.widthM * HANDLE.heightPx / HANDLE.widthPx;   // m
const PX = 2;   // canvas pixels per texture pixel
const spriteOf = (w, h, draw, scale) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  s.scale.set(scale[0], scale[1], 1);
  s.center.set(0.5, 0);   // bottom-centre origin, like the panels' origin [0, -1]
  s.renderOrder = 10;
  s.redraw = (f) => { const g = c.getContext('2d'); g.clearRect(0, 0, w, h); f(g, w, h); t.needsUpdate = true; };
  scene.add(s);
  return s;
};
const roundRect = (g, x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); };
const barSprite = spriteOf(264, 60, (g, w, h) => {
  g.fillStyle = 'rgba(40, 44, 52, 0.55)'; roundRect(g, w * 0.08 - 4, h * 0.31 - 4, w * 0.84 + 8, h * 0.38 + 8, h);
  g.fillStyle = 'rgba(235, 238, 242, 0.92)'; roundRect(g, w * 0.08, h * 0.31, w * 0.84, h * 0.38, h);
}, [HANDLE.widthM, HANDLE_H]);
// The controls: one #23262E section (.6 opacity until hovered), ⋯ left, X right;
// a hovered button #3D4450, a pressed one #67707b.
const ctlSprite = spriteOf(CONTROLS.widthPx * PX, CONTROLS.heightPx * PX, () => {}, [CONTROLS.widthM, CONTROLS.widthM * CONTROLS.heightPx / CONTROLS.widthPx]);
const drawControls = (hover, pressed) => ctlSprite.redraw((g, w, h) => {
  g.save();
  g.beginPath(); g.roundRect(0, 0, w, h, 10 * PX); g.clip();
  g.globalAlpha = hover ? 1 : 0.6;
  g.fillStyle = '#23262E'; g.fillRect(0, 0, w, h);
  ['menu', 'close'].forEach((b, i) => {
    if (pressed === b || hover === b) { g.fillStyle = pressed === b ? '#67707b' : '#3D4450'; g.fillRect(i * w / 2, 0, w / 2, h); }
  });
  g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineCap = 'round'; g.lineWidth = 2.6 / 24 * h * 0.6;
  const cx = w * 0.75, cy = h / 2, r = h * 0.18;
  g.beginPath(); g.moveTo(cx - r, cy - r); g.lineTo(cx + r, cy + r); g.moveTo(cx + r, cy - r); g.lineTo(cx - r, cy + r); g.stroke();
  for (const dx of [-1, 0, 1]) { g.beginPath(); g.arc(w * 0.25 + dx * h * 0.2, cy, h * 0.045, 0, 2 * Math.PI); g.fill(); }
  g.restore();
});
drawControls(null, null);
// The menu (the stock popup look): the models (a separator between the coats
// and the animals), a separator, the commands.
const { breaks: groupBreaks, px: menuPx } = UI.menuLayout(catalog);
const menuRows = [], menuSeps = [];   // rows { y0, y1, model | cmd }; separator y
{
  let y = MENU.padPx;
  for (const id of catalog.order) {
    if (groupBreaks.includes(id)) { menuSeps.push(y + 4); y += MENU.sepPx; }
    menuRows.push({ y0: y, y1: y + MENU.modelRowPx, model: id }); y += MENU.modelRowPx;
  }
  menuSeps.push(y + 4);
  y += MENU.sepPx;
  for (const [cmd, label] of MENU_CMDS) { menuRows.push({ y0: y, y1: y + MENU.cmdRowPx, cmd, label }); y += MENU.cmdRowPx; }
}
const thumbs = Object.fromEntries(await Promise.all(catalog.order.map(async (id) => {
  const im = new Image(); im.src = catalog.models[id].thumb; await im.decode().catch(() => {}); return [id, im];
})));
const menuSprite = spriteOf(MENU.widthPx * PX, menuPx * PX, () => {}, [MENU.widthM, MENU.widthM * menuPx / MENU.widthPx]);
menuSprite.visible = false;
const drawMenu = (hover, pressed) => menuSprite.redraw((g, w) => {
  g.save();
  g.scale(PX, PX);
  g.fillStyle = '#2d3239'; roundRect(g, 0, 0, MENU.widthPx, menuPx, 10);
  g.font = '22px "Motiva Sans", Arial, sans-serif'; g.textBaseline = 'middle';
  menuRows.forEach((r, i) => {
    if (pressed === i || hover === i) { g.fillStyle = pressed === i ? '#67707b' : '#3d4450'; g.fillRect(0, r.y0, MENU.widthPx, r.y1 - r.y0); }
    const cy = (r.y0 + r.y1) / 2;
    g.fillStyle = '#fff';
    if (r.model) {
      g.drawImage(thumbs[r.model], 20, cy - 16, 32, 32);
      g.fillText(catalog.models[r.model].name, 20 + 32 + 16, cy);
      if (r.model === modelId) { g.fillStyle = '#1a9fff'; g.font = 'bold 22px Arial, sans-serif'; g.fillText('✓', MENU.widthPx - 24 - 16, cy); g.font = '22px "Motiva Sans", Arial, sans-serif'; }
    } else g.fillText(r.label, 20, cy);
  });
  g.fillStyle = 'rgba(255, 255, 255, 0.07)';
  for (const y of menuSeps) g.fillRect(0, y, MENU.widthPx, 1);
  g.restore();
  void w;
});

// ----------------------------------------------------------- fake user ----
const user = { x: 0, z: 1.6, yaw: 0, pitch: -0.35, height: 1.6, crouch: false, handDist: 0.45, depth: 0 };
const mouse = { x: 0, y: 0, inside: false };   // NDC
const planeAt = new THREE.Vector3(0, 0.2, 0);    // the hand plane's anchor (hand mode)
let handJump = true;                             // the hand teleported (no velocity from it)
const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), new THREE.MeshLambertMaterial({ color: 0xdddddd }));
const noseMesh = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.08, 8).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xf0a04b }));
noseMesh.position.z = -0.12;
headMesh.add(noseMesh);
scene.add(headMesh);
const handGeo = new THREE.BoxGeometry(0.05, 0.04, 0.12);
const hands = {
  left: new THREE.Mesh(handGeo, new THREE.MeshLambertMaterial({ color: 0x8899aa })),
  right: new THREE.Mesh(handGeo, new THREE.MeshLambertMaterial({ color: 0x8899aa })),
};
scene.add(hands.left, hands.right);
const lastHand = { left: new THREE.Vector3(), right: new THREE.Vector3() };
const handVel = { left: new THREE.Vector3(), right: new THREE.Vector3() };   // smoothed like a tracker's
// Pet helpers: the petting reach around head, back and scruff.
const wire = (r, color) => new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10), new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.25, depthTest: false }));
const reach = { pet: ['head', 'back', 'scruff'].map(() => wire(VrPetCore.THRESHOLDS.PET_RADIUS, 0x69db7c)) };
scene.add(...reach.pet);
const followRing = ring(1, 0x4dabf7), nearRing = ring(1, 0x69db7c);

const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  keys.add(e.code);
  if (e.code === 'KeyC') user.crouch = !user.crouch;
  if (e.code === 'KeyV') { $('third').checked = !$('third').checked; }
  if (e.code === 'KeyH') { $('handmode').checked = !$('handmode').checked; handJump = true; }
});
addEventListener('keyup', (e) => keys.delete(e.code));
// Mouse: look with the mouse captured (double-click; Esc releases) or with the
// right button dragged (left button too without hand mode).
renderer.domElement.addEventListener('dblclick', () => renderer.domElement.requestPointerLock?.());
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('mousemove', (e) => {
  if (e.target === renderer.domElement) {
    if (!mouse.inside) handJump = true;
    mouse.x = e.clientX / innerWidth * 2 - 1; mouse.y = -(e.clientY / innerHeight) * 2 + 1; mouse.inside = true;
  }
  const look = document.pointerLockElement === renderer.domElement ||
    (e.target === renderer.domElement && (e.buttons & 2 || (e.buttons & 1 && !$('handmode').checked && !barDrag)));
  if (!look) return;
  user.yaw -= e.movementX * 0.0025;
  user.pitch = Math.max(-1.4, Math.min(1.4, user.pitch - e.movementY * 0.0025));
});
renderer.domElement.addEventListener('mouseleave', () => { mouse.inside = false; handJump = true; });
$('handmode').addEventListener('change', () => { handJump = true; });
addEventListener('wheel', (e) => {
  if (barDrag) barDrag.dist = Math.max(0.3, Math.min(5, barDrag.dist - Math.sign(e.deltaY) * 0.1));   // the thumbstick's push / pull
  else if ($('handmode').checked) user.depth = Math.max(-0.4, Math.min(0.4, user.depth + Math.sign(e.deltaY) * 0.02));
  else user.handDist = Math.max(0.15, Math.min(1.2, user.handDist - Math.sign(e.deltaY) * 0.04));
}, { passive: true });
const raycaster = new THREE.Raycaster();

function updateUser(dt) {
  const run = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.5 : 1.2;
  const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0), s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  // camera looks along -Z at yaw 0
  user.x += (-Math.sin(user.yaw) * f + Math.cos(user.yaw) * s) * run * dt;
  user.z += (-Math.cos(user.yaw) * f - Math.sin(user.yaw) * s) * run * dt;
  const h = user.crouch ? 0.9 : user.height;
  camera.position.set(user.x, h, user.z);
  camera.rotation.set(user.pitch, user.yaw, 0, 'YXZ');
  headMesh.position.copy(camera.position);
  headMesh.quaternion.copy(camera.quaternion);
  // Right hand: on the cursor (hand mode) or in front of the view; left hand at the side.
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  let placed = false;
  if ($('handmode').checked && document.pointerLockElement !== renderer.domElement && mouse.inside) {
    // The vertical plane through the cat (0.2 m up), facing the camera, moved
    // by the wheel; kept where it was while the cat is held or falling (it
    // would follow the hand along the ray).
    const st = cat.state(), flat = new THREE.Vector3(fwd.x, 0, fwd.z).normalize();
    if (!st.held && !st.falling) planeAt.set(st.x, 0.2, st.z);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(flat, planeAt.clone().addScaledVector(flat, user.depth));
    raycaster.setFromCamera(new THREE.Vector2(mouse.x, mouse.y), camera);
    const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (hit && hit.distanceTo(camera.position) < 6) { hands.right.position.copy(hit); placed = true; }
  }
  if (!placed) hands.right.position.copy(camera.position).addScaledVector(fwd, user.handDist).addScaledVector(right, 0.12).add(new THREE.Vector3(0, -0.15, 0));
  hands.right.quaternion.copy(camera.quaternion);
  hands.left.position.copy(camera.position).addScaledVector(right, -0.25).add(new THREE.Vector3(0, -0.55, 0)).addScaledVector(fwd, 0.1);
  hands.left.quaternion.copy(camera.quaternion);
  for (const k of ['left', 'right']) {
    if (handJump) handVel[k].set(0, 0, 0);   // cursor entered / mode switched: no swing
    else if (dt > 0) handVel[k].lerp(new THREE.Vector3().subVectors(hands[k].position, lastHand[k]).divideScalar(dt), Math.min(1, dt / 0.06));
    lastHand[k].copy(hands[k].position);
  }
  handJump = false;
}

// ---------------------------------------------------------- the world ----
let saved;
try { saved = JSON.parse(sessionStorage.getItem('vr-pet') ?? 'null') ?? undefined; } catch { saved = undefined; }
// Merged writes, as systemui.js (the core saves its keys, hide / show `hidden`).
const store = (v) => { saved = { ...saved, ...v }; try { sessionStorage.setItem('vr-pet', JSON.stringify(saved)); } catch { /* private mode */ } };
let hidden = saved?.hidden === true;
let modelId = catalog.models[saved?.model] ? saved.model : catalog.default;
const logLines = [];
let forcedClip = '', forcedT = 0;
const world = {
  head() {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const l = Math.hypot(f.x, f.z) || 1;
    return { x: camera.position.x, y: camera.position.y, z: camera.position.z, fx: f.x / l, fz: f.z / l };
  },
  hands: () => handsNow,
  held: () => heldNow,
  show(clip, i, at) {
    if (forcedClip) { clip = forcedClip; i = Math.floor(forcedT * baked.clips[clip].fps) % baked.clips[clip].frames; }
    catMesh.geometry = geos[clip]?.[i] ?? catMesh.geometry;
    placed = { p: [at.x, at.y, at.z], q: at.q ?? VrPetCore.math.qyaw(at.yaw) };
    shownClip = clip; shownFrame = i;
  },
  load: () => saved,
  save: (v) => store(v),
  log: (...a) => {
    logLines.push(`${(performance.now() / 1000).toFixed(1)} ${a.join(' ')}`);
    if (logLines.length > 40) logLines.shift();
    $('log').textContent = logLines.slice().reverse().join('\n');
  },
};
let shownClip = 'idle', shownFrame = 0;
let placed = null;
function placeCat() {
  if (!placed) return;
  catRoot.position.set(...placed.p);
  catRoot.quaternion.set(placed.q[1], placed.q[2], placed.q[3], placed.q[0]);
}
let handsNow = { left: null, right: null }, heldNow = null;
const sampleHands = () => {
  const h = (k) => ({ x: hands[k].position.x, y: hands[k].position.y, z: hands[k].position.z, vx: handVel[k].x, vy: handVel[k].y, vz: handVel[k].z });
  return { left: h('left'), right: h('right') };
};
// The laser drag (systemui.js' drag of the grip bar): the grab point on the
// mouse ray at `dist` from the camera; velocity from its motion.
let barDrag = null, lastDragEnd = -Infinity;   // { dist, point, prev }
const dragPoint = (dt) => {
  pointer.setFromCamera(new THREE.Vector2(mouse.x, mouse.y), camera);
  const q = pointer.ray.at(barDrag.dist, new THREE.Vector3());
  const prev = barDrag.point ?? q;
  barDrag.point = q;
  return { x: q.x, y: Math.max(0.05, q.y), z: q.z, vx: dt > 0 ? (q.x - prev.x) / dt : 0, vy: dt > 0 ? (q.y - prev.y) / dt : 0, vz: dt > 0 ? (q.z - prev.z) / dt : 0 };
};

let cat = null;   // the core (a new one for another animal: setModel())
const TH = VrPetCore.THRESHOLDS;
// Readout: what the hand does to the cat, against the thresholds.
function interaction(st) {
  const n = st.near.find((x) => x.side === 'right');
  const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
  const onPet = n && n.dPet < TH.PET_RADIUS;
  const verdict = st.held ? `held (${st.held.source} ${st.held.hand})`
    : !n ? '-'
    : n.speed > TH.STARTLE_SPEED && n.dPet < TH.STARTLE_RADIUS + 0.1 ? 'FAST: startles'
    : onPet && n.speed < TH.PET_MAX_SPEED ? 'petting' : onPet ? 'too fast to pet' : '';
  return [
    `hand R   ${barDrag ? `DRAGGING the bar (${barDrag.dist.toFixed(1)} m)` : 'free'}`,
    `  speed  ${f(n?.speed)} m/s (pet < ${TH.PET_MAX_SPEED}, startle > ${TH.STARTLE_SPEED})`,
    `  pet    ${f(n?.dPet)} m (< ${TH.PET_RADIUS}; startle < ${TH.STARTLE_RADIUS})`,
    `  -> ${verdict}`,
    `petting  ${'#'.repeat(Math.round(Math.min(1, st.petT / TH.PET_TIME) * 12)).padEnd(12, '.')} ${f(st.petT, 1)}/${TH.PET_TIME} s${st.purring ? '  PURRING' : ''}${st.wary > 0 ? `  wary ${f(st.wary, 1)} s` : ''}`,
    `action   ${st.action ?? '-'}${st.pending ? ` (next ${st.pending})` : ''}${st.falling ? '  FALLING' : ''}  y ${f(st.y)}`,
  ];
}
$('go').onclick = () => cat.command($('cmd').value);
// Hide / show (systemui.js hide() / show()).
const inView = (st) => UI.inView(camera.position.toArray(), new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).toArray(), { x: st.x, y: 0, z: st.z });
function hideCat() {
  if (hidden) return;
  barDrag = null;
  cat.settle();
  closeMenu();
  hidden = true; store({ hidden: true });
  world.log('hidden');
}
function showCat() {
  const st = cat.state(), h = world.head();
  const r = VrPetCore.reveal(st, h, { inView: inView(st), force: $('summonshow').checked });
  if (r === 'summon') cat.command('summon');
  if (hidden) { hidden = false; store({ hidden: false }); }
  world.log('shown', r === 'summon' ? 'summoned' : 'at its spot');
}
$('show').onclick = showCat;
const pointer = new THREE.Raycaster();
// What the pointer is on: { target: 'bar' | 'menu' | 'close' | 'row', row } or null.
const hit = (e) => {
  if (hidden) return null;
  pointer.setFromCamera(new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  if (menuSprite.visible) {
    const [h] = pointer.intersectObject(menuSprite);
    if (h) {
      const y = (1 - h.uv.y) * menuPx, row = menuRows.findIndex((r) => y >= r.y0 && y < r.y1);
      return { target: row >= 0 ? 'row' : 'menuBox', row };
    }
  }
  const [c] = pointer.intersectObject(ctlSprite);
  if (c) return { target: c.uv.x < 0.5 ? 'menu' : 'close' };
  if (pointer.intersectObject(barSprite).length) return { target: 'bar' };
  return null;
};
const same = (a, b) => a && b && a.target === b.target && a.row === b.row;
// Buttons (⋯, X, menu rows): act on a press and a release on the same one,
// not while dragged or just after (systemui.js).
let armed = null, hovered = null, leaveTimer = null;
const dragBusy = () => !!barDrag || performance.now() - lastDragEnd < UI.AFTER_DRAG_MS;
const redraw = () => {
  const hb = hovered && ['menu', 'close'].includes(hovered.target) ? hovered.target : null;
  drawControls(hb, armed && ['menu', 'close'].includes(armed.target) ? armed.target : null);
  if (menuSprite.visible) drawMenu(hovered?.target === 'row' ? hovered.row : null, armed?.target === 'row' ? armed.row : null);
};
const openMenu = () => { menuSprite.visible = true; clearTimeout(leaveTimer); redraw(); world.log('menu open'); };
const closeMenu = () => { if (!menuSprite.visible) return; menuSprite.visible = false; clearTimeout(leaveTimer); world.log('menu closed'); };
async function setModel(id) {
  if (!catalog.models[id]) return;
  const set = setOf(id);
  if (catalog.frameSets[set] !== baked) {   // another animal (or the first model): its frames, a new core at the same spot
    geos = await loadSet(set);
    if (cat) {
      barDrag = null;
      cat.settle();
      cat.save();   // the spot and pose go over to the new core
    }
    baked = catalog.frameSets[set];
    cat = VrPetCore.create(world, { ...config.cat }, baked);
    cat.options.demo = $('demo').checked;
    catMesh.geometry = geos.idle[0];
    shownClip = 'idle'; shownFrame = 0; forcedClip = '';
    drawZones();
    $('clip').length = 1;
    for (const name of Object.keys(baked.clips)) $('clip').add(new Option(`clip: ${name} (${baked.clips[name].source}, ${baked.clips[name].frames})`, name));
  }
  modelId = id;
  material.map = await textureOf(id);
  material.needsUpdate = true;
  store({ model: id });
  $('model').value = id;
  world.log('model', id);
}
function act(h) {
  if (h.target === 'close') hideCat();
  else if (h.target === 'menu') { if (menuSprite.visible) closeMenu(); else openMenu(); }
  else if (h.target === 'row') {
    const r = menuRows[h.row];
    closeMenu();
    if (r.model) setModel(r.model); else { cat.command(r.cmd); world.log('menu', r.cmd); }
  }
}
renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const h = hit(e);
  if (menuSprite.visible && (!h || h.target === 'bar')) closeMenu();   // a press elsewhere
  if (h && ['menu', 'close', 'row'].includes(h.target)) { armed = dragBusy() ? null : h; redraw(); return; }
  const st = cat.state();
  if (h?.target === 'bar' && !st.falling) {
    const sc = cat.zone('scruff');
    barDrag = { dist: sc ? camera.position.distanceTo(new THREE.Vector3(sc.x, sc.y, sc.z)) : 1, point: null };
    armed = null;
    world.log('drag');
  }
});
addEventListener('mouseup', (e) => {
  const was = armed;
  armed = null;
  if (barDrag) { barDrag = null; lastDragEnd = performance.now(); world.log('drag end'); }
  else if (was && e.target === renderer.domElement && same(hit(e), was) && !dragBusy()) act(was);
  redraw();
}, true);
renderer.domElement.addEventListener('mousemove', (e) => {
  const h = hit(e);
  if (armed && !same(h, armed)) armed = null;   // left the pressed button
  hovered = h && !dragBusy() ? h : null;
  // The menu closes MENU.leaveMs after the pointer left it and the controls.
  const onUs = h && h.target !== 'bar';
  if (onUs) { clearTimeout(leaveTimer); leaveTimer = null; }
  else if (menuSprite.visible && !leaveTimer) leaveTimer = setTimeout(() => { leaveTimer = null; closeMenu(); }, MENU.leaveMs);
  redraw();
});
for (const id of catalog.order) $('model').add(new Option(`${catalog.models[id].group === 'animals' ? 'animal' : 'coat'}: ${catalog.models[id].name}`, id));
$('model').onchange = () => setModel($('model').value);
await setModel(modelId);
$('clip').onchange = () => { forcedClip = $('clip').value; forcedT = 0; };
$('speed').oninput = () => { $('speedv').textContent = (+$('speed').value).toFixed(1); };
$('demo').onchange = () => { cat.options.demo = $('demo').checked; };

window.__vrPetPreview = { get cat() { return cat; }, camera, user, openMenu, closeMenu, setModel, hideCat, showCat };   // debugging (DevTools)

// ---------------------------------------------------------------- loop ----
const tickDt = 1 / (config.fps || 12);
let acc = 0, last = performance.now(), fpsN = 0, fpsT = 0, fps = 0;
function frame(now) {
  const real = Math.min(0.1, (now - last) / 1000);
  last = now;
  updateUser(real);
  const scale = +$('speed').value;
  acc += real * scale;
  forcedT += real * scale;
  const step = (dt) => {   // same order as systemui.js: sample, the drag, tick
    handsNow = sampleHands();
    heldNow = barDrag ? { source: 'laser', hand: 'right', ...dragPoint(dt) } : null;
  };
  if (hidden) acc = 0;   // hidden: no ticks (as in SteamVR)
  while (acc >= tickDt) { step(tickDt); cat.tick(tickDt); acc -= tickDt; }   // same fixed step as in SteamVR
  if (scale === 0 && !hidden) { step(0); cat.tick(0); }
  placeCat();
  catRoot.visible = !hidden;
  // Grip bar, controls below it and the menu above it (world up; the dangle frames' origin is the scruff).
  const lift = shownClip === 'dangle' ? HANDLE.liftDangle : UI.liftOf(baked.height);
  barSprite.position.copy(catRoot.position).add(new THREE.Vector3(0, lift, 0));
  ctlSprite.position.copy(barSprite.position).add(new THREE.Vector3(0, -(CONTROLS.gapM + ctlSprite.scale.y), 0));
  const toCam = new THREE.Vector3().subVectors(camera.position, barSprite.position).setY(0).normalize();
  menuSprite.position.copy(barSprite.position).add(new THREE.Vector3(0, HANDLE_H + MENU.gapM, 0)).addScaledVector(toCam, MENU.forwardM);
  barSprite.visible = ctlSprite.visible = !hidden;
  if (hidden) menuSprite.visible = false;
  $('hiddenv').textContent = hidden ? 'hidden' : '';

  const st = cat.state();
  zoneGroup.visible = $('zones').checked && shownClip === 'idle';
  // Reach spheres: petting (head, back, scruff).
  const showReach = $('reach').checked && !hidden;
  ['head', 'back', 'scruff'].forEach((k, i) => {
    const z = cat.zone(k);
    reach.pet[i].visible = showReach && !!z && !st.held && !st.falling;
    if (z) reach.pet[i].position.set(z.x, z.y, z.z);
  });
  const showPaths = $('paths').checked;
  pathLine.visible = followRing.visible = nearRing.visible = showPaths;
  if (showPaths) {
    const pts = [new THREE.Vector3(st.x, 0.01, st.z), ...st.waypoints.map(([x, z]) => new THREE.Vector3(x, 0.01, z))];
    pathLine.geometry.setFromPoints(pts);
    const h = world.head();
    followRing.position.set(h.x, 0.003, h.z); followRing.scale.setScalar(cat.options.follow);
    nearRing.position.set(h.x, 0.003, h.z); nearRing.scale.setScalar(cat.options.near);
  }
  fpsN++; fpsT += real;
  if (fpsT > 0.5) { fps = fpsN / fpsT; fpsN = 0; fpsT = 0; }
  const h = world.head();
  $('state').textContent = [
    `pose     ${st.pose}${st.edge ? ` (${st.edge} -> ${st.goal})` : st.goal !== st.pose ? ` -> ${st.goal}` : ''}`,
    `activity ${st.activity}${st.forced ? ` (forced ${st.forced})` : ''}`,
    `clip     ${shownClip} ${shownFrame}/${baked.clips[shownClip].frames - 1}${forcedClip ? ' (forced)' : ''}`,
    `calm     ${st.calm.toFixed(0)} s`,
    `cat      ${st.x.toFixed(2)} ${st.z.toFixed(2)}  yaw ${(st.yaw * 180 / Math.PI).toFixed(0)}°`,
    `user     ${Math.hypot(h.x - st.x, h.z - st.z).toFixed(2)} m away`,
    ...interaction(st),
    `render   ${fps.toFixed(0)} fps, core ${(config.fps || 12)} Hz`,
  ].join('\n');

  headMesh.visible = $('third').checked;
  let cam = camera;
  if ($('third').checked) {   // behind and above the user, looking at the cat
    const back = new THREE.Vector3(Math.sin(user.yaw), 0, Math.cos(user.yaw));
    observer.position.set(user.x + back.x * 2.2, 2.4, user.z + back.z * 2.2);
    observer.lookAt((user.x + st.x) / 2, 0.2, (user.z + st.z) / 2);
    cam = observer;
  }
  renderer.render(scene, cam);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
