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
// Everything goes through the CDP binding window.__vrkbdKey("<op>:<arg>"),
// executed by helper.mjs with xdotool on :0. Every replaced function keeps its
// original as __vrkbdOrig (unpatch.js restores them).
// Idempotent: safe to evaluate repeatedly.
(() => {
  const VERSION = 9;
  const send = (msg) => window.__vrkbdKey && window.__vrkbdKey(msg);
  const wr = window.__vrkbdWr ||
    (webpackChunksteamui.push([[Symbol('vrkbd')], {}, (r) => { window.__vrkbdWr = r; }]), window.__vrkbdWr);
  const Layouts = wr(40222);                      // keyboard layouts (exports G$: enabled, r_: current)
  const Status = wr(58508).qL;                    // .VRKeyboardStatus
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
  // The keyboard window has a fixed height, so no extra row: Esc/Ctrl/Alt go
  // left of the space bar, and Steam's arrow keys become four separate keys
  // (stock layouts pair them as [Left, Up-when-shifted], [Right, Down-when-shifted]).
  // Every entry is a [normal, shifted, altgr] triple: Steam's stock bottom row
  // lacks explicit variants, so with Shift the close icon jumps and with AltGr
  // keys turn into empty full-width panels. null as the shifted variant means
  // "same key, no shift label".
  const HALF = 2;                                  // key type "Half"; widths set by the stylesheet
  const k = (key, label) => ({ key, label, type: HALF });
  const same = (x) => [x, null, x];
  const MODS = [k('VKX_Escape', 'Esc'), k('Control', 'Ctrl'), k('Alt', 'Alt')];
  const ALTGR_ARROWS = [k('VKX_Home', 'Pos1'), k('VKX_Prior', 'Bild↑'), k('VKX_Next', 'Bild↓'), k('VKX_End', 'Ende')];
  const ARROWS = [Layouts.Md, Layouts.GO, Layouts.xl, Layouts.B6]   // Steam's ArrowLeft/Up/Down/Right keys
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
  for (const l of [...(Layouts.G$() || []), Layouts.r_()]) {
    if (typeof l?.rgLayout !== 'function') continue;
    window.__vrkbdLayouts.add(l);
    wrap(l, 'rgLayout', (orig) => (opts) => {
      const rows = orig(opts);
      return [...rows.slice(0, -1), bottomRow(rows[rows.length - 1])];
    });
  }

  // ---- text: characters Steam's key emulation can't produce --------------------
  // All keyboard text for gamescope windows ends up in
  // SteamClient.Input.ControllerKeyboardSendText (via several paths, incl. the
  // VR text override), which only maps plain ASCII on the base/shift levels;
  // everything else comes out as "1". Hand those characters to the helper, in
  // order; the rest passes through unchanged. (helper.mjs checks the same set.)
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
  // The manager keeps the props of the last focused Steam text field
  // (m_ActiveElementProps, set on DOM focus) until that field gets a gamepad
  // blur, which doesn't happen when you leave the dashboard. Search boxes
  // carry strEnterKeyLabel "#SearchEnterKeyLabel" ("Suchen") and an
  // onEnterKeyPress returning "VKClose", so when the keyboard is then opened
  // for an app window, Enter shows "Suchen", runs the Steam search and hides
  // the keyboard instead of typing Return. While the keyboard serves
  // something other than this Steam UI (Steam's own test, L() in module
  // 5363), ignore those props and the dismiss-on-Enter flag.
  const Manager = wr(5363).PE.prototype;
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
  const el = doc.querySelector('[data-key]');
  let fiber = el[Object.keys(el).find((x) => x.startsWith('__reactFiber'))];
  while (fiber && !fiber.stateNode?.TypeKeyInternal) fiber = fiber.return;
  const inst = fiber?.stateNode;
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
    inst.setState({ standardLayout: Layouts.r_() });
    inst.forceUpdate();
  }
  return 'patched';
})()
