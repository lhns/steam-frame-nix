// steam-close-button: a Close (X) button on the SteamVR dashboard's main Steam
// window (overlay valve.steam.gamepadui.main). Target: "systemui" on
// 127.0.0.1:8087; mkPatch patch, no options.
//
// Button: the frame's `closing` component shows X when
// componentProps.onCloseRequested exists; this instance's defaultComponentProps
// gets one (original kept as __sfuiOrig) and frame.props is re-assigned so the
// MobX computed re-evaluates.
//
// X hides Steam: docks the window back if undocked, then switches to the most
// recently active other alive, docked frame with a bar tab, else "bar only"
// (no active frame). Without the Dashboard component it hides the dashboard.
// Steam stays hidden until it is the active frame again, which only explicit
// requests do (tab click, Steam menu pick, SwitchToDashboardOverlay). While
// hidden, stock fallbacks to Steam go to that same target instead:
//  - Dashboard.autoSwitchOverlayIfNeeded (instance override): no active frame
//    (active window closed, dashboard opened) -> target; bar-only stays;
//  - mailbox handler "dashboard_overlay_destroyed" (stock: active overlay gone
//    -> switchToHomeOverlay -> Steam) -> target;
//  - mailbox show/switch requests for Steam with reason "SetDockLocation" (echo
//    of X docking Steam) are dropped, "theater frame destroyed" (vrserver) are
//    passed on without the key.
// Rarer stock "go home" paths (Now Playing, message overlay) still show Steam.
//
// Contract: state in window.__sfuiSteamCloseState (schema 1: steamHidden,
// barOnly, history, redirected, redirects; older versions' fields are left
// for a rollback) survives re-injection; teardown restores all overrides and
// never switches frames.
// window.__sfuiSteamClose: plan(), homePlan(), steamHidden, barOnly, state.
((find, sigs, opts) => {
  const NAME = 'steam-close-button';
  const VERSION = 7;
  const MAIN_KEY = 'valve.steam.gamepadui.main';   // sigs.overlayKeys
  const FRAME_ALIVE = 2;                           // sigs.frame
  const REASON = 'sfui steam-close-button';
  const DOCK_ECHO = 'SetDockLocation';             // sigs.docking
  const THEATER_GONE = 'theater frame destroyed';  // sent by vrserver

  const prev = window.__sfuiSteamClose;
  if (prev?.version === VERSION) return prev.apply();

  const DS = window.DashboardStore, FS = window.FrameStore;
  if (!DS || !FS) return 'not patched: window.DashboardStore/FrameStore missing';
  let mods;
  try {
    mods = find.resolveAll(find.getWebpackRequire('webpackChunkvrwebui'), sigs);
  } catch (e) {
    return `signature not found, dashboard left unpatched: ${e.message}`;
  }
  const mx = mods.mobx.module;
  if (typeof mx.runInAction !== 'function' || typeof mx.reaction !== 'function')
    return 'signature not found, dashboard left unpatched: mobx.runInAction/reaction';
  const Closing = mods.closing.exports.Closing;
  const DOCK_DASHBOARD = mods.dock.exports.EDockLocation.Dashboard;

  prev?.teardown?.();                              // other VERSION; never switches frames

  const S = (() => {
    const s = window.__sfuiSteamCloseState;
    if (s?.schema !== 1) return (window.__sfuiSteamCloseState =
      { schema: 1, steamHidden: false, barOnly: false, history: [], redirected: 0, redirects: [] });
    s.steamHidden ??= !!s.barOnly;                 // version <= 5: bar-only implied hidden
    s.barOnly = !!s.barOnly && DS.activeFrame == null;
    s.history ??= []; s.redirected ??= 0; s.redirects ??= [];
    return s;
  })();
  const mainActive = () => DS.activeFrameID != null && DS.activeFrameID === DS.m_unMainSteamFrameID;
  if (mainActive()) S.steamHidden = false;

  const note = (id) => {                           // recently active frames, most recent last
    if (id == null) return;
    const h = S.history, i = h.indexOf(id);
    if (i >= 0) h.splice(i, 1);
    h.push(id);
    if (h.length > 32) h.shift();
  };
  note(DS.activeFrameID);

  const fallbackFrame = (except) => {
    const main = DS.mainSteamFrame;
    for (let i = S.history.length - 1; i >= 0; i--) {
      const f = FS.GetFrame(S.history[i]);
      if (f && f !== main && f !== except && f.m_eState === FRAME_ALIVE &&
          f.tab?.visibleInDashboardBar && f.docking?.dockLocation === DOCK_DASHBOARD) return f;
    }
    return null;
  };

  // What a click on X would do: { action, dock, to?, title? }.
  const plan = (frame = DS.mainSteamFrame) => {
    if (!frame) return { action: 'none', reason: 'no main frame' };
    const dock = !!frame.docking && frame.docking.dockLocation !== DOCK_DASHBOARD;
    if (!frame.isActiveDashboardFrame) return { action: dock ? 'dock' : 'none', dock };
    const other = fallbackFrame(frame);
    if (other && window.Dashboard?.switchToFrameInternal) return { action: 'switch', dock, to: other.frameID, title: other.title };
    if (window.Dashboard && DS._setActiveFrame) return { action: 'bar-only', dock };
    return { action: DS.isFullyVisible ? 'hide' : 'none', dock };
  };
  // Where a fallback away from `except` goes while hidden.
  const homePlan = (except = DS.activeFrame) => {
    const f = fallbackFrame(except);
    return f ? { action: 'switch', to: f.frameID, title: f.title } : { action: 'bar-only' };
  };

  const hiding = () => S.steamHidden && DS.mainSteamFrame != null && !mainActive();
  const barOnly = () => {
    S.barOnly = true;
    if (DS.activeFrameID != null) DS._setActiveFrame(undefined, undefined);
  };
  const goHome = (except, why) => {
    const p = homePlan(except);
    S.redirected++;
    S.redirects.push({ at: new Date().toISOString(), why, to: p.to ?? 'bar-only' });
    if (S.redirects.length > 10) S.redirects.shift();
    if (p.to != null && window.Dashboard?.switchToFrameInternal) window.Dashboard.switchToFrameInternal(FS.GetFrame(p.to), undefined, REASON);
    else barOnly();
  };

  // ---- overrides: a Dashboard instance method and its mailbox handlers ------
  const methodWrappers = {
    autoSwitchOverlayIfNeeded: (orig) => function autoSwitchOverlayIfNeeded(...args) {
      if (S.barOnly && DS.activeFrame == null) return;
      if (hiding() && DS.activeFrame == null) return goHome(null, 'autoSwitchOverlayIfNeeded');
      return orig.apply(this, args);
    },
  };
  const showRequest = (orig) => function showRequest(e, ...rest) {
    if (hiding() && e?.overlay_key === MAIN_KEY) {
      if (e.reason === DOCK_ECHO) return;
      if (e.reason === THEATER_GONE) return orig.call(this, { ...e, overlay_key: undefined }, ...rest);
    }
    return orig.call(this, e, ...rest);
  };
  const handlerWrappers = {
    dashboard_overlay_destroyed: (orig) => function overlayDestroyed(e, ...rest) {
      const a = DS.activeFrame;
      if (hiding() && a?.associatedSummonOverlayKeys?.includes(e?.overlay_key ?? '')) return goHome(a, 'overlay destroyed');
      return orig.call(this, e, ...rest);
    },
    show_dashboard_requested: showRequest,
    switch_dashboard_overlay_requested: showRequest,
  };
  const ours = (f) => f?.__sfuiPatch === NAME && f.__sfuiVersion === VERSION;
  const wrapAll = (obj, wrappers) => {
    for (const [name, make] of Object.entries(wrappers)) {
      const cur = obj[name];
      if (typeof cur !== 'function' || ours(cur)) continue;
      const own = Object.getOwnPropertyDescriptor(obj, name);
      if (own && !own.writable && !own.configurable) continue;
      const old = cur.__sfuiPatch === NAME;        // left by another version
      const orig = old ? cur.__sfuiOrig : cur;
      obj[name] = Object.assign(make(orig), { __sfuiPatch: NAME, __sfuiVersion: VERSION, __sfuiOrig: orig,
        __sfuiHadOwn: old ? cur.__sfuiHadOwn : !!own });
    }
  };
  const DASH_NAMES = [...Object.keys(methodWrappers), 'onShowOverlayRequestFromSteam'];   // + version <= 6
  const unwrapAll = (obj, names) => {
    for (const name of names) {
      const f = obj?.[name];
      if (f?.__sfuiPatch !== NAME) continue;
      if (f.__sfuiHadOwn) obj[name] = f.__sfuiOrig;
      else delete obj[name];
    }
  };
  let guarded = null, guardedHandlers = null;
  // Installs the overrides (idempotent); true if autoSwitchOverlayIfNeeded is ours.
  const guard = () => {
    const dash = window.Dashboard;
    if (!dash) return false;
    if (guarded && guarded !== dash) unguard();   // Dashboard remounted
    guarded = dash;
    unwrapAll(dash, DASH_NAMES.filter((n) => !(n in methodWrappers)));   // left by an older version
    wrapAll(dash, methodWrappers);
    const h = dash.m_mailbox?.m_oHandlers;        // registered once the mailbox is up
    if (h && typeof h === 'object') {
      guardedHandlers = h;
      wrapAll(h, Object.fromEntries(Object.entries(handlerWrappers).filter(([t]) => typeof h[t] === 'function')));
    }
    return ours(dash.autoSwitchOverlayIfNeeded);
  };
  const unguard = () => {
    unwrapAll(guarded, DASH_NAMES);
    unwrapAll(guardedHandlers, Object.keys(handlerWrappers));
    guarded = guardedHandlers = null;
  };

  const onClose = (frame) => {
    const p = plan(frame);
    const dash = window.Dashboard;
    if (p.action !== 'none' || p.dock) { guard(); S.steamHidden = true; }
    if (p.dock) frame.docking.SetDockLocation(DOCK_DASHBOARD);
    if (p.action === 'switch') dash.switchToFrameInternal(FS.GetFrame(p.to), undefined, REASON);
    else if (p.action === 'bar-only' && guard()) barOnly();
    else if (p.action === 'bar-only' || p.action === 'hide') {
      if (dash?.hideDashboard) dash.hideDashboard(REASON, false);
      else window.VRHTML?.VRDashboardManager?.HideDashboard(REASON, false);
    }
  };

  // ---- the button --------------------------------------------------------------
  let closing = null;                              // the component we changed
  const nudge = (frame) => mx.runInAction(() => { if (frame?.props) frame.props = { ...frame.props }; });
  const resetSpinner = (c) => mx.runInAction(() => { c.m_bShowSpinner = false; });

  const patchFrame = (frame) => {
    const c = frame.closing;
    if (!(c instanceof Closing)) return 'not patched: main frame has no closing component';
    const cur = c.defaultComponentProps;
    closing = c;
    if (cur?.__sfuiPatch === NAME && cur.__sfuiVersion === VERSION) return 'unchanged';
    const orig = cur?.__sfuiPatch === NAME ? cur.__sfuiOrig : cur;
    const props = {
      ...orig,
      onCloseRequested: () => {                    // RequestClose sets the spinner after we return
        try { onClose(frame); } finally { setTimeout(() => resetSpinner(c), 0); }
      },
    };
    for (const [k, value] of [['__sfuiPatch', NAME], ['__sfuiVersion', VERSION], ['__sfuiOrig', orig]])
      Object.defineProperty(props, k, { value, configurable: true });   // non-enumerable: not merged
    c.defaultComponentProps = props;
    nudge(frame);
    return 'patched';
  };
  const unpatchFrame = () => {
    const c = closing;
    closing = null;
    const cur = c?.defaultComponentProps;
    if (cur?.__sfuiPatch !== NAME) return;
    c.defaultComponentProps = cur.__sfuiOrig;
    if (c.frame?.m_eState !== FRAME_ALIVE) return;
    resetSpinner(c);
    nudge(c.frame);
  };

  const apply = () => {
    const f = DS.mainSteamFrame;
    if (closing && closing.frame !== f) unpatchFrame();          // main frame recreated
    guard();
    if (!f) return 'main Steam frame not found';
    const r = patchFrame(f);
    const notes = [S.steamHidden && 'Steam hidden', S.barOnly && 'bar-only',
      S.redirected && `${S.redirected} redirect${S.redirected === 1 ? '' : 's'}`].filter(Boolean);
    return notes.length ? `${r} (${notes.join(', ')})` : r;
  };

  const disposers = [
    mx.reaction(() => DS.activeFrameID, note),
    mx.reaction(() => DS.activeFrameID != null, (active) => { if (active) S.barOnly = false; }),
    mx.reaction(mainActive, (on) => { if (on) S.steamHidden = false; }),
    mx.reaction(() => DS.m_unMainSteamFrameID, () => { try { apply(); } catch (e) { console.error(NAME, e); } }),
  ];
  const teardown = () => {
    for (const d of disposers.splice(0)) d();
    unpatchFrame();
    unguard();
    if (window.__sfuiSteamClose === self) delete window.__sfuiSteamClose;
  };
  const self = window.__sfuiSteamClose = {
    version: VERSION, apply, teardown, plan, homePlan, state: S,
    get steamHidden() { return S.steamHidden; },
    get barOnly() { return S.barOnly; },
  };
  return apply().replace(/^unchanged/, 'patched');
})
