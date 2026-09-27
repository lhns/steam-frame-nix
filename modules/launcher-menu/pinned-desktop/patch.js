// pinned-desktop: in the VR dashboard's "+" menu (section
// #VRDashboard_LaunchNonSteamApp), "Desktop" (the nested Plasma session) is
// pinned above or below the scrolling program list instead of scrolling with
// it.
//
// This file is a function expression; launcher-menu.nix calls it with the
// options: (<this file>)({ position: "top" }) or ({ position: "bottom" }).
//
// DOM patch, evaluated in SharedJSContext (the bar popups share its realm):
// a timer attaches a MutationObserver to every dashboard bar popup document
// (g_PopupManager); whenever the menu renders, the stock Desktop item (found
// through its React fiber: list key == strExePath "steamos-nested-desktop")
// is hidden by CSS and a pinned block is inserted into the list container:
// "bottom" appends it after the scroll region (1px separator, then a clone of
// the item), "top" inserts it right before the scroll region, i.e. below the
// menu heading (clone, then separator). The clone keeps the item's classes,
// icon and CSS :hover; clicking it clicks the hidden stock item, so Steam's
// own handler runs (nav sound + SteamClient.Apps.LaunchNonSteamApp). The
// list container is a flex column with a max-height, so the scroll region
// shrinks to make room and the menu keeps its size.
// unpatch.js (or a new VERSION/position) calls __sfuiPinnedDesktop.stop(),
// which removes the pinned blocks, CSS, markers, observers and the timer.
((opts) => {
  const VERSION = 1;
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
  window.__sfuiDesktopFooter?.stop?.();          // predecessor of this patch
  if (!window.g_PopupManager) return 'g_PopupManager missing';

  const docs = new Map();                         // popup document -> MutationObserver
  const fiberOf = (el) => { const k = Object.keys(el).find((k) => k.startsWith('__reactFiber$')); return k && el[k]; };

  // The stock Desktop item: role=button element whose fiber ancestors include
  // the list entry keyed by the program's exe path.
  const isDesktop = (el) => {
    for (let f = fiberOf(el), i = 0; f && i < 12; f = f.return, i++)
      if (f.key != null) return f.key === KEY || String(f.key).endsWith('/' + KEY);
    return false;
  };
  // The list container (host div of the section component, which has a `header` prop).
  const listOf = (el) => {
    for (let f = fiberOf(el), i = 0; f && i < 60; f = f.return, i++) {
      if (f.memoizedProps && 'header' in f.memoizedProps && typeof f.type === 'function') {
        let c = f.child;
        while (c && typeof c.type !== 'string') c = c.child;
        return c?.stateNode ?? null;
      }
    }
    return null;
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
    if (!d.getElementById(STYLE_ID)) {
      const s = d.createElement('style');
      s.id = STYLE_ID; s.textContent = CSS;
      (d.head ?? d.documentElement).appendChild(s);
    }
    const obs = new MutationObserver(() => { try { update(d); } catch (e) { console.error('sfui pinned-desktop:', e); } });
    obs.observe(d.body, { childList: true, subtree: true, characterData: true });
    docs.set(d, obs);
    update(d);
  };

  const scan = () => {
    for (const [d, obs] of docs) if (!d.defaultView || d.defaultView.closed) { obs.disconnect(); docs.delete(d); }
    for (const p of g_PopupManager.GetPopups()) {
      if (!/barpopup/.test(p.m_strName ?? '')) continue;
      try { attach(p.window?.document); } catch (e) { console.error('sfui pinned-desktop:', e); }
    }
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
