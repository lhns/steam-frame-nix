// gesture-input.js: which input events belong to the gesture in progress
// (patch.js), and its path from the controller bridge. Evaluates to
// { VERSION, create }.
//
// SteamVR's lasers reach the keyboard page as touches (a trigger press: one
// touch with a new identifier per press) and as mouse hover (pointerId 1,
// no hand distinguisher; Chromium's pointer events for touches are cancelled
// after a few moves). With both controllers on the keyboard the idle one's
// hover keeps arriving during the other's press. A gesture is therefore owned
// by the contact that started it: a touch identifier, a pointerId or the
// mouse. Moves, the release and a cancel of other contacts are ignored, so
// they never enter the swipe path or end it. A second press while a gesture
// runs is ignored (Steam handles it as stock); one whose owner is gone
// (missed release) replaces it.
//
// Controller bridge (frame(f): vr-keyboard-controllers' hub.js frames): with
// both lasers on the keyboard SteamVR forwards per poll only one laser's
// movement, so the pressing one may get no touchmoves at all. A press is
// attributed to the hand whose laser hit (ray x/y) was within TOL px of it in
// the last STALE ms (nearest; trigger as a tiebreak). Without such frames
// (the bridge sends full rate only on demand, patch.js asks at the press)
// the first usable frame within WAIT ms decides: the hand nearest to the
// press or the touch's last move, within LATE px. The path then comes
// from runs of one source: the owner's touchmoves while they flow (or
// Chromium's pointer moves of the touch, which precede them), the hand's
// ray per frame once they pause for GAP ms, and touchmoves again once frames
// pause. The release is the touch's; its point is the hand's last ray point
// if the touchend's disagrees (by more than AGREE px) during a bridge run.
// Touchmoves far from the hand's ray but on the other hand's move the
// attribution. No fresh frames at the press: touch events only, as without
// the bridge.
(() => {
  const VERSION = 3;
  const STALE = 150, GAP = 60, TOL = 30, AGREE = 40, FAR = 60, WAIT = 250, LATE = 60;

  function create({ now = () => performance.now() } = {}) {
    let owner = null, sawPointer = false;
    // Bridge: recent frames [{ at, f }]; the gesture's hand and source.
    let frames = [];
    let hand = null, mode = 'touch', touchAt = 0, bridgeAt = -Infinity, bridgePt = null;
    let waitUntil = -Infinity, refs = [];          // a press not attributed yet: its points
    const stats = { touch: 0, bridge: 0, switches: 0, late: false };

    // The contacts of an event: [{ id, x, y, target }].
    function contacts(e) {
      if (e.type.startsWith('touch')) {
        const list = e.type === 'touchmove' ? e.touches : e.changedTouches;
        return [...(list || [])].map((t) => ({ id: `t${t.identifier}`, x: t.clientX, y: t.clientY, target: t.target }));
      }
      if (e.type.startsWith('pointer')) {
        sawPointer = true;
        if (e.pointerType === 'touch') return [];   // touch events carry these
        return [{ id: `p${e.pointerId}`, x: e.clientX, y: e.clientY, target: e.target }];
      }
      if (sawPointer) return [];                    // pointer events carry the mouse
      return [{ id: 'm', x: e.clientX, y: e.clientY, target: e.target }];
    }
    const PHASE = {
      touchstart: 'down', pointerdown: 'down', mousedown: 'down',
      touchmove: 'move', pointermove: 'move', mousemove: 'move',
      touchend: 'up', pointerup: 'up', mouseup: 'up',
      touchcancel: 'cancel', pointercancel: 'cancel',
    };

    const usable = (f) => !!(f?.keyboard && !f.moving);
    const ray = (f, h) => { const r = f?.hands?.[h]?.ray; return r?.onKeyboard ? r : null; };
    const dist = (r, x, y) => Math.hypot(r.x - x, r.y - y);
    const recent = (t) => frames.filter((e) => t - e.at <= STALE && usable(e.f));
    // The hand whose ray in frames fs was nearest to one of the points pts, within tol.
    function attribute(fs, pts, tol) {
      if (!fs.length) return null;
      const near = ['left', 'right'].map((h) => ({
        h, d: Math.min(...fs.flatMap((e) => { const r = ray(e.f, h); return r ? pts.map(([x, y]) => dist(r, x, y)) : [Infinity]; })),
        trig: fs[fs.length - 1].f.hands?.[h]?.trigger ?? null,
      })).filter((c) => c.d <= tol).sort((a, b) => a.d - b.d);
      if (near.length === 2 && near[1].d - near[0].d < 10) {
        const pulled = near.filter((c) => c.trig !== null && c.trig >= 0.5);
        if (pulled.length === 1) return pulled[0].h;
      }
      return near[0]?.h ?? null;
    }
    function lastRay(h, t) {
      const e = frames[frames.length - 1];
      return e && t - e.at <= STALE && usable(e.f) ? ray(e.f, h) : null;
    }
    function reset() { owner = null; hand = null; mode = 'touch'; bridgePt = null; bridgeAt = -Infinity; waitUntil = -Infinity; refs = []; }

    return {
      VERSION,
      get owner() { return owner; },
      get hand() { return hand; },
      stats,
      // { phase, id, x, y, target } if the event concerns the gesture (or may
      // start one: phase 'down'), else null. An 'up' or 'cancel' ends the
      // ownership. A move during a bridge run: null (the frames carry the path).
      read(e) {
        const phase = PHASE[e.type];
        if (!phase) return null;
        const cs = contacts(e);
        // Chromium's pointer moves of a touch (before its pointercancel): the touch is moving.
        if (e.type === 'pointermove' && e.pointerType === 'touch' && owner?.[0] === 't' && mode === 'touch') touchAt = now();
        if (phase === 'down') {
          // One touch at a time starts a gesture (a multi-touch press is Steam's).
          if (e.type === 'touchstart' && (e.touches?.length ?? 0) > 1) {
            if (owner?.[0] === 't' && ![...e.touches].some((t) => `t${t.identifier}` === owner)) reset();
            return null;
          }
          const c = cs[0];
          if (!c) return null;
          // Busy: ignored, unless the owner is gone (a lone touch, or its own id again).
          if (owner && !(e.type === 'touchstart' || c.id === owner)) return null;
          reset();
          return { phase, ...c };
        }
        if (!owner) return null;
        const c = cs.find((x) => x.id === owner);
        if (!c) return null;
        const t = now();
        if (phase === 'move') {
          if (t < waitUntil) refs[1] = [c.x, c.y];
          if (hand) {
            // A touchmove far from the hand's laser but on the other's: the other hand pressed.
            const other = hand === 'left' ? 'right' : 'left', r = lastRay(hand, t), o = lastRay(other, t);
            if (r && o && dist(r, c.x, c.y) > FAR && dist(o, c.x, c.y) <= TOL) { hand = other; stats.switches++; }
          }
          if (mode === 'bridge') {
            if (t - bridgeAt <= GAP) return null;   // frames flowing: they carry the path
            mode = 'touch';
          }
          touchAt = t;
          stats.touch++;
          return { phase, ...c };
        }
        let r = { phase, ...c };
        if (phase === 'up' && mode === 'bridge' && bridgePt && t - bridgeAt <= STALE && Math.hypot(bridgePt[0] - c.x, bridgePt[1] - c.y) > AGREE) {
          r = { ...r, x: bridgePt[0], y: bridgePt[1] };
        }
        reset();
        return r;
      },
      // The 'down' contact starts a gesture; returns the hand it is attributed to (or null).
      claim(c) {
        owner = c.id;
        touchAt = now();
        Object.assign(stats, { touch: 0, bridge: 0, switches: 0, late: false });
        hand = attribute(recent(touchAt), [[c.x, c.y]], TOL);
        if (!hand) { waitUntil = touchAt + WAIT; refs = [[c.x, c.y]]; }
        return hand;
      },
      // A bridge frame (null: bridge lost). Returns [x, y] to add to the path, or null.
      frame(f) {
        const t = now();
        if (!f) { frames = []; return null; }
        frames.push({ at: t, f });
        while (frames.length && t - frames[0].at > STALE) frames.shift();
        if (!owner || !usable(f)) return null;
        if (!hand && t < waitUntil) {
          hand = attribute([{ at: t, f }], refs, LATE);
          if (hand) { waitUntil = -Infinity; stats.late = true; }
        }
        if (!hand) return null;
        const r = f.hands?.[hand]?.ray;
        if (!r) return null;
        bridgeAt = t;
        if (!r.onKeyboard) return null;
        bridgePt = [r.x, r.y];
        if (mode === 'touch' && t - touchAt > GAP) mode = 'bridge';
        if (mode !== 'bridge') return null;
        stats.bridge++;
        return bridgePt;
      },
    };
  }

  return { VERSION, create };
})()
