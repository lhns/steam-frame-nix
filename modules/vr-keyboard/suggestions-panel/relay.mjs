// relay.mjs (user service vr-keyboard-relay): carries the suggestion strip
// between Steam's keyboard page (../patch.js in SharedJSContext, 8080) and
// SteamVR's systemui page (patch.js here, 8087) for suggestions.position
// "above" / "below". CDP bindings: the keyboard page calls
// __sfuiStripOut(state json) -> systemui __sfuiKbdStrip.show(state); the
// panel calls __sfuiStripPick({ seq, index } json) -> keyboard page
// __sfuiSwipe.remote.pick(seq, index). Only these two messages, validated
// (up to 12 items: the F-keys of keyboard.vr.functionKeys).
// On (re)connects and page reloads the keyboard page re-sends its state; if
// the keyboard page goes away, the panel is hidden.
const SIDES = {
  steam: { url: 'http://127.0.0.1:8080/json/list', title: 'SharedJSContext', binding: '__sfuiStripOut' },
  vr: { url: 'http://127.0.0.1:8087/json/list', title: 'systemui', binding: '__sfuiStripPick' },
};
const HIDDEN = { seq: 0, visible: false, current: -1, items: [] };
const live = {};                                  // side -> evaluate(expression)
let lastState = HIDDEN;

// Key style values: numbers, short CSS values that can't end a declaration.
function cleanStyle(st) {
  if (!st || typeof st !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(st)) {
    if (!/^[a-zA-Z]{1,20}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v.length < 200 && !/[;{}<>\\]/.test(v)) out[k] = v;
    else if (Array.isArray(v) && v.length <= 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) out[k] = v;
  }
  return out;
}
const show = (state) => { lastState = state; live.vr?.(`window.__sfuiKbdStrip?.show(${JSON.stringify(state)})`); };
const resync = () => live.steam?.('window.__sfuiSwipe?.remote?.sync()');
// New contexts come in bursts; the injector re-patches ~3 s after the last.
let resyncTimer = null;
const resyncSoon = () => { clearTimeout(resyncTimer); resyncTimer = setTimeout(resync, 3500); };

function forward(side, payload) {
  let msg;
  try { msg = JSON.parse(payload); } catch { return; }
  if (side === 'steam' && Array.isArray(msg?.items) && typeof msg.seq === 'number') {
    show({ seq: msg.seq, visible: !!msg.visible, current: Number(msg.current) | 0,
      items: msg.items.slice(0, 12).map((s) => String(s).slice(0, 64)), style: cleanStyle(msg.style),
      haptic: Math.max(0, Math.min(5, Number(msg.haptic) | 0)), position: msg.position === 'below' ? 'below' : 'above' });
  } else if (side === 'vr' && typeof msg?.seq === 'number' && typeof msg.index === 'number') {
    live.steam?.(`window.__sfuiSwipe?.remote?.pick(${msg.seq | 0}, ${msg.index | 0})`);
  }
}

async function connect(side) {
  const cfg = SIDES[side];
  const list = await (await fetch(cfg.url, { signal: AbortSignal.timeout(3000) })).json();
  const t = list.find((x) => x.title === cfg.title && x.webSocketDebuggerUrl);
  if (!t) throw new Error(`${cfg.title} not found`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const send = (method, params = {}) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: ++id, method, params })); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.bindingCalled' && m.params.name === cfg.binding) forward(side, m.params.payload);
    else if (m.method === 'Runtime.executionContextCreated') resyncSoon();
  };
  const closed = new Promise((res) => { ws.onclose = res; });
  send('Runtime.enable');
  send('Runtime.addBinding', { name: cfg.binding });
  live[side] = (expression) => send('Runtime.evaluate', { expression });
  console.log(`${side}: connected`);
  if (side === 'vr') show(lastState);
  resync();
  await closed;
  delete live[side];
  if (side === 'steam') show(HIDDEN);             // no keyboard page: no strip
  console.log(`${side}: disconnected`);
}
for (const side of Object.keys(SIDES)) {
  (async () => {
    for (let failed = false; ; await new Promise((r) => setTimeout(r, 3000))) {
      try { await connect(side); failed = false; } catch (e) { if (!failed) console.error(`${side}: ${e.message}`); failed = true; }
    }
  })();
}
