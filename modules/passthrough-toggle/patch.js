// passthrough-toggle: turns the VR dashboard's stock room-view button into a
// three-way cycle Off -> colour -> mono -> Off (colour needs an Arcturus RGB
// accessory; otherwise it quietly stays mono -- adapted from upstream
// toorux/steam-frame-passthrough-toggle, see the README's Credits). mkPatch
// patch (steam-ui-patches/lib/default.nix) on SharedJSContext; opts:
// { invocation, icon, iconActive }, the room-view action's shape, so a
// future Steam renumbering is a module option, not a code change.
//
// The button is found like launcher-menu's patches: the dock's own bar
// popups (g_PopupManager, "valve.steam.gamepadui.bar.<n>_...", never the
// "+" menu's "...gamepadui.barpopup") share SharedJSContext's realm; the
// action is identified by its invocation/icon/icon_active shape (opts), not
// its id (changes across SteamVR restarts), via find.findFiberUp on the
// button's React fiber. Each bar popup is its own window though (only the
// JS realm is shared), so the capture-phase click listener and icon
// MutationObserver go on every bar popup's own window/document, attached by
// scan() as popups appear -- a click there never reaches SharedJSContext's.
//
// Every press is swallowed (capture phase) and queued; one job at a time
// decides from live state, never a cached guess: off -> ask the relay
// (window.__sfuiPassthroughCall, relay.mjs) to set rgb (the source byte is
// held while off, so it comes up in colour), replay the stock click, wait
// for `active`; on+rgb -> set mono; on+mono -> replay the stock click
// (off). Queued presses wait their turn rather than being dropped, and
// status refreshes share the same queue, so no reply can overtake the
// decision it's for.
// The three states show from confirmed state only (the action's own
// `active` plus the helper's last read-back source): off/mono are the
// stock icons, colour is the active icon tinted purple (#a855f7), via a
// data-sfui-passthrough attribute plus a per-window stylesheet (so a
// re-rendered SVG doesn't undo it). A MutationObserver per bar window, a
// 50 ms poll while a press waits for SteamVR, and the 1 s scan all re-set
// the attribute, so the icon follows within a tick of each change.
// State on window.__sfuiPassthrough (id, version, mode, reply() for
// relay.mjs, scan(), stop()); unpatch.js calls stop().
((find, sigs, opts) => {
  const NAME = 'passthrough-toggle';
  const VERSION = 6;
  const STYLE_ID = 'sfui-passthrough-style';
  const ATTR = 'data-sfui-passthrough';
  const CSS = `
[${ATTR}="rgb"] svg { color: #a855f7 !important; }
[${ATTR}="rgb"] svg :not([fill="none"]) { fill: #a855f7 !important; }`;
  const RELAY_TIMEOUT_MS = 9000;     // a bit over the helper's own 8 s
  const SETTLE_TIMEOUT_MS = 3000;    // how long to wait for SteamVR to flip `active`
  const POLL_MS = 50;
  const VERIFY_DELAY_MS = 1000;      // re-read the source after turning colour on
  const MAX_QUEUED = 3;              // presses beyond this while busy are dropped
  const SIG = { invocation: opts.invocation ?? 2, icon: opts.icon ?? 2, iconActive: opts.iconActive ?? 1 };
  const ID = `${VERSION}:${SIG.invocation}:${SIG.icon}:${SIG.iconActive}`;

  const prev = window.__sfuiPassthrough;
  if (prev?.id === ID) { prev.scan(); return 'unchanged'; }
  prev?.stop?.();
  if (!window.g_PopupManager) return 'g_PopupManager missing';

  const guard = (f) => (...a) => { try { return f(...a); } catch (e) { console.error(`sfui ${NAME}:`, e); } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const isRoomViewAction = (action) => action?.invocation === SIG.invocation &&
    action?.icon?.enum === SIG.icon && action?.icon_active?.enum === SIG.iconActive;
  // A DOM node's __reactFiber$ may be the stale alternate of a pair, whose
  // memoizedProps lag one render (`active` seen live to catch up only on
  // the next unrelated re-render). Prefer whichever of a fiber/alternate
  // pair is in the committed tree (its .return chain's FiberRoot.current).
  const committed = (f) => {
    let top = f;
    for (let i = 0; top.return && i < 200; i++) top = top.return;
    return top.stateNode?.current === top;
  };
  const current = (f) => (f.alternate && !committed(f) && committed(f.alternate) ? f.alternate : f);
  const actionFor = (el) => {
    const f = find.findFiberUp(el, (x) => isRoomViewAction(x.memoizedProps?.action), 40);
    return f ? current(f).memoizedProps?.action ?? null : null;
  };
  // The dock's own bar popups, not the "+" menu's "...gamepadui.barpopup".
  const isBarPopup = (name) => typeof name === 'string' && /^valve\.steam\.gamepadui\.bar\.\d+_/.test(name) && !name.includes('barpopup');

  function buttons() {
    const out = [];
    for (const p of window.g_PopupManager.GetPopups()) {
      if (!isBarPopup(p.m_strName)) continue;
      let doc;
      try { doc = p.window?.document; } catch { continue; }
      if (!doc) continue;
      for (const el of doc.querySelectorAll('[role="button"]')) if (actionFor(el)) { out.push(el); break; }
    }
    return out;
  }
  const button = () => buttons()[0] ?? null;
  const isActive = () => !!actionFor(button())?.active;

  // ---- relay calls (window.__sfuiPassthroughCall, installed by relay.mjs
  // as a CDP binding once it is connected) ----
  let nextId = 1;
  const pending = new Map();
  function call(op, source) {
    if (typeof window.__sfuiPassthroughCall !== 'function') return Promise.resolve({ ok: false, error: 'relay not connected' });
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => { if (pending.delete(id)) resolve({ ok: false, error: 'relay timed out' }); }, RELAY_TIMEOUT_MS);
      pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
      window.__sfuiPassthroughCall(JSON.stringify(source ? { id, op, source } : { id, op }));
    });
  }
  function reply(id, result) {
    const cb = pending.get(id);
    if (!cb) return;
    pending.delete(id);
    cb(result);
  }

  // ---- confirmed state & icon ----
  // The helper's last read-back source ('rgb' | 'mono'); only meaningful
  // while room view is active, which is always read live.
  let source = 'mono';
  const mode = () => (isActive() ? source : 'off');
  async function helper(op, src) {
    const result = await call(op, src);
    if (result?.ok) source = result.source === 'rgb' ? 'rgb' : 'mono';
    decorateAll();
    return result;
  }

  // What the icon shows: always mode(), i.e. confirmed state only.
  let shown = 'off';
  function decorate(target) {
    if (target && target.getAttribute(ATTR) !== shown) target.setAttribute(ATTR, shown);
  }
  const decorateAll = () => {
    const next = mode();
    shown = next;
    for (const b of buttons()) decorate(b);
  };

  // ---- the job queue: presses and status refreshes, one at a time ----
  let stopped = false;
  let tail = Promise.resolve();
  let queued = 0;
  const enqueue = (job) => { tail = tail.then(guard(job), guard(job)).then(() => {}, () => {}); return tail; };

  async function waitActive(want) {
    for (let waited = 0; isActive() !== want && waited < SETTLE_TIMEOUT_MS; waited += POLL_MS) await sleep(POLL_MS);
    decorateAll();
    return isActive() === want;
  }

  let replaying = false;
  function stockClick(target) {
    if (stopped) return;
    replaying = true;
    try { target.click(); } finally { replaying = false; }
  }

  async function press() {
    queued--;
    if (stopped) return;
    const target = button();
    if (!target) return;
    try { await handle(target); } finally { decorateAll(); }
  }
  async function handle(target) {
    if (!isActive()) {
      await helper('set', 'rgb');
      stockClick(target);
      await waitActive(true);
      // Re-read once a moment later, so the icon follows if SteamVR's
      // camera renderer resets the source while it finishes opening.
      setTimeout(() => { if (!stopped) enqueue(() => helper('status')); }, VERIFY_DELAY_MS);
      return;
    }
    const status = await helper('status');
    if (status?.ok && status.source === 'rgb') {
      await helper('set', 'mono');
      return;
    }
    stockClick(target);
    await waitActive(false);
  }

  function onClick(event) {
    if (replaying) return;   // our own replay of the stock click
    const target = button();
    if (!target || !target.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (queued >= MAX_QUEUED) return;
    queued++;
    enqueue(press);
  }

  // Bar popup windows with our click listener and icon observer attached.
  const attached = new Map();   // window -> MutationObserver
  function attach() {
    // p.window can throw once its popup is torn down (same as buttons()
    // and the loop below); treat that like closed, so one dead reference
    // can't stop every other bar popup from attaching.
    for (const [w, obs] of attached) {
      let closed;
      try { closed = w.closed; } catch { closed = true; }
      if (closed) { obs.disconnect(); attached.delete(w); }
    }
    for (const p of window.g_PopupManager.GetPopups()) {
      if (!isBarPopup(p.m_strName)) continue;
      let w;
      try { w = p.window; if (!w?.document?.documentElement || attached.has(w)) continue; } catch { continue; }
      find.ensureStyle(w.document, STYLE_ID, CSS);
      w.addEventListener('click', onClick, true);
      const obs = new MutationObserver(guard(decorateAll));
      obs.observe(w.document.documentElement, { childList: true, subtree: true });
      attached.set(w, obs);
    }
  }

  // scan: attach to new bar windows, refresh the source when room view
  // turns on (e.g. a controller binding) or a bar appears, decorate.
  let wasActive = false;
  let sawBar = false;
  function scan() {
    attach();
    const barVisible = !!button();
    const active = isActive();
    if (active && (!wasActive || (barVisible && !sawBar))) enqueue(() => helper('status'));
    wasActive = active;
    sawBar = barVisible;
    decorateAll();
  }

  const timer = setInterval(guard(scan), 1000);

  const stop = () => {
    stopped = true;
    for (const [w, obs] of attached) {
      obs.disconnect();
      try {
        w.removeEventListener('click', onClick, true);
        w.document.getElementById(STYLE_ID)?.remove();
      } catch {}
    }
    attached.clear();
    clearInterval(timer);
    for (const cb of pending.values()) cb({ ok: false, error: 'patch stopped' });
    pending.clear();
    for (const b of buttons()) b.removeAttribute(ATTR);
    if (window.__sfuiPassthrough === state) delete window.__sfuiPassthrough;
  };

  const state = { id: ID, version: VERSION, get mode() { return mode(); }, reply, scan, stop };
  window.__sfuiPassthrough = state;
  scan();
  return 'patched';
})
