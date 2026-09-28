// Injected into Steam's SharedJSContext (CEF, 127.0.0.1:8080) by helper.mjs.
// Extends Steam's VR keyboard for gamescope app windows:
//  - bottom row: Esc Ctrl Alt [space] AltGr ← ↑ ↓ → Close, stable with Shift
//    and AltGr; AltGr + arrows = Pos1/PgUp/PgDn/End
//  - AltGr + the key left of Backspace (German ´/`, empty on AltGr) = Delete
//    (Steam's "#Key_Delete" label, e.g. Entf), repeating while held
//  - Ctrl/Alt chords, Esc, the AltGr arrow keys and Shift+arrows are pressed
//    for real (Steam can't: in VR SteamClient.Input.ControllerKeyboardSetKeyState
//    throws "Unknown method")
//  - while Ctrl/Alt is active and the keyboard is open, the real modifier is
//    held down, so e.g. Ctrl+scroll works
//  - characters Steam's own key emulation (ControllerKeyboardSendText) turns
//    into "1" -- anything non-ASCII or needing AltGr / a dead key on the X
//    keymap -- are typed by the helper instead
//  - Enter types Return for app windows, even if a Steam search box had focus
//    before (Steam then labels it "Search" and closes the keyboard instead)
// Key output goes through the CDP binding window.__vrkbdKey("<op>:<arg>"),
// run by helper.mjs with xdotool on :0. Replaced functions keep their
// original as __vrkbdOrig; window.__vrkbdRefs etc. are for unpatch.js.
//
// mkPatch patch (see lib/default.nix); no options. On a signature mismatch
// it returns an error and changes nothing. Idempotent.
((find, sigs) => {
  const VERSION = 16;
  const send = (msg) => window.__vrkbdKey && window.__vrkbdKey(msg);
  let mods;
  try {
    mods = find.resolveAll(find.getWebpackRequire('webpackChunksteamui'), sigs);
  } catch (e) {
    return `signature not found, Steam left unpatched: ${e.message}`;
  }
  const Layouts = mods.layouts.exports;            // currentLayout(), enabledLayouts(), arrow keys
  const Status = mods.vrStatus.exports.holder;     // .VRKeyboardStatus
  const Manager = mods.keyboardManager.exports.VirtualKeyboardManager.prototype;
  // For unpatch.js, which runs without the finder library.
  window.__vrkbdRefs = { Manager, currentLayout: Layouts.currentLayout };
  let changed = false;
  const active = (v) => (v & 7) !== 0;           // toggle state bits: 1 one-shot, 2 locked, 4 held

  // Replace obj[name] with make(original), once per VERSION.
  const wrap = (obj, name, make) => {
    if (obj[name].__vrkbd === VERSION) return;
    const orig = obj[name].__vrkbdOrig || obj[name];
    const f = make(orig);
    f.__vrkbd = VERSION; f.__vrkbdOrig = orig;
    obj[name] = f;
    changed = true;
  };

  // ---- bottom row ------------------------------------------------------------
  // Fixed window height, so no extra row: Esc/Ctrl/Alt go left of the space
  // bar and the stock paired arrows ([Left, Up-shifted], [Right, Down-shifted])
  // become four keys. Entries are explicit [normal, shifted, altgr] triples:
  // without them Shift moves the close icon and AltGr yields empty
  // full-width keys. null shifted = same key, no shift label.
  const HALF = 2;                                  // key type "Half"; widths set by the stylesheet
  const k = (key, label) => ({ key, label, type: HALF });
  const same = (x) => [x, null, x];
  const MODS = [k('VKX_Escape', 'Esc'), k('Control', 'Ctrl'), k('Alt', 'Alt')];
  const ALTGR_ARROWS = [k('VKX_Home', 'Pos1'), k('VKX_Prior', 'Bild↑'), k('VKX_Next', 'Bild↓'), k('VKX_End', 'Ende')];
  const ARROWS = [Layouts.arrowLeft, Layouts.arrowUp, Layouts.arrowDown, Layouts.arrowRight]   // Steam's own keys
    .map((a, i) => [{ ...a, type: HALF }, null, ALTGR_ARROWS[i]]);
  const first = (x) => (Array.isArray(x) ? x.find((y) => y) : x);
  const isArrow = (x) => (Array.isArray(x) ? x : [x]).some((y) => y?.key?.startsWith?.('Arrow'));
  const bottomRow = (row) => {
    const out = [];
    for (const x of row) {
      const key = first(x);
      if (!key || isArrow(x)) continue;
      if (key.key === ' ') out.push(...MODS.map(same));
      out.push(same(key));
    }
    out.splice(out.length - 1, 0, ...ARROWS);      // before Close/Done (last entry)
    return out;
  };
  // ---- AltGr: Delete on the key left of Backspace --------------------------------
  // rgLayout is called while the keyboard component renders
  // (RenderStandardKeyboard, wrapped below to publish the instance as
  // window.__vrkbdRendering), so the rows follow its AltGr state. While AltGr
  // is active, the key left of Backspace becomes Delete if it has no AltGr
  // character (German ´/`, US =/+; Steam would draw it empty). Also while a
  // Delete hold repeats: its first Delete releases a one-shot AltGr, like any
  // key, but the held key stays until release. It gets Backspace's key type
  // (the dark special-key face and label style); the stylesheet gives it
  // back the replaced key's flexible width.
  const DEL = 'VKX_Delete';
  const delLabel = () => {                         // Steam's own: Entf, Suppr, Canc, Del; English "Delete" -> Del
    let l = null;
    try { l = window.LocalizationManager?.LocalizeString?.('#Key_Delete'); } catch { /* not loaded */ }
    return typeof l === 'string' && l && l.length <= 5 ? l : 'Del';
  };
  const freeOnAltGr = (x) => first(x)?.type == null && (Array.isArray(x) ? !x[2] : (typeof x === 'string' ? x : x?.key)?.length === 1);
  // Steam draws an [normal, shifted] entry as a bare empty key on AltGr,
  // dropping its key type: German ^ (a Half key) grows to a full key. Keep
  // its type with an empty AltGr entry.
  const keepSize = (x) => (Array.isArray(x) && x.length < 3 && first(x)?.type != null
    ? [x[0], x[1] ?? null, { key: '', label: '', type: first(x).type }] : x);
  // Without AltGr the free key shows a small Delete hint (stylesheet, like
  // the arrows' AltGr hints), enabled by the class vrkbd-del-hint on the
  // keyboard document while the current layout has such a key.
  const withDelete = (rows) => {
    const kb = window.__vrkbdRendering;
    if (!kb) return rows;
    const bsRow = rows.findIndex((row) => row.some((x) => !Array.isArray(x) && x?.key === 'Backspace'));
    const i = bsRow < 0 ? -1 : rows[bsRow].findIndex((x) => !Array.isArray(x) && x?.key === 'Backspace');
    const free = i >= 1 && freeOnAltGr(rows[bsRow][i - 1]);
    try { kb.m_keyboardDiv?.ownerDocument?.documentElement.classList.toggle('vrkbd-del-hint', free); } catch { /* no document */ }
    const altGr = active(kb.state?.toggleStates?.AltGr);
    if (!(altGr || kb.__vrkbdDelHold)) return rows;
    if (altGr) rows = rows.map((row) => row.map(keepSize));
    if (!free) return rows;
    const row = rows[bsRow];
    rows = [...rows];
    rows[bsRow] = [...row.slice(0, i - 1), { key: DEL, label: delLabel(), type: row[i].type }, ...row.slice(i)];
    return rows;
  };
  window.__vrkbdLayouts ??= new Set();             // for unpatch.js, incl. layouts disabled since
  for (const l of [...(Layouts.enabledLayouts() || []), Layouts.currentLayout()]) {
    if (typeof l?.rgLayout !== 'function') continue;
    window.__vrkbdLayouts.add(l);
    wrap(l, 'rgLayout', (orig) => (opts) => {
      const rows = withDelete(orig(opts));
      return [...rows.slice(0, -1), bottomRow(rows[rows.length - 1])];
    });
  }

  // ---- text: characters Steam's key emulation can't produce --------------------
  // All text for gamescope windows ends in ControllerKeyboardSendText, which
  // only maps plain ASCII on the base/shift levels (else "1"). Those
  // characters go to the helper, in order; the rest passes through.
  // (helper.mjs checks the same set.)
  const viaHelper = (c) => c.codePointAt(0) > 127 || '|@{[]}\\~^`'.includes(c);
  wrap(SteamClient.Input, 'ControllerKeyboardSendText', (orig) => function (text, ...rest) {
    if (typeof text !== 'string') return orig.call(this, text, ...rest);
    let run = '';
    for (const c of text) {
      if (viaHelper(c)) {
        if (run) { orig.call(this, run, ...rest); run = ''; }
        send('type:' + c);
      } else run += c;
    }
    if (run) return orig.call(this, run, ...rest);
  });

  // ---- Enter for app windows ------------------------------------------------------
  // The manager keeps the last focused Steam text field's props
  // (m_ActiveElementProps) until a gamepad blur, which leaving the dashboard
  // doesn't send. A search box's props (Enter label "Search", onEnterKeyPress
  // -> "VKClose") then make Enter search and hide the keyboard in app windows.
  // While the keyboard serves something other than this Steam UI (Steam's own
  // test, VirtualKeyboardManager module), ignore those props and the
  // dismiss-on-Enter flag.
  const forOther = (m) => {
    const s = Status.VRKeyboardStatus, ui = m.m_Instance;
    return !!s?.bIsOpen && !(s.sOverlayKey && s.sOverlayKey === ui?.GetVROverlayKey?.()) &&
      !(s.unAppID && s.unAppID === ui?.MainRunningAppID);
  };
  wrap(Manager, 'GetEnterKeyLabel', (orig) => function (...a) {
    return forOther(this) ? undefined : orig.apply(this, a);
  });
  wrap(Manager, 'HandleVirtualKeyDown', (orig) => function (key, ...rest) {
    if (key !== 'Enter' || !forOther(this)) return orig.call(this, key, ...rest);
    const props = this.m_ActiveElementProps, dismiss = this.m_bDismissOnEnter;
    this.m_ActiveElementProps = null; this.m_bDismissOnEnter = false;
    try { return orig.call(this, key, ...rest); } finally {
      if (this.m_ActiveElementProps === null) this.m_ActiveElementProps = props;
      if (this.m_bDismissOnEnter === false) this.m_bDismissOnEnter = dismiss;
    }
  });

  // ---- keyboard component -------------------------------------------------------
  const kbPopup = [...(g_PopupManager.GetPopups?.() || [])]
    .find((p) => p.window?.document.querySelector('[data-key]'));
  if (!kbPopup) return 'no keyboard popup yet';
  const doc = kbPopup.window.document;
  // The keyboard component: nearest fiber above a key whose instance has TypeKeyInternal.
  const inst = find.findFiberUp(doc.querySelector('[data-key]'),
    (f) => typeof f.stateNode?.TypeKeyInternal === 'function', 200)?.stateNode;
  if (!inst) return 'no keyboard component';
  let proto = Object.getPrototypeOf(inst);
  while (!Object.prototype.hasOwnProperty.call(proto, 'TypeKeyInternal')) proto = Object.getPrototypeOf(proto);
  window.__vrkbdInst = inst;                       // for the hold timer and unpatch.js
  window.__vrkbdProto = proto;
  const canDelete = typeof proto.RenderStandardKeyboard === 'function';
  if (canDelete) {
    wrap(proto, 'RenderStandardKeyboard', (orig) => function (...a) {
      const prev = window.__vrkbdRendering;
      window.__vrkbdRendering = this;
      try { return orig.apply(this, a); } finally { window.__vrkbdRendering = prev; }
    });
  }

  // Stylesheet, re-applied on every inject (the popup can be recreated). The
  // space bar is the only flexible key, so it absorbs the width changes.
  const sel = (keys, suffix = '') => keys.map((key) => `[data-key="${key}"]${suffix}`).join(',');
  const lastRow = Math.max(...[...doc.querySelectorAll('[data-key-row]')].map((e) => +e.getAttribute('data-key-row')));
  const added = [...MODS, ...ARROWS.map(first), ...ALTGR_ARROWS].map((x) => x.key);
  let style = doc.getElementById('vrkbd-style');
  if (!style) { style = doc.createElement('style'); style.id = 'vrkbd-style'; doc.head.appendChild(style); }
  style.textContent = [
    `${sel(added)} { width: 43px !important; }`,
    '[data-key="AltGr"] { width: 52px !important; }',
    // Steam draws the AltGr variant as a small secondary label: hide it in the
    // bottom row, except on the arrows, where it's the Pos1/Ende/Bild hint.
    `[data-key-row="${lastRow}"]:not([data-key^="Arrow"]) span ~ span { display: none !important; }`,
    // Arrow keys: smaller (still centered) icon and a small hint at the bottom edge.
    '[data-key^="Arrow"] span ~ span { font-size: 7px !important; top: auto !important; bottom: 3px !important; line-height: 1 !important; }',
    '[data-key^="Arrow"] span:first-child svg { height: 18px !important; }',
    `${sel(ALTGR_ARROWS.map((x) => x.key), ' span')} { font-size: 13px !important; }`,
    // Delete: Backspace's look, the replaced character key's size (Steam: width 0,
    // flex-grow 1), its label centred.
    `[data-key="${DEL}"] { width: 0 !important; flex-grow: 1 !important; }`,
    `[data-key="${DEL}"] > div { justify-content: center !important; text-align: center !important; }`,
    `[data-key="${DEL}"] > div > span { margin: 0 !important; }`,
    // Delete hint on the free key without AltGr: the arrow hints' size, on
    // the baseline of Steam's AltGr hints (e.g. } on 0: right/bottom 4px,
    // 9px, line-height normal; 1px more for 7px's shorter descent).
    `.vrkbd-del-hint [role="gridcell"]:has(+ [role="gridcell"] > [data-key="Backspace"]) > [data-key]:not([data-key="${DEL}"]) > div::after {` +
      ` content: ${JSON.stringify(delLabel())}; position: absolute; right: 4px; bottom: 5px; font-size: 7px; line-height: normal;` +
      ' opacity: 0.45; pointer-events: none; }',
  ].join('\n');

  // ---- key handling ----------------------------------------------------------
  const release = (v) => { const z = v & 3; return (z === 1 ? 0 : z) | (v & 4); };
  const TOGGLES = ['Shift', 'CapsLock', 'Control', 'Alt', 'AltGr'];
  const SYMS = {
    ' ': 'space', Backspace: 'BackSpace', Enter: 'Return', Tab: 'Tab',
    '.': 'period', ',': 'comma', '-': 'minus', '+': 'plus', '#': 'numbersign', '<': 'less',
    '/': 'slash', 'ß': 'ssharp', 'ü': 'udiaeresis', 'ö': 'odiaeresis', 'ä': 'adiaeresis',
    ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  };
  const keysym = (key) => {
    if (key.startsWith('VKX_')) return key.slice(4);
    if (SYMS[key]) return SYMS[key];
    if (/^[a-zA-Z0-9]$/.test(key)) return key.toLowerCase();
    return null;
  };
  wrap(proto, 'TypeKeyInternal', (orig) => function (st) {
    const key = st?.strKey;
    const ts = this.state?.toggleStates || {};
    const ctrl = active(ts.Control), alt = active(ts.Alt), shift = active(ts.Shift);
    // Extra keys always; Shift+arrow too (Steam's own arrow path drops Shift).
    const special = key?.startsWith('VKX_') || (shift && key?.startsWith('Arrow'));
    const sym = key && !TOGGLES.includes(key) && (special || ctrl || alt) && keysym(key);
    if (!sym) return orig.call(this, st);
    send('key:' + [ctrl && 'ctrl', alt && 'alt', shift && 'shift', sym].filter(Boolean).join('+'));
    this.setState((s) => ({ ...s, toggleStates: { ...s.toggleStates,
      Shift: release(s.toggleStates.Shift), Control: release(s.toggleStates.Control),
      Alt: release(s.toggleStates.Alt), AltGr: release(s.toggleStates.AltGr) } }));
  });

  // ---- Delete repeat -----------------------------------------------------------
  // Steam repeats only data-key "Backspace" on a long press (and types other
  // keys once at release). Like it: after s_longPressThreshold of holding
  // Delete, take the press over (Steam's own touch-end cleanup: no key at
  // release, no long press) and type Delete every s_longPressRepeatThreshold
  // until release. Passive capture listeners, one set per keyboard window.
  const win = kbPopup.window;
  if (canDelete && win.__vrkbdDelRepeat !== VERSION) {
    win.__vrkbdDelDetach?.();
    let hold = null;                               // { inst, el, target, timer, taken }
    const stop = () => {
      if (!hold) return;
      const h = hold;
      hold = null;
      clearTimeout(h.timer);
      if (h.inst.__vrkbdDelHold) { h.inst.__vrkbdDelHold = false; h.inst.forceUpdate(); }
    };
    const start = (target, el) => {
      const kb = find.findFiberUp(el, (f) => typeof f.stateNode?.TypeKeyInternal === 'function', 200)?.stateNode;
      if (!kb) return;
      const C = kb.constructor;
      const delay = C.s_longPressThreshold ?? 450, repeat = C.s_longPressRepeatThreshold ?? 200;
      const h = hold = { inst: kb, el, target, timer: 0, taken: false };
      const tick = (ms) => {
        h.timer = setTimeout(() => {
          if (hold !== h) return;
          if (!el.isConnected || el.getAttribute('data-key') !== DEL || !Status.VRKeyboardStatus?.bIsOpen) { stop(); return; }
          if (!h.taken) {
            h.taken = true;
            kb.__vrkbdDelHold = true;              // keeps the key after a one-shot AltGr is released
            try {
              for (const t of [...kb.m_mapTouched]) if (el.contains(t)) kb.m_mapTouched.delete(t);
              kb.CancelLongPressTimer(); kb.DismissLongPress(); kb.ClearHoldTarget();
            } catch { /* Steam changed: at worst one more Delete at release */ }
          }
          kb.TypeKeyInternal({ strKey: DEL });
          tick(repeat);
        }, ms);
      };
      tick(delay - 10);                            // just before Steam's own long-press timer
    };
    const keyEl = (t) => t?.closest?.('[data-key]');
    const onDown = (e) => {
      stop();
      const t = e.type === 'touchstart' ? (e.touches.length === 1 ? e.changedTouches[0]?.target : null) : (e.button === 0 ? e.target : null);
      const el = keyEl(t);
      if (el?.getAttribute('data-key') === DEL) start(t, el);
    };
    const onUp = (e) => {
      if (!hold) return;
      if (e.type.startsWith('touch') && ![...e.changedTouches].some((t) => t.target === hold.target)) return;
      stop();
    };
    const L = { capture: true, passive: true };
    const types = [['touchstart', onDown], ['mousedown', onDown], ['touchend', onUp], ['touchcancel', onUp], ['mouseup', onUp]];
    for (const [type, f] of types) win.addEventListener(type, f, L);
    win.__vrkbdDelDetach = () => {
      stop();
      for (const [type, f] of types) win.removeEventListener(type, f, L);
      delete win.__vrkbdDelDetach; delete win.__vrkbdDelRepeat;
    };
    win.__vrkbdDelRepeat = VERSION;                // __vrkbdDelDetach: for unpatch.js
  }

  // ---- held modifiers ---------------------------------------------------------
  // Keep the real Ctrl/Alt pressed while the toggle is active and the keyboard is
  // open (for Ctrl+scroll etc.). One timer per Steam UI instance.
  if (!window.__vrkbdHoldTimer) {
    window.__vrkbdHeld = { ctrl: false, alt: false };
    window.__vrkbdHoldTimer = setInterval(() => {
      const ts = window.__vrkbdInst?.state?.toggleStates || {};
      const open = !!Status.VRKeyboardStatus?.bIsOpen;
      for (const [mod, state] of [['ctrl', ts.Control], ['alt', ts.Alt]]) {
        const want = open && active(state);
        if (want !== window.__vrkbdHeld[mod]) {
          window.__vrkbdHeld[mod] = want;
          send((want ? 'down:' : 'up:') + mod);
        }
      }
    }, 250);
  }

  // Re-render with the new row (only when something changed or it's a new instance).
  if (changed || inst.__vrkbd !== VERSION) {
    inst.__vrkbd = VERSION;
    inst.setState({ standardLayout: Layouts.currentLayout() });
    inst.forceUpdate();
  }
  return 'patched';
})
