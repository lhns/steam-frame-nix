// vr-pet show [--summon] | hide | status | models | model <id>
//
// Shows / hides the VR pet (systemui.js) from outside SteamVR, e.g. the "+"
// menu's Pet entry (vr-pet.desktop runs `vr-pet show`). Talks to the
// systemui page over CEF DevTools (127.0.0.1:8087: /json/list, the target
// titled "systemui", one Runtime.evaluate) and calls only the patch's own API,
// window.__sfuiPet.api (its version checked); nothing else of the page is
// touched.
//
// show       the cat back at its spot while that is within 3 m and in view,
//            else 1 m in front of you (a shown cat: the same rule)
// --summon   always 1 m in front of you
// hide       the cat leaves the scene (as its close button)
// status     JSON: hidden, pose, spot, distance, model, ...
// models     the models, the cat's coats and the other animals (* the
//            current one): id and name
// model <id> switch to that model (kept across restarts; a hidden pet
//            switches too and is shown as that)
//
// Exit: 0 done, 2 SteamVR / DevTools unreachable (or timeout, 3 s), 3 the cat
// is not injected or has another API version, 4 error, usage or an unknown
// model.
export const API_VERSION = 2;
export const ENDPOINT = 'http://127.0.0.1:8087';
export const TITLE = 'systemui';
export const EXIT = { ok: 0, unreachable: 2, notInjected: 3, error: 4 };
const USAGE = 'usage: vr-pet show [--summon] | hide | status | models | model <id>';
// CLI command -> API method
const METHOD = { show: 'show', hide: 'hide', status: 'status', models: 'models', model: 'setModel' };

// Thrown by a transport: SteamVR / DevTools not reachable (exit 2).
export class Unreachable extends Error {}

// The expression evaluated in the page: only window.__sfuiPet.api.
export function expression(method, args = {}) {
  return `(async () => {
  const api = window.__sfuiPet?.api;
  if (!api) return { status: 'not-injected' };
  if (api.version !== ${API_VERSION}) return { status: 'version', version: api.version };
  return { status: 'ok', value: await api[${JSON.stringify(method)}](${JSON.stringify(args)}) };
})()`;
}

// Default transport: fetch + the WebSocket of node >= 22.
export const cdp = {
  async list(endpoint, signal) {
    let r;
    try { r = await fetch(`${endpoint}/json/list`, { signal }); } catch (e) { throw new Unreachable(`${endpoint}: ${e.cause?.code ?? e.message}`); }
    if (!r.ok) throw new Unreachable(`${endpoint}/json/list: HTTP ${r.status}`);
    return r.json();
  },
  evaluate(target, expr, signal) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(target.webSocketDebuggerUrl); } catch (e) { reject(new Unreachable(e.message)); return; }
      let opened = false;
      const done = (f, v) => { try { ws.close(); } catch { /* closed */ } f(v); };
      signal?.addEventListener('abort', () => done(reject, new Unreachable('timeout')));
      ws.onopen = () => {
        opened = true;
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
      };
      ws.onmessage = (m) => {
        let msg;
        try { msg = JSON.parse(m.data); } catch { return; }
        if (msg.id === 1) done(resolve, msg);
      };
      ws.onerror = () => done(reject, opened ? new Error('DevTools connection error') : new Unreachable('DevTools websocket refused'));
      ws.onclose = () => reject(new Unreachable('DevTools websocket closed'));
    });
  },
};

// argv (without node and script) -> { code, out: [lines], err: [lines] }
export async function run(argv, { transport = cdp, endpoint = ENDPOINT, timeoutMs = 3000 } = {}) {
  const out = [], err = [];
  const [cmd, ...rest] = argv;
  const flags = new Set(rest);
  const known = { show: ['--summon'], hide: [], status: [], models: [] };
  const idOk = cmd === 'model' && rest.length === 1 && /^[A-Za-z0-9_-]+$/.test(rest[0]);
  if (!idOk && (!(cmd in known) || rest.some((f) => !known[cmd].includes(f)))) { err.push(USAGE); return { code: EXIT.error, out, err }; }
  const args = cmd === 'show' ? { summon: flags.has('--summon') } : cmd === 'model' ? { id: rest[0] } : {};
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, no) => { timer = setTimeout(() => { ac.abort(); no(new Unreachable(`no answer within ${timeoutMs / 1000} s`)); }, timeoutMs); });
  try {
    const reply = await Promise.race([(async () => {
      const targets = await transport.list(endpoint, ac.signal);
      const target = Array.isArray(targets) && targets.find((t) => t.title === TITLE && t.webSocketDebuggerUrl);
      if (!target) throw new Unreachable(`no "${TITLE}" page at ${endpoint} (SteamVR not running?)`);
      return transport.evaluate(target, expression(METHOD[cmd], args), ac.signal);
    })(), timeout]);
    const ex = reply?.result?.exceptionDetails;
    if (reply?.error || ex) {
      err.push(`vr-pet: ${reply.error?.message ?? ex.exception?.description ?? ex.text ?? 'exception'}`);
      return { code: EXIT.error, out, err };
    }
    const v = reply?.result?.result?.value;
    if (v?.status === 'not-injected') { err.push('vr-pet: the cat is not in SteamVR (patch not injected yet?)'); return { code: EXIT.notInjected, out, err }; }
    if (v?.status === 'version') { err.push(`vr-pet: the cat's API is version ${v.version}, this is ${API_VERSION}`); return { code: EXIT.notInjected, out, err }; }
    if (v?.status !== 'ok') { err.push(`vr-pet: unexpected reply ${JSON.stringify(reply?.result?.result ?? reply)}`); return { code: EXIT.error, out, err }; }
    const r = v.value ?? {};
    if (r.error) { err.push(`vr-pet: ${r.error}${r.models ? ` (models: ${r.models.join(', ')})` : ''}`); return { code: EXIT.error, out, err }; }
    if (cmd === 'status') out.push(JSON.stringify(r));
    else if (cmd === 'models') {
      const w = Math.max(0, ...(r.models ?? []).map((m) => m.id.length));   // names in one column
      for (const m of r.models ?? []) out.push(`${m.id === r.current ? '*' : ' '} ${m.id.padEnd(w)}  ${m.name}`);
    }
    else if (cmd === 'model') out.push(r.was === r.model ? `vr-pet: already ${r.name}` : `vr-pet: now ${r.name}${r.hidden ? ' (hidden; shown as that)' : ''}`);
    else if (cmd === 'hide') out.push(r.was === 'hidden' ? 'vr-pet: already hidden' : 'vr-pet: hidden');
    else out.push(`vr-pet: ${r.was === 'hidden' ? 'shown' : 'already shown'}${r.summoned ? ' (summoned in front of you)' : ''}`);
    return { code: EXIT.ok, out, err };
  } catch (e) {
    if (e instanceof Unreachable) { err.push(`vr-pet: ${e.message}`); return { code: EXIT.unreachable, out, err }; }
    err.push(`vr-pet: ${e.message ?? e}`);
    return { code: EXIT.error, out, err };
  } finally {
    clearTimeout(timer);
  }
}

// node cli.mjs <args>
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await run(process.argv.slice(2));
  for (const l of r.out) console.log(l);
  for (const l of r.err) console.error(l);
  process.exit(r.code);
}
