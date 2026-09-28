// frame-controls: move SteamVR dashboard window controls between the bottom
// bar and the More Options (three-dot) menu. A long press (opts.longPressMs;
// progress ring from half that time, at most after 1 s) on a bar icon or menu
// row opens a "Show in bar" popup; toggling it moves that control in all
// windows. Short presses stay stock; the three-dot button can't be moved.
// opts.floatInTheater gives theater windows the "Float" control back.
//
// Target: SteamVR dashboard (vrwebhelper, DevTools 127.0.0.1:8087, title
// "systemui"). mkPatch patch (see steam-ui-patches/lib/default.nix); opts:
// { inBar, inMenu, longPressMs, floatInTheater }.
//
// Stock: each Frame renders <FrameControlsItem params={type, action_id}>
// (2 = action, 1 = spacer); <FrameControls> passes the lists to the MobX
// action Frame.prototype.SetControlsItems(bottom, tabHover, additional)
// (onlyVisibleIn="additional-options" items go to `additional`). systemui
// draws them as panels vsg-node#legacy-frame-controls-<frameID> (bar) and
// #legacy-frame-controls-additional-options-<frameID> (open menu); buttons are
// div.ButtonControl with the item as React prop `control`.
//
// Placement: SetControlsItems is wrapped; stock lists are remembered per frame
// and a re-partitioned copy is stored (stock order kept; a control moved to the
// bar joins the group left of the three-dot button; adjacent spacer runs are
// merged). A change re-applies all remembered lists (no re-render needed).
// Keyed per control type by action icon, "icon:<enum>" (action ids are per
// frame, app window keys per app start). Effective: popup choice, else
// opts.inBar/inMenu, else stock; a popup choice is dropped when that control's
// option changes. State in window.__sfuiFrameControlsState (kept across
// re-patch and unpatch), saved on every change through the injector's
// persistent store (window.__sfuiStore, patch registered with state = true:
// ~/.local/state/steam-frame-nix/ui-patches/frame-controls.json), which
// seeds a fresh page (SteamVR restart, reboot, reload). localStorage can't
// do that: steamvr.service deletes ~/.cache/SteamVR (vrwebhelper's profile)
// on every start (which also took version 4's localStorage copy with it).
//
// Long press: the dashboard only gets primary-button laser input (no right
// click; thumbstick click arrives as nothing). Holding changes nothing; the
// timer survives the laser leaving the control, an early release cancels it.
// On completion the popup opens and the next click on that control is
// swallowed so its stock action doesn't run.
// Contract with window-curvature (whose controls own press-and-drag): its
// elements carry class sfui-curv-ctl; a drag there dispatches a bubbling
// CustomEvent 'sfui-curv-dragstart', which cancels the long press (a drag
// always wins). When the ring shows, the press's drag threshold is raised to
// CURV_RING_THRESHOLD x its own via
// window.__sfuiWindowCurvature.scalePressDragThreshold(), still measured from
// the press start: laser drift keeps the long press, a deliberate drag still
// cancels it. On completion the long press takes the press over via
// cancelPress() (no curvature click on release). Neither reads the other's
// thresholds.
//
// Popup: its own scene-graph panel so the bar/menu panels don't change. The
// dashboard builds its scene graph from the DOM (vsg-transform attributes,
// other nodes via element.buildNode()); panel textures are page regions
// published through SGApp's embedded-UV table. So, after the bar's transform:
//   <vsg-transform parent-id=<anchor> translation=...>
//     <vsg-node> buildNode: panel copying the bar/menu panel's properties
//                (key, meters-per-pixel, curvature origin, laser visibility),
//                origin bottom centre, own UVs and embedded-UV slot
// Anchor: bar -> the button's tooltip anchor, 0.15 up (tooltip offset); menu
// -> the three-dot popout anchor, centred on the menu, GAP_PX above it. The
// stock menu closes when compositor focus leaves bar and menu, which pointing
// at the popup does, so while a menu popup is open that close is deferred
// (SetControlAdditionalOptionsOpen wrapped) and settled on popup close. Closes
// on a press outside, Escape, 1 s after the laser left popup and bar/menu, and
// after toggling. Without SGApp/anchors the popup goes into the bar/menu panel.
//
// Debugging: window.__sfuiFrameControls: log, dump(), placement(),
// setPlacement(name or "icon:N", 'bar' | 'menu' | null), reset().
((find, sigs, opts) => {
  const NAME = 'frame-controls';
  const VERSION = 7;
  const T_SPACER = 1, T_ACTION = 2;
  // Action icon enums (sigs.controls anchors them): names for the options.
  const NAMES = { keyboard: 22, float: 26, dashboard: 27, theater: 28, dockLeft: 29, dockRight: 30, close: 31, curvature: 40 };
  const ICON = { more: 38, float: 26, dashboard: 27 };
  const NAME_OF = { ...Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [`icon:${v}`, k])), [`icon:${ICON.more}`]: 'more' };
  const GAP_PX = 10, MENU_LEFT_PX = 34;           // stock menu: x -34 px from its anchor
  const TOOLTIP_OFFSET = '0 0.15 0.06';           // stock tooltip / menu offset (y 0.15, z 0.05), in front

  const o = { inBar: [], inMenu: [], longPressMs: 1500, floatInTheater: false, ...opts };
  if (!(o.longPressMs >= 300)) return `invalid options ${JSON.stringify(opts)}`;
  const toKey = (x) => (typeof x === 'number' ? `icon:${x}` : NAMES[x] != null ? `icon:${NAMES[x]}` : /^icon:\d+$/.test(x) ? x : null);
  const optMap = {};                              // key -> 'bar' | 'menu' from the options
  for (const [list, where] of [[o.inBar, 'bar'], [o.inMenu, 'menu']]) {
    for (const x of list ?? []) {
      const k = toKey(x);
      if (!k) return `invalid control ${JSON.stringify(x)} (use ${Object.keys(NAMES).join(', ')} or "icon:N")`;
      if (optMap[k] && optMap[k] !== where) return `control ${JSON.stringify(x)} is in both inBar and inMenu`;
      optMap[k] = where;
    }
  }
  const id = JSON.stringify([VERSION, optMap, o.longPressMs, !!o.floatInTheater]);

  const prev = window.__sfuiFrameControls;
  if (prev?.version === VERSION && prev.id === id) return prev.check();

  const FS = window.FrameStore;
  if (!FS) return 'not patched: window.FrameStore missing';
  const mods = find.resolvePatch('webpackChunkvrwebui', sigs);
  if (typeof mods === 'string') return mods;
  const mx = mods.mobx.module;
  const P = mods.frame.exports.Frame.prototype;
  const actions = mods.actions.exports.store;
  const DOCK = mods.dock.exports.EDockLocation;
  const focus = mods.inputFocus.exports.store;
  const localize = mods.localize.exports.localize;
  if (typeof mx.runInAction !== 'function') return 'signature not found, dashboard left unpatched: mobx.runInAction';

  prev?.teardown?.();                             // other version or options: back to stock first

  // ---- state + log -------------------------------------------------------------------
  const store = window.__sfuiStore;               // injector's persistent store (absent: in-page only)
  let S = window.__sfuiFrameControlsState, restored = null;
  if (S?.schema !== 1) {
    const saved = store?.get(NAME);
    const ok = saved?.schema === 1 && saved.placement && typeof saved.placement === 'object';
    restored = ok ? 'file' : 'nothing';
    S = window.__sfuiFrameControlsState = { schema: 1, placement: ok ? { ...saved.placement } : {}, nixSeen: ok ? { ...saved.nixSeen } : {}, log: [] };
  }
  const logBuf = S.log ??= [];
  const log = find.logger(logBuf);
  if (restored) log('state restored', { from: restored, popup: S.placement });
  let unsaved = true;                             // last save not sent (no injector binding): retried by check()
  const save = () => {
    unsaved = !store?.set?.(NAME, { schema: 1, placement: { ...S.placement }, nixSeen: { ...S.nixSeen } });
  };
  for (const k of new Set([...Object.keys(optMap), ...Object.keys(S.nixSeen)])) {
    if (S.nixSeen[k] !== optMap[k] && k in S.placement) {
      log('option changed, popup choice dropped', { key: k, was: S.placement[k], option: optMap[k] ?? 'stock' });
      delete S.placement[k];
    }
  }
  S.nixSeen = { ...optMap };
  save();

  // Popup text in the dashboard's language (its own rule: the first of
  // navigator.languages it has a translation for, else English).
  const LANGS = ['en', 'de', 'fr', 'it', 'ko', 'es-419', 'es', 'zh-CN', 'zh-TW', 'ru', 'th', 'ja', 'pt', 'pl', 'da', 'nl',
    'fi', 'no', 'sv', 'hu', 'cs', 'ro', 'tr', 'pt-BR', 'bg', 'el', 'uk', 'vi'];
  const lang = (() => {
    for (const t of navigator.languages ?? []) {
      if (LANGS.includes(t)) return t;
      if (LANGS.includes(t.split('-')[0])) return t.split('-')[0];
    }
    return 'en';
  })();
  const TEXT_SHOW = { de: 'In der Leiste anzeigen' }[lang] ?? 'Show in bar';

  // ---- controls ----------------------------------------------------------------------
  const protoOf = (aid) => { try { return actions.GetAction(aid)?.protoForSteam; } catch { return undefined; } };
  // protoForSteam is a MobX computed, recomputed on every read outside a
  // reaction; during onSet each action's icon is read once (iconMemo).
  let iconMemo = null;
  const iconOf = (aid) => {
    if (iconMemo?.has(aid)) return iconMemo.get(aid);
    const p = protoOf(aid), e = p?.icon?.enum ?? p?.icon_active?.enum;
    iconMemo?.set(aid, e);
    return e;
  };
  const keyOf = (aid) => { const e = iconOf(aid); return e ? `icon:${e}` : null; };
  const isMore = (frame, it) => it?.action_id != null &&
    (it.action_id === frame.m_unControlAdditionalOptionsActionID || iconOf(it.action_id) === ICON.more);
  const movable = (frame, it) => it?.type === T_ACTION && it.action_id != null && !isMore(frame, it);
  const wanted = (key) => (key ? S.placement[key] ?? optMap[key] : undefined);   // 'bar' | 'menu' | undefined (stock)

  // Float in theater: stock shows "Float" (SetDockLocation(World)) only for
  // windows docked in the dashboard; a theater window gets an action of its
  // own (frame.CreateAction, destroyed with the frame) with the stock label,
  // icon and call, after "back to dashboard". Same key, so it follows Float's
  // placement.
  const floatActions = new Map();                 // frame -> action
  const withFloat = (frame, bottom) => {
    if (!o.floatInTheater || !Array.isArray(bottom) || frame.docking?.dockLocation !== DOCK.Theater) return bottom;
    if (bottom.some((it) => iconOf(it?.action_id) === ICON.float)) return bottom;
    let a = floatActions.get(frame);
    if (!a?.isAlive) {
      a = frame.CreateAction({ display_name: localize('#FloatInWorld'), icon: { enum: ICON.float }, invocation: 1 },
        () => frame.docking.SetDockLocation(DOCK.World));
      floatActions.set(frame, a);
    }
    const out = [...bottom];
    let at = out.findIndex((it) => iconOf(it?.action_id) === ICON.dashboard) + 1;
    if (at === 0) {
      at = Math.max(0, out.findIndex((it) => isMore(frame, it)));
      while (at > 0 && out[at - 1]?.type === T_SPACER) at--;
    }
    out.splice(at, 0, { type: T_ACTION, action_id: a.actionID });
    return out;
  };

  // Stock lists -> [bottom, additional] with the placements applied, or null
  // when nothing moves.
  const partition = (frame, bottom, add) => {
    if (!Array.isArray(bottom) || !Array.isArray(add)) return null;
    const toMenu = bottom.filter((it) => movable(frame, it) && wanted(keyOf(it.action_id)) === 'menu');
    const toBar = add.filter((it) => movable(frame, it) && wanted(keyOf(it.action_id)) === 'bar');
    if (!toMenu.length && !toBar.length) return null;
    const tokens = [], runLen = [];               // bar items; spacers tagged with their run
    let run = -1, inRun = false;
    for (const it of bottom) {
      if (it?.type === T_SPACER) {
        if (!inRun) { run++; runLen[run] = 0; inRun = true; }
        runLen[run]++;
        tokens.push({ it, run });
      } else {
        inRun = false;
        if (!toMenu.includes(it)) tokens.push({ it });
      }
    }
    if (toBar.length) {
      const ins = toBar.map((it) => ({ it }));
      const more = tokens.findIndex((t) => t.run == null && isMore(frame, t.it));
      let at = more;
      if (at >= 0) {                              // end of the group left of the three-dot button
        while (at > 0 && tokens[at - 1].run != null) at--;
        if (at === more) { runLen.push(1); ins.push({ it: { type: T_SPACER }, run: runLen.length - 1 }); }
      } else {                                    // no three-dot button: before the first wide gap
        at = tokens.findIndex((t) => t.run != null && runLen[t.run] >= 2);
        if (at < 0) at = tokens.length;
      }
      tokens.splice(at, 0, ...ins);
    }
    const outBar = [];
    for (let i = 0; i < tokens.length;) {
      if (tokens[i].run == null) { outBar.push(tokens[i++].it); continue; }
      const group = [];
      while (i < tokens.length && tokens[i].run != null) group.push(tokens[i++]);
      const runs = [...new Set(group.map((t) => t.run))];
      const keep = runs.reduce((a, b) => (runLen[b] > runLen[a] ? b : a));
      for (const t of group) if (runs.length === 1 || t.run === keep) outBar.push(t.it);
    }
    return [outBar, [...toMenu, ...add.filter((it) => !toBar.includes(it))]];
  };

  // SetControlsItems wrapper: one per page, version independent (looks the
  // current state up per call, inert once it is gone; found anywhere in the
  // chain, so a wrapper on top of it doesn't make us re-wrap). onSet returns
  // true when the resulting lists equal the frame's current ones, and the
  // wrapper then skips the stock setter: stock calls it once per control on
  // every re-render of a window's controls (~12 identical calls per window),
  // and each call replaces three MobX arrays, which re-renders the bar.
  const stock = new WeakMap();                    // frame -> [bottom, tab, additional] as passed by React
  const sameItem = (a, b) => {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
  };
  const sameList = (a, b) => Array.isArray(a) && b != null && typeof b.length === 'number' && a.length === b.length &&
    a.every((it, i) => sameItem(it, b[i]));
  const onSet = (frame, args) => {
    stock.set(frame, [args[0], args[1], args[2]]);
    iconMemo = new Map();
    try {
      const bottom = withFloat(frame, args[0]);
      const r = partition(frame, bottom, args[2]);
      if (r) [args[0], args[2]] = r;
      else args[0] = bottom;
    } finally { iconMemo = null; }
    return sameList(args[0], frame.m_rgControlsItems_BottomFrameControls) &&
      sameList(args[1], frame.m_rgControlsItems_TabHoverControls) &&
      sameList(args[2], frame.m_rgControlsItems_AdditionalOptions);
  };
  const findOurs = () => {
    for (let f = P.SetControlsItems, i = 0; f && i < 20; f = f.__sfuiOrig, i++) if (f.__sfuiPatch === NAME) return f;
    return null;
  };
  const install = () => {
    if (findOurs()) return;
    const orig = P.SetControlsItems;
    P.SetControlsItems = Object.assign(function SetControlsItems(...args) {
      const st = window.__sfuiFrameControls;
      if (st?.onSet) {
        try { if (st.onSet(this, args) === true) return undefined; } catch (e) { st.addLog?.('partition error', String(e)); }
      }
      return orig.apply(this, args);
    }, { __sfuiPatch: NAME, __sfuiOrig: orig, isMobxAction: orig.isMobxAction });
  };
  // Frames that existed before the patch: their current lists are stock.
  const captureExisting = () => {
    for (const f of FS.frames ?? []) {
      if (stock.has(f)) continue;
      const pl = (a) => (a ? Array.from(a) : []);
      stock.set(f, [pl(f.m_rgControlsItems_BottomFrameControls), pl(f.m_rgControlsItems_TabHoverControls), pl(f.m_rgControlsItems_AdditionalOptions)]);
    }
  };
  // Re-applies every frame's stock lists through the wrapper (or, useStock,
  // straight to the stock setter).
  const applyAll = (useStock = false) => {
    const set = useStock ? findOurs()?.__sfuiOrig ?? P.SetControlsItems : null;
    mx.runInAction(() => {
      for (const f of FS.frames ?? []) {
        const s = stock.get(f);
        if (!s) continue;
        try {
          if (useStock) set.call(f, s[0], s[1], s[2]);
          else f.SetControlsItems(s[0], s[1], s[2]);
          // A menu emptied by a move would pop open again once it gets an entry back.
          if (!f.m_rgControlsItems_AdditionalOptions?.length && f.m_bControlAdditionalOptionsOpen) f.SetControlAdditionalOptionsOpen(false);
        } catch (e) { log('apply error', { frame: f.frameID, e: String(e) }); }
      }
    });
  };
  const placeIn = (lists, aid) => (lists?.[0]?.some((it) => it?.action_id === aid) ? 'bar'
    : lists?.[1]?.some((it) => it?.action_id === aid) ? 'menu' : undefined);
  const stockPlace = (f, aid) => { const s = stock.get(f); return placeIn(s && [s[0], s[2]], aid); };
  const currentPlace = (f, aid) => placeIn([f.m_rgControlsItems_BottomFrameControls, f.m_rgControlsItems_AdditionalOptions], aid);
  const setPlacement = (key, where, why = 'api') => {   // where: 'bar' | 'menu' | null (option / stock)
    if (!key) return 'unknown control';
    if (where == null) delete S.placement[key];
    else S.placement[key] = where;
    save();
    log('placement', { key, name: NAME_OF[key], where: where ?? 'default', why });
    applyAll();
    return S.placement[key] ?? optMap[key] ?? 'stock';
  };

  // ---- popup -------------------------------------------------------------------------
  const STYLE_ID = 'sfui-frame-controls-style';
  const CSS = `
.sfui-fc-pop { display: block; width: max-content; box-sizing: border-box; background: var(--gamepadui-darkish-grey, #2d3239);
  border-radius: 10px; overflow: hidden; color: #fff; font-size: 24px; line-height: 1.2; text-align: left;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.55); }
.sfui-fc-own { display: inline-block; vertical-align: top; }
.sfui-fc-in-bar { margin: 10px 0 0 0; }
.sfui-fc-in-menu { margin: 0 0 10px 0; }
.sfui-fc-row { display: flex; flex-direction: row; align-items: center; gap: 16px; padding: 14px 24px 14px 20px;
  white-space: nowrap; cursor: pointer; }
.sfui-fc-row:hover { background: var(--gamepadui-dark-grey, #3d4450); }
.sfui-fc-row:active { background: var(--gamepadui-grey, #67707b); }
.sfui-fc-box { flex: none; position: relative; width: 1em; height: 1em; box-sizing: border-box;
  border: 2px solid currentColor; border-radius: 4px; }
.sfui-fc-box.sfui-on { background: #1a9fff; border-color: #1a9fff; }
.sfui-fc-box.sfui-on::after { content: ''; position: absolute; left: 30%; top: 6%; width: 28%; height: 56%;
  border: solid #fff; border-width: 0 3px 3px 0; transform: rotate(45deg); }
.sfui-fc-pressing { position: relative; }
`;
  const ensureStyle = () => find.ensureStyle(document, STYLE_ID, CSS);

  const PANEL_RE = /^legacy-frame-controls-(additional-options-)?(\d+)$/;
  // The control under an event target: { frame, actionId, where, button, panel } or null.
  const controlAt = (target) => {
    const button = target?.closest?.('.ButtonControl');
    const panel = button?.closest('vsg-node[id^="legacy-frame-controls-"]');
    const m = panel && PANEL_RE.exec(panel.id);
    if (!m) return null;
    const actionId = find.findFiberUp(button, (f) => f.memoizedProps?.control != null, 12)?.memoizedProps.control.action_id;
    const frame = FS.GetFrame(+m[2]);
    return actionId != null && frame ? { frame, actionId, where: m[1] ? 'menu' : 'bar', button, panel } : null;
  };

  let pop = null;   // { el, frame, actionId, panel, button, where, own, leaveTimer, off, menuCloseDeferred }
  const closePopup = (why) => {
    const p = pop;
    if (!p) return;
    pop = null;
    clearTimeout(p.leaveTimer);
    p.off();
    p.el.remove();
    try { p.own?.dispose(); } catch (e) { log('popup panel dispose failed', String(e)); }
    if (p.menuCloseDeferred) setTimeout(() => settleMenu(p.frame), 250);
    log('popup closed', { why });
  };

  // Keep the three-dot menu open while its popup is pointed at (see header).
  const GUARD = 'frame-controls-menu-guard';
  const origOpen = P.SetControlAdditionalOptionsOpen;
  const guardOpen = Object.assign(function SetControlAdditionalOptionsOpen(v, ...rest) {
    if (window.__sfuiFrameControls?.deferMenuClose?.(this, v)) return undefined;
    return guardOpen.__sfuiOrig.call(this, v, ...rest);
  }, { __sfuiPatch: GUARD, __sfuiOrig: origOpen, isMobxAction: origOpen.isMobxAction });
  const deferMenuClose = (frame, v) => {
    if (v !== false || !pop?.own || pop.where !== 'menu' || pop.frame !== frame) return false;
    if (!pop.menuCloseDeferred) log('menu close deferred while its popup is open', { frame: frame.frameID });
    pop.menuCloseDeferred = true;
    return true;
  };
  // After the popup closed: close the menu unless the laser is on the bar or menu.
  const settleMenu = (frame) => {
    if (pop?.frame === frame && pop.where === 'menu') return;
    let keep = false;
    try { keep = !!frame.inputFocus?.frameControlsHaveFocus || focus.BPanelHasFocus(frame.panels?.additionalOptionsPanelSGID); } catch { /* close */ }
    if (!keep) { try { origOpen.call(frame, false); } catch (e) { log('menu close failed', String(e)); } }
  };

  // The popup's own scene-graph panel (see header); null if SGApp or the
  // anchor isn't there.
  const mountOwnPanel = (hit, content) => {
    const { panel: base, button, frame } = hit;   // base: the bar or menu panel, whose look is copied
    const app = window.SGApp;
    const menu = hit.where === 'menu';
    const host = document.getElementById(`legacy-frame-controls-${frame.frameID}`)?.parentElement;
    const anchor = menu ? document.getElementById(`legacy-frame-controls-additional-options-anchor-${frame.frameID}`)
      : button.querySelector('vsg-node[vsg-type="panel-anchor"] vsg-transform[id]');
    if (typeof app?.addEmbeddedPanelUVs !== 'function' || typeof base.buildNode !== 'function' ||
        typeof VRHTML?.NextSGID !== 'function' || !anchor || !host) return null;
    const baseProps = (ctx) => base.buildNode(ctx, base)?.[1]?.properties ?? {};
    let translation = TOOLTIP_OFFSET;
    if (menu) {                                   // centred on the menu, GAP_PX above it
      const mpp = baseProps({ currentPanel: null, bInsideReparentedPanel: false, bShouldAbort: false })['meters-per-pixel'];
      const r = base.getBoundingClientRect();
      if (!(mpp > 0 && r.width > 0 && r.height > 0)) return null;
      const x = -MENU_LEFT_PX * mpp * (app.m_fCurrentScale ?? 1) + (r.width / 2) * mpp, y = 0.15 + (r.height + GAP_PX) * mpp;
      translation = `${x.toFixed(5)} ${y.toFixed(5)} 0.06`;
    }
    const outer = document.createElement('vsg-transform');
    for (const [k, v] of Object.entries({ 'parent-id': anchor.id, translation, rotation: '1 0 0 0', scale: '1 1 1', sgid: VRHTML.NextSGID() }))
      outer.setAttribute(k, String(v));
    const node = document.createElement('vsg-node');
    node.id = `sfui-fc-popup-${frame.frameID}`;
    node.className = 'sfui-fc-own';
    node.setAttribute('vsg-type', 'panel');
    const sgid = VRHTML.NextSGID();
    node.setAttribute('sgid', String(sgid));
    node.appendChild(content);
    outer.appendChild(node);
    const fp = {                                  // what SGApp's embedded-UV table reads of a panel
      props: { debug_name: node.id }, isExternal: false, m_Rect: { x: 0, y: 0, width: 0, height: 0 }, idx: undefined,
      getSGID: () => sgid, getEmbeddedIndex: () => fp.idx, getCurrentRootElement: () => node,
      updateLayoutValues() { const r = node.getBoundingClientRect(); fp.m_Rect = { x: r.x, y: r.y, width: r.width, height: r.height }; },
    };
    fp.idx = app.addEmbeddedPanelUVs(fp);
    if (fp.idx == null) return null;
    const KEEP = ['key', 'overlay_handle', 'meters-per-pixel', 'curvature-origin-id', 'reflect', 'lasermouse-filtering',
      'focus-outline', 'only-visible-with-laser', 'steam-input-appid', 'scale-index'];
    node.buildNode = (ctx) => {
      if (!base.isConnected || !anchor.isConnected) {   // bar / menu gone: drop the popup
        queueMicrotask(() => { if (pop?.own?.node === node) closePopup('panel gone'); });
        return [ctx, null];
      }
      const bp = baseProps(ctx), r = node.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight;
      const props = {};
      for (const k of KEEP) if (bp[k] !== undefined) props[k] = bp[k];
      Object.assign(props, {
        id: typeof bp.id === 'string' ? bp.id.replace(/[^:]*$/, node.id) : node.id, sgid, debug_name: node.id,
        origin: [0, -1], interactive: true, visibility: 0, 'sort-depth-bias': -1, 'can-take-keyboard-focus': false,
        'embedded-uv-index': fp.idx, uv_min: [r.x / W, r.y / H], uv_max: [(r.x + r.width) / W, (r.y + r.height) / H],
      });
      return [{ ...ctx, currentPanel: fp, bInsideReparentedPanel: false }, { type: 'panel', properties: props }];
    };
    host.after(outer);
    window.forceLayoutUpdate?.();
    return {
      node,
      dispose: () => { outer.remove(); app.removeEmbeddedPanelUVs(fp); window.forceLayoutUpdate?.(); },
    };
  };

  const openPopup = (hit) => {
    closePopup('reopen');
    const { frame, actionId, panel, button, where } = hit;
    const key = keyOf(actionId);
    if (!key) return;
    ensureStyle();
    const el = document.createElement('div');
    el.className = 'sfui-fc-pop';
    const row = document.createElement('div');
    row.className = 'sfui-fc-row';
    const box = document.createElement('span');
    box.className = `sfui-fc-box${currentPlace(frame, actionId) === 'bar' ? ' sfui-on' : ''}`;
    const label = document.createElement('span');
    label.textContent = TEXT_SHOW;
    row.append(box, label);
    el.append(row);
    for (const t of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu'])
      el.addEventListener(t, (e) => e.stopPropagation());   // nothing reaches the page's handlers
    row.addEventListener('click', () => {
      const now = currentPlace(frame, actionId), to = now === 'bar' ? 'menu' : 'bar';
      const dflt = optMap[key] ?? stockPlace(frame, actionId);
      closePopup('toggled');
      setPlacement(key, to === dflt ? null : to, `popup (${now} -> ${to})`);
    });
    const own = mountOwnPanel(hit, el);
    if (!own) {                                   // fallback: inside the bar (below) / menu (on top)
      log('no own popup panel', { where });
      el.classList.add(where === 'bar' ? 'sfui-fc-in-bar' : 'sfui-fc-in-menu');
      if (where === 'bar') {
        panel.appendChild(el);
        const pr = panel.getBoundingClientRect(), br = button.getBoundingClientRect(), w = el.getBoundingClientRect().width;
        el.style.marginLeft = `${Math.round(Math.max(0, Math.min(pr.width - w, br.left + br.width / 2 - pr.left - w / 2)))}px`;
      } else panel.insertBefore(el, panel.firstChild);
    }
    const p = pop = { el, frame, actionId, panel, button, where, own, leaveTimer: null, off: null, menuCloseDeferred: false };
    // Leaving the popup and its bar/menu for 1 s closes it.
    const onLeave = () => { clearTimeout(p.leaveTimer); p.leaveTimer = setTimeout(() => { if (pop === p) closePopup('laser left'); }, 1000); };
    const onEnter = () => clearTimeout(p.leaveTimer);
    const watched = own ? [panel, own.node] : [panel];
    for (const w of watched) { w.addEventListener('mouseleave', onLeave); w.addEventListener('mouseenter', onEnter); }
    p.off = () => { for (const w of watched) { w.removeEventListener('mouseleave', onLeave); w.removeEventListener('mouseenter', onEnter); } };
    log('popup opened', { frame: frame.frameID, key, name: NAME_OF[key], where, ownPanel: !!own });
  };

  // ---- long press --------------------------------------------------------------------
  const SVGNS = 'http://www.w3.org/2000/svg';
  const RING_DELAY = Math.min(1000, o.longPressMs / 2);
  const CURV_RING_THRESHOLD = 3;                  // x window-curvature's drag threshold once the ring shows
  const curvApi = () => window.__sfuiWindowCurvature;
  let press = null;                               // { hit, t0, timer, ringTimer, ring, done, curv }
  let swallow = null;                             // { until, button }: the click after a completed long press

  // Ring around the pressed control's icon (svg.Icon, or img.Icon for the
  // dock-to-controller rows), ~icon size, starting at the elapsed fraction;
  // essential styling inline, so it can't show unstyled.
  const showRing = (p) => {
    const btn = p.hit.button;
    if (!btn.isConnected) return null;
    const icon = btn.querySelector('.Icon');
    const br = btn.getBoundingClientRect(), ir = icon?.getBoundingClientRect();
    const ok = ir?.width > 0 && ir.height > 0;
    const size = Math.round(Math.min(48, Math.max(20, ok ? Math.max(ir.width, ir.height) : Math.min(br.height, 38))) + 20);
    const cx = ok ? ir.left - br.left + ir.width / 2 : br.height / 2 + 12;
    const cy = ok ? ir.top - br.top + ir.height / 2 : br.height / 2;
    const ring = document.createElementNS(SVGNS, 'svg');
    for (const [k, v] of Object.entries({ class: 'sfui-fc-ring', viewBox: '0 0 40 40', width: size, height: size })) ring.setAttribute(k, String(v));
    const circle = (stroke, extra = {}) => {
      const c = document.createElementNS(SVGNS, 'circle');
      for (const [k, v] of Object.entries({ cx: 20, cy: 20, r: 17, fill: 'none', stroke, 'stroke-width': 3.5, ...extra })) c.setAttribute(k, String(v));
      return c;
    };
    const fg = circle('#1a9fff', { pathLength: 100, 'stroke-dasharray': 100, 'stroke-linecap': 'round' });
    ring.append(circle('rgba(255,255,255,0.18)'), fg);
    const elapsed = performance.now() - p.t0;
    Object.assign(ring.style, {
      position: 'absolute', pointerEvents: 'none', overflow: 'visible', margin: '0', zIndex: '1', transform: 'rotate(-90deg)',
      width: `${size}px`, height: `${size}px`, left: `${Math.round(cx - size / 2)}px`, top: `${Math.round(cy - size / 2)}px`,
    });
    fg.style.strokeDashoffset = String(100 * (1 - Math.min(1, elapsed / o.longPressMs)));
    btn.appendChild(ring);
    ring.getBoundingClientRect();                 // start value applied, then animate the rest
    fg.style.transition = `stroke-dashoffset ${Math.round(Math.max(0, o.longPressMs - elapsed))}ms linear`;
    fg.style.strokeDashoffset = '0';
    return ring;
  };
  const endPress = (why) => {
    const p = press;
    if (!p) return;
    press = null;
    clearTimeout(p.timer); clearTimeout(p.ringTimer);
    p.ring?.remove();
    p.hit.button.classList.remove('sfui-fc-pressing');
    if (!p.done) log('long press cancelled', { why, ms: Math.round(performance.now() - p.t0) });
  };
  const completePress = () => {
    const p = press;
    if (!p?.hit.button.isConnected) { endPress('button gone'); return; }
    p.done = true;
    p.ring?.remove(); p.ring = null;
    if (p.curv) curvApi()?.cancelPress?.();
    openPopup(p.hit);
  };
  const onCurvDrag = () => { if (press && !press.done) endPress('curvature drag'); };

  const onEvent = (e) => {
    const t = e.type;
    if (t === 'click') {
      const w = swallow;
      if (w && e.button === 0 && performance.now() < w.until && w.button.contains(e.target)) {
        swallow = null;
        e.stopImmediatePropagation(); e.preventDefault();
      }
      return;
    }
    if (t === 'mousedown' || t === 'pointerdown') {
      if (pop && (!pop.el.contains(e.target) || !pop.button.isConnected)) closePopup('press outside');
      if (t !== 'mousedown' || e.button !== 0) return;
      swallow = null;
      endPress('new press');
      const hit = controlAt(e.target);
      if (!hit || !movable(hit.frame, { type: T_ACTION, action_id: hit.actionId })) return;   // three-dot: stock
      ensureStyle();
      const p = press = {
        hit, t0: performance.now(), done: false, ring: null, curv: hit.button.classList.contains('sfui-curv-ctl'),
        timer: setTimeout(completePress, o.longPressMs), ringTimer: null,
      };
      hit.button.classList.add('sfui-fc-pressing');   // positioning context for the ring
      p.ringTimer = setTimeout(() => {
        if (press !== p || p.done) return;
        if (p.curv) curvApi()?.scalePressDragThreshold?.(CURV_RING_THRESHOLD);   // drift keeps the hold, a drag still wins
        p.ring = showRing(p);
      }, RING_DELAY);
      return;
    }
    if (t === 'mouseup' && e.button === 0 && press) {
      const p = press;
      endPress(p.done ? 'released after long press' : 'released');
      if (p.done) swallow = { until: performance.now() + 1000, button: p.hit.button };
    }
  };
  const onKey = (e) => { if (pop && e.key === 'Escape') { e.stopPropagation(); closePopup('escape'); } };
  const EVENTS = ['mousedown', 'pointerdown', 'mouseup', 'click'];

  // ---- setup / teardown --------------------------------------------------------------
  const teardown = () => {
    endPress('teardown');
    closePopup('teardown');
    for (const t of EVENTS) window.removeEventListener(t, onEvent, true);
    window.removeEventListener('sfui-curv-dragstart', onCurvDrag);
    window.removeEventListener('keydown', onKey, true);
    if (P.SetControlAdditionalOptionsOpen === guardOpen) P.SetControlAdditionalOptionsOpen = origOpen;
    if (window.__sfuiFrameControls === state) delete window.__sfuiFrameControls;   // wrappers now inert
    applyAll(true);                               // stock lists back
    for (const a of floatActions.values()) { try { a.Destroy(); } catch { /* gone */ } }
    floatActions.clear();
    if (P.SetControlsItems?.__sfuiPatch === NAME) P.SetControlsItems = P.SetControlsItems.__sfuiOrig;
    document.getElementById(STYLE_ID)?.remove();
  };
  const check = () => {
    if (unsaved) save();
    if (findOurs()) return 'unchanged';
    install(); captureExisting(); applyAll();
    return 'patched (wrapper reinstalled)';
  };
  const effective = () => Object.fromEntries([...new Set([...Object.keys(optMap), ...Object.keys(S.placement)])]
    .map((k) => [NAME_OF[k] ?? k, S.placement[k] ? `${S.placement[k]} (popup)` : `${optMap[k]} (option)`]));
  const names = (list) => (list ?? []).map((it) => (it?.type === T_SPACER ? '|' : NAME_OF[keyOf(it?.action_id)] ?? keyOf(it?.action_id) ?? '?')).join(' ');
  const dump = () => (FS.frames ?? []).map((f) => ({
    frame: f.frameID, title: f.title, bar: names(f.m_rgControlsItems_BottomFrameControls), menu: names(f.m_rgControlsItems_AdditionalOptions),
    stockBar: names(stock.get(f)?.[0]), stockMenu: names(stock.get(f)?.[2]), menuOpen: f.isControlAdditionalOptionsOpen,
  }));
  const state = {
    version: VERSION, id, opts: o, log: logBuf, addLog: log, onSet, deferMenuClose, teardown, check, dump,
    placement: effective,
    setPlacement: (name, where) => setPlacement(toKey(name), where),
    reset: () => { S.placement = {}; save(); log('reset'); applyAll(); return 'reset'; },
  };

  window.__sfuiFrameControls = state;
  if (P.SetControlAdditionalOptionsOpen?.__sfuiPatch !== GUARD) P.SetControlAdditionalOptionsOpen = guardOpen;
  for (const t of EVENTS) window.addEventListener(t, onEvent, true);
  window.addEventListener('sfui-curv-dragstart', onCurvDrag);
  window.addEventListener('keydown', onKey, true);
  ensureStyle();
  install();
  captureExisting();
  applyAll();
  log('patched', { version: VERSION, options: optMap, popup: S.placement });
  const eff = Object.entries(effective());
  return `patched (long press ${o.longPressMs} ms${o.floatInTheater ? ', float in theater' : ''}` +
    `${eff.length ? `; ${eff.map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''})`;
})
