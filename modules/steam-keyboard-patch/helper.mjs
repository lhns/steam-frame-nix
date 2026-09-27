// helper.mjs: injects the patch (patch.js wrapped with the finder library by
// lib/default.nix mkPatch) into Steam's UI via CEF DevTools and
// performs the key requests of the patched VR keyboard with xdotool on :0.
// On SIGTERM/SIGINT it reverts the patch (unpatch.js), so stopping the service
// restores Steam's stock keyboard without restarting Steam.
// usage: node helper.mjs <patch.js> <unpatch.js> [xdotool]
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

const [, , patchPath, unpatchPath, xdotool = 'xdotool'] = process.argv;
const PATCH = readFileSync(patchPath, 'utf8');
const UNPATCH = readFileSync(unpatchPath, 'utf8');
let current = null;                               // CDP `call` of the live session, if any
const CDP = 'http://127.0.0.1:8080/json/list';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// :0 is the Steam session's Xwayland, where the VR app windows live.
const ENV = { ...process.env, DISPLAY: process.env.VRKBD_DISPLAY || ':0', LC_ALL: 'C.UTF-8' };

// Allowlist: requests come from Steam's UI JS, so the helper must not be able
// to type ASCII text or press Enter on its behalf. Accepted:
//  key:<combo>  the extra keys (Esc, Del, Home, End, PgUp/PgDn, arrows),
//               optionally with modifiers; or ctrl and/or alt (+ optional
//               shift) with one key
//  type:<char>  one character Steam's key emulation can't produce: non-ASCII
//               (äöüß€§°´…) or | @ { [ ] } \ ~ ^ `
//  down:<mod> / up:<mod>   hold/release ctrl or alt
const SPECIAL = new Set(['Escape', 'Delete', 'Home', 'End', 'Prior', 'Next', 'Left', 'Right', 'Up', 'Down']);
const KEY = /^([a-z0-9]|space|BackSpace|Tab|period|comma|minus|plus|numbersign|less|slash|ssharp|udiaeresis|odiaeresis|adiaeresis)$/;
const MODKEY = { ctrl: 'Control_L', alt: 'Alt_L' };
function allowedCombo(combo) {
  const parts = combo.split('+');
  const key = parts.pop();
  const mods = new Set(parts);
  if (parts.length !== mods.size || ![...mods].every((m) => ['ctrl', 'alt', 'shift'].includes(m))) return false;
  if (SPECIAL.has(key)) return true;
  return KEY.test(key) && (mods.has('ctrl') || mods.has('alt'));
}
function allowedChar(c) {
  if ([...c].length !== 1) return false;
  const cp = c.codePointAt(0);
  return (cp > 0xa0 && !/\s|\p{C}/u.test(c)) || '|@{[]}\\~^`'.includes(c);
}

const held = new Set();                           // modifiers currently held down via keydown
const xdo = (args) => execFile(xdotool, args, { env: ENV }, (err) => err && console.error('xdotool', args.join(' '), err.message));
function releaseAll() { for (const m of held) xdo(['keyup', MODKEY[m]]); held.clear(); }

function handle(msg) {
  if (typeof msg !== 'string') return;
  const i = msg.indexOf(':');
  const op = msg.slice(0, i), arg = msg.slice(i + 1);
  if (op === 'key' && allowedCombo(arg)) {
    // Modifiers already held down stay pressed; don't press/release them again.
    const parts = arg.split('+');
    const key = parts.pop();
    return xdo(['key', '--', [...parts.filter((m) => !held.has(m)), key].join('+')]);
  }
  if (op === 'type' && allowedChar(arg)) return xdo(['type', '--', arg]);
  if ((op === 'down' || op === 'up') && MODKEY[arg]) {
    if (op === 'down') held.add(arg); else held.delete(arg);
    return xdo([op === 'down' ? 'keydown' : 'keyup', MODKEY[arg]]);
  }
  console.error('rejected', msg);
}

async function session() {
  const list = await (await fetch(CDP)).json();
  const t = list.find((x) => x.title === 'SharedJSContext');
  if (!t) throw new Error('SharedJSContext not found');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const call = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  let last;                                       // logged when it changes (e.g. a signature error once, not every 15 s)
  const inject = async () => {
    const r = await call('Runtime.evaluate', { expression: PATCH, returnByValue: true });
    const v = r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
    if (v !== last || process.env.VRKBD_VERBOSE) console.log('inject:', v);
    last = v;
  };
  // New JS contexts (UI reload, popups) come in bursts: inject once after them.
  let soon = null;
  const injectSoon = () => { clearTimeout(soon); soon = setTimeout(() => inject().catch(() => {}), 3000); };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.bindingCalled' && m.params.name === '__vrkbdKey') handle(m.params.payload);
    else if (m.method === 'Runtime.executionContextCreated') injectSoon();
  };
  const closed = new Promise((res) => {
    ws.onclose = () => {
      current = null;
      clearTimeout(soon);
      for (const r of pending.values()) r({});    // unblock calls that will never be answered
      pending.clear();
      res();
    };
  });
  current = call;
  await call('Runtime.enable');
  await call('Runtime.addBinding', { name: '__vrkbdKey' });
  // Nothing is held by this helper instance; make the page re-send holds.
  await call('Runtime.evaluate', { expression: 'window.__vrkbdHeld = { ctrl: false, alt: false }' });
  console.log('connected');
  await inject();
  // Re-apply periodically: keyboard popup recreated, layouts switched, UI reloaded.
  const timer = setInterval(() => inject().catch(() => {}), 15000);
  await closed;
  clearInterval(timer);
  releaseAll();
}

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
  releaseAll();
  if (current) {
    const r = await Promise.race([current('Runtime.evaluate', { expression: UNPATCH, returnByValue: true }), sleep(2000)]);
    console.log('unpatch:', r?.result?.result?.value ?? 'timeout');
  }
  setTimeout(() => process.exit(0), 200);
});

for (;;) {
  try { await session(); console.log('disconnected'); }
  catch (e) { console.error('retry:', e.message); }
  releaseAll();
  await sleep(5000);
}
