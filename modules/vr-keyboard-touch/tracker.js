// tracker.js: when a controller's tip touches a key (vr-keyboard-touch.nix;
// argument of keyboard-patch.js, tested by tests/tracker.test.mjs).
// Evaluates to { VERSION, DEFAULTS, createTracker, touchEvent }.
//
// createTracker(opts): one hand. update(sample, tMs) with the tip relative
// to the keyboard ({ u, v, d } of vr-keyboard-controllers' geometry.js:
// keyboard widths from the top left corner, m behind the surface; null: no
// pose / keyboard unusable) returns null or an event { phase, u, v }:
//   down    the tip passed through the surface (at `depth` behind it) from
//           the front between two samples, at u, v (interpolated) inside the
//           keyboard, not faster than maxStep per sample, minIntervalMs
//           after the last release;
//   up      it came back out: release m back from its deepest point, or in
//           front of the surface by arm; u, v where it is now;
//   cancel  the sample was null while down.
// A press needs the tip in front by arm (re-armed) since the last one, so
// tracking jitter at the surface can't repeat it, and the tip coming from
// behind or around the keyboard never presses.
//
// touchEvent(t, others, starting): what Steam's HandleTouchStart /
// HandleTouchEnd read, shaped like a DOM TouchEvent: changedTouches [t];
// touches: the touches down, with t at its start, without it at its end.
// Steam's UpdateTouchState counts `touches` per key for the pressed
// highlight and starts the long press (Backspace repeat, accents) there.
(() => {
  const VERSION = 2;
  const DEFAULTS = {
    depth: 0,             // m behind the drawn surface where a touch registers
    arm: 0.005,           // m in front of it to re-arm
    release: 0.01,        // m back from the deepest point to release
    maxV: 0.5,            // keyboard height bound (widths; the page is ~0.33)
    maxStep: 0.08,        // m per sample; more is a tracking jump, not a touch
    minIntervalMs: 60,    // release -> next press
  };

  function createTracker(opts = {}) {
    const O = { ...DEFAULTS, ...opts };
    let prev = null, armed = false, pressed = false, deepest = 0, releasedAt = -Infinity;
    const inside = (u, v) => u >= 0 && u <= 1 && v >= 0 && v <= O.maxV;
    function update(s, t) {
      if (!s) {
        prev = null; armed = false;
        if (!pressed) return null;
        pressed = false; releasedAt = t;
        return { phase: 'cancel' };
      }
      const d = s.d - O.depth;
      let ev = null;
      if (pressed) {
        deepest = Math.max(deepest, d);
        if (d < deepest - O.release || d < -O.arm) {
          pressed = false; armed = false; releasedAt = t;
          ev = { phase: 'up', u: s.u, v: s.v };
        }
      } else if (armed && prev && prev.d < 0 && d >= 0) {
        armed = false;
        const f = prev.d / (prev.d - d);            // where the segment meets the surface
        const u = prev.u + f * (s.u - prev.u), v = prev.v + f * (s.v - prev.v);
        if (inside(u, v) && d - prev.d <= O.maxStep && t - releasedAt >= O.minIntervalMs) {
          pressed = true; deepest = d;
          ev = { phase: 'down', u, v };
        }
      } else if (d < -O.arm) armed = true;
      else if (d >= 0) armed = false;
      prev = { u: s.u, v: s.v, d };
      return ev;
    }
    return { update, get pressed() { return pressed; } };
  }

  const touchEvent = (t, others, starting) => ({
    type: starting ? 'touchstart' : 'touchend', target: t.target, changedTouches: [t],
    touches: starting ? [...others, t] : [...others],
    preventDefault() {}, stopPropagation() {},
  });

  return { VERSION, DEFAULTS, createTracker, touchEvent };
})()
