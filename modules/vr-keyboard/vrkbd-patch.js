// Injected into Steam's SharedJSContext (CEF, 127.0.0.1:8080) by vrkbd-helper.
// Extends Steam's VR keyboard for gamescope app windows:
//  - bottom row: Esc Ctrl Alt [space] AltGr and four separate arrow keys
//  - Ctrl/Alt chords and Esc are pressed for real (Steam can't: in VR
//    SteamClient.Input.ControllerKeyboardSetKeyState throws "Unknown method")
//  - while Ctrl/Alt is active and the keyboard is open, the real modifier is
//    held down, so e.g. Ctrl+scroll works
//  - characters Steam's own key emulation (ControllerKeyboardSendText) turns
//    into "1" -- anything non-ASCII or needing AltGr / a dead key on the X
//    keymap -- are typed by the helper instead
// Everything goes through the CDP binding window.__vrkbdKey("<op>:<arg>"),
// executed by vrkbd-helper with xdotool on :0.
// Idempotent: safe to evaluate repeatedly.
(() => {
  const VERSION = 5;
  const send = (msg) => window.__vrkbdKey && window.__vrkbdKey(msg);
  const wr = window.__vrkbdWr ||
    (webpackChunksteamui.push([[Symbol('vrkbd')], {}, (r) => { window.__vrkbdWr = r; }]), window.__vrkbdWr);
  const Layouts = wr(40222);                      // keyboard layouts (exports G$: enabled, r_: current)
  const VKM = wr(5363).PE;                        // VirtualKeyboardManager class
  const Status = wr(58508).qL;                    // .VRKeyboardStatus

  // ---- bottom row ------------------------------------------------------------
  // The keyboard window has a fixed height, so no extra row: Esc/Ctrl/Alt go
  // left of the space bar, and Steam's arrow keys become four separate keys
  // (stock layouts pair them as [Left, Up-when-shifted], [Right, Down-when-shifted]).
  // Key type "Half" for all added keys; the stylesheet below sets their width.
  const HALF = 2;
  const k = (key, label) => ({ key, label, type: HALF });
  const MODS = [k('VKX_Escape', 'Esc'), k('Control', 'Ctrl'), k('Alt', 'Alt')];
  const ARROWS = [Layouts.Md, Layouts.GO, Layouts.xl, Layouts.B6]   // Steam's ArrowLeft/Up/Down/Right
    .map((a) => ({ ...a, type: HALF }));
  const isArrow = (x) => (Array.isArray(x) ? x : [x]).some((y) => y && typeof y.key === 'string' && y.key.startsWith('Arrow'));
  const bottomRow = (row) => {
    const out = [];
    for (const x of row) {
      if (x === undefined || isArrow(x)) continue;
      if (x && x.key === ' ') out.push(...MODS);
      out.push(x);
    }
    out.splice(out.length - 1, 0, ...ARROWS);      // before Close/Done (last entry)
    return out;
  };
  let changed = false;
  const patchLayout = (l) => {
    if (!l || typeof l.rgLayout !== 'function' || l.rgLayout.__vrkbd === VERSION) return;
    changed = true;
    const orig = l.rgLayout.__vrkbdOrig || l.rgLayout;
    const f = (opts) => { const rows = orig(opts); return [...rows.slice(0, -1), bottomRow(rows[rows.length - 1])]; };
    f.__vrkbd = VERSION; f.__vrkbdOrig = orig;
    l.rgLayout = f;
  };
  for (const l of Layouts.G$() || []) patchLayout(l);
  patchLayout(Layouts.r_());

  // ---- text: characters Steam's key emulation can't produce --------------------
  // All keyboard text for gamescope windows ends up in
  // SteamClient.Input.ControllerKeyboardSendText (via several paths, incl. the
  // VR text override), which only maps plain ASCII on the base/shift levels;
  // everything else comes out as "1". Hook that one call and hand those
  // characters to the helper, in order; the rest passes through unchanged.
  if (VKM.prototype.DispatchKeypress.__vrkbdOrig) {   // undo the v4 hook
    VKM.prototype.DispatchKeypress = VKM.prototype.DispatchKeypress.__vrkbdOrig;
  }
  const viaHelper = (c) => c.codePointAt(0) > 127 || '|@{[]}\\~^`'.includes(c);
  const Input = SteamClient.Input;
  if (Input.ControllerKeyboardSendText.__vrkbd !== VERSION) {
    const orig = Input.ControllerKeyboardSendText.__vrkbdOrig || Input.ControllerKeyboardSendText;
    const patched = function (text, ...rest) {
      if (typeof text !== 'string') return orig.call(this, text, ...rest);
      let run = '';
      for (const c of text) {
        if (viaHelper(c)) {
          if (run) { orig.call(this, run, ...rest); run = ''; }
          send('type:' + c);
        } else run += c;
      }
      if (run) return orig.call(this, run, ...rest);
    };
    patched.__vrkbd = VERSION; patched.__vrkbdOrig = orig;
    Input.ControllerKeyboardSendText = patched;
  }

  // ---- key handling ----------------------------------------------------------
  const kbPopup = [...(g_PopupManager.GetPopups?.() || [])]
    .find((p) => p.window?.document.querySelector('[data-key]'));
  if (!kbPopup) return 'no keyboard popup yet';
  // Widen the added half keys and slim AltGr; the space bar is the only
  // flexible key, so it adjusts. Re-applied on every inject (the popup can be recreated).
  const doc = kbPopup.window.document;
  let style = doc.getElementById('vrkbd-style');
  if (!style) { style = doc.createElement('style'); style.id = 'vrkbd-style'; doc.head.appendChild(style); }
  style.textContent = ['VKX_Escape', 'Control', 'Alt', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight']
    .map((key) => `[data-key="${key}"]`).join(',') + '{ width: 43px !important; }'
    + '[data-key="AltGr"]{ width: 52px !important; }';
  const el = doc.querySelector('[data-key]');
  let f = el[Object.keys(el).find((x) => x.startsWith('__reactFiber'))];
  while (f && !(f.stateNode && f.stateNode.TypeKeyInternal)) f = f.return;
  const inst = f?.stateNode;
  if (!inst) return 'no keyboard component';
  window.__vrkbdInst = inst;
  let proto = Object.getPrototypeOf(inst);
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'TypeKeyInternal')) proto = Object.getPrototypeOf(proto);

  const active = (v) => (v & 7) !== 0;           // toggle state bits: 1 one-shot, 2 locked
  const release = (v) => { const z = v & 3; return (z === 1 ? 0 : z) | (v & 4); };
  const SYMS = {
    ' ': 'space', Backspace: 'BackSpace', Enter: 'Return', Tab: 'Tab',
    '.': 'period', ',': 'comma', '-': 'minus', '+': 'plus', '#': 'numbersign', '<': 'less',
    '/': 'slash', 'ß': 'ssharp', 'ü': 'udiaeresis', 'ö': 'odiaeresis', 'ä': 'adiaeresis',
    ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',   // only with Ctrl/Alt; plain arrows stay Steam's
  };
  const keysym = (key) => {
    if (key.startsWith('VKX_')) return key.slice(4);
    if (SYMS[key]) return SYMS[key];
    if (/^[a-zA-Z0-9]$/.test(key)) return key.toLowerCase();
    return null;
  };

  if (proto.TypeKeyInternal.__vrkbd !== VERSION) {
    const orig = proto.TypeKeyInternal.__vrkbdOrig || proto.TypeKeyInternal;
    const patched = function (st) {
      const key = st?.strKey;
      const ts = this.state?.toggleStates || {};
      const ctrl = active(ts.Control), alt = active(ts.Alt), shift = active(ts.Shift);
      const special = key?.startsWith('VKX_');
      const isToggle = key && ['Shift', 'CapsLock', 'Control', 'Alt', 'AltGr'].includes(key);
      if (key && !isToggle && (special || ctrl || alt)) {
        const sym = keysym(key);
        if (sym) {
          send('key:' + [ctrl && 'ctrl', alt && 'alt', shift && 'shift', sym].filter(Boolean).join('+'));
          this.setState((s) => ({ ...s, toggleStates: { ...s.toggleStates,
            Shift: release(s.toggleStates.Shift), Control: release(s.toggleStates.Control),
            Alt: release(s.toggleStates.Alt), AltGr: release(s.toggleStates.AltGr) } }));
          return;
        }
      }
      return orig.call(this, st);
    };
    patched.__vrkbd = VERSION; patched.__vrkbdOrig = orig;
    proto.TypeKeyInternal = patched;
    changed = true;
  }

  // ---- held modifiers ---------------------------------------------------------
  // Keep the real Ctrl/Alt pressed while the toggle is active and the keyboard is
  // open (for Ctrl+scroll etc.). One timer per Steam UI instance.
  if (!window.__vrkbdHoldTimer) {
    window.__vrkbdHeld = { ctrl: false, alt: false };
    window.__vrkbdHoldTimer = setInterval(() => {
      const i = window.__vrkbdInst;
      const ts = i?.state?.toggleStates || {};
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
  window.__vrkbdPatched = VERSION;
  return 'patched';
})()
