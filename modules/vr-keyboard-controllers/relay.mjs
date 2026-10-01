// relay.mjs (user service vr-keyboard-controllers-relay): carries the
// controller frames from SteamVR's systemui page (bridge-patch.js, 8087; CDP
// binding __sfuiCtlOut) to Steam's SharedJSContext (hub.js, 8080:
// __sfuiControllers.frame(frame)). Frames are rebuilt from their numbers
// (nothing else passes). If the systemui page goes away: lost().
const SIDES = {
  steam: { url: 'http://127.0.0.1:8080/json/list', title: 'SharedJSContext' },
  vr: { url: 'http://127.0.0.1:8087/json/list', title: 'systemui', binding: '__sfuiCtlOut' },
};
const live = {};                                  // side -> evaluate(expression)

const num = (x) => (Number.isFinite(x) ? +x : null);
const point = (p, keys) => {
  if (!p || typeof p !== 'object') return null;
  const o = {};
  for (const k of keys) { o[k] = num(p[k]); if (o[k] === null) return null; }
  return o;
};
const hand = (h) => (h && typeof h === 'object'
  ? { tip: point(h.tip, ['u', 'v', 'd']), ray: point(h.ray, ['u', 'v', 'dist']), trigger: num(h.trigger) }
  : null);
function clean(m) {
  if (!m || typeof m !== 'object' || !Number.isFinite(m.seq) || !Number.isFinite(m.t)) return null;
  const f = { seq: m.seq, t: m.t, moving: !!m.moving, keyboard: point(m.keyboard, ['width']), hands: { left: hand(m.hands?.left), right: hand(m.hands?.right) } };
  for (const h of ['left', 'right']) if (f.hands[h] && !f.hands[h].tip) f.hands[h] = null;
  return f;
}

function forward(payload) {
  let m;
  try { m = clean(JSON.parse(payload)); } catch { return; }
  if (m) live.steam?.(`window.__sfuiControllers?.frame(${JSON.stringify(m)})`);
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
    if (m.method === 'Runtime.bindingCalled' && m.params.name === cfg.binding) forward(m.params.payload);
  };
  const closed = new Promise((res) => { ws.onclose = res; });
  if (cfg.binding) { send('Runtime.enable'); send('Runtime.addBinding', { name: cfg.binding }); }
  live[side] = (expression) => send('Runtime.evaluate', { expression });
  console.log(`${side}: connected`);
  await closed;
  delete live[side];
  if (side === 'vr') live.steam?.('window.__sfuiControllers?.lost()');
  console.log(`${side}: disconnected`);
}
for (const side of Object.keys(SIDES)) {
  (async () => {
    for (let failed = false; ; await new Promise((r) => setTimeout(r, 3000))) {
      try { await connect(side); failed = false; } catch (e) { if (!failed) console.error(`${side}: ${e.message}`); failed = true; }
    }
  })();
}
