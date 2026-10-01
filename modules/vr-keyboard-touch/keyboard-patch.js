// Touch typing (vr-keyboard-touch.nix; patch name "vr-keyboard-touch"),
// injected into Steam's SharedJSContext (8080). mkPatch convention plus two
// more arguments: tracker.js and vr-keyboard-controllers' hub.js.
//
// The controller frames (hub.js; the tips relative to the keyboard) go
// through one tracker.js per hand; its events press keys with the keyboard's
// own touch handlers, like a laser press (the laser arrives as touch
// events): HandleTouchStart at "down" (key highlighted, sound, Steam's long
// press: repeating Backspace, the accent popup), HandleTouchEnd at "up"
// (Steam types the key, unless its long press already did). The key is the
// [data-key] element at the point (skipping MouseHoverBlockerHack, like
// Steam's hit test); no key there: nothing. Each hand is its own touch, so
// both hands can overlap like two fingers (Steam's multi-touch: Shift held
// by one hand). No DOM events: the swipe patch's and the extra keys'
// listeners don't see these touches; the swipe patch's text model does (it
// hooks the methods the keys go through).
// "cancel" (no pose), frames stopping for STALE_MS, the keyboard moving or
// closing end a touch without typing. Debugging: __sfuiTouchTypeLog.
((find, sigs, opts, hooks, TR, HUB) => {
  const VERSION = 4;
  const G = window;
  const STALE_MS = 1000;                           // Steam's UI thread can stall frames for ~0.3 s
  const SNAP = 3;                                   // SteamVR overlay haptic effect (1 ButtonEnter, 3 Snap)
  const HANDS = ['left', 'right'];
  const ID = { left: 0x5f10, right: 0x5f11 };       // touch identifiers
  let status;
  try {
    const mods = find.resolveAll(find.getWebpackRequire('webpackChunksteamui'), sigs);
    status = mods.vrStatus.exports.holder;
  } catch (e) {
    return `Steam internals changed, no touch typing: ${e.message}`;
  }
  const stamp = `${VERSION}:${TR.VERSION}:${HUB.version} ${JSON.stringify(opts)}`;
  if (G.__sfuiTouchType?.stamp === stamp) return 'unchanged';
  try { G.__sfuiTouchType?.dispose?.(); } catch { /* gone */ }

  const log = (...a) => {
    const l = (G.__sfuiTouchTypeLog ??= []);
    l.push([Math.round(performance.now()), ...a]);
    if (l.length > 200) l.splice(0, l.length - 200);
  };
  const kbInst = (el) => find.findFiberUp(el, (f) => typeof f.stateNode?.HandleTouchStart === 'function' &&
    typeof f.stateNode?.HandleTouchEnd === 'function' && f.stateNode.m_mapTouched instanceof Set, 200)?.stateNode;
  const touches = new Map();                        // hand -> { t, inst, doc }

  // Steam's handlers read target, changedTouches, touches (tracker.js
  // touchEvent) and the touches' target / clientX / clientY.
  const others = (t, inst) => [...touches.values()].filter((e) => e.inst === inst && e.t !== t).map((e) => e.t);

  function end(hand, { cancel = false, u, v } = {}) {
    const e = touches.get(hand);
    if (!e) return;
    touches.delete(hand);
    // Where it left, if on the page (an accent picked in Steam's popup);
    // Steam types nothing for a release off the page.
    const win = e.doc.defaultView, x = u * win?.innerWidth, y = v * win?.innerWidth;
    if (!cancel && x >= 0 && y >= 0 && x < win.innerWidth && y < win.innerHeight) Object.assign(e.t, { clientX: x, clientY: y, pageX: x, pageY: y });
    if (cancel) e.inst.m_mapTouched.delete(e.t.target);         // Steam types only keys still in m_mapTouched
    try { e.inst.HandleTouchEnd(TR.touchEvent(e.t, others(e.t, e.inst), false)); } catch (err) { log('end-error', String(err)); }
    log(hand, cancel ? 'cancel' : 'up', e.t.target.getAttribute('data-key'));
  }

  function down(hand, u, v) {
    end(hand, { cancel: true });
    const win = find.keyboardPopup()?.window;
    if (!win) return;
    const doc = win.document, x = u * win.innerWidth, y = v * win.innerWidth;
    const el = doc.elementsFromPoint(x, y).find((e) => e.id !== 'MouseHoverBlockerHack');
    const keyEl = el?.closest?.('[data-key]');
    const inst = keyEl && kbInst(keyEl);
    if (!inst) { log(hand, 'miss', Math.round(x), Math.round(y)); return; }
    const t = { identifier: ID[hand], target: keyEl, clientX: x, clientY: y, pageX: x, pageY: y };
    touches.set(hand, { t, inst, doc });
    try { inst.HandleTouchStart(TR.touchEvent(t, others(t, inst), true)); } catch (err) { log('start-error', String(err)); end(hand, { cancel: true }); return; }
    if (opts.haptics) win.SteamClient?.OpenVR?.TriggerOverlayHapticEffect?.(SNAP, 0);
    log(hand, 'down', keyEl.getAttribute('data-key'), Math.round(x), Math.round(y));
  }

  const trackers = Object.fromEntries(HANDS.map((h) => [h, TR.createTracker({ depth: opts.depth })]));
  let lastT = 0, lastAt = -Infinity;
  function step(hand, sample, t) {
    const ev = trackers[hand].update(sample, t);
    if (ev?.phase === 'down') down(hand, ev.u, ev.v);
    else if (ev?.phase === 'up') end(hand, { u: ev.u, v: ev.v });
    else if (ev?.phase === 'cancel') end(hand, { cancel: true });
  }
  const unsubscribe = HUB.subscribe((f) => {
    const now = performance.now();
    const t = f?.t ?? lastT + (now - lastAt);
    lastT = t; lastAt = now;
    const usable = !!(f?.keyboard && !f.moving && status.VRKeyboardStatus?.bIsOpen);
    for (const h of HANDS) step(h, usable ? f.hands?.[h]?.tip ?? null : null, t);
  });
  // No frames (relay or SteamVR gone) or the keyboard closed: end the touches.
  const watchdog = setInterval(() => {
    const now = performance.now();
    if (now - lastAt > STALE_MS || !status.VRKeyboardStatus?.bIsOpen) {
      for (const h of HANDS) if (trackers[h].pressed || touches.has(h)) { step(h, null, lastT + (now - lastAt)); end(h, { cancel: true }); }
    }
  }, 250);

  G.__sfuiTouchType = {
    stamp,
    dispose() {
      unsubscribe(); clearInterval(watchdog);
      for (const h of HANDS) end(h, { cancel: true });
    },
  };
  log('attached', VERSION);
  return 'patched';
})
