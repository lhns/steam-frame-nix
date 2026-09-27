// grid: shows the programs of the VR dashboard's "+" menu (section
// #VRDashboard_LaunchNonSteamApp) as a grid of tiles: large icon, name
// centred below (up to 2 lines).
//
// This file is a function expression, called by the file lib/default.nix
// (mkPatch) generates: (<this file>)(find, sigs, opts), with find the finder
// library (lib/finders.js) and opts { columns: 4, maxRows: 4 } from
// launcher-menu.nix (maxRows null: the list fills up to the menu's stock
// 600 px max height).
//
// Pure restyling, evaluated in SharedJSContext (the bar popups share its
// realm): Steam's own items (with their onActivate, focus handling and
// sounds) stay where they are, so launching and the other launcher-menu
// patches keep working unchanged. A timer attaches a MutationObserver to
// every dashboard bar popup document (g_PopupManager); whenever the menu
// renders, the programs section is found through React fibers (the section
// component, which has a `header` prop, keyed "programs"; the "windows"
// section, "add desktop window", stays a list) and its elements get
// data-sfui-grid="<role>" markers, which a stylesheet in that document turns
// into:
// - list:     the section (flex column: heading + scroll region) is as wide
//             as the popup window (100vw, a fixed 300 px);
// - panel:    the item container becomes a CSS grid of N columns; it still
//             scrolls inside the stock scroll region, so the heading stays;
// - tile internals (wrap, label, iconbox, icon, labelbox, marquee, text)
//             are laid out as a column;
// - scroller: the stock scroll region. With maxRows, its max-height (CSS
//             variable) is set to the bottom of row maxRows, measured at
//             layout time (labels have 1 or 2 lines), so the menu shrinks to
//             that many rows and the rest scrolls;
// - fade:     the element with Steam's ScrollFade class. Steam computes its
//             ScrolledToTop/ScrolledToBottom state only on React renders and
//             scroll events, so it is stale once the grid changes the layout
//             (e.g. a bottom fade although nothing overflows). The state is
//             recomputed (same thresholds) on scroll, resize and mutation and
//             put in data-sfui-fade (none/top/bottom/both), which selects the
//             same gradients as Steam's stylesheet (var(--scroll-fade-size)).
// Steam's gamepad navigation derives a panel's layout from its computed
// style (display: grid), so up/down/left/right move between tiles.
// With the pinned-desktop patch, its pinned row (.sfui-pinned-desktop,
// outside the grid) is made slim and its content centred.
// Anchors (section keys, `header` prop, ScrollFade classes and gradients)
// are checked by scripts/check-signatures.mjs ("launcher-menu-grid" in
// lib/signatures.json).
// unpatch.js (or a new VERSION or options) calls __sfuiLauncherGrid.stop(),
// which removes markers, stylesheets, observers and the timer.
((find, sigs, opts) => {
  const NAME = 'launcher-menu-grid';
  const VERSION = 4;
  const COLS = opts.columns;
  const ROWS = opts.maxRows ?? null;
  if (!(Number.isInteger(COLS) && COLS >= 1) || !(ROWS === null || (Number.isInteger(ROWS) && ROWS >= 1)))
    return `invalid options ${JSON.stringify(opts)}`;
  const ID = `${VERSION}:${COLS}:${ROWS}`;
  const SECTION_KEY = 'programs';
  const ATTR = 'data-sfui-grid';
  const FADE = 'data-sfui-fade';
  const MAXH = '--sfui-grid-max-height';
  const STYLE_ID = 'sfui-launcher-grid-style';
  const PIN = 'sfui-pinned-desktop';              // pinned-desktop patch's block
  const TILE = `[${ATTR}=panel] > [role=button]`;
  const PINNED = `[${ATTR}=list] > .${PIN}`;
  const gradient = (stops) => `linear-gradient(to bottom, ${stops}) !important`;
  const CSS = `
[${ATTR}=list] { width: 100vw !important; }
[${ATTR}=panel] {
  display: grid !important;
  grid-template-columns: repeat(${COLS}, minmax(0, 1fr));
  grid-auto-rows: max-content;
  align-content: start;
  gap: 4px;
  width: auto !important;
  padding: 8px !important;
  box-sizing: border-box;
}
[${ATTR}=scroller] { max-height: var(${MAXH}, none) !important; }
[${FADE}=none] { mask-image: none !important; }
[${FADE}=top] { mask-image: ${gradient('transparent 0%, black var(--scroll-fade-size), black 100%')}; }
[${FADE}=bottom] { mask-image: ${gradient('black 0%, black calc(100% - var(--scroll-fade-size)), transparent 100%')}; }
[${FADE}=both] { mask-image: ${gradient('transparent 0%, black var(--scroll-fade-size), black calc(100% - var(--scroll-fade-size)), transparent 100%')}; }
${TILE} {
  margin: 0 !important;
  padding: 8px 4px 6px !important;
  min-width: 0;
  border-radius: 6px;
  transform-origin: 50% 50%;
  container-type: inline-size;
}
${TILE}::after { display: none !important; }
${TILE} [${ATTR}=wrap] { width: 100%; min-width: 0; align-self: flex-start !important; justify-content: center !important; }
${TILE} [${ATTR}=label] { flex-direction: column !important; align-items: center !important; gap: 6px; width: 100%; min-width: 0; }
${TILE} [${ATTR}=iconbox] { padding: 0 !important; }
${TILE} [${ATTR}=icon] { width: clamp(20px, 50cqi, 64px) !important; height: clamp(20px, 50cqi, 64px) !important; }
${TILE} [${ATTR}=icon] > img, ${TILE} [${ATTR}=icon] > svg { width: 100% !important; height: 100% !important; max-width: none !important; object-fit: contain; }
${TILE} [${ATTR}=labelbox] { width: 100%; min-width: 0; }
${TILE} [${ATTR}=marquee] { justify-content: center; mask-image: none !important; animation: none !important; }
${TILE} [${ATTR}=text] {
  display: -webkit-box !important;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  flex: 0 1 auto !important;
  max-width: 100%;
  overflow: hidden;
  white-space: normal;
  word-break: break-word;
  text-align: center;
  font-size: 13px;
  line-height: 16px;
  padding: 0 !important;
  animation: none !important;
  transform: none !important;
}
${PINNED} { padding: 2px 20px !important; --field-negative-horizontal-margin: 20px !important; }
${PINNED} > [role=button] { padding-top: 7px !important; padding-bottom: 7px !important; }
${PINNED} > [role=button], ${PINNED} > [role=button] * { justify-content: center !important; }
${PINNED} > [role=button] * { flex-grow: 0 !important; text-align: center !important; }`;

  const prev = window.__sfuiLauncherGrid;
  if (prev?.id === ID) { prev.scan(); return 'unchanged'; }
  prev?.stop?.();
  if (!window.g_PopupManager) return 'g_PopupManager missing';

  const docs = new Map();                         // popup document -> { obs, ro }
  const regions = new Map();                      // scroller -> { d, list, panel, fade, onScroll }
  const guard = (f) => (...a) => { try { f(...a); } catch (e) { console.error(`sfui ${NAME}:`, e); } };
  const mark = (el, role) => { if (el && el.getAttribute(ATTR) !== role) el.setAttribute(ATTR, role); };
  // Menu items are leaf buttons (the scroll region is a role=button too).
  const isItem = (el) => el.getAttribute('role') === 'button' && !el.querySelector('[role=button]');
  const tilesOf = (panel) => [...panel.children].filter(isItem);
  const regionsOf = (d) => [...regions].filter(([, r]) => r.d === d).map(([sc]) => sc);
  const px = (x) => parseFloat(x) || 0;

  // Section of an item: the nearest fiber ancestor that is a function
  // component with a `header` prop; its key names the section, its first
  // host descendant is the list container.
  const sectionOf = (item) => {
    const f = find.findFiberUp(item, (x) => typeof x.type === 'function' &&
      x.memoizedProps && typeof x.memoizedProps === 'object' && 'header' in x.memoizedProps, 60);
    if (!f) return null;
    let c = f.child;
    while (c && typeof c.type !== 'string') c = c.child;
    return { key: f.key, list: c?.stateNode ?? null };
  };

  // Stock scroll region: nearest ancestor of the panel, below the list, that
  // scrolls vertically.
  const scrollerOf = (panel, list) => {
    const w = panel.ownerDocument.defaultView;
    for (let e = panel.parentElement; e && e !== list; e = e.parentElement)
      if (/^(auto|scroll)$/.test(w.getComputedStyle(e).overflowY)) return e;
    return null;
  };

  // Element with Steam's scroll fade: the scroller or an ancestor below the
  // list that is already marked or whose stock mask is a gradient.
  const fadeOf = (sc, list) => {
    const w = sc.ownerDocument.defaultView;
    for (let e = sc; e && e !== list; e = e.parentElement) {
      if (e.hasAttribute(FADE)) return e;
      const cs = w.getComputedStyle(e);
      if (/gradient/.test(cs.maskImage || cs.webkitMaskImage || '')) return e;
    }
    return null;
  };

  // Tile internals: item > wrappers > label [iconbox > icon, labelbox > marquee > text].
  const markItem = (item) => {
    const text = [...item.querySelectorAll('div')].find((e) => e.childElementCount === 0 && e.textContent.trim());
    const marquee = text?.parentElement;
    const labelbox = marquee?.parentElement;
    const label = labelbox?.parentElement;
    if (!label || label === item || !item.contains(label)) return;
    for (const t of marquee.children) mark(t, 'text');
    mark(marquee, 'marquee');
    mark(labelbox, 'labelbox');
    mark(label, 'label');
    const iconbox = label.firstElementChild !== labelbox ? label.firstElementChild : null;
    if (iconbox) { mark(iconbox, 'iconbox'); mark(iconbox.firstElementChild, 'icon'); }
    for (let w = label.parentElement; w && w !== item; w = w.parentElement) mark(w, 'wrap');
  };

  // Fade state from the actual scroll position (Steam's thresholds).
  const fade = (sc) => {
    const r = regions.get(sc);
    if (!r?.fade) return;
    const top = sc.scrollTop > 1;
    const bottom = sc.scrollHeight - sc.scrollTop > sc.clientHeight + 1;
    const v = top && bottom ? 'both' : top ? 'top' : bottom ? 'bottom' : 'none';
    if (r.fade.getAttribute(FADE) !== v) r.fade.setAttribute(FADE, v);
  };

  // maxRows: scroller max-height from its border-box top to the bottom of row
  // ROWS, plus the panel's bottom padding (at least the fade size, so that
  // row is not faded). Empty (no limit) while there are no more rows.
  const maxHeight = (sc, r) => {
    const tiles = tilesOf(r.panel);
    if (tiles.length <= ROWS * COLS) return '';
    const w = sc.ownerDocument.defaultView;
    const bottom = Math.max(...tiles.slice((ROWS - 1) * COLS, ROWS * COLS).map((t) => t.getBoundingClientRect().bottom));
    const cs = w.getComputedStyle(sc);
    const fadeSize = r.fade ? px(w.getComputedStyle(r.fade).getPropertyValue('--scroll-fade-size')) : 0;
    const pad = Math.max(px(w.getComputedStyle(r.panel).paddingBottom), fadeSize);
    let h = bottom - sc.getBoundingClientRect().top + sc.scrollTop + pad + px(cs.paddingBottom) + px(cs.borderBottomWidth);
    if (cs.boxSizing !== 'border-box') h -= px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    return `${Math.ceil(h)}px`;
  };

  const layout = (sc) => {
    const r = regions.get(sc);
    if (!r) return;
    r.fade ??= fadeOf(sc, r.list);
    if (ROWS !== null) {
      const v = maxHeight(sc, r);
      if (sc.style.getPropertyValue(MAXH) !== v) {
        if (v) sc.style.setProperty(MAXH, v); else sc.style.removeProperty(MAXH);
      }
    }
    fade(sc);
  };

  const track = (d, sc, panel, list) => {
    const ro = docs.get(d)?.ro;
    const r = regions.get(sc);
    if (r) {
      if (r.panel !== panel) { ro?.unobserve(r.panel); r.panel = panel; ro?.observe(panel); }
      return;
    }
    const onScroll = guard(() => fade(sc));
    regions.set(sc, { d, list, panel, fade: fadeOf(sc, list), onScroll });
    sc.addEventListener('scroll', onScroll, { passive: true });
    ro?.observe(sc);
    ro?.observe(panel);
  };

  const untrack = (sc) => {
    const r = regions.get(sc);
    if (!r) return;
    regions.delete(sc);
    sc.removeEventListener('scroll', r.onScroll);
    const ro = docs.get(r.d)?.ro;
    ro?.unobserve(sc);
    ro?.unobserve(r.panel);
    sc.style.removeProperty(MAXH);
    r.fade?.removeAttribute(FADE);
  };

  const update = (d) => {
    const keep = new Set();
    for (const item of d.querySelectorAll('[role=button]')) {
      const panel = item.parentElement;
      if (!panel || keep.has(panel) || !isItem(item) || item.closest('.' + PIN)) continue;
      const sec = sectionOf(item);
      if (sec?.key !== SECTION_KEY || !sec.list?.contains(panel) || sec.list === panel) continue;
      keep.add(panel).add(sec.list);
      mark(sec.list, 'list');
      mark(panel, 'panel');
      tilesOf(panel).forEach(markItem);
      const sc = scrollerOf(panel, sec.list);
      if (sc) { keep.add(sc); mark(sc, 'scroller'); track(d, sc, panel, sec.list); }
    }
    for (const el of d.querySelectorAll(`[${ATTR}=list], [${ATTR}=panel], [${ATTR}=scroller]`))
      if (!keep.has(el)) el.removeAttribute(ATTR);
    for (const sc of regionsOf(d)) if (!keep.has(sc) || !sc.isConnected) untrack(sc);
    regionsOf(d).forEach(layout);
  };

  const attach = (d) => {
    if (docs.has(d) || !d?.body) return;
    let s = d.getElementById(STYLE_ID);
    if (!s) {
      s = d.createElement('style');
      s.id = STYLE_ID;
      (d.head ?? d.documentElement).appendChild(s);
    }
    if (s.textContent !== CSS) s.textContent = CSS;
    const obs = new MutationObserver(guard(() => update(d)));
    obs.observe(d.body, { childList: true, subtree: true, characterData: true });
    const ro = new d.defaultView.ResizeObserver(guard(() => regionsOf(d).forEach(layout)));
    docs.set(d, { obs, ro });
    update(d);
  };

  const detach = (d, { obs, ro }) => {
    obs.disconnect();
    ro.disconnect();
    for (const sc of regionsOf(d)) regions.delete(sc);
    docs.delete(d);
  };

  const scan = () => {
    for (const [d, o] of docs) if (!d.defaultView || d.defaultView.closed) detach(d, o);
    for (const p of g_PopupManager.GetPopups())
      if (/barpopup/.test(p.m_strName ?? '')) guard(attach)(p.window?.document);
  };

  const timer = setInterval(scan, 1000);
  const stop = () => {
    clearInterval(timer);
    for (const sc of [...regions.keys()]) { try { untrack(sc); } catch {} }
    for (const [d, o] of docs) {
      detach(d, o);
      try {
        for (const el of d.querySelectorAll(`[${ATTR}], [${FADE}]`)) { el.removeAttribute(ATTR); el.removeAttribute(FADE); }
        d.getElementById(STYLE_ID)?.remove();
      } catch {}
    }
    if (window.__sfuiLauncherGrid === state) delete window.__sfuiLauncherGrid;
  };
  const state = { id: ID, version: VERSION, columns: COLS, maxRows: ROWS, scan, stop, docs, regions };
  window.__sfuiLauncherGrid = state;
  scan();
  return `patched (${COLS} columns${ROWS === null ? '' : `, max ${ROWS} rows`})`;
})
