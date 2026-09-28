// Gestures and suggestions for Steam's VR keyboard (vr-keyboard.nix),
// injected into Steam's SharedJSContext (8080). The keyboard is a popup of
// that context ("SteamVR - Keyboard"); everything works on its document.
// mkPatch convention plus four more arguments: decoder.js, textmodel.js,
// corrector.js and the dictionary text ("word<TAB>zipf*10\n...").
//
// - Swipe: the laser arrives as touch events; Steam types the key a touch
//   started on at release. Once a press leaves its first key we drop that
//   key from Steam's pending touches (m_mapTouched) and cancel its long press
//   (Steam's own touch-end cleanup, minus the typing), then decode the path.
// - Output: one character or "Backspace" per HandleVirtualKeyDown, the path
//   of Steam's own keys (incl. extraKeys' xdotool fallback for non-ASCII,
//   which is async: we pause after such characters).
// - Text model: an own-property hook on the manager's HandleVirtualKeyDown
//   feeds everything the keyboard emits to textmodel.js; one on
//   TypeKeyInternal resets it for keys the model can't follow (extraKeys'
//   xdotool keys, dead keys) and freezes suggestions at once for taps (their
//   character arrives later). Keyboard
//   closed/retargeted, another Steam text field, idle: reset. Suggestions
//   replace text only while the model proves the characters they replace
//   intact.
// - Strip: in the page over the number row ("inside") or as a SteamVR panel
//   above/below the keyboard ("above"/"below", panel.js): state out via the
//   CDP binding __sfuiStripOut, picks back via
//   __sfuiSwipe.remote.pick(seq, index) (relay.mjs).
// All Steam internals are checked first (sigs, instance members); if one is
// missing the keyboard stays stock. Only passive listeners; never blocks
// Steam's events. Debugging: __sfuiSwipeLog, __sfuiSwipePaths
// (scripts/vr-keyboard-replay.mjs).
((find, sigs, opts, hooks, D, T, C, DICT) => {
  const VERSION = 23;
  const G = window;
  const O = opts;

  const log = (...a) => {
    const l = (G.__sfuiSwipeLog ??= []);
    l.push([Math.round(performance.now()), ...a]);
    if (l.length > 300) l.splice(0, l.length - 300);
  };

  // Shared across injections: the parsed dictionary (and decoder layouts,
  // corrector index), one detach function per patched keyboard document.
  const dictId = `${DICT.length}:${DICT.slice(0, 80)}:${D.VERSION}:${C.VERSION}`;
  let S = G.__sfuiSwipe;
  if (S?.dictId !== dictId) {
    for (const detach of S?.docs?.values() || []) detach();
    S = G.__sfuiSwipe = { dictId, dict: D.parseDict(DICT), layouts: new Map(), corrector: null, docs: new Map() };
  }
  for (const [doc, detach] of S.docs) if (!doc.defaultView) { detach(); S.docs.delete(doc); }

  let status, Manager;
  try {
    const req = find.getWebpackRequire('webpackChunksteamui');
    const mods = find.resolveAll(req, sigs);
    status = mods.vrStatus.exports.holder;
    Manager = mods.keyboardManager.exports.VirtualKeyboardManager;
    find.findModule(req, sigs.keyboardComponent.module, 'keyboardComponent');
  } catch (e) {
    return `Steam internals changed, keyboard left stock: ${e.message}`;
  }

  const popup = [...(g_PopupManager.GetPopups?.() || [])].find((p) => p.window?.document.querySelector('[data-key]'));
  if (!popup) return 'no keyboard popup yet';
  const doc = popup.window.document;
  const stamp = `${VERSION} ${JSON.stringify(O)}`;   // new code or options: re-attach
  if (doc.__sfuiSwipe === stamp && S.docs.has(doc)) return 'unchanged';
  S.docs.get(doc)?.();
  S.docs.delete(doc);
  const kbInst = (el) => find.findFiberUp(el, (f) => typeof f.stateNode?.TypeKeyInternal === 'function', 200)?.stateNode;
  const inst0 = kbInst(doc.querySelector('[data-key]'));
  const missing = [
    !inst0 && 'keyboard component',
    !(inst0?.props?.VirtualKeyboardManager instanceof Manager) && 'VirtualKeyboardManager instance',
    !(inst0?.m_mapTouched instanceof Set) && 'm_mapTouched',
    ...['CancelLongPressTimer', 'DismissLongPress', 'ClearHoldTarget'].filter((m) => typeof inst0?.[m] !== 'function'),
    typeof inst0?.state?.toggleStates !== 'object' && 'toggleStates',
  ].filter(Boolean);
  if (missing.length) return `Steam internals changed, keyboard left stock: missing ${missing.join(', ')}`;
  S.docs.set(doc, attach(popup.window, doc));
  doc.__sfuiSwipe = stamp;
  return `patched (${S.dict.words.length} words)`;

  function attach(win, doc) {
    const cleanup = [];
    const isLetter = (k) => typeof k === 'string' && [...k].length === 1 && /\p{L}/u.test(k);
    const on = (v) => (v & 7) !== 0;               // toggle state: 1 one-shot, 2 locked
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

    // ---- trail and in-page strip -------------------------------------------------
    const inPage = O.position === 'inside';       // else a SteamVR panel (panel.js)
    const style = doc.createElement('style');
    style.textContent = `
      #sfui-swipe-trail { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 10000; }
      #sfui-swipe-strip { position: fixed; left: 2px; right: 2px; z-index: 10001;
        background: rgb(35, 38, 46); display: none; gap: 4px; box-sizing: border-box; }
      #sfui-swipe-strip.shown { display: flex; }
      #sfui-swipe-strip > div { flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center;
        background: rgb(35, 38, 46); color: rgb(220, 222, 226); border-radius: 4px;
        font-family: "Motiva Sans", Arial, Helvetica, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #sfui-swipe-strip > div.current { background: rgb(26, 105, 170); color: white; }
      #sfui-swipe-strip > div.hover { outline: 2px solid rgba(255, 255, 255, 0.6); outline-offset: -2px; }`;
    const canvas = doc.createElement('canvas');
    canvas.id = 'sfui-swipe-trail';
    const strip = doc.createElement('div');
    strip.id = 'sfui-swipe-strip';
    doc.head.appendChild(style);
    doc.body.append(canvas, strip);
    cleanup.push(() => { style.remove(); canvas.remove(); strip.remove(); });
    const ctx = canvas.getContext('2d');
    let fadeTimer = 0;
    cleanup.push(() => clearTimeout(fadeTimer));
    const clearTrail = () => ctx.clearRect(0, 0, canvas.width, canvas.height);
    function drawTrail(pts, color, fadeMs = 0) {
      const dpr = win.devicePixelRatio || 1, w = Math.round(win.innerWidth * dpr), h = Math.round(win.innerHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      clearTimeout(fadeTimer);
      clearTrail();
      ctx.save();
      ctx.scale(dpr, dpr);
      Object.assign(ctx, { lineWidth: 6, lineCap: 'round', lineJoin: 'round', strokeStyle: color });
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.restore();
      if (fadeMs) fadeTimer = setTimeout(clearTrail, fadeMs);
    }

    // ---- key geometry -> decoder layout (cached per key positions) -------------
    function currentLayout() {
      const keys = {}, widths = [];
      for (const el of doc.querySelectorAll('[data-key]')) {
        const k = el.getAttribute('data-key'), r = el.getBoundingClientRect();
        if (!isLetter(k) || !r.width) continue;
        keys[k.toLowerCase()] = [r.x + r.width / 2, r.y + r.height / 2];
        widths.push(r.width);
      }
      if (widths.length < 10) return null;
      const sig = Object.entries(keys).map(([k, [x, y]]) => `${k}${Math.round(x)},${Math.round(y)}`).join(' ');
      let lay = S.layouts.get(sig);
      if (!lay) {
        if (S.layouts.size >= 4) S.layouts.clear();
        const unit = widths.sort((a, b) => a - b)[widths.length >> 1];
        lay = { unit, keys, dec: D.layout(S.dict, keys, unit) };
        S.layouts.set(sig, lay);
      }
      return lay;
    }

    // ---- text model, hooks, resets --------------------------------------------------
    const model = T.create({ size: O.bufferChars });
    S.model = model;
    let lastActivity = Date.now();
    const activity = () => { lastActivity = Date.now(); };
    let refreshQueued = false;
    const refreshLater = () => {
      if (refreshQueued) return;
      refreshQueued = true;
      queueMicrotask(() => { refreshQueued = false; showStrip(); });
    };
    const reset = (why, o) => { model.reset(why, o); log('reset', why); refreshLater(); };

    // Own-property hooks calling the (possibly keyboard-patch-wrapped)
    // prototype method; re-installed if the instance changes.
    function hook(obj, name, make) {
      if (!obj || (own(obj, name) && obj[name].__sfuiSwipe === hook)) return;
      // The prototype's current method (the keyboard patch may re-wrap it).
      const f = make((self, args) => Object.getPrototypeOf(obj)[name].apply(self, args));
      f.__sfuiSwipe = hook;
      obj[name] = f;
      cleanup.push(() => { if (own(obj, name) && obj[name] === f) delete obj[name]; });
    }
    const TOGGLES = new Set(['Shift', 'CapsLock', 'Control', 'Alt', 'AltGr']);
    function hookInst(inst) {
      if (!inst) return;
      const mgr = inst.props?.VirtualKeyboardManager;
      hook(mgr, 'HandleVirtualKeyDown', (call) => function (key, ...rest) {
        if (this === mgr) {
          if (!emitting) log('k', key);            // what the keyboard typed (not our own output)
          if (this.m_strDeadKeyPending) reset('dead key');
          else if (!model.observe(key)) log('reset', `key ${key}`);
          activity(); refreshLater();
        }
        return call(this, [key, ...rest]);
      });
      hook(inst, 'TypeKeyInternal', (call) => function (st) {
        const key = st?.strKey, ts = this.state?.toggleStates || {};
        if (typeof key === 'string' && !TOGGLES.has(key) && !/^(SwitchKeys_|IME_)/.test(key)) {
          // Extra keys typed by keyboard.vr.extraKeys with xdotool (chords, Esc,
          // arrows, AltGr Delete: text after the cursor) and dead keys: the
          // model can't follow them.
          if (on(ts.Control) || on(ts.Alt) || key.startsWith('VKX_') || st.strDeadKeyNext || (on(ts.Shift) && key.startsWith('Arrow'))) {
            reset(`key ${key}`);
          } else { model.freeze(); refreshLater(); }
        }
        activity();
        return call(this, [st]);
      });
    }
    hookInst(inst0);

    const ids = new WeakMap();
    let nextId = 1;
    const idOf = (o) => (o && typeof o === 'object' ? (ids.get(o) ?? (ids.set(o, nextId), nextId++)) : 0);
    let lastTarget = null, idle = false;
    const poll = setInterval(() => {
      const s = status.VRKeyboardStatus;
      const target = [s?.bIsOpen, s?.sOverlayKey, s?.unAppID, idOf(inst0.props?.VirtualKeyboardManager?.m_ActiveElementProps)].join('|');
      if (lastTarget !== null && target !== lastTarget) reset(`target ${target}`, { boundary: true });
      lastTarget = target;
      const quiet = O.resetAfterIdleSeconds > 0 && Date.now() - lastActivity > O.resetAfterIdleSeconds * 1000;
      // Idle: the cursor may have moved; the next word starts a new known text.
      // (A boundary only matters for suggestions, whose replacements stay exact.)
      if (quiet && !idle) reset('idle', { boundary: true });
      idle = quiet;
    }, 500);
    cleanup.push(() => clearInterval(poll));

    // ---- output: serialised operations ----------------------------------------------
    let queue = Promise.resolve(), busy = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    function run(name, fn) {
      busy++;
      queue = queue.then(fn).catch((e) => log(`${name}-error`, String(e))).finally(() => { busy--; refreshLater(); });
    }
    let emitting = false;
    const emitter = (mgr) => (key) => {
      emitting = true;
      try { mgr.HandleVirtualKeyDown(key); } finally { emitting = false; }
      if (key.codePointAt(0) > 127 && G.__vrkbdKey) return sleep(120);
    };
    // SteamVR overlay haptic effects: 1 ButtonEnter (light), 3 Snap.
    const HAPTIC = { step: 1, border: 3, pick: 1 };
    const haptic = (effect) => O.haptics && win.SteamClient?.OpenVR?.TriggerOverlayHapticEffect?.(effect, 0);

    // ---- suggestions: one strip, last event wins --------------------------------
    // cur: { kind, items, index (what the text shows), anchor } -- swipe (the
    // swiped word's alternatives), correct (a finished tapped word not in the
    // dictionary: itself, then corrections; anchor incl. the terminator),
    // complete (the typed prefix, then its completions). A pick
    // replaces the anchored text and keeps the strip, so picks can be
    // switched; the strip stays while its anchor is intact.
    let cur = null, computedAt = -1;
    const corrector = () => (S.corrector ??= C.create(S.dict));
    const valid = (c) => model.anchorIntact(c.anchor);
    function suggest() {
      if (cur && valid(cur)) return;
      cur = null;
      if (computedAt === model.version) return;
      computedAt = model.version;
      const mgr = inst0.props?.VirtualKeyboardManager;
      const w = O.autocorrect && model.endedWord();
      if (O.autocorrect && !w && /[\p{L}\p{N}][ .,!?;:]$/u.test(model.text)) log('word-end', 'start unknown');
      if (w) {
        const lay = currentLayout();             // neighbouring keys are cheap substitutions
        if (lay && S.correctorLayout !== lay) { corrector().setLayout(lay.dec.centre); S.correctorLayout = lay; }
        const c = corrector().corrections(w.word, { maxDistance: O.maxEditDistance, max: O.count - 1 });
        log('word-end', w.word, c.length ? c.join(' ') : 'ok');
        if (c.length) cur = { kind: 'correct', items: [w.word, ...c], index: 0, term: w.term, anchor: model.anchor(w.n), mgr };
      }
      const p = !cur && O.completions && model.currentWord();
      if (p && [...p.text].length >= O.minPrefix) {
        const c = corrector().completions(p.text, { max: O.count - 1 });
        if (c.length) cur = { kind: 'complete', items: [p.text, ...c], index: 0, anchor: model.anchor(p.n), mgr };
      }
      if (cur) log('suggest', cur.kind, cur.items.join(' '));
    }
    function showStrip() {
      if (busy) return;                          // shown again when the operation is done
      const dragging = down?.kind === 'backspace' && down.active;   // no suggestions during a Backspace drag
      if (!dragging) suggest();
      const shown = !dragging && !!(cur && valid(cur));
      if (!inPage) { publish(shown); return; }
      strip.replaceChildren(...(shown ? cur.items : []).map((text, i) => {
        const el = doc.createElement('div');
        el.textContent = text;
        el.dataset.index = i;
        if (i === cur.index) el.className = 'current';
        return el;
      }));
      strip.classList.toggle('shown', shown);
      if (shown) placeStrip();
    }
    // The in-page strip covers exactly the number row (up to Backspace).
    function placeStrip() {
      const row0 = [...doc.querySelectorAll('[data-key-row="0"]')].map((el) => el.getBoundingClientRect());
      if (!row0.length) return;
      const top = Math.min(...row0.map((r) => r.top)), height = Math.max(...row0.map((r) => r.bottom)) - top;
      const bs = doc.querySelector('[data-key="Backspace"]')?.getBoundingClientRect();
      strip.style.right = bs?.width && bs.top < top + height ? `${Math.max(2, win.innerWidth - bs.x + 2)}px` : '2px';
      Object.assign(strip.style, { top: `${top}px`, height: `${height}px`, fontSize: `${Math.max(10, Math.min(18, height - 10))}px` });
    }

    function commit(inst, results) {
      const ts = inst.state.toggleStates;
      const upper = on(ts.CapsLock) || (ts.Shift & 2) !== 0, first = !upper && on(ts.Shift);
      const shape = (w) => (upper ? w.toUpperCase() : first ? w[0].toUpperCase() + w.slice(1) : w);
      if (first && (ts.Shift & 3) === 1) {       // release a one-shot Shift, like a typed key
        inst.setState((s) => ({ ...s, toggleStates: { ...s.toggleStates, Shift: s.toggleStates.Shift & 4 } }));
      }
      const mgr = inst.props.VirtualKeyboardManager;
      const entry = { kind: 'swipe', items: results.map((r) => shape(r.word)), index: 0, mgr, anchor: null };
      cur = null;
      run('commit', async () => {
        if (!O.autoSpace) model.reset('no auto-space');
        const r = await model.commitWord(emitter(mgr), entry.items[0]);
        entry.anchor = r.anchor;
        cur = entry;
        log('commit', entry.items[0], r.space ? 'space' : '');
      });
    }
    function pick(i) {
      const c = cur;
      if (!c || i === c.index || c.items[i] === undefined) return;
      run('pick', async () => {
        if (cur !== c || !valid(c)) return;
        const before = model.text.slice(-24);
        // A correction keeps the typed terminator; nothing is appended otherwise.
        const a = await model.replaceAnchored(c.anchor, emitter(c.mgr), c.items[i] + (c.kind === 'correct' ? c.term : ''));
        log('pick', c.kind, c.items[i], !!a, JSON.stringify(before), JSON.stringify(model.text.slice(-24)));
        if (a) {
          Object.assign(c, { anchor: a, index: i });   // every kind can be switched again
          if (inPage) haptic(HAPTIC.pick);        // a panel ticks on its own overlay
        } else if (cur === c) cur = null;
      });
    }

    // ---- strip as a SteamVR panel ("above" / "below") -------------------------------
    // State { seq, items, current, visible, style } out via __sfuiStripOut;
    // style: a letter key's look, so the panel's buttons match the keys.
    let outSeq = 0, outLast = '', published = null, keyStyleCache = null;
    function keyStyle() {
      const key = doc.querySelector('[data-key="g"]') || doc.querySelector('[data-key="a"]');
      const face = key?.firstElementChild;
      if (!face) return null;
      const board = key.closest('[class*="Layout_"]');
      const sig = `${board?.className}|${face.className}|${win.innerWidth}`;
      if (keyStyleCache?.sig === sig) return keyStyleCache.style;
      const cs = win.getComputedStyle(face), ks = win.getComputedStyle(key);
      // Pressed colour: the theme's rule for the key face plus one class.
      const faceCls = String(face.className).split(/\s+/)[0], boardCls = String(board?.className || '').split(/\s+/).filter(Boolean);
      let pressed = null;
      for (const sh of doc.styleSheets) {
        let rules; try { rules = sh.cssRules; } catch { continue; }
        pressed = [...rules].find((r) => r.selectorText?.includes(`.${faceCls}.`) && !r.selectorText.includes('::') &&
          !r.selectorText.includes('KeyTheme_') && r.style?.backgroundColor && boardCls.some((c) => r.selectorText.includes(`.${c} `)))?.style.backgroundColor;
        if (pressed) break;
      }
      const style = {
        pageWidth: win.innerWidth, pageHeight: win.innerHeight, keyHeight: face.getBoundingClientRect().height,
        pad: [ks.paddingTop, ks.paddingRight, ks.paddingBottom, ks.paddingLeft].map((v) => parseFloat(v) || 0),
        background: cs.backgroundColor, color: cs.color, fontFamily: cs.fontFamily, fontSize: parseFloat(cs.fontSize) || 16,
        fontWeight: cs.fontWeight, radius: parseFloat(cs.borderRadius) || 0, border: cs.border, boxShadow: cs.boxShadow,
        board: board ? win.getComputedStyle(board).backgroundColor : undefined, pressed: pressed || undefined,
      };
      keyStyleCache = { sig, style };
      return style;
    }
    function publish(shown, force = false) {
      let st = null;
      if (shown) try { st = keyStyle(); } catch (e) { log('key-style-error', String(e)); }
      const body = JSON.stringify(shown ? { items: cur.items, current: cur.index, visible: true, style: st, haptic: O.haptics ? HAPTIC.pick : 0, position: O.position } : { items: [], current: -1, visible: false });
      if (body === outLast && !force) return;
      outLast = body;
      published = shown ? cur : null;
      try { G.__sfuiStripOut?.(JSON.stringify({ seq: ++outSeq, ...JSON.parse(body) })); } catch (e) { log('publish-error', String(e)); }
    }
    const remote = {
      pick(seq, i) { if (seq === outSeq && published && published === cur) pick(i); else log('stale-pick', seq, outSeq); },
      sync() { outLast = ''; showStrip(); return 'ok'; },
    };
    S.remote = remote;
    cleanup.push(() => {
      if (!inPage) publish(false, true);
      if (S.remote === remote) delete S.remote;
    });

    // ---- gestures ------------------------------------------------------------------
    // down: { kind: 'strip', index } | { kind: 'backspace', ... } | { kind: 'key', ... }.
    // Touch is read from touch events (they go on after Chromium's
    // pointercancel); a mouse from pointer events, or mouse events if there
    // are no pointer events.
    let down = null, sawPointer = false;
    const keyOf = (t) => t?.closest?.('[data-key]');
    const stripIndexOf = (t) => {
      const el = t?.closest?.('#sfui-swipe-strip > div');
      return el && strip.contains(el) ? +el.dataset.index : -1;
    };
    const at = (x, y) => doc.elementFromPoint(x, y);
    function point(e) {
      if (e.type.startsWith('touch')) {
        const t = e.type === 'touchend' || e.type === 'touchcancel' ? e.changedTouches[0] : e.touches[0];
        return t && !(e.type === 'touchstart' && e.touches.length > 1) ? [t.clientX, t.clientY, t.target] : null;
      }
      if (e.type.startsWith('pointer')) { sawPointer = true; if (e.pointerType === 'touch') return null; }
      else if (sawPointer) return null;
      return [e.clientX, e.clientY, e.target];
    }
    // Keep Steam from typing the pressed key at release and from its long press.
    function takeOver(d) {
      const inst = d.inst;
      try {
        for (const el of [...inst.m_mapTouched]) if (d.keyEl.contains(el)) inst.m_mapTouched.delete(el);
        inst.CancelLongPressTimer();
        inst.DismissLongPress();
        inst.ClearHoldTarget();
      } catch (e) { log('takeover-error', String(e)); }
    }
    function onDown(e) {
      const p = point(e);
      if (!p) return;
      const [x, y, target] = p;
      const si = stripIndexOf(target);
      if (si !== -1) { down = { kind: 'strip', index: si }; return; }
      const keyEl = keyOf(target), key = keyEl?.getAttribute('data-key'), inst = keyEl && kbInst(keyEl);
      down = null;
      if (!inst) return;
      hookInst(inst);
      if (key === 'Backspace' && O.pixelsPerChar > 0) {
        down = { kind: 'backspace', keyEl, inst, x0: x, active: false, planned: 0,
          g: model.dragStart({ px: O.pixelsPerChar, detentPx: O.wordDetentPixels }) };
      } else if (O.swipe && isLetter(key)) {
        const lay = currentLayout();
        if (lay) down = { kind: 'key', key, keyEl, inst, lay, pts: [[x, y]], active: false };
      }
    }
    // Backspace drag: a character per px of leftward travel (the first at px;
    // releasing before is Steam's tap), a detent of detentPx at a word border;
    // back right retypes what this drag deleted while the model is sure.
    function backspaceMove(d, x) {
      const travel = d.x0 - x;
      if (!d.active) {
        if (travel < O.pixelsPerChar) return;
        d.active = true;
        takeOver(d);
        refreshLater();                          // hides the strip
      }
      const target = d.g.target(travel), emit = emitter(d.inst.props.VirtualKeyboardManager);
      const tick = (r) => haptic(r.border ? HAPTIC.border : HAPTIC.step);
      for (; d.planned < target; d.planned++) run('backspace', async () => tick(await model.dragDelete(d.g, emit)));
      for (; d.planned > target && d.g.restorable; d.planned--) {
        run('restore', async () => {
          const r = await model.dragRestore(d.g, emit);
          if (r) tick(r); else d.planned = d.g.applied;
        });
      }
    }
    function onMove(e) {
      const p = point(e);
      if (!p || !down || down.kind === 'strip') return;
      const [x, y] = p;
      if (down.kind === 'backspace') { backspaceMove(down, x); return; }
      const q = down.pts[down.pts.length - 1];
      if (Math.hypot(x - q[0], y - q[1]) < 2) return;
      down.pts.push([x, y]);
      if (!down.active) {
        const s = down.pts[0];
        if (Math.hypot(x - s[0], y - s[1]) <= 0.6 * down.lay.unit || keyOf(at(x, y))?.getAttribute('data-key') === down.key) return;
        down.active = true;
        takeOver(down);
      }
      drawTrail(down.pts, 'rgba(26, 159, 255, 0.75)');
    }
    function onUp(e) {
      const p = point(e);
      if (!p) return;
      const [x, y] = p, d = down;
      down = null;
      if (d?.kind === 'strip') {                  // released anywhere on the strip: the button pressed
        if (strip.contains(at(x, y))) pick(d.index);
        return;
      }
      if (d?.kind === 'backspace' && d.active) {
        run('backspace-log', () => {             // after the drag's queued steps
          const st = d.g.stats;
          log('backspace-drag', `known ${d.g.snap.length}`, `deleted ${st.deleted}`, `restored ${st.restored}`,
            `borders ${st.borders}`, `unknown ${st.unknown}`, st.stop || 'ok');
        });
      }
      if (d?.kind !== 'key' || !d.active) return;   // taps are Steam's
      d.pts.push([x, y]);
      setTimeout(() => decode(d), 0);             // after Steam has handled the release
    }
    function decode(d) {
      let results = [];
      try { results = D.decode(d.lay.dec, d.pts, { max: O.count, unit: d.lay.unit }); } catch (err) { log('decode-error', String(err)); }
      log('decode', results.map((r) => r.word).join(' '));
      const paths = (G.__sfuiSwipePaths ??= []);
      paths.push({ unit: d.lay.unit, keys: d.lay.keys, pts: d.pts.map(([x, y]) => [Math.round(x), Math.round(y)]), top: results.map((r) => r.word) });
      if (paths.length > 20) paths.shift();
      if (!results.length) { drawTrail(d.pts, 'rgba(255, 80, 80, 0.75)', 400); return; }
      fadeTimer = setTimeout(clearTrail, 150);
      commit(d.inst, results);
    }
    function onCancel(e) {
      if (e.type === 'pointercancel' && e.pointerType === 'touch') return;   // touch events go on
      if (down?.active) clearTrail();
      down = null;
    }
    function onHover(e) {
      const si = stripIndexOf(e.target);
      for (const el of strip.children) el.classList.toggle('hover', +el.dataset.index === si);
    }

    const L = { capture: true, passive: true };
    // No 'blur': the VR keyboard window blurs on every touch.
    for (const [type, f] of [
      ['touchstart', onDown], ['pointerdown', onDown], ['mousedown', onDown],
      ['touchmove', onMove], ['pointermove', onMove], ['mousemove', onMove],
      ['touchend', onUp], ['pointerup', onUp], ['mouseup', onUp],
      ['touchcancel', onCancel], ['pointercancel', onCancel],
      ['pointerover', onHover], ['mouseover', onHover],
    ]) {
      win.addEventListener(type, f, L);
      cleanup.push(() => win.removeEventListener(type, f, L));
    }
    log('attached', VERSION);
    return () => {
      for (const f of cleanup.reverse()) { try { f(); } catch { /* page gone */ } }
      delete doc.__sfuiSwipe;
    };
  }
})
