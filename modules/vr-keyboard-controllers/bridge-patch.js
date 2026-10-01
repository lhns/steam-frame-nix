// The controller bridge (vr-keyboard-controllers.nix; patch name
// "vr-keyboard-controllers"), injected into SteamVR's systemui page (8087):
// both controllers relative to Steam's VR keyboard, streamed to Steam's
// SharedJSContext (relay.mjs -> hub.js). mkPatch convention plus one more
// argument: geometry.js.
//
// While SteamVR shows the keyboard (systemui mounts its overlay, mountedId
// "...gamepadui.keyboard", only then, also without the dashboard, in a
// transform scaled to its size; the overlay hangs from its top edge, 1
// overlay width = 1 unit there):
// - its pose: an empty vsg-transform of ours (id PROBE) in that transform,
//   read with SteamVR's own SGQueryService.requestSGTransform every POLL_MS;
//   for MOVE_QUIET_MS after it moved (drag, dashboard re-latch) frames say
//   moving: true;
// - every TICK_MS both controllers: VRHTML.GetPose(hand, Standing) times the
//   render model's "tip" component (SteamVR's laser origin) -> the tip and
//   the laser's hit on the keyboard (geometry.js), the trigger from the
//   render model's animated "trigger" component (null without one).
// Frames go out through the CDP binding __sfuiCtlOut(json) at TICK_MS while
// a hand is relevant (tip within NEAR m of the keyboard or trigger pulled),
// else every IDLE_MS; one { keyboard: null } frame when the keyboard goes.
// Nothing at all while the keyboard is hidden (one DOM lookup per POLL_MS). Frame (hub.js adds page px):
//   { seq, t, moving, keyboard: { width } | null,
//     hands: { left, right: null | { tip: { u, v, d }, ray: { u, v, dist } | null,
//                                    trigger: 0..1 | null } } }
// Never touches SteamVR's input or the lasers. Debugging: __sfuiCtl.log,
// __sfuiCtl.last (the last frame).
((find, sigs, opts, hooks, GEO) => {
  const VERSION = 3;
  const G = window;
  const TICK_MS = 11, IDLE_MS = 1000, POLL_MS = 250, MOVE_QUIET_MS = 300, TIP_CACHE_MS = 5000;
  const NEAR = 0.1;                                  // m
  const TRIGGER_DEG = 12.5;                          // frame controller: trigger component's full travel
  const PROBE = 'sfui-ctl-keyboard';
  const HANDS = ['left', 'right'];
  const STANDING = 1;                                // ETrackingUniverseOrigin, as SteamVR's dashboard reads poses
  const stamp = `${VERSION}:${GEO.VERSION} ${JSON.stringify(opts)}`;
  if (G.__sfuiCtl?.stamp === stamp) return 'unchanged';
  const V = G.VRHTML;
  const missing = [
    typeof V?.GetPose !== 'function' && 'VRHTML.GetPose',
    typeof V?.VRRenderModels?.GetComponentStateForDevicePath !== 'function' && 'VRHTML.VRRenderModels.GetComponentStateForDevicePath',
    typeof V?.VRProperties?.GetStringProperty !== 'function' && 'VRHTML.VRProperties.GetStringProperty',
    typeof V?.NextSGID !== 'function' && 'VRHTML.NextSGID',
    typeof V?.VROverlay?.ThisOverlayKey !== 'function' && 'VRHTML.VROverlay.ThisOverlayKey',
    typeof G.SGQueryService?.requestSGTransform !== 'function' && 'SGQueryService.requestSGTransform',
    typeof G.forceLayoutUpdate !== 'function' && 'forceLayoutUpdate',
  ].filter(Boolean);
  if (missing.length) return `SteamVR internals changed, no controller bridge: missing ${missing.join(', ')}`;
  try { G.__sfuiCtl?.dispose?.(); } catch { /* gone */ }

  const S = G.__sfuiCtl = { stamp, log: [], kb: null, last: null };
  const log = (...a) => { S.log.push([Math.round(performance.now()), ...a]); if (S.log.length > 100) S.log.shift(); };
  let seq = 0, sentAt = -Infinity, wasRelevant = false;
  const send = (f) => {
    S.last = f;
    sentAt = f.t;
    try { G.__sfuiCtlOut?.(JSON.stringify(f)); } catch (e) { log('send', String(e)); }
  };

  // ---- the keyboard -----------------------------------------------------------
  const fiberProps = (e) => {
    const k = Object.keys(e).find((x) => x.startsWith('__reactFiber$'));
    let f = k && e[k];
    for (let i = 0; f && i < 6; f = f.return, i++) if (f.memoizedProps?.mountedId) return f.memoizedProps;
    return null;
  };
  let scaled = null, probe = null;
  function findScaled() {
    if (scaled?.isConnected) return scaled;
    scaled = null;
    for (const e of document.querySelectorAll('[vsg-type="mountedscenegraph"]')) {
      if (String(fiberProps(e)?.mountedId ?? '').endsWith('gamepadui.keyboard') && e.parentElement?.tagName === 'VSG-TRANSFORM') {
        scaled = e.parentElement;
        break;
      }
    }
    return scaled;
  }
  function ensureProbe(parent) {
    if (probe?.parentElement === parent) return;
    probe?.remove();
    probe = document.createElement('vsg-transform');
    for (const [k, v] of Object.entries({ translation: '0 0 0', rotation: '1 0 0 0', scale: '1 1 1', sgid: V.NextSGID() }))
      probe.setAttribute(k, String(v));
    probe.id = PROBE;
    parent.appendChild(probe);
    G.forceLayoutUpdate();
  }
  const removeProbe = () => { if (probe) { probe.remove(); probe = null; G.forceLayoutUpdate(); } };

  let pending = false, movedAt = -Infinity;
  async function pollKeyboard() {
    pending = true;
    try {
      const xf = await Promise.race([
        G.SGQueryService.requestSGTransform(`${V.VROverlay.ThisOverlayKey()}::${PROBE}`),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1000)),
      ]);
      if (!probe) return;
      let ow = 1;
      try { ow = V.VROverlay.GetWidthInMeters(V.VROverlay.FindOverlay('valve.steam.gamepadui.keyboard')) || 1; } catch { /* 1 */ }
      const kb = { translation: xf.translation, rotation: xf.rotation, width: xf.scale.x * ow };
      const o = S.kb;
      if (!o || Math.hypot(kb.translation.x - o.translation.x, kb.translation.y - o.translation.y, kb.translation.z - o.translation.z) > 0.002 ||
        Math.abs(kb.rotation.w * o.rotation.w + kb.rotation.x * o.rotation.x + kb.rotation.y * o.rotation.y + kb.rotation.z * o.rotation.z) < 0.99998 ||
        Math.abs(kb.width - o.width) > 0.002) movedAt = performance.now();
      S.kb = kb;
    } catch (e) { log('keyboard pose', String(e?.message ?? e)); } finally { pending = false; }
  }

  // ---- the controllers ------------------------------------------------------------
  const models = {};                                 // hand -> { at, rm, tip }
  function model(hand, now) {
    const c = models[hand];
    if (c && now - c.at < TIP_CACHE_MS) return c;
    const path = `/user/hand/${hand}`;
    let rm = null, tip = null;
    try {
      rm = V.VRProperties.GetStringProperty(path, 1003) || null;   // Prop_RenderModelName_String
      tip = rm ? V.VRRenderModels.GetComponentStateForDevicePath(rm, 'tip', path)?.xfTrackingToComponentLocal ?? null : null;
    } catch { /* the device pose */ }
    return (models[hand] = { at: now, rm, tip });
  }
  function trigger(hand, rm) {
    try {
      const q = rm && V.VRRenderModels.GetComponentStateForDevicePath(rm, 'trigger', `/user/hand/${hand}`)?.xfTrackingToComponentRenderModel?.rotation;
      return q ? Math.min(1, GEO.rotationDegrees(q) / TRIGGER_DEG) : null;
    } catch { return null; }
  }
  function handFrame(hand, now) {
    const [p] = V.GetPose(`/user/hand/${hand}`, STANDING) || [];
    if (!p?.bPoseIsValid) return null;
    const m = model(hand, now);
    const pose = GEO.tipPose(p.xfDeviceToAbsoluteTracking, m.tip);
    return { tip: GEO.toKeyboard(pose.translation, S.kb), ray: GEO.rayHit(pose, S.kb), trigger: trigger(hand, m.rm) };
  }
  const relevant = (h) => !!h && ((Math.abs(h.tip.d) < NEAR && h.tip.u > -0.2 && h.tip.u < 1.2 && h.tip.v > -0.2 && h.tip.v < 0.7) ||
    h.trigger >= 0.5);

  // ---- loops ---------------------------------------------------------------------
  let active = false;
  const slow = setInterval(() => {
    const parent = findScaled();
    if (!parent) {
      if (active) { send({ seq: ++seq, t: performance.now(), moving: false, keyboard: null, hands: { left: null, right: null } }); log('inactive'); }
      active = false; S.kb = null;
      removeProbe();
      return;
    }
    ensureProbe(parent);
    if (!active) log('active');
    active = true;
    if (!pending) pollKeyboard();
  }, POLL_MS);
  const fast = setInterval(() => {
    if (!active || !S.kb) return;
    const now = performance.now(), hands = {};
    for (const h of HANDS) {
      try { hands[h] = handFrame(h, now); } catch (e) { hands[h] = null; log('pose', String(e)); }
    }
    const rel = HANDS.some((h) => relevant(hands[h]));
    if (rel || wasRelevant || now - sentAt >= IDLE_MS) {
      send({ seq: ++seq, t: now, moving: now - movedAt < MOVE_QUIET_MS, keyboard: { width: S.kb.width }, hands });
    }
    wasRelevant = rel;
  }, TICK_MS);

  S.dispose = () => {
    clearInterval(slow); clearInterval(fast);
    if (active) send({ seq: ++seq, t: performance.now(), moving: false, keyboard: null, hands: { left: null, right: null } });
    removeProbe();
  };
  return 'patched';
})
