// pinned-desktop: pins "Desktop" (the nested Plasma session) above or below
// the scrolling list of the VR dashboard's "+" menu.
// mkPatch patch (see lib/default.nix); opts: { position: "top" | "bottom" }.
//
// DOM patch in SharedJSContext: a timer attaches a MutationObserver to every
// bar popup document (g_PopupManager). The stock Desktop item (fiber list key
// == strExePath "steamos-nested-desktop") is hidden by CSS and a clone plus a
// 1 px separator is inserted before ("top") or after ("bottom") the scroll
// region. Clicking the clone clicks the hidden item, so Steam's own handler
// runs. The list container is a flex column with a max-height, so the scroll
// region shrinks and the menu keeps its size.
// Anchors: "launcher-menu-pinned-desktop" in lib/signatures.json.
// unpatch.js (or a new VERSION/position) calls __sfuiPinnedDesktop.stop().
((find, sigs, opts) => {
  const NAME = 'launcher-menu-pinned-desktop';
  const VERSION = 4;
  const POS = opts.position === 'top' ? 'top' : 'bottom';
  const KEY = 'steamos-nested-desktop';
  const HIDDEN = 'data-sfui-desktop-hidden';
  const PIN = 'sfui-pinned-desktop';
  const STYLE_ID = 'sfui-pinned-desktop-style';
  const CSS = `
[${HIDDEN}] { display: none !important; }
.${PIN} { flex: 0 0 auto; }
.${PIN} > .${PIN}-sep { height: 1px; background: rgba(255, 255, 255, 0.1); }
.${PIN} > [role=button]::after { display: none !important; }`;

  const prev = window.__sfuiPinnedDesktop;
  if (prev?.version === VERSION && prev.position === POS) { prev.scan(); return 'unchanged'; }
  prev?.stop?.();
  if (!window.g_PopupManager) return 'g_PopupManager missing';

  const docs = new Map();                         // popup document -> MutationObserver
  const guard = (f) => (...a) => { try { f(...a); } catch (e) { console.error(`sfui ${NAME}:`, e); } };
  // The stock Desktop item: role=button element whose fiber ancestors include
  // the list entry keyed by the program's exe path.
  const isDesktop = (el) => {
    const f = find.findFiberUp(el, (x) => x.key != null, 12);
    return !!f && (f.key === KEY || String(f.key).endsWith('/' + KEY));
  };
  // The list container (host div of the section component, which has a `header` prop).
  const listOf = (el) => {
    const f = find.findFiberUp(el, (x) => x.memoizedProps && typeof x.memoizedProps === 'object' &&
      'header' in x.memoizedProps && typeof x.type === 'function', 60);
    let c = f?.child;
    while (c && typeof c.type !== 'string') c = c.child;
    return c?.stateNode ?? null;
  };
  // Child of the list container that holds the (scrolling) items.
  const scrollerOf = (orig, list) => {
    let el = orig;
    while (el && el.parentElement !== list) el = el.parentElement;
    return el;
  };

  const buildPin = (d, orig) => {
    const w = d.defaultView;
    const pin = d.createElement('div');
    pin.className = PIN;
    const panel = orig.parentElement;           // scroll panel: copy its side padding
    const cs = w.getComputedStyle(panel);
    pin.style.paddingLeft = cs.paddingLeft;
    pin.style.paddingRight = cs.paddingRight;
    if (POS === 'top') pin.style.paddingTop = cs.paddingTop;
    else pin.style.paddingBottom = cs.paddingBottom;
    const margin = cs.getPropertyValue('--field-negative-horizontal-margin');
    if (margin) pin.style.setProperty('--field-negative-horizontal-margin', margin);
    const sep = d.createElement('div');
    sep.className = `${PIN}-sep`;
    const item = orig.cloneNode(true);
    item.removeAttribute(HIDDEN);
    item.classList.remove('gpfocus', 'gpfocuswithin');
    item.addEventListener('click', (e) => {
      // Not to React's root listener (the clone has no fiber); the stock item
      // gets its own click instead.
      e.stopPropagation();
      e.preventDefault();
      if (orig.isConnected) orig.click();
    });
    if (POS === 'top') pin.append(item, sep); else pin.append(sep, item);
    pin.__sfuiOrig = orig;
    pin.__sfuiLabel = orig.textContent;
    return pin;
  };

  const update = (d) => {
    const pins = [...d.getElementsByClassName(PIN)];
    const hidden = d.querySelector(`[${HIDDEN}]`);
    let orig = hidden?.isConnected && isDesktop(hidden) ? hidden : null;
    if (!orig) {
      for (const el of d.querySelectorAll('[role=button]'))
        if (!el.closest('.' + PIN) && isDesktop(el)) { orig = el; break; }
    }
    for (const el of d.querySelectorAll(`[${HIDDEN}]`)) if (el !== orig) el.removeAttribute(HIDDEN);
    const list = orig && listOf(orig);
    const scroller = list && scrollerOf(orig, list);
    const placed = (p) => POS === 'top' ? p.nextElementSibling === scroller : list.lastElementChild === p;
    const ok = (p) => p.__sfuiOrig === orig && p.parentElement === list && placed(p) &&
      p.__sfuiLabel === orig.textContent;
    let keep = null;
    for (const p of pins) if (!scroller || keep || !ok(p)) p.remove(); else keep = p;
    if (!scroller) return;
    if (!orig.hasAttribute(HIDDEN)) orig.setAttribute(HIDDEN, '');
    if (!keep) {
      const pin = buildPin(d, orig);
      if (POS === 'top') list.insertBefore(pin, scroller); else list.appendChild(pin);
    }
  };

  const attach = (d) => {
    if (docs.has(d) || !d?.body) return;
    find.ensureStyle(d, STYLE_ID, CSS);
    const obs = new MutationObserver(guard(() => update(d)));
    obs.observe(d.body, { childList: true, subtree: true, characterData: true });
    docs.set(d, obs);
    update(d);
  };

  const scan = () => {
    for (const [d, obs] of docs) if (!d.defaultView || d.defaultView.closed) { obs.disconnect(); docs.delete(d); }
    for (const p of g_PopupManager.GetPopups())
      if (/barpopup/.test(p.m_strName ?? '')) guard(() => attach(p.window?.document))();
  };

  const timer = setInterval(scan, 1000);
  const stop = () => {
    clearInterval(timer);
    for (const [d, obs] of docs) {
      obs.disconnect();
      try {
        for (const p of [...d.getElementsByClassName(PIN)]) p.remove();
        for (const el of d.querySelectorAll(`[${HIDDEN}]`)) el.removeAttribute(HIDDEN);
        d.getElementById(STYLE_ID)?.remove();
      } catch {}
    }
    docs.clear();
    if (window.__sfuiPinnedDesktop === state) delete window.__sfuiPinnedDesktop;
  };
  const state = { version: VERSION, position: POS, scan, stop, docs };
  window.__sfuiPinnedDesktop = state;
  scan();
  return `patched (${POS})`;
})
