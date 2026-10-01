// hub.js: the controller frames in Steam's SharedJSContext
// (vr-keyboard-controllers.nix). A single expression for consumer patches'
// extraArgs (like lib/hooks.js): installs window.__sfuiControllers unless an
// equal or newer VERSION is there (a newer one takes over the subscribers)
// and evaluates to it. relay.mjs calls frame(f) with bridge-patch.js's
// frames and lost() when the SteamVR side goes away.
//   subscribe(fn) -> unsubscribe   fn(frame) per frame, fn(null) when lost
//   last                           the last frame (null: none / lost)
// Each frame's hand points (tip, ray) get the keyboard page's px: x, y
// (CSS px of the keyboard popup) and onKeyboard (inside the page), if the
// keyboard popup exists. Frames come at up to ~90 Hz while a hand's tip is
// within 10 cm of the keyboard or its trigger is pulled, else every 1 s, and
// only while SteamVR shows the keyboard (then one with keyboard null).
(() => {
  const VERSION = 1;
  const G = globalThis;
  const have = G.__sfuiControllers;
  if (have && have.version >= VERSION) return have;
  const subs = have?.subs ?? new Set();
  const errors = have?.errors ?? { count: 0, last: null };

  let win = null, winAt = -Infinity;
  function keyboardWindow(now) {
    if (now - winAt < 1000 && win && !win.closed) return win;
    winAt = now;
    win = [...(G.g_PopupManager?.GetPopups?.() || [])].find((p) => p.window?.document.querySelector('[data-key]'))?.window ?? null;
    return win;
  }
  const px = (p, w, h) => {
    if (!p) return p;
    const x = p.u * w, y = p.v * w;
    return { ...p, x, y, onKeyboard: x >= 0 && y >= 0 && x < w && y < h };
  };
  function deliver(f) {
    hub.last = f;
    for (const fn of [...subs]) {
      try { fn(f); } catch (e) { errors.count++; errors.last = String(e?.stack ?? e); }
    }
  }
  function frame(f) {
    if (!f || typeof f !== 'object') return;
    const now = performance.now(), w = f.keyboard ? keyboardWindow(now) : null;
    if (w?.innerWidth) {
      for (const h of ['left', 'right']) {
        const x = f.hands?.[h];
        if (x) f.hands[h] = { ...x, tip: px(x.tip, w.innerWidth, w.innerHeight), ray: px(x.ray, w.innerWidth, w.innerHeight) };
      }
    }
    f.receivedAt = now;
    deliver(f);
  }
  const hub = {
    version: VERSION, subs, errors, last: null,
    frame, lost: () => deliver(null),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
  G.__sfuiControllers = hub;
  return hub;
})()
