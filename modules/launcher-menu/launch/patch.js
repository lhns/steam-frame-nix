// launch: what happens when a program of the VR dashboard's "+" menu
// (#VRDashboard_LaunchNonSteamApp) is activated.
//
// This file is a function expression; launcher-menu.nix calls it with the
// options: (<this file>)({ closeOnLaunch: true, debounceSeconds: 10 }).
//
// Stock, an item's onActivate only calls
// SteamClient.Apps.LaunchNonSteamApp(strCmdline) (plus the nav sound); the
// "+" popup stays open until the new window takes over, so users click again
// and start the program twice. That call is the only use of
// LaunchNonSteamApp in Steam's UI and is looked up at call time, so this
// patch wraps it in SharedJSContext (the dashboard bar's realm):
// - debounceSeconds > 0: a launch of the same command line within that many
//   seconds of the last accepted one is ignored (console.info, and reported
//   in the steam-ui-patches journal on the next re-injection);
// - closeOnLaunch: after a launch (ignored or not), the "+" popup is closed
//   through the bar button's own popup handle (closePopup(), what stock does
//   after adding a desktop window). The handle is found in the dashboard bar
//   document: the button's React fiber ancestors include the "+" component
//   (prop allowLaunchProgram) and the bar button (prop refBarPopopHandle).
// Works for every activation path (pointer, controller, the pinned Desktop
// copy, which clicks the stock item). The original is kept as __sfuiOrig
// (unpatch.js restores it). Idempotent; bump VERSION when changing the
// wrapper.
((opts) => {
  const VERSION = 1;
  const NAME = 'launcher-menu-launch';
  const CLOSE = opts.closeOnLaunch === true;
  const DEBOUNCE_MS = Math.max(0, Number(opts.debounceSeconds) || 0) * 1000;
  const Apps = window.SteamClient?.Apps;
  const cur = Apps?.LaunchNonSteamApp;
  if (typeof cur !== 'function') return 'SteamClient.Apps.LaunchNonSteamApp missing';
  const st = cur.__sfuiPatch === NAME ? cur.__sfuiState : null;
  if (st && cur.__sfuiVersion === VERSION && st.close === CLOSE && st.debounceMs === DEBOUNCE_MS) {
    // Report ignored launches since the last evaluation (the injector logs
    // results that differ from the previous one).
    const msgs = st.log.splice(0);
    return msgs.length ? msgs.join('; ') : 'unchanged';
  }
  const orig = cur.__sfuiPatch === NAME ? cur.__sfuiOrig : cur;

  const fiberOf = (el) => { const k = Object.keys(el).find((k) => k.startsWith('__reactFiber$')); return k && el[k]; };
  // Popup handles of the "+" bar button(s) (normally one).
  const plusHandles = () => {
    const hs = [];
    for (const p of window.g_PopupManager?.GetPopups() ?? []) {
      if (!/gamepadui\.bar\./.test(p.m_strName ?? '')) continue;
      let d;
      try { d = p.window?.document; } catch { continue; }
      for (const el of d?.querySelectorAll('.VRDashboardBarSmallButton') ?? []) {
        let h = null;
        for (let f = fiberOf(el), i = 0; f && i < 20; f = f.return, i++) {
          const mp = f.memoizedProps;
          if (!mp || typeof mp !== 'object') continue;
          if ('refBarPopopHandle' in mp) h = mp.refBarPopopHandle?.current ?? null;
          if ('allowLaunchProgram' in mp) { if (h && !hs.includes(h)) hs.push(h); break; }
        }
      }
    }
    return hs;
  };
  const closeMenu = () => {
    for (const h of plusHandles()) if (h.BPopupOpen?.()) h.closePopup();
  };

  const state = { close: CLOSE, debounceMs: DEBOUNCE_MS, last: new Map(), log: [], plusHandles, closeMenu };
  const f = function LaunchNonSteamApp(cmdline, ...rest) {
    let result;
    const now = Date.now();
    const key = String(cmdline);
    const prev = state.last.get(key);
    if (DEBOUNCE_MS > 0 && prev !== undefined && now - prev < DEBOUNCE_MS) {
      const msg = `ignored repeated launch of ${JSON.stringify(key)} (${((now - prev) / 1000).toFixed(1)} s after the last one, at ${new Date(now).toLocaleTimeString()})`;
      console.info(`sfui ${NAME}: ${msg}`);
      state.log.push(msg);
      if (state.log.length > 20) state.log.shift();
    } else {
      state.last.set(key, now);
      for (const [k, t] of state.last) if (now - t >= DEBOUNCE_MS && k !== key) state.last.delete(k);
      result = orig.call(this, cmdline, ...rest);
    }
    if (CLOSE) { try { closeMenu(); } catch (e) { console.error(`sfui ${NAME}:`, e); } }
    return result;
  };
  f.__sfuiPatch = NAME; f.__sfuiVersion = VERSION; f.__sfuiOrig = orig; f.__sfuiState = state;
  Apps.LaunchNonSteamApp = f;
  const what = [CLOSE && 'close on launch', DEBOUNCE_MS > 0 && `debounce ${DEBOUNCE_MS / 1000} s`].filter(Boolean);
  return `patched (${what.join(', ') || 'no-op'})`;
})
