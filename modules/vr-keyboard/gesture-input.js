// gesture-input.js: which input events belong to the gesture in progress
// (patch.js). Evaluates to { VERSION, create }.
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
(() => {
  const VERSION = 1;

  function create() {
    let owner = null, sawPointer = false;

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

    return {
      VERSION,
      get owner() { return owner; },
      // { phase, id, x, y, target } if the event concerns the gesture (or may
      // start one: phase 'down'), else null. An 'up' or 'cancel' ends the
      // ownership.
      read(e) {
        const phase = PHASE[e.type];
        if (!phase) return null;
        const cs = contacts(e);
        if (phase === 'down') {
          // One touch at a time starts a gesture (a multi-touch press is Steam's).
          if (e.type === 'touchstart' && (e.touches?.length ?? 0) > 1) {
            if (owner?.[0] === 't' && ![...e.touches].some((t) => `t${t.identifier}` === owner)) owner = null;
            return null;
          }
          const c = cs[0];
          if (!c) return null;
          // Busy: ignored, unless the owner is gone (a lone touch, or its own id again).
          if (owner && !(e.type === 'touchstart' || c.id === owner)) return null;
          owner = null;
          return { phase, ...c };
        }
        if (!owner) return null;
        const c = cs.find((x) => x.id === owner);
        if (!c) return null;
        if (phase !== 'move') owner = null;
        return { phase, ...c };
      },
      claim(c) { owner = c.id; },                 // the 'down' contact starts a gesture
      release() { owner = null; },
    };
  }

  return { VERSION, create };
})()
