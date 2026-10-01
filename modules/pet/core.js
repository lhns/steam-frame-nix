// VR pet core: behaviour, movement, interaction and clip playback,
// independent of where the cat is drawn. The adapters (systemui.js for
// SteamVR's dashboard, preview/preview.js for a desktop browser, tests/ for
// node) implement the world interface:
//
//   world.head()      -> { x, y, z, fx, fz } | null   head position (standing
//                        space: metres, y up, floor at 0) and its forward
//                        direction on the floor (unit)
//   world.hands()     -> { left, right }, each { x, y, z, vx, vy, vz, ... }
//                        | null: controller position (m) and velocity (m/s)
//                        (petting, startle)
//   world.held()      -> null | { source: 'laser', hand: 'left' | 'right' }
//                        (optional x, y, z, vx, vy, vz: the grab point, else
//                        world.hands()[hand]): the cat is being held by the
//                        scruff (the adapters: the laser drag of the grip bar
//                        above it). The adapter decides; the core only
//                        reacts: dangle while held (the offset between grab
//                        point and scruff at the grab is kept), fall and land
//                        on release.
//   world.heldPose() -> null | { x, y, z, q }  (optional) where the held cat
//                        really is: an adapter whose compositor carries the
//                        held cat (systemui.js: its root parented to the hand) reports its
//                        world pose, also on the tick it is let go, so the
//                        fall starts from there. Without it the core moves the
//                        cat with the grab point.
//   world.show(clip, frame, { x, y, z, yaw, q })  draw baked frame `frame` of
//                        `clip` at that spot (yaw: radians about +y, 0 = the
//                        cat faces +z; q: the full orientation, a quaternion
//                        [w, x, y, z]: the yaw, or a held / falling cat's tilt)
//   world.prefetch(clips)  (optional) the clips needed now or soon (a Set,
//                        most urgent first)
//   world.ready(clip) -> bool  (optional) whether the clip can be shown yet;
//                        playback holds the current frame until it is
//   world.load() -> saved object | undefined;  world.save(object)
//   world.log(...args)
//
// Baked data (frames.json from bake.py / bake_gltf.py): clips { name: {
// frames, fps, loop } }, walkSpeed (m/s of the walk clip at its fps), zones /
// poseZones (scruff, head, back, chin, tailBase per pose, in the frames' own
// space), optional species { actions: { name: { pose, weight, cooldown } } }
// (an animal's own idle actions, chosen like the cat's groom or stretch).
//
// Other animals (species): the graph below is the cat's; an animal gets what
// its baked clips allow (NEAREST, logged once; the fallbacks for model
// authors: docs/pet-models.md, "Clips").
//
// Poses and the clips between them (a transition played backwards is the
// reverse transition):
//
//   stand (idle) --sitdown--> sit --standup--> stand
//   stand --liedown--> lie --curl--> sleep        (and back, reversed)
//   stand --walkstart--> walk                     (and back, reversed, when
//                                                  the walk cycle is at 0)
//   stand --purrin--> purr, sit --sitpurrin--> sitpurr,
//   lie --liepurrin--> liepurr                    (petted; and back)
//   dangle (held by the scruff), fall (dropped): entered without a
//   transition; landing plays `land` and ends standing.
//
// Actions: one-shot clips that start and end in a pose's rest frame:
// groom (sit), stretch, shake, startle, land (stand). The cat walks the pose
// graph to the action's pose first.
//
// Behaviour: rests in a pose for a while, then wanders to a random spot near
// the user (never through them), sits, grooms, stretches (above all after
// waking), shakes itself, lies down, falls asleep after a long calm, turns to
// face the user now and then, follows when the user is more than `follow`
// metres away, reappears in front of the user beyond `summon`.
//
// Interaction (thresholds below):
//   scruff grab   world.held() (see above): lifted by the scruff, dangles
//                 from the grab point until released (carried by the adapter,
//                 world.heldPose()), then falls with gravity from where it
//                 was (keeping a little of the grab point's swing; a tilted
//                 cat rights itself in the air), lands (squash) and shakes
//                 itself, grooms or walks off.
//   petting       a free hand resting or stroking slowly on the
//                 head / back / scruff for PET_TIME: the cat purrs (eyes
//                 closed, leaning into the hand) in its pose (standing,
//                 sitting or lying; a sleeping cat wakes up to lie), as long
//                 as strokes keep coming, PURR_LINGER after the last one.
//   startle       a fast hand close to the cat: it arches its back (standing
//                 up first if it sat or lay) and backs off, away from the
//                 hand; no purring for WARY_TIME after that.
//
var VrPetCore = (() => {
  // ---- interaction thresholds ----
  const PET_RADIUS = 0.10;      // m: controller to head / back / scruff counts as touching
  const PET_MAX_SPEED = 0.4;    // m/s: slower is a stroke (or a resting hand)
  const PET_TIME = 0.6;         // s of touching before the cat purrs
  const PET_DECAY = 0.5;        // touching time lost per second without touching
  const PURR_LINGER = 2.5;      // s: purring goes on this long after the last touch
  const STARTLE_SPEED = 1.0;    // m/s: a hand this fast ...
  const STARTLE_RADIUS = 0.18;  // m: ... this close to any part of the cat startles it
  const STARTLE_COOLDOWN = 4;   // s between startles
  const WARY_TIME = 6;          // s after a startle without purring
  const FLEE_DISTANCE = 0.9;    // m: backs off this far from the hand
  const FLEE_SPEED = 1.8;       // x walkSpeed while backing off
  const GRAVITY = 9.81;         // m/s²
  const THROW = 0.3;            // share of the grabber's velocity a dropped cat keeps
  const THROW_MAX = 1.2;        // m/s
  const RIGHT_TIME = 0.3;       // s: a cat dropped tilted rights itself in the air in this time
  // Clips kept loaded all the time (world.prefetch): grab, drop and landing
  // must show at once. Near a hand only: the purr (a hand this close to the
  // head / back) and the startle (a hand this close moving fast).
  const ALWAYS = ['dangle', 'fall', 'land'];
  const PURR_PREP = 0.3;        // m
  const STARTLE_PREP = 0.6;     // m, above STARTLE_PREP_SPEED m/s
  const STARTLE_PREP_SPEED = 0.5;
  const LOOKAHEAD = 1.2;        // s: the next idle choice is made this early (its clips load meanwhile)
  const COOLDOWN = { groom: 40, stretch: 60, shake: 50 };   // s between idle actions of a kind
  const REVEAL_KEEP = 3;        // m: a cat shown again (reveal()) stays at its spot within this of the user

  const EDGES = [
    ['stand', 'sit', 'sitdown', 1], ['sit', 'stand', 'standup', 1],
    ['stand', 'lie', 'liedown', 1], ['lie', 'stand', 'liedown', -1],
    ['lie', 'sleep', 'curl', 1], ['sleep', 'lie', 'curl', -1],
    ['stand', 'walk', 'walkstart', 1], ['walk', 'stand', 'walkstart', -1],
    ['stand', 'purr', 'purrin', 1], ['purr', 'stand', 'purrin', -1],
    ['sit', 'sitpurr', 'sitpurrin', 1], ['sitpurr', 'sit', 'sitpurrin', -1],
    ['lie', 'liepurr', 'liepurrin', 1], ['liepurr', 'lie', 'liepurrin', -1],
  ];
  const LOOP = { stand: 'idle', sit: 'sit', lie: 'lie', sleep: 'sleep', walk: 'walk', dangle: 'dangle', fall: 'fall',
    purr: 'purr', sitpurr: 'sitpurr', liepurr: 'liepurr' };
  const SNAP = ['dangle', 'fall'];                     // entered / left without a transition
  const RESTING = ['stand', 'sit', 'lie', 'sleep'];
  // The resting pose a pose counts as (saving, zones, purring).
  const BASE = { stand: 'stand', sit: 'sit', lie: 'lie', sleep: 'sleep', walk: 'stand', purr: 'stand', sitpurr: 'sit',
    liepurr: 'lie', dangle: 'stand', fall: 'stand' };
  const PURR = { stand: 'purr', sit: 'sitpurr', lie: 'liepurr', sleep: 'liepurr' };
  const ACTIONS = { groom: 'sit', stretch: 'stand', shake: 'stand', startle: 'stand', land: 'stand' };
  const DEFAULTS = {
    walkSpeed: 0.25,   // m/s
    turnRate: 2.2,     // rad/s while walking
    near: 0.8,         // m: follow stops this far from the user
    follow: 2.5,       // m: farther away, the cat follows
    wakeDistance: 4,   // m: a sleeping cat follows only beyond this
    wanderRadius: 2,   // m around the user
    personal: 0.55,    // m: paths keep this far from the user
    summon: 8,         // m: farther away, it reappears in front of the user
    lieAfter: 40,      // s of calm before it may lie down
    sleepAfter: 70,    // s of calm before it may fall asleep
    dangleHeight: 0.45, // m: scruff height of the forced (debug) dangle
    demo: false,       // cycle through all poses/activities (debug)
  };

  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (weights) => {   // { key: weight } -> key
    let t = Math.random() * Object.values(weights).reduce((s, w) => s + w, 0);
    for (const [k, w] of Object.entries(weights)) if ((t -= w) < 0) return k;
    return Object.keys(weights)[0];
  };
  const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  // ---- poses: { p: [x, y, z], q: [w, x, y, z] } (rotation first, then p) ----
  const qmul = (a, b) => [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
  const qconj = (q) => [q[0], -q[1], -q[2], -q[3]];
  const qnorm = (q) => { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); };
  const qrot = (q, v) => { const r = qmul(qmul(q, [0, v[0], v[1], v[2]]), qconj(q)); return [r[1], r[2], r[3]]; };
  const qyaw = (yaw) => [Math.cos(yaw / 2), 0, Math.sin(yaw / 2), 0];   // about +y
  // Heading of the cat's +z (its nose) on the floor; `fallback` when it points straight up or down.
  const yawOf = (q, fallback = 0) => { const f = qrot(q, [0, 0, 1]); return Math.hypot(f[0], f[2]) < 1e-3 ? fallback : Math.atan2(f[0], f[2]); };
  const nlerp = (a, b, t) => {
    const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
    return qnorm(a.map((v, i) => v + (s * b[i] - v) * t));
  };
  const compose = (a, b) => { const r = qrot(a.q, b.p); return { p: [a.p[0] + r[0], a.p[1] + r[1], a.p[2] + r[2]], q: qnorm(qmul(a.q, b.q)) }; };
  const invert = (a) => { const c = qconj(a.q), r = qrot(c, a.p); return { p: [-r[0], -r[1], -r[2]], q: c }; };
  const relative = (parent, child) => compose(invert(parent), child);   // child in the parent's frame
  const qdiffDeg = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI;
  const math = { qmul, qconj, qnorm, qrot, qyaw, yawOf, nlerp, compose, invert, relative, qdiffDeg };

  // Where a pose without its loop goes instead (other animals).
  const NEAREST = { sit: 'stand', lie: 'stand', sleep: 'lie', purr: 'stand', sitpurr: 'sit', liepurr: 'lie', dangle: 'fall', fall: 'stand' };

  function routeEdges(from, to, edges = EDGES) {   // BFS over the edges -> list of edges
    const prev = { [from]: null }, queue = [from];
    while (queue.length) {
      const p = queue.shift();
      if (p === to) break;
      for (const e of edges) if (e[0] === p && !(e[1] in prev)) { prev[e[1]] = e; queue.push(e[1]); }
    }
    if (!(to in prev)) return null;
    const path = [];
    for (let p = to; prev[p]; p = prev[p][0]) path.unshift(prev[p]);
    return path;
  }

  function create(world, userOpts, baked) {
    const o = { ...DEFAULTS, ...userOpts };
    const clips = baked.clips;
    // ---- the species: what its baked clips allow (the cat: everything) ----
    const logged = new Set();
    const logOnce = (...a) => { const k = a.join(' '); if (!logged.has(k)) { logged.add(k); world.log?.(...a); } };
    const has = (c) => !!clips[c];
    const avail = (p) => has(LOOP[p]);   // a pose is there when its loop is baked
    const nearest = (p) => { let q = p; while (q && !avail(q)) q = NEAREST[q]; return q ?? 'stand'; };
    const loop = {};   // pose -> the clip it shows (its own loop, else the nearest pose's)
    for (const p of Object.keys(LOOP)) {
      loop[p] = LOOP[nearest(p)];
      if (loop[p] !== LOOP[p]) logOnce('no clip', LOOP[p], '->', loop[p]);
    }
    const edges = EDGES.filter((e) => avail(e[0]) && avail(e[1]));
    const route = (from, to) => routeEdges(from, to, edges);
    const spActions = Object.entries(baked.species?.actions ?? {});
    const actions = { ...ACTIONS, ...Object.fromEntries(spActions.map(([k, a]) => [k, a.pose ?? 'stand'])) };
    const cooldown = { ...COOLDOWN, ...Object.fromEntries(spActions.map(([k, a]) => [k, a.cooldown ?? 30])) };
    const zonesOf = (pose) => baked.poseZones?.[pose] ?? baked.poseZones?.[BASE[pose]] ?? baked.zones ?? {};
    const cat = {
      x: 0, z: 0, yaw: 0, y: 0,
      pose: 'stand',          // pose reached (or being left, during an edge)
      edge: null,             // [from, to, clip, dir] being played
      path: [],               // edges still to play
      goal: 'stand',          // pose wanted
      clip: 'idle', f: 0,     // clip playing and its (fractional) frame
      action: null,           // { name, then } one-shot clip playing
      pending: null,          // { name, then } action waiting for its pose
      activity: 'rest', until: rnd(3, 8), calm: 0,
      waypoints: [], placed: false, forced: null,
      time: 0,                // s since start (cooldowns)
      held: null,             // { source, hand, off: [dx, dy, dz], v } held by the scruff
      fall: null,             // { vx, vy, vz, q0, t } dropped, in the air (q0: tilt at the release)
      tilt: null,             // full orientation [w, x, y, z] while held / righting itself, else the yaw
      upcoming: null,         // the next idle choice, made LOOKAHEAD early
      petT: 0, lastPet: -1e9, purring: false, wary: -1e9, startleAt: -1e9,
      lastAct: { groom: 0, stretch: 0, shake: 0, ...Object.fromEntries(spActions.map(([k]) => [k, 0])) }, woke: false,
      near: [],               // per hand: distances, speed (debug readout)
    };
    const saved = world.load?.();
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.z)) {
      Object.assign(cat, { x: saved.x, z: saved.z, yaw: +saved.yaw || 0, placed: true });
      if (RESTING.includes(saved.pose)) { const p = nearest(saved.pose); Object.assign(cat, { pose: p, goal: p, clip: loop[p] }); }
    }
    const save = () => world.save?.({ x: +cat.x.toFixed(3), z: +cat.z.toFixed(3), yaw: +cat.yaw.toFixed(3), pose: BASE[cat.goal] ?? 'stand' });
    const log = (...a) => world.log?.(...a);

    // ---- pose graph / clip playback ----
    function goTo(pose) {
      if (cat.action) endAction(false);
      if (!SNAP.includes(pose)) pose = nearest(pose);   // (dangle, fall: states; their clip may be another's)
      cat.goal = pose;
      if (SNAP.includes(pose) || SNAP.includes(cat.pose)) {   // no transitions
        cat.edge = null; cat.path = []; cat.pose = pose; cat.clip = loop[pose]; cat.f = 0;
        return;
      }
      if (!cat.edge) plan();
    }
    function plan() {
      cat.path = cat.pose === cat.goal ? [] : (route(cat.pose, cat.goal) ?? []);
      startNext();
    }
    function startNext(cycleDone = false) {
      const e = cat.path[0];
      if (!e) { if (cat.clip !== loop[cat.pose]) { cat.clip = loop[cat.pose]; cat.f = 0; } return; }
      if (e[2] === 'walkstart' && e[3] < 0 && cat.clip === 'walk' && !cycleDone) return;   // wait for the cycle to come round
      cat.path.shift();
      cat.edge = e;
      if (!has(e[2])) { logOnce('no clip', e[2], '(cut)'); arrive(); return; }   // no transition clip: a cut
      cat.clip = e[2];
      cat.f = e[3] > 0 ? 0 : clips[e[2]].frames - 1;
    }
    // The edge being played is done: its pose reached.
    function arrive() {
      const from = cat.edge[0];
      cat.pose = cat.edge[1]; cat.edge = null;
      if (from === 'lie' && cat.pose === 'stand') cat.woke = true;
      if (cat.pose !== cat.goal) plan(); else { cat.clip = loop[cat.pose]; cat.f = 0; }
      if (RESTING.includes(cat.pose)) save();
    }
    const settled = () => !cat.edge && cat.path.length === 0 && cat.pose === cat.goal;
    const busy = () => !!(cat.action || cat.pending);

    // Actions: play `name` once in its pose (walking the pose graph there
    // first), then call `then`.
    function startAction(name, then) {
      if (!clips[name]) { then?.(); return; }
      if (name in cat.lastAct) cat.lastAct[name] = cat.time;
      cat.pending = { name, then };
      if (cat.pose !== actions[name] || !settled()) goTo(actions[name]);
      else runPending();
    }
    function runPending() {
      const p = cat.pending;
      if (!p || cat.pose !== actions[p.name] || !settled()) return;
      cat.pending = null;
      cat.action = p; cat.clip = p.name; cat.f = 0;
      log('action', p.name);
    }
    function endAction(done) {
      const a = cat.action;
      cat.action = null;
      cat.clip = loop[cat.pose]; cat.f = 0;
      if (done) a?.then?.();
    }
    function cancelActions() { cat.pending = null; if (cat.action) endAction(false); }

    let anticipate = new Set();
    const routeClips = (from, to, out) => { for (const e of route(from, to) ?? []) { out.add(e[2]); out.add(loop[e[1]]); } };
    // The clips needed now or soon, most urgent first.
    function wanted() {
      const out = new Set([cat.clip]);
      if (cat.edge) out.add(cat.edge[2]);
      for (const e of cat.path) { out.add(e[2]); out.add(loop[e[1]]); }
      out.add(loop[cat.pose]); out.add(loop[cat.goal]);
      if (cat.pending) { routeClips(cat.pose, actions[cat.pending.name], out); out.add(cat.pending.name); }
      for (const c of anticipate) out.add(c);
      const u = cat.activity === 'rest' && cat.upcoming;
      if (u === 'wander' || u === 'turn') { out.add('walkstart'); out.add('walk'); }
      else if (u in actions) { routeClips(cat.pose, actions[u], out); out.add(u); }
      else if (u && u !== 'stay') routeClips(cat.pose, u, out);
      for (const c of ALWAYS) out.add(c);
      for (const c of out) if (!clips[c]) out.delete(c);
      return out;
    }
    function play(dt, rate) {
      world.prefetch?.(wanted());
      if (world.ready && !world.ready(cat.clip)) return;   // not loaded yet: hold
      const c = clips[cat.clip];
      const step = dt * c.fps * rate;
      if (cat.action) {
        cat.f += step;
        if (cat.f >= c.frames - 1) { cat.f = c.frames - 1; endAction(true); }
      } else if (cat.edge) {
        cat.f += step * cat.edge[3];
        if (cat.f >= c.frames - 1 || cat.f <= 0) {
          cat.f = Math.max(0, Math.min(c.frames - 1, cat.f));
          arrive();
        }
      } else {
        const before = cat.f;
        cat.f = (cat.f + step) % c.frames;
        if (cat.clip === 'walk' && cat.path[0]?.[2] === 'walkstart' && cat.f < before) { cat.f = 0; startNext(true); }
      }
    }
    const frame = () => {
      const n = clips[cat.clip].frames;
      return Math.max(0, Math.min(n - 1, cat.edge?.[3] < 0 ? Math.ceil(cat.f) : Math.floor(cat.f)));
    };

    // ---- geometry ----
    // The cat's orientation, and a point of the current frame's space (zones) in the world.
    const orient = () => cat.tilt ?? qyaw(cat.yaw);
    const toWorld = (p) => {
      if (cat.tilt) { const r = qrot(cat.tilt, p); return { x: cat.x + r[0], y: cat.y + r[1], z: cat.z + r[2] }; }
      const c = Math.cos(cat.yaw), s = Math.sin(cat.yaw);
      return { x: cat.x + p[0] * c + p[2] * s, y: cat.y + p[1], z: cat.z - p[0] * s + p[2] * c };
    };
    const zone = (name, pose = cat.pose) => { const z = zonesOf(pose)[name]; return z ? toWorld(z) : null; };

    // ---- behaviour ----
    function summon(h, d = o.near * 1.3) {   // d metres in front of the user, facing them
      cat.x = h.x + h.fx * d; cat.z = h.z + h.fz * d; cat.y = 0;
      cat.yaw = Math.atan2(h.x - cat.x, h.z - cat.z); cat.placed = true;
      cat.waypoints = []; setActivity('rest', rnd(2, 5)); goTo(SNAP.includes(cat.pose) ? 'stand' : cat.pose);
      save(); log('summoned', cat.x.toFixed(2), cat.z.toFixed(2));
    }
    // A path to (tx, tz) that keeps `personal` metres from the user at (ux, uz).
    function pathTo(tx, tz, ux, uz) {
      const dx = tx - cat.x, dz = tz - cat.z, L2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((ux - cat.x) * dx + (uz - cat.z) * dz) / L2));
      const cx = cat.x + u * dx, cz = cat.z + u * dz;
      const d = Math.hypot(cx - ux, cz - uz);
      if (u > 0.05 && u < 0.95 && d < o.personal) {   // detour around the user
        let nx = cx - ux, nz = cz - uz;
        if (d < 1e-3) { nx = -dz; nz = dx; }
        const nl = Math.hypot(nx, nz) || 1, r = o.personal + 0.25;
        return [[ux + nx / nl * r, uz + nz / nl * r], [tx, tz]];
      }
      return [[tx, tz]];
    }
    function setActivity(a, until) {
      if (a !== cat.activity) log('activity', a);
      cat.activity = a; cat.until = until ?? 0; cat.upcoming = null;
    }
    function wander(h) {
      for (let i = 0; i < 12; i++) {
        const a = rnd(0, 2 * Math.PI), r = rnd(o.near + 0.1, o.wanderRadius);
        const tx = h.x + Math.sin(a) * r, tz = h.z + Math.cos(a) * r;
        if (Math.hypot(tx - cat.x, tz - cat.z) < 0.5) continue;
        cat.waypoints = pathTo(tx, tz, h.x, h.z);
        setActivity('wander'); goTo('walk');
        return true;
      }
      return false;
    }
    function follow(h) {
      const dx = cat.x - h.x, dz = cat.z - h.z, d = Math.hypot(dx, dz) || 1;
      cat.waypoints = pathTo(h.x + dx / d * o.near, h.z + dz / d * o.near, h.x, h.z);
      if (cat.activity !== 'follow') { setActivity('follow'); goTo('walk'); }
    }
    function faceUser() {
      cat.waypoints = []; cat.faceUntil = 2.5; setActivity('turn'); goTo('walk');
    }
    const restAfter = (a, b) => () => setActivity('rest', rnd(a, b));
    const ready = (name) => !!clips[name] && cat.time - cat.lastAct[name] > cooldown[name];
    function act(name) { setActivity('action'); startAction(name, restAfter(4, 10)); }
    // The next idle step, chosen LOOKAHEAD before the rest ends (its clips
    // are prefetched meanwhile, wanted()).
    function choose(err) {
      const calm = cat.calm;
      const a = (p) => (avail(p) ? 1 : 0);   // (another animal: only its poses)
      let w = null;
      switch (cat.pose) {
        case 'stand': w = { wander: 3, sit: 2.5 * a('sit'), turn: Math.abs(err) > 0.8 ? 3 : 0.3, lie: calm > o.lieAfter ? 2.5 * a('lie') : 0, stay: 1.5,
          stretch: ready('stretch') ? (cat.woke ? 8 : 1.5) : 0, shake: ready('shake') ? 0.4 : 0 }; break;
        case 'sit': w = { stand: 1.5, lie: (calm > o.lieAfter * 0.6 ? 2 : 0.3) * a('lie'), stay: 2, groom: ready('groom') ? 3 : 0,
          stretch: ready('stretch') ? 0.6 : 0 }; break;
        case 'lie': w = { sleep: calm > o.sleepAfter ? 3 * a('sleep') : 0, stand: 1, stay: 2 }; break;
        case 'sleep': return 'lie';
        default: return 'stand';
      }
      for (const [k, s] of spActions) if ((s.pose ?? 'stand') === cat.pose) w[k] = ready(k) ? (s.weight ?? 1) : 0;   // the animal's own
      return pick(w);
    }
    function rest(dt, h, dist, err) {
      cat.until -= dt;
      if (cat.until > 0) {
        if (cat.until < LOOKAHEAD && !cat.upcoming) cat.upcoming = choose(err);
        return;
      }
      const next = cat.upcoming ?? choose(err);
      cat.upcoming = null;
      cat.woke = false;
      log('rest ->', next);
      if (next === 'wander') { if (!wander(h)) setActivity('rest', rnd(2, 5)); return; }
      if (next === 'turn') { faceUser(); return; }
      if (next === 'stay') { setActivity('rest', rnd(4, 10)); return; }
      if (next in actions) { act(next); return; }
      goTo(next);
      setActivity('rest', next === 'sleep' ? rnd(60, 180) : next === 'lie' ? rnd(15, 40) : rnd(6, 14));
    }

    // ---- interaction ----
    function grab(by, p) {
      const s = cat.held ? { x: cat.x, y: cat.y, z: cat.z } : zone('scruff');   // dangle frames hang from the scruff
      cancelActions();
      // (A tilted cat, caught while righting itself, keeps its tilt.)
      Object.assign(cat, { held: { source: by.source, hand: by.hand, off: [s.x - p.x, s.y - p.y, s.z - p.z], v: [0, 0, 0] },
        fall: null, purring: false, petT: 0, waypoints: [], x: s.x, y: s.y, z: s.z });
      goTo('dangle'); setActivity('held');
      log('grabbed', by.source, by.hand ?? '');
    }
    // Where the attaching adapter really holds the cat (world.heldPose()).
    function followHeld() {
      const hp = world.heldPose?.();
      if (!hp) return false;
      Object.assign(cat, { x: hp.x, y: hp.y, z: hp.z, yaw: yawOf(hp.q, cat.yaw) });
      cat.tilt = hp.q;
      return true;
    }
    function release() {
      followHeld();   // the hand's pose now: the fall starts where the cat is seen
      const v = cat.held.v.map((x) => x * THROW);
      const hv = Math.hypot(v[0], v[2]);
      if (hv > THROW_MAX) { v[0] *= THROW_MAX / hv; v[2] *= THROW_MAX / hv; }
      // Keep the scruff (the dangle frames' origin) where it is: the fall
      // frames stand on their feet, turned like the held cat.
      const s = zonesOf('fall').scruff ?? [0, 0.2, 0.06];
      const q = orient(), r = qrot(q, s);
      log('released', `from ${cat.y.toFixed(2)} m`);
      // (fresh: shown where it was released first; the fall starts next tick)
      Object.assign(cat, { held: null, fall: { vx: v[0], vy: Math.min(v[1], 1), vz: v[2], q0: cat.tilt, t: 0, fresh: true },
        x: cat.x - r[0], z: cat.z - r[2], y: Math.max(0, cat.y - r[1]) });
      goTo('fall'); setActivity('falling');
    }
    function land() {
      Object.assign(cat, { fall: null, y: 0, tilt: null });
      goTo('stand');
      save();   // where it was dropped
      setActivity('landed');
      startAction('land', afterLanding);
      log('landed');
    }
    function afterLanding() {
      const next = pick({ shake: has('shake') ? 2 : 0, groom: has('groom') ? 1.2 : 0, wander: 1.5 });
      log('after landing ->', next);
      if (next === 'wander') { const h = world.head(); if (h && wander(h)) return; }
      act(next === 'wander' ? 'shake' : next);
    }
    function startle(g) {
      Object.assign(cat, { petT: 0, purring: false, wary: cat.time + WARY_TIME, startleAt: cat.time, waypoints: [] });
      cancelActions();
      setActivity('startled');
      if (['stand', 'walk', 'purr'].includes(cat.pose) || cat.edge?.[0] === 'stand' || cat.edge?.[0] === 'walk') {
        cat.edge = null; cat.path = []; cat.pose = cat.goal = 'stand';   // jolt: no transition
      }
      startAction('startle', () => flee(g));
      log('startled', g.side ?? '', Math.hypot(g.vx, g.vy, g.vz).toFixed(2), 'm/s');
    }
    // Away from the hand, but not onto the user: the first direction (straight
    // away, then turning further) whose end stays `near` from the user.
    function flee(g) {
      const h = world.head();
      let dx = cat.x - g.x, dz = cat.z - g.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-3) { dx = -Math.sin(cat.yaw); dz = -Math.cos(cat.yaw); } else { dx /= d; dz /= d; }
      let tx = cat.x + dx * FLEE_DISTANCE, tz = cat.z + dz * FLEE_DISTANCE;
      for (const a of [0, 0.8, -0.8, 1.6, -1.6, 2.4, -2.4]) {
        const c = Math.cos(a), s = Math.sin(a), ex = dx * c + dz * s, ez = -dx * s + dz * c;
        const x = cat.x + ex * FLEE_DISTANCE, z = cat.z + ez * FLEE_DISTANCE;
        if (!h || Math.hypot(x - h.x, z - h.z) >= o.near) { tx = x; tz = z; break; }
      }
      cat.waypoints = h ? pathTo(tx, tz, h.x, h.z) : [[tx, tz]];
      setActivity('flee'); goTo('walk');
    }
    function startPurr() {
      const to = PURR[BASE[cat.pose]] ?? 'purr';
      cat.purring = true; cat.waypoints = [];
      setActivity('petted'); goTo(to);
      log('purring', to);
    }
    function stopPurr() {
      cat.purring = false; cat.petT = 0;
      goTo(BASE[cat.goal] ?? 'stand');
      setActivity('rest', rnd(4, 10));
      log('purring stopped');
    }

    // Held (world.held()), petting and startle (the free hands).
    function interact(dt) {
      const hs = world.hands?.() ?? {};
      const by = cat.forced ? null : world.held?.() ?? null;
      const hands = ['left', 'right'].filter((k) => hs[k]).map((k) => ({ side: k, vx: 0, vy: 0, vz: 0, ...hs[k] }));
      if (by) {
        const p = Number.isFinite(by.x) ? { vx: 0, vy: 0, vz: 0, ...by } : hands.find((h) => h.side === by.hand);
        if (p) {
          if (!cat.held || cat.held.hand !== by.hand || cat.held.source !== by.source) grab(by, p);   // a new grab
          if (!followHeld()) {
            const [ox, oy, oz] = cat.held.off;
            cat.x = p.x + ox; cat.y = p.y + oy; cat.z = p.z + oz;
          }
          cat.held.v = [p.vx, p.vy, p.vz];
        }
        anticipate = new Set();
        cat.near = [];
        return;
      }
      if (cat.held) release();
      const zs = zonesOf(cat.pose);
      const pts = Object.fromEntries(Object.entries(zs).map(([k, p]) => [k, toWorld(p)]));
      cat.near = [];
      let contact = false, fast = null, petNear = false, fastNear = false;
      for (const g of hands) {
        const dScruff = pts.scruff ? dist3(g, pts.scruff) : Infinity;
        const dPet = Math.min(...['head', 'back', 'scruff'].map((k) => (pts[k] ? dist3(g, pts[k]) : Infinity)));
        const dAny = Math.min(dPet, ...Object.values(pts).map((p) => dist3(g, p)));
        const speed = Math.hypot(g.vx, g.vy, g.vz);
        cat.near.push({ side: g.side, dScruff, dPet, speed });
        if (dPet < PURR_PREP) petNear = true;
        if (dAny < STARTLE_PREP && speed > STARTLE_PREP_SPEED) fastNear = true;
        if (dAny < STARTLE_RADIUS && speed > STARTLE_SPEED) fast = g;
        else if (dPet < PET_RADIUS && speed < PET_MAX_SPEED) contact = true;
      }
      const purr = PURR[BASE[cat.pose]] ?? 'purr';
      anticipate = new Set([...(petNear ? [`${purr}in`, purr] : []), ...(fastNear ? ['startle'] : [])]);
      if (cat.fall || cat.forced || cat.pending?.name === 'land' || cat.action?.name === 'land') return;
      if (fast && cat.time - cat.startleAt > STARTLE_COOLDOWN) { startle(fast); return; }
      if (contact) { cat.petT = Math.min(PET_TIME * 2, cat.petT + dt); cat.lastPet = cat.time; }
      else cat.petT = Math.max(0, cat.petT - PET_DECAY * dt);
      const canPurr = cat.time > cat.wary && !busy() && cat.activity !== 'startled' && cat.activity !== 'flee' && avail(purr);
      if (!cat.purring && cat.petT >= PET_TIME && canPurr) startPurr();
      else if (cat.purring && cat.time - cat.lastPet > PURR_LINGER) stopPurr();
    }

    // Demo (debug): a fixed tour of everything.
    const DEMO = ['stand', 'sit', 'groom', 'stand', 'stretch', 'wander', 'lie', 'sleep', 'purr', 'lie', 'stand', 'turn',
      'startle', 'drop', 'dangle', 'stand', 'follow'];
    let demoI = -1, demoT = 0;

    function command(cmd, h) {
      log('command', cmd);
      cat.forced = null;
      cancelActions();
      cat.held = null; cat.tilt = null;   // until world.held() grabs again
      if (cmd === 'dangle') {
        Object.assign(cat, { forced: 'dangle', fall: null, purring: false });
        goTo('dangle'); cat.y = o.dangleHeight; return;
      }
      if (SNAP.includes(cat.pose)) { cat.fall = null; cat.y = 0; goTo('stand'); }
      if (cmd === 'summon') { if (h) summon(h, 1); return; }
      if (cmd === 'drop') { Object.assign(cat, { fall: { vx: 0, vy: 0, vz: 0, q0: null, t: 0 }, y: 0.8, purring: false }); goTo('fall'); setActivity('falling'); return; }
      if (cmd === 'purr') { if (avail(PURR[BASE[cat.pose]] ?? 'purr')) { cat.lastPet = cat.time + 6; startPurr(); } return; }
      if (cmd === 'startle') {
        const g = { x: cat.x + Math.sin(cat.yaw) * 0.2, y: 0.2, z: cat.z + Math.cos(cat.yaw) * 0.2, vx: 2, vy: 0, vz: 0 };
        startle(g); return;
      }
      if (cmd in actions) { if (has(cmd)) act(cmd); else logOnce('no clip', cmd, '(command ignored)'); return; }
      if (cmd === 'wander') { if (h) wander(h); return; }
      if (cmd === 'follow') { if (h) { cat.x = h.x + 3.2 * h.fx; cat.z = h.z + 3.2 * h.fz; follow(h); } return; }
      if (cmd === 'turn') { if (h) { cat.yaw = wrap(cat.yaw + Math.PI * 0.8); faceUser(); } return; }
      if (RESTING.includes(cmd)) { cat.purring = false; cat.waypoints = []; goTo(cmd); setActivity('rest', 20); }
    }

    // Put down whatever holds it (the laser drag, a forced dangle; falling:
    // landed at once) and stand where it is (adapter: hiding the cat,
    // switching to another animal).
    function settle() {
      if (!cat.held && !cat.fall && !cat.forced) return false;
      if (SNAP.includes(cat.pose) && !cat.fall) {   // dangling: its origin is the scruff; stand below it
        const s = zonesOf('stand').scruff ?? [0, 0, 0], r = qrot(qyaw(cat.yaw), s);
        cat.x -= r[0]; cat.z -= r[2];
      }
      command('stand', world.head());
      save();
      return true;
    }

    function tick(dt) {
      dt = Math.min(0.5, Math.max(0, dt));
      cat.time += dt;
      const h = world.head();
      let rate = 1;
      interact(dt);
      if (cat.fall?.fresh) cat.fall.fresh = false;
      else if (cat.fall) {
        const f = cat.fall;
        f.t += dt;
        if (f.q0) {   // right itself: from the tilt at the release to upright (its heading kept)
          const u = Math.min(1, f.t / RIGHT_TIME);
          cat.tilt = u < 1 ? nlerp(f.q0, qyaw(cat.yaw), u * u * (3 - 2 * u)) : null;
        }
        f.vy -= GRAVITY * dt;
        cat.x += f.vx * dt; cat.y += f.vy * dt; cat.z += f.vz * dt;
        if (cat.y <= 0) land();
      }
      const free = !cat.held && !cat.fall && !cat.forced;
      if (h && free) {
        if (!cat.placed) summon(h);
        const dx = h.x - cat.x, dz = h.z - cat.z, dist = Math.hypot(dx, dz);
        if (dist > o.summon) summon(h);
        const toUser = Math.atan2(dx, dz), err = wrap(toUser - cat.yaw);
        if (o.demo) {
          demoT -= dt;
          if (demoT <= 0) { demoI = (demoI + 1) % DEMO.length; demoT = DEMO[demoI] === 'sleep' ? 12 : 9; command(DEMO[demoI], h); }
        }
        const moving = ['wander', 'follow', 'turn', 'flee'].includes(cat.activity);
        cat.calm = moving || cat.purring ? 0 : cat.calm + dt;
        if (!o.demo && !cat.purring && !busy() && !['startled', 'flee', 'landed'].includes(cat.activity)) {
          const far = cat.pose === 'sleep' ? o.wakeDistance : o.follow;
          if (dist > far && cat.activity !== 'follow') follow(h);
          else if (cat.activity === 'follow' && dist > o.near + 0.3) follow(h);   // keep re-aiming
        }
        if (cat.activity === 'rest' && settled() && !busy() && !o.demo) rest(dt, h, dist, err);

        // Walking: steer along the waypoints (or turn toward the user).
        if (cat.pose === 'walk' && !cat.edge && cat.clip === 'walk') {
          const wp = cat.waypoints[0];
          let heading = toUser, speed = 0;
          const fast = cat.activity === 'flee' ? FLEE_SPEED : 1;
          if (wp) {
            const wx = wp[0] - cat.x, wz = wp[1] - cat.z, wd = Math.hypot(wx, wz);
            heading = Math.atan2(wx, wz);
            speed = o.walkSpeed * fast * Math.min(1, wd / 0.15 + 0.3);
            if (wd < 0.06) cat.waypoints.shift();
          }
          const e = wrap(heading - cat.yaw);
          cat.yaw = wrap(cat.yaw + Math.sign(e) * Math.min(Math.abs(e), o.turnRate * fast * dt));
          if (Math.abs(e) > 0.9) speed *= 0.2;   // mostly turn on the spot
          if (cat.path[0]?.[2] === 'walkstart') speed *= 0.5;   // stopping
          cat.x += Math.sin(cat.yaw) * speed * dt; cat.z += Math.cos(cat.yaw) * speed * dt;
          rate = Math.max(0.6, speed / (baked.walkSpeed || 0.2));
          const done = cat.activity === 'turn' ? (Math.abs(e) < 0.1 || (cat.faceUntil -= dt) < 0) : !cat.waypoints.length;
          if (done && cat.goal === 'walk') {
            goTo('stand'); setActivity('rest', cat.activity === 'flee' ? rnd(3, 6) : rnd(5, 12)); save();
          }
        } else if (cat.pose === 'walk' && cat.edge) {
          cat.x += Math.sin(cat.yaw) * o.walkSpeed * 0.3 * dt; cat.z += Math.cos(cat.yaw) * o.walkSpeed * 0.3 * dt;
        }
      } else if (!h && free) cat.calm += dt;
      play(dt, rate);
      if (cat.pending && !cat.held && !cat.fall) runPending();
      if (!cat.held && !cat.fall && !SNAP.includes(cat.pose)) cat.y = 0;
      if (!cat.held && !cat.fall) cat.tilt = null;
      world.show(cat.clip, frame(), { x: cat.x, y: cat.y, z: cat.z, yaw: cat.yaw, q: orient() });
    }

    return {
      tick,
      command: (cmd) => command(cmd, world.head()),
      settle,
      save,   // world.save() the spot and pose now (adapter: handing them to another animal's core)
      state: () => ({ pose: cat.pose, goal: cat.goal, clip: cat.clip, frame: frame(), activity: cat.activity,
        edge: cat.edge?.[2] ?? null, action: cat.action?.name ?? null, pending: cat.pending?.name ?? null,
        x: cat.x, y: cat.y, z: cat.z, yaw: cat.yaw, calm: cat.calm, time: cat.time, waypoints: cat.waypoints.slice(),
        forced: cat.forced, held: cat.held && { source: cat.held.source, hand: cat.held.hand }, falling: !!cat.fall, q: orient(),
        purring: cat.purring, petT: cat.petT, wary: Math.max(0, cat.wary - cat.time), near: cat.near.slice(),
      }),
      zone: (name) => zone(name),
      options: o,
      // What this animal can do: its poses, actions and every clip the core may ask for.
      species: () => ({ poses: Object.keys(LOOP).filter(avail), actions: Object.keys(actions).filter(has),
        clips: [...new Set([...Object.values(loop), ...edges.map((e) => e[2]).filter(has), ...Object.keys(actions).filter(has)])] }),
    };
  }

  // A hidden cat shown again (adapter): 'stay' at its spot (spot: { x, z })
  // while that is within `keep` m of the user (head: world.head()) on the
  // floor and in view (the adapter's test), else 'summon' (1 m in front of the
  // user); force: always 'summon'. No head pose: 'stay'.
  function reveal(spot, head, { inView = true, force = false, keep = REVEAL_KEEP } = {}) {
    if (force) return 'summon';
    if (!head || !spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.z)) return 'stay';
    return Math.hypot(spot.x - head.x, spot.z - head.z) > keep || !inView ? 'summon' : 'stay';
  }

  // ---- the controls above the pet, shared by the adapters ----
  // systemui.js draws them as SteamVR panels, preview.js imitates them: the
  // grip bar (its bottom `lift` m above the frames' origin for the 0.30 m
  // cat, liftOf(): another animal's height + 0.10 m; liftDangle over a
  // dangling one's scruff), the controls row (⋯ X) gapM below it, the ⋯
  // menu gapM above it and forwardM nearer (rows in px of its texture).
  const HANDLE = { widthM: 0.11, widthPx: 132, heightPx: 30, lift: 0.40, liftDangle: 0.15 };
  const CONTROLS = { widthM: 0.08, widthPx: 96, heightPx: 48, gapM: 0.008 };
  const MENU = { widthM: 0.13, widthPx: 240, gapM: 0.01, forwardM: 0.02, padPx: 8, modelRowPx: 48, cmdRowPx: 44, sepPx: 9, leaveMs: 1000 };
  const ui = {
    HANDLE, CONTROLS, MENU,
    MENU_CMDS: [['summon', 'Summon'], ['sit', 'Sit'], ['lie', 'Lie down'], ['sleep', 'Sleep']],
    AFTER_DRAG_MS: 300,   // buttons stay inert this long after a drag
    liftOf: (height = 0.30) => HANDLE.lift + (height - 0.30),
    // The menu's models (catalog.order), the ones a separator goes before
    // (a new group: the coats, the animals) and its height in px.
    menuLayout(catalog) {
      const ids = catalog.order ?? Object.keys(catalog.models);
      const breaks = ids.filter((id, i) => i > 0 && catalog.models[id].group !== catalog.models[ids[i - 1]].group);
      const px = MENU.padPx * 2 + ids.length * MENU.modelRowPx + (breaks.length + 1) * MENU.sepPx + ui.MENU_CMDS.length * MENU.cmdRowPx;
      return { ids, breaks, px };
    },
    // Whether the pet at `at` (its feet) is in view from `eye` looking along
    // the unit vector `fwd`: within 65° (plus the pet's own size).
    inView(eye, fwd, at) {
      const d = [at.x - eye[0], at.y + 0.15 - eye[1], at.z - eye[2]];
      const l = Math.hypot(...d) || 1;
      const deg = Math.acos(Math.max(-1, Math.min(1, (fwd[0] * d[0] + fwd[1] * d[1] + fwd[2] * d[2]) / l))) * 180 / Math.PI;
      return deg < 65 + Math.atan2(0.35, l) * 180 / Math.PI;
    },
  };

  const THRESHOLDS = { PET_RADIUS, PET_MAX_SPEED, PET_TIME, PURR_LINGER, STARTLE_SPEED,
    STARTLE_RADIUS, STARTLE_COOLDOWN, WARY_TIME, GRAVITY, THROW, COOLDOWN, REVEAL_KEEP };
  return { create, reveal, EDGES, LOOP, ACTIONS, THRESHOLDS, math, ui };
})();
if (typeof module === 'object' && module.exports) module.exports = VrPetCore;   // node (tests)
