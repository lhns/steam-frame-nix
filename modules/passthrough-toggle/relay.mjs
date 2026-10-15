// relay.mjs (user service passthrough-toggle-relay): the only process that
// runs steam-frame-nix-passthrough. Exposes a CDP binding
// __sfuiPassthroughCall on Steam's SharedJSContext (127.0.0.1:8080, the
// realm patch.js's bar popups share) that patch.js calls with JSON
// {id, op, source?}; request.mjs's allowlist decides what reaches the
// helper, one call at a time, each with an 8 s timeout. The result goes
// back as window.__sfuiPassthrough.reply(id, result) -- patch.js owns that
// object and whatever promise is waiting on `id`; this relay never touches
// the DOM or the patch's own state directly.
// usage: node relay.mjs <steam-frame-nix-passthrough path>
import { execFile } from 'node:child_process';
import { allowed, argsFor, parseResult, createQueue } from './request.mjs';

const [, , helperPath] = process.argv;
if (!helperPath) {
  console.error('usage: node relay.mjs <steam-frame-nix-passthrough path>');
  process.exit(2);
}

const CDP = 'http://127.0.0.1:8080/json/list';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runSerially = createQueue();
let stopping = false;

function runHelper(payload) {
  return new Promise((resolve) => {
    execFile(helperPath, argsFor(payload), { timeout: 8000, killSignal: 'SIGKILL' }, (error, stdout) => {
      const result = parseResult(stdout, error);
      // Only failures (a non-zero exit or a timeout) go to the journal.
      if (!result.ok) console.error(`${argsFor(payload).join(' ')}: exit ${error?.code ?? 0}, error ${result.error}`);
      resolve(result);
    });
  });
}

async function session() {
  const list = await (await fetch(CDP, { signal: AbortSignal.timeout(3000) })).json();
  const target = list.find((x) => x.title === 'SharedJSContext');
  if (!target) throw new Error('SharedJSContext not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const call = (method, params = {}) => new Promise((res) => {
    if (ws.readyState !== WebSocket.OPEN) return res({});   // closed: never answered
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const closed = new Promise((res) => {
    ws.onclose = () => { for (const r of pending.values()) r({}); pending.clear(); res(); };
  });
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method !== 'Runtime.bindingCalled' || m.params.name !== '__sfuiPassthroughCall') return;
    let payload;
    try { payload = JSON.parse(m.params.payload); } catch { console.error('malformed request', m.params.payload); return; }
    if (!allowed(payload)) { console.error('rejected', m.params.payload); return; }
    const result = await runSerially(() => runHelper(payload));
    if (stopping) return;
    const expr = `window.__sfuiPassthrough && window.__sfuiPassthrough.reply(${JSON.stringify(payload.id)}, ${JSON.stringify(result)})`;
    await call('Runtime.evaluate', { expression: expr });
  };
  await call('Runtime.enable');
  await call('Runtime.addBinding', { name: '__sfuiPassthroughCall' });
  console.log('connected');
  await closed;
}

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; setTimeout(() => process.exit(0), 50); });

for (;;) {
  if (stopping) break;
  try { await session(); console.log('disconnected'); }
  catch (e) { console.error('retry:', e.message); }
  if (stopping) break;
  await sleep(5000);
}
