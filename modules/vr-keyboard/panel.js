// The suggestion strip as a SteamVR dashboard panel above or below Steam's
// VR keyboard (suggestions.position "above" / "below"), injected into
// SteamVR's systemui page (8087). State comes from the keyboard page through relay.mjs:
// __sfuiKbdStrip.show({ seq, items, current, visible, style }); a click calls
// the binding __sfuiStripPick('{"seq":n,"index":i}').
//
// systemui mounts the keyboard overlay (mountedId "...gamepadui.keyboard")
// under an anchor transform, scaled by its sibling transform; the overlay
// hangs from its top edge (SteamVR's grab handle sits in the page's
// transparent bottom band). Our panel is a child of that anchor, as wide as
// the keyboard, so it follows it: "above" at y = +GAP (origin bottom
// centre); "below" at the keyboard's lower edge (origin top centre), in
// front of the grab handle. Built like
// frame-controls' own popups: a vsg-node panel whose buildNode publishes a
// region of this page (SGApp embedded-UV slot) at a free spot of the page.
(() => {
  const VERSION = 12;
  const G = window;
  const GAP = 0.012, DEPTH = 0.005;                 // m above the keyboard's top edge / in front of it
  // "below": the strip's top edge sits this much above the lower of the
  // keyboard's and the grab handle's lower edges (user-tuned), overlapping
  // the handle's hit area a little -- so the strip lies in front of the
  // handle (+z toward the viewer; the handle is at z 0.01) and gets the laser.
  const BELOW_OFFSET = 0.013, BELOW_DEPTH = 0.015;
  const O = { heightPx: 110, widthPx: 1700 };       // max page region for the strip texture (px)
  const old = G.__sfuiKbdStrip;
  if (old?.version === VERSION) return 'unchanged';
  const missing = [
    typeof G.SGApp?.addEmbeddedPanelUVs !== 'function' && 'SGApp.addEmbeddedPanelUVs',
    typeof G.SGApp?.removeEmbeddedPanelUVs !== 'function' && 'SGApp.removeEmbeddedPanelUVs',
    typeof G.VRHTML?.NextSGID !== 'function' && 'VRHTML.NextSGID',
    typeof G.VRHTML?.VROverlay?.TriggerOverlayHapticEffect !== 'function' && 'VRHTML.VROverlay.TriggerOverlayHapticEffect',
    typeof G.forceLayoutUpdate !== 'function' && 'forceLayoutUpdate',
  ].filter(Boolean);
  if (missing.length) return `SteamVR internals changed, no strip panel: missing ${missing.join(', ')}`;
  const saved = old?.state ?? null;
  try { old?.dispose?.(); } catch { /* gone */ }

  const S = G.__sfuiKbdStrip = { version: VERSION, state: saved, own: null, log: [] };
  const log = (...a) => { S.log.push([Math.round(performance.now()), ...a]); if (S.log.length > 100) S.log.shift(); };

  const style = document.createElement('style');
  style.id = 'sfui-kbd-strip-style';
  style.textContent = `
    .sfui-kbd-strip { position: fixed; display: flex; box-sizing: border-box; width: ${O.widthPx}px;
      background: rgb(35, 38, 46); z-index: 1; pointer-events: auto; }
    .sfui-kbd-strip > div { flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; }
    .sfui-kbd-strip > div:hover { filter: brightness(1.6); }`;
  document.head.appendChild(style);

  const fiberProps = (e) => {
    const k = Object.keys(e).find((x) => x.startsWith('__reactFiber$'));
    let f = k && e[k];
    for (let i = 0; f && i < 6; f = f.return, i++) if (f.memoizedProps?.mountedId) return f.memoizedProps;
    return null;
  };
  // The keyboard's anchor transform (see header) and its overlay scale, or null.
  function keyboardAnchor() {
    for (const e of document.querySelectorAll('[vsg-type="mountedscenegraph"]')) {
      if (!String(fiberProps(e)?.mountedId ?? '').endsWith('gamepadui.keyboard')) continue;
      const scaled = e.parentElement, anchor = scaled?.parentElement;
      if (!anchor || anchor.tagName !== 'VSG-TRANSFORM') return null;
      const scale = parseFloat((scaled.getAttribute('scale') || '1').split(' ')[0]) || 1;
      let width = 1;
      try { width = VRHTML.VROverlay.GetWidthInMeters(VRHTML.VROverlay.FindOverlay('valve.steam.gamepadui.keyboard')) || 1; } catch { /* 1 m */ }
      // SteamVR's grab handle: a sibling transform (origin bottom centre) whose
      // y is where its panel ends; 0.66 m if not found.
      const handle = [...anchor.children].find((c) => c !== scaled && !c.querySelector?.('.sfui-kbd-own') && c.querySelector?.('[vsg-type="panel"]'));
      const handleBottom = -parseFloat((handle?.getAttribute('translation') || '0 -0.66').split(' ')[1]) || 0.66;
      return { anchor, width: width * scale, handleBottom };
    }
    return null;
  }
  // A free spot of the page for the texture region (below every panel).
  function freeSpot() {
    const rs = [...document.querySelectorAll('[vsg-type="panel"]')]
      .filter((p) => !p.classList.contains('sfui-kbd-own')).map((p) => p.getBoundingClientRect()).filter((r) => r.width && r.height);
    const W = Math.min(O.widthPx, innerWidth - 4), H = O.heightPx;
    for (let y = innerHeight - H - 4; y >= 0; y -= 16) {
      if (!rs.some((r) => r.top < y + H + 2 && r.bottom > y - 2 && r.left < W + 4)) return { x: 2, y, W };
    }
    return null;
  }

  function mount(kb) {
    const app = G.SGApp, spot = freeSpot();
    if (!spot) { log('no free spot'); return null; }
    const outer = document.createElement('vsg-transform');
    for (const [k, v] of Object.entries({ translation: '0 0 0', rotation: '1 0 0 0', scale: '1 1 1', sgid: VRHTML.NextSGID() }))
      outer.setAttribute(k, String(v));
    const node = document.createElement('vsg-node');
    node.id = 'sfui-kbd-strip-panel';
    node.className = 'sfui-kbd-own';
    node.setAttribute('vsg-type', 'panel');
    const sgid = VRHTML.NextSGID();
    node.setAttribute('sgid', String(sgid));
    const content = document.createElement('div');
    content.className = 'sfui-kbd-strip';
    content.style.left = `${spot.x}px`; content.style.top = `${spot.y}px`; content.style.width = `${spot.W}px`;
    content.style.height = `${O.heightPx}px`;
    for (const t of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu'])
      content.addEventListener(t, (e) => e.stopPropagation());   // nothing reaches the dashboard's handlers
    content.addEventListener('click', (e) => {
      const el = e.target.closest?.('[data-index]');
      if (!el || !S.state) return;
      log('pick', S.state.seq, +el.dataset.index);
      if (+el.dataset.index !== S.state.current && S.state.haptic) {   // tick on this (the laser's) overlay
        try { VRHTML.VROverlay.TriggerOverlayHapticEffect(VRHTML.VROverlay.ThisOverlayHandle(), S.state.haptic); } catch (err) { log('haptic', String(err)); }
      }
      G.__sfuiStripPick?.(JSON.stringify({ seq: S.state.seq, index: +el.dataset.index }));
    });
    node.appendChild(content);
    outer.appendChild(node);
    const fp = {                                  // what SGApp's embedded-UV table reads of a panel
      props: { debug_name: node.id }, isExternal: false, m_Rect: { x: 0, y: 0, width: 0, height: 0 }, idx: undefined,
      getSGID: () => sgid, getEmbeddedIndex: () => fp.idx, getCurrentRootElement: () => node,
      updateLayoutValues() { const r = content.getBoundingClientRect(); fp.m_Rect = { x: r.x, y: r.y, width: r.width, height: r.height }; },
    };
    fp.idx = app.addEmbeddedPanelUVs(fp);
    if (fp.idx == null) { log('no embedded UV slot'); return null; }
    node.buildNode = (ctx) => {
      if (!kb.anchor.isConnected) { queueMicrotask(() => unmount('keyboard gone')); return [ctx, null]; }
      const r = content.getBoundingClientRect(), W = innerWidth, H = innerHeight;
      return [{ ...ctx, currentPanel: fp, bInsideReparentedPanel: false }, { type: 'panel', properties: {
        id: `system.systemui::${node.id}`, sgid, key: 'system.systemui', debug_name: node.id,
        width: kb.width, origin: S.state?.position === 'below' ? [0, 1] : [0, -1], interactive: true, scrollable: false, visibility: 0,
        'only-visible-with-laser': false, 'lasermouse-filtering': 0, 'can-take-keyboard-focus': false,
        'sort-depth-bias': -1, 'scale-index': 0,
        'embedded-uv-index': fp.idx, uv_min: [r.x / W, r.y / H], uv_max: [(r.x + r.width) / W, (r.y + r.height) / H],
      } }];
    };
    kb.anchor.appendChild(outer);
    G.forceLayoutUpdate();
    log('mounted', spot.y, kb.width);
    return { outer, node, content, fp, anchor: kb.anchor };
  }
  function unmount(why) {
    const o = S.own;
    if (!o) return;
    S.own = null;
    o.outer.remove();
    try { G.SGApp.removeEmbeddedPanelUVs(o.fp); } catch (e) { log('remove UVs', String(e)); }
    G.forceLayoutUpdate();
    log('unmounted', why);
  }
  // The keyboard's key look (patch.js keyStyle), scaled from its page
  // (pageWidth px across the keyboard) to ours (content width across it).
  const FALLBACK = { pageWidth: 854, pageHeight: 280, keyHeight: 44, pad: [1, 1, 2, 2], background: 'rgb(14, 20, 27)', color: 'rgb(255, 255, 255)',
    fontFamily: '"Motiva Sans", Arial, Helvetica, sans-serif', fontSize: 16, fontWeight: '400', radius: 0,
    border: '0px none rgb(255, 255, 255)', boxShadow: 'none', board: 'rgb(35, 38, 46)', pressed: 'rgb(26, 159, 255)' };
  function applyStyle(content, st) {
    const k = { ...FALLBACK, ...(st || {}) };
    const f = content.getBoundingClientRect().width / (k.pageWidth || 854) || 2;
    const [pt, pr, pb, pl] = (Array.isArray(k.pad) && k.pad.length === 4 ? k.pad : FALLBACK.pad).map((v) => v * f);
    const h = Math.min(O.heightPx, Math.round((k.keyHeight + (k.pad?.[0] ?? 1) + (k.pad?.[2] ?? 2)) * f));
    Object.assign(content.style, { height: `${h}px`, background: k.board, padding: `${pt}px ${pr}px ${pb}px ${pl}px`, gap: `${pl + pr}px` });
    S.applied = { f, h, key: k };
    return { k, f };
  }
  function render() {
    const st = S.state;
    const kb = st?.visible && st.items?.length ? keyboardAnchor() : null;
    if (!kb) { unmount(st?.visible ? 'no keyboard' : 'hidden'); return; }
    if (S.own && (S.own.anchor !== kb.anchor || !S.own.outer.isConnected)) unmount('anchor changed');
    if (!S.own) S.own = mount(kb);
    if (!S.own) return;
    const { k, f } = applyStyle(S.own.content, st.style);
    // Placement (m, in the keyboard anchor's frame; the keyboard hangs from y = 0).
    const kbHeight = kb.width * (k.pageHeight || 280) / (k.pageWidth || 854);
    const below = st.position === 'below';
    const y = below ? -(Math.max(kbHeight, kb.handleBottom) - BELOW_OFFSET) : GAP;
    S.own.outer.setAttribute('translation', `0 ${y.toFixed(4)} ${below ? BELOW_DEPTH : DEPTH}`);
    S.placement = { position: st.position, y, kbHeight, handleBottom: kb.handleBottom };
    S.own.content.replaceChildren(...st.items.map((text, i) => {
      const el = document.createElement('div');
      el.textContent = text;
      el.dataset.index = i;
      Object.assign(el.style, {
        background: k.background, color: k.color, fontFamily: k.fontFamily, fontSize: `${k.fontSize * f}px`,
        fontWeight: k.fontWeight, borderRadius: `${k.radius * f}px`, border: k.border, boxShadow: k.boxShadow,
      });
      // The word as it stands in the text: a thin bar in the keyboard's pressed colour.
      if (i === st.current) el.style.boxShadow = `inset 0 ${-Math.max(2, Math.round(3 * f))}px 0 ${k.pressed}`;
      el.addEventListener('mousedown', () => { el.style.background = k.pressed; });
      el.addEventListener('mouseleave', () => { el.style.background = k.background; });
      return el;
    }));
    G.forceLayoutUpdate();
  }
  S.show = (state) => { S.state = state; render(); return 'ok'; };
  // The keyboard can appear/disappear without a new state (dashboard toggled).
  S.timer = setInterval(() => {
    const want = !!(S.state?.visible && S.state.items?.length);
    if (want !== !!S.own || (S.own && !S.own.anchor.isConnected)) render();
  }, 500);
  S.dispose = () => { clearInterval(S.timer); unmount('dispose'); style.remove(); };
  render();
  return 'patched';
})
