// steam-close-button: a Close (X) button on the SteamVR dashboard's main
// "Steam" window (overlay valve.steam.gamepadui.main).
// Target: SteamVR dashboard (vrwebhelper, DevTools 127.0.0.1:8087, title
// "systemui"). mkPatch patch (see lib/default.nix); no options.
//
// The button: a frame's `closing` component shows X when a close method is
// possible; method 0 is "componentProps.onCloseRequested exists", with
// componentProps = {...defaultComponentProps, ...frame.props.componentProps.closing}.
// The main frame passes no closing props, so this instance's
// defaultComponentProps is replaced by a copy adding onCloseRequested
// (original as non-enumerable __sfuiOrig) and frame.props is re-assigned (in a
// MobX action) so the computed re-evaluates. Later React props updates keep it.
//
// Clicking X: the frame can't be destroyed, so it is put out of view:
//  * undocked (world/theater/hand) -> docked back into the dashboard;
//  * if it was active -> switch to the most recently active other frame that
//    is alive, docked and has a dashboard-bar tab (as a tab click does);
//  * with none -> "bar only": dashboard open with no active frame.
// Stock SteamVR has that state but never keeps it, so while bar-only is on
// and no frame is active:
//  - an instance override of Dashboard.autoSwitchOverlayIfNeeded returns
//    early (its autorun, and reopening the dashboard, would switch back);
//  - an instance override of Dashboard.onShowOverlayRequestFromSteam drops
//    the FIRST ShowOverlay(main) from Steam after each dashboard open, within
//    STEAM_SHOW_CAP_MS (Steam sends it by itself 50 ms .. 1.7 s after open).
//    Trade-off: if Steam doesn't send it, the user's first explicit Steam-menu
//    pick in that session is swallowed once.
// Steam tab clicks and SteamVR's SwitchToDashboardOverlay aren't filtered.
// Bar-only ends as soon as any frame becomes active.
//
// State (bar-only flag, open time, pending request, history, log) lives in
// window.__sfuiSteamCloseState (schema 1), taken over by upgrades. Teardown
// never switches frames and keeps the state, so a re-injection continues
// bar-only; a dashboard reload starts fresh.
//
// Without the Dashboard component, X hides the dashboard. RequestClose's
// spinner (it expects the frame to go away) is reset right after. A MobX
// reaction tracks active-frame history and re-applies when the main frame
// changes. window.__sfuiSteamClose: plan() (what a click would do),
// wouldIgnoreSteamShow(), barOnly, state, teardown(). Result: "patched" /
// "unchanged", plus " (bar-only, N ignored Steam requests)" when relevant.
((find, sigs, opts) => {
  const NAME = 'steam-close-button';
  const VERSION = 5;
  const MAIN_KEY = 'valve.steam.gamepadui.main';   // anchored by sigs.overlayKeys
  const FRAME_ALIVE = 2;                           // frame m_eState Alive (sigs.frame)
  const STEAM_SHOW_CAP_MS = 10000;
  const REASON = 'sfui steam-close-button';

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

  // Page state. To keep bar-only across dashboard reloads, load/save it here
  // (e.g. localStorage; shownAt is performance.now() of this page).
  const loadState = () => {
    const s = window.__sfuiSteamCloseState;
    if (s?.schema === 1) return s;
    return (window.__sfuiSteamCloseState = {
      schema: 1, barOnly: false, shownAt: -Infinity, steamShowPending: false,
      history: [], ignored: 0, suppressed: [],
    });
  };
  const S = loadState();
  if (S.barOnly && DS.activeFrame != null) S.barOnly = false;   // a frame became active meanwhile

  // Recently active frame IDs, most recent last.
  const note = (id) => {
    if (id == null) return;
    const h = S.history, i = h.indexOf(id);
    if (i >= 0) h.splice(i, 1);
    h.push(id);
    if (h.length > 32) h.shift();
  };
  note(DS.activeFrameID);

  const fallbackFrame = (main) => {
    for (let i = S.history.length - 1; i >= 0; i--) {
      const f = FS.GetFrame(S.history[i]);
      if (f && f.frameID !== main.frameID && f.m_eState === FRAME_ALIVE &&
          f.tab?.visibleInDashboardBar && f.docking?.dockLocation === DOCK_DASHBOARD) return f;
    }
    return null;
  };

  // What a click on the main frame's X would do: { action, dock, to?, title? }.
  const plan = (frame = DS.mainSteamFrame) => {
    if (!frame) return { action: 'none', reason: 'no main frame' };
    const dock = !!frame.docking && frame.docking.dockLocation !== DOCK_DASHBOARD;
    if (!frame.isActiveDashboardFrame) return { action: dock ? 'dock' : 'none', dock };
    const other = fallbackFrame(frame);
    if (other && window.Dashboard?.switchToFrameInternal) return { action: 'switch', dock, to: other.frameID, title: other.title };
    if (window.Dashboard && DS._setActiveFrame) return { action: 'bar-only', dock };
    return { action: DS.isFullyVisible ? 'hide' : 'none', dock };
  };

  // ---- bar-only: overrides on the Dashboard instance --------------------------
  const holding = () => S.barOnly && DS.activeFrame == null;
  const wouldIgnoreSteamShow = (key = MAIN_KEY) => holding() && key === MAIN_KEY && DS.visibilityState !== 0 &&
    S.steamShowPending && performance.now() - S.shownAt < STEAM_SHOW_CAP_MS;
  const wrappers = {
    autoSwitchOverlayIfNeeded: (orig) => function autoSwitchOverlayIfNeeded(...args) {
      if (holding()) return;
      return orig.apply(this, args);
    },
    onShowOverlayRequestFromSteam: (orig) => function onShowOverlayRequestFromSteam(e, ...rest) {
      if (e?.overlay_key === MAIN_KEY) {
        const ignore = wouldIgnoreSteamShow(MAIN_KEY);
        S.steamShowPending = false;
        if (ignore) {
          S.ignored++;
          S.suppressed.push({ at: new Date().toISOString(), afterOpenMs: Math.round(performance.now() - S.shownAt), key: MAIN_KEY });
          if (S.suppressed.length > 10) S.suppressed.shift();
          return;
        }
      }
      return orig.call(this, e, ...rest);
    },
  };
  let guarded = null;                              // Dashboard instance carrying the overrides
  // Installs the overrides (idempotent); true if autoSwitchOverlayIfNeeded,
  // the one bar-only needs, is overridden.
  const guard = () => {
    const dash = window.Dashboard;
    if (!dash) return false;
    if (guarded && guarded !== dash) unguard();   // Dashboard remounted
    guarded = dash;
    for (const [name, make] of Object.entries(wrappers)) {
      const cur = dash[name];
      if (typeof cur !== 'function' || (cur.__sfuiPatch === NAME && cur.__sfuiVersion === VERSION)) continue;
      const own = Object.getOwnPropertyDescriptor(dash, name);
      if (own && !own.writable && !own.configurable) continue;
      const ours = cur.__sfuiPatch === NAME;       // left by another version
      const orig = ours ? cur.__sfuiOrig : cur;
      dash[name] = Object.assign(make(orig), {
        __sfuiPatch: NAME, __sfuiVersion: VERSION, __sfuiOrig: orig, __sfuiHadOwn: ours ? cur.__sfuiHadOwn : !!own,
      });
    }
    return dash.autoSwitchOverlayIfNeeded?.__sfuiVersion === VERSION && dash.autoSwitchOverlayIfNeeded.__sfuiPatch === NAME;
  };
  const unguard = () => {
    const d = guarded;
    guarded = null;
    for (const name of Object.keys(wrappers)) {
      const f = d?.[name];
      if (f?.__sfuiPatch !== NAME) continue;
      if (f.__sfuiHadOwn) d[name] = f.__sfuiOrig;
      else delete d[name];
    }
  };

  const onClose = (frame) => {
    const p = plan(frame);
    if (p.dock) frame.docking.SetDockLocation(DOCK_DASHBOARD);
    const dash = window.Dashboard;
    switch (p.action) {
      case 'switch':
        dash.switchToFrameInternal(FS.GetFrame(p.to), undefined, REASON);
        break;
      case 'bar-only':
        if (!guard()) { dash.hideDashboard?.(REASON, false); break; }
        S.barOnly = true;
        S.steamShowPending = false;
        DS._setActiveFrame(undefined, undefined);
        break;
      case 'hide':
        if (dash?.hideDashboard) dash.hideDashboard(REASON, false);
        else window.VRHTML?.VRDashboardManager?.HideDashboard(REASON, false);
        break;
    }
  };

  // ---- the button: defaultComponentProps of the main frame's `closing` --------
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
      onCloseRequested: () => {
        try { onClose(frame); } finally { setTimeout(() => resetSpinner(c), 0); }   // set after we return
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
    const notes = [S.barOnly && 'bar-only', S.ignored && `${S.ignored} ignored Steam request${S.ignored === 1 ? '' : 's'}`]
      .filter(Boolean);
    return notes.length ? `${r} (${notes.join(', ')})` : r;
  };

  const disposers = [
    mx.reaction(() => DS.activeFrameID, note),
    mx.reaction(() => DS.activeFrameID != null, (active) => {
      if (active) { S.barOnly = false; S.steamShowPending = false; }
    }),
    mx.reaction(() => DS.visibilityState !== 0, (shown) => {
      if (shown) { S.shownAt = performance.now(); S.steamShowPending = true; }
    }),
    mx.reaction(() => DS.m_unMainSteamFrameID, () => { try { apply(); } catch (e) { console.error(NAME, e); } }),
  ];
  const teardown = () => {
    for (const d of disposers.splice(0)) d();
    unpatchFrame();
    unguard();
    if (window.__sfuiSteamClose === self) delete window.__sfuiSteamClose;
  };
  const self = window.__sfuiSteamClose = {
    version: VERSION, apply, teardown, plan, wouldIgnoreSteamShow, state: S,
    get barOnly() { return S.barOnly; },
  };
  return apply().replace(/^unchanged/, 'patched');
})
