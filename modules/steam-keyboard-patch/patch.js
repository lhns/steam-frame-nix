// Injected into Steam's SharedJSContext (CEF, 127.0.0.1:8080) by helper.mjs.
// Extends Steam's VR keyboard for gamescope app windows:
//  - bottom row: Esc Ctrl Alt [space] AltGr ← ↑ ↓ → Close, stable with Shift
//    and AltGr; AltGr + arrows = Pos1/PgUp/PgDn/End
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
  const VERSION = 10;
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
  window.__vrkbdLayouts ??= new Set();             // for unpatch.js, incl. layouts disabled since
  for (const l of [...(Layouts.enabledLayouts() || []), Layouts.currentLayout()]) {
    if (typeof l?.rgLayout !== 'function') continue;
    window.__vrkbdLayouts.add(l);
    wrap(l, 'rgLayout', (orig) => (opts) => {
      const rows = orig(opts);
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
  ].join('\n');

  // ---- key handling ----------------------------------------------------------
  const active = (v) => (v & 7) !== 0;           // toggle state bits: 1 one-shot, 2 locked
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
