// Tests of the vr-pet CLI (cli.mjs) with a fake DevTools transport.
// usage: node cli.test.mjs   (exit 1 on failure)
// Run by the flake check `pet` (package.nix `tests`).
import { run, expression, API_VERSION, EXIT, Unreachable } from '../cli.mjs';

const TARGETS = [
  { title: 'Steam', webSocketDebuggerUrl: 'ws://x/steam' },
  { title: 'systemui', webSocketDebuggerUrl: 'ws://x/systemui' },
];
// A transport answering `value` (the page's reply object) for the systemui target.
const fake = ({ targets = TARGETS, value, reply, listError, evalError, hang } = {}) => {
  const calls = [];
  return {
    calls,
    async list(endpoint) { calls.push(['list', endpoint]); if (listError) throw listError; return targets; },
    async evaluate(target, expr) {
      calls.push(['evaluate', target.title, expr]);
      if (hang) return new Promise(() => {});
      if (evalError) throw evalError;
      return reply ?? { id: 1, result: { result: { type: 'object', value } } };
    },
  };
};
// The page side of the expression, evaluated against a fake window.
const evalIn = async (expr, window) => new Function('window', `return ${expr};`)(window);

let failed = 0;
const tests = [];
const test = (name, f) => tests.push([name, f]);
const assert = (c, msg) => { if (!c) throw new Error(msg); };

test('usage errors exit 4', async () => {
  for (const argv of [[], ['toggle'], ['show', '--now'], ['hide', '--summon'], ['status', 'x'], ['model'], ['model', 'a', 'b'], ['model', '"x'], ['models', 'x']]) {
    const t = fake();
    const r = await run(argv, { transport: t });
    assert(r.code === EXIT.error && r.code === 4 && /usage/.test(r.err[0]), `${argv.join(' ')}: ${r.code}`);
    assert(t.calls.length === 0, 'no DevTools call on a usage error');
  }
});

