# SteamVR dashboard patches: how they work

Technical details of the four dashboard patches. What they do and how to
configure them: README, [dashboard windows](../README.md#dashboard-windows-dashboardwindows),
[Steam close button](../README.md#steam-close-button-dashboardsteamclosebuttonenable),
[window curvature](../README.md#window-curvature-dashboardwindowcurvature),
[window control bar](../README.md#window-control-bar-dashboardframecontrols).

All four are `mkPatch` [UI patches](ui-patches.md) of SteamVR's dashboard
(`vrwebhelper`, page title `systemui`, DevTools `127.0.0.1:8087`, webpack
chunk `webpackChunkvrwebui`), registered only when enabled; they turn on the
[SteamVR debugger](steamvr-debugger.md). Each is found by signature (its
entry in `modules/lib/signatures.json` has the patch's name); on mismatch
the dashboard stays stock. Sources: `modules/<name>/patch.js`, whose header
comments go into more detail.

## Dashboard windows

`dashboard-windows`. `systemui` sends its scene graph to vrcompositor via
`mailbox.SendMessage("vrcompositor_systemlayer", { type: "update_scene_graph", scene_graph })`,
and vrcompositor enforces the limits in it:

- `frame-resize-scale-min` / `-max` on window frames;
- `min-distance` / `max-distance` on grab nodes: `grab-scale` for world
  windows, `grab-transform` for the theater screen and the dashboard (the
  keyboard's `grab-transform`, 0.2 / 1 m, is left alone).

They are literals in the bundle, so the patch hooks `SendMessage` on the
mailbox prototype ([shared hooks](ui-patches.md#shared-method-hooks), shared
with window curvature) and edits outgoing scene graphs in place. Grab nodes
are matched by type plus exact stock values, so if SteamVR changes them the
distance rewrite becomes a no-op. A scene-graph resend applies new limits at
once.

State: `window.__sfuiDashboardWindows` (counters in `.hits`).

## Steam close button

`steam-close-button`, with [persistent state](ui-patches.md#persistent-state)
(`{ schema: 1, steamHidden }`).

- **Button:** the frame's `closing` component shows X when
  `componentProps.onCloseRequested` exists; the Steam window's instance
  (overlay `valve.steam.gamepadui.main`) gets one and its props are
  re-assigned so the MobX computed re-evaluates.
- **Staying hidden:** while hidden, stock fallbacks to Steam go to the
  previous window or bar-only instead: `Dashboard.autoSwitchOverlayIfNeeded`
  (instance override) and the mailbox handler `dashboard_overlay_destroyed`.
  Mailbox show/switch requests for Steam with reason `SetDockLocation` (the
  echo of X docking Steam) are dropped, "theater frame destroyed" ones are
  passed on without the Steam key. Explicit requests (tab click, Steam menu
  pick, `SwitchToDashboardOverlay`) show Steam again.
- **Restarts:** a restored hidden state stays pending (`restorePending`)
  until Steam's frame is seen, since the injector attaches within ~5 s of
  the page appearing.

Debugging: `window.__sfuiSteamClose.plan()` / `homePlan()`; state in
`window.__sfuiSteamCloseState` (survives re-injection; teardown restores all
overrides and never switches frames).

## Window curvature

`window-curvature`. Stock curvature: the frame renders a transform
`frame:<id>:curvature-origin` at `z = DashboardStore.curvatureDistance` when
curved, else 1000; its panels reference it as `curvature-origin-id` and
vrcompositor bends them onto a cylinder around it (curvature = 1/radius).
Those MobX properties are non-configurable, so the patch hooks the mailbox
`SendMessage` (shared with dashboard windows) and rewrites the origin's z
in outgoing scene graphs to stock / value. On/off stays the stock toggle
state, so stock toggle and wheel always agree.

Values are kept per window (key: first overlay key) in
`window.__sfuiWindowCurvatureState`, across re-patch and unpatch, not across
a dashboard reload. The bar button uses the coordinates SteamVR keeps
sending past the pressed panel's edge while the trigger is held; the bar
panel is never resized.

Debugging: `window.__sfuiWindowCurvature.dump()` (`.log` recent events).

### Contract for other patches

For patches handling presses on the curvature controls (e.g. the window
control bar's long press): every element the patch drives has class
`sfui-curv-ctl`; when a press becomes a drag, a bubbling `CustomEvent`
`sfui-curv-dragstart` (detail `{ frameID, where: 'menu' | 'bar' }`) is
dispatched on it, and `sfui-curv-dragend` when it ends;
`window.__sfuiWindowCurvature.scalePressDragThreshold(factor)` sets the
current press's drag threshold to `factor` × `dragThresholdPixels` (from the
press start; returns whether it applied, i.e. a press that is not yet a
drag); `window.__sfuiWindowCurvature.cancelPress()` ends a press without its
click. A patch with its own gesture lets `mousemove` through while
undecided, drops its gesture on `sfui-curv-dragstart`, may raise the
threshold while its gesture is under way, and calls `cancelPress()` when it
takes the press over. The window control bar uses factor 3 once its
progress ring shows.

## Window control bar

`frame-controls`, with [persistent state](ui-patches.md#persistent-state)
(placements). Short presses stay stock; the three-dot button can't be
moved. Works with window curvature through the
[contract](#contract-for-other-patches) above.

Debugging: `window.__sfuiFrameControls.dump()`, `.placement()`, `.reset()`
(forget choices), `.log`, `window.__sfuiFrameControlsState`.