test('show: evaluates only __sfuiPet.api.show on the systemui page', async () => {
  const t = fake({ value: { status: 'ok', value: { hidden: false, was: 'hidden', summoned: false } } });
  const r = await run(['show'], { transport: t });
  assert(r.code === 0 && r.out[0] === 'vr-pet: shown', `${r.code} ${r.out}`);
  const [, title, expr] = t.calls[1];
  assert(title === 'systemui', `target ${title}`);
  assert(/window\.__sfuiPet\?\.api/.test(expr) && /api\["show"\]\(\{"summon":false\}\)/.test(expr), expr);
  assert(!/document|VRHTML|click|dispatch/.test(expr), 'nothing but the api');
  const s = await run(['show', '--summon'], { transport: fake({ value: { status: 'ok', value: { was: 'shown', summoned: true } } }) });
  assert(s.code === 0 && /already shown \(summoned/.test(s.out[0]), s.out[0]);
});

test('the expression: not injected, wrong version, ok (against a fake page)', async () => {
  const e = expression('show', { summon: true });
  assert((await evalIn(e, {})).status === 'not-injected', 'not injected');
  assert((await evalIn(e, { __sfuiPet: { api: { version: API_VERSION + 1 } } })).status === 'version', 'version');
  let got;
  const w = { __sfuiPet: { api: { version: API_VERSION, show: async (a) => { got = a; return { was: 'hidden' }; } } } };
  const v = await evalIn(e, w);
  assert(v.status === 'ok' && v.value.was === 'hidden' && got.summon === true, JSON.stringify(v));
});

test('hide and status', async () => {
  let r = await run(['hide'], { transport: fake({ value: { status: 'ok', value: { hidden: true, was: 'shown' } } }) });
  assert(r.code === 0 && r.out[0] === 'vr-pet: hidden', r.out[0]);
  r = await run(['hide'], { transport: fake({ value: { status: 'ok', value: { hidden: true, was: 'hidden' } } }) });
  assert(r.out[0] === 'vr-pet: already hidden', r.out[0]);
  r = await run(['status'], { transport: fake({ value: { status: 'ok', value: { hidden: false, pose: 'sit' } } }) });
  assert(r.code === 0 && JSON.parse(r.out[0]).pose === 'sit', r.out[0]);
});

test('unreachable: no endpoint, no systemui page, timeout -> 2', async () => {
  let r = await run(['status'], { transport: fake({ listError: new Unreachable('refused') }) });
  assert(r.code === 2 && /refused/.test(r.err[0]), `refused: ${r.code}`);
  r = await run(['status'], { transport: fake({ listError: new Error('bug') }) });
  assert(r.code === EXIT.error, `a transport bug: ${r.code}`);
  r = await run(['status'], { transport: fake({ targets: [TARGETS[0]] }) });
  assert(r.code === 2 && /no "systemui" page/.test(r.err[0]), `${r.code} ${r.err}`);
  r = await run(['status'], { transport: fake({ targets: {} }) });
  assert(r.code === 2, `bad list: ${r.code}`);
  const t0 = Date.now();
  r = await run(['status'], { transport: fake({ hang: true }), timeoutMs: 50 });
  assert(r.code === 2 && /no answer/.test(r.err[0]) && Date.now() - t0 < 1000, `timeout: ${r.code} ${r.err}`);
  // the real transport against a closed port
  r = await run(['status'], { endpoint: 'http://127.0.0.1:9', timeoutMs: 2000 });
  assert(r.code === 2, `closed port: ${r.code} ${r.err}`);
});

test('not injected / wrong version -> 3; page exception -> 4', async () => {
  let r = await run(['show'], { transport: fake({ value: { status: 'not-injected' } }) });
  assert(r.code === 3, `not injected: ${r.code}`);
  r = await run(['show'], { transport: fake({ value: { status: 'version', version: 9 } }) });
  assert(r.code === 3 && /version 9/.test(r.err[0]), `version: ${r.code} ${r.err}`);
  r = await run(['show'], { transport: fake({ reply: { id: 1, result: { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom' } } } } }) });
  assert(r.code === 4 && /boom/.test(r.err[0]), `exception: ${r.code} ${r.err}`);
  r = await run(['show'], { transport: fake({ reply: { id: 1, error: { message: 'Target closed' } } }) });
  assert(r.code === 4, `protocol error: ${r.code}`);
  r = await run(['show'], { transport: fake({ value: 'unchanged' }) });
  assert(r.code === 4, `odd reply: ${r.code}`);
});

test('models: lists the coats, the current one starred, names aligned past the longest id; only api.models is called', async () => {
  const t = fake({ value: { status: 'ok', value: { current: 'tuxedo', default: 'ginger', models: [{ id: 'ginger', name: 'Ginger' }, { id: 'tuxedo', name: 'Tuxedo' }, { id: 'dachshund', name: 'Dachshund' }] } } });
  const r = await run(['models'], { transport: t });
  const want = ['  ginger     Ginger', '* tuxedo     Tuxedo', '  dachshund  Dachshund'];
  assert(r.code === 0 && JSON.stringify(r.out) === JSON.stringify(want), JSON.stringify(r.out));
  assert(/api\["models"\]\(\{\}\)/.test(t.calls[1][2]), t.calls[1][2]);
});

test('model <id>: api.setModel({ id }); unknown -> 4 with the list; API version 2', async () => {
  assert(API_VERSION === 2, `API_VERSION ${API_VERSION}`);
  const t = fake({ value: { status: 'ok', value: { model: 'blue', was: 'ginger', name: 'Blue' } } });
  let r = await run(['model', 'blue'], { transport: t });
  assert(r.code === 0 && r.out[0] === 'vr-pet: now Blue', `${r.code} ${r.out}`);
  assert(/api\["setModel"\]\(\{"id":"blue"\}\)/.test(t.calls[1][2]), t.calls[1][2]);
  r = await run(['model', 'blue'], { transport: fake({ value: { status: 'ok', value: { model: 'blue', was: 'blue', name: 'Blue' } } }) });
  assert(r.code === 0 && r.out[0] === 'vr-pet: already Blue', r.out[0]);
  r = await run(['model', 'blue'], { transport: fake({ value: { status: 'ok', value: { model: 'blue', was: 'ginger', name: 'Blue', hidden: true } } }) });
  assert(/hidden/.test(r.out[0]), r.out[0]);
  r = await run(['model', 'lion'], { transport: fake({ value: { status: 'ok', value: { error: 'unknown model "lion"', model: 'blue', models: ['ginger', 'blue'] } } }) });
  assert(r.code === 4 && /unknown model "lion" \(models: ginger, blue\)/.test(r.err[0]), `${r.code} ${r.err}`);
  // an old page (API 1): not ours to call
  r = await run(['models'], { transport: fake({ value: { status: 'version', version: 1 } }) });
  assert(r.code === 3, `old API: ${r.code}`);
});

for (const [name, f] of tests) {
  try { await f(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.stack}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
