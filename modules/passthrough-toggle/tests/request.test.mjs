// request.mjs: the passthrough-toggle relay's allowlist, helper arguments,
// result parsing and serial queue.
// usage: node request.test.mjs <request.mjs>
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { allowed, argsFor, parseResult, createQueue } = await import(pathToFileURL(process.argv[2]).href);
let passed = 0;
const test = (name, f) => { f(); passed++; console.log(`ok ${name}`); };

// ---- allowed ----
test('status is allowed with no source', () => {
  assert.equal(allowed({ id: 1, op: 'status' }), true);
  assert.equal(allowed({ id: 1, op: 'status', source: 'rgb' }), true);   // ignored, not rejected
});
test('set needs a valid source', () => {
  assert.equal(allowed({ id: 1, op: 'set', source: 'rgb' }), true);
  assert.equal(allowed({ id: 1, op: 'set', source: 'mono' }), true);
  assert.equal(allowed({ id: 1, op: 'set', source: 'color' }), false);
  assert.equal(allowed({ id: 1, op: 'set' }), false);
  assert.equal(allowed({ id: 1, op: 'set', source: '' }), false);
});
test('an id is required (status()/set() match replies by id)', () => {
  assert.equal(allowed({ op: 'status' }), false);
  assert.equal(allowed({ id: 'a', op: 'status' }), true);
  assert.equal(allowed({ id: null, op: 'status' }), false);
});
test('anything else is rejected', () => {
  for (const bad of [null, undefined, 1, 'status', [], { op: 'cycle' }, { op: 'set', source: 'rgb;mono' },
    { id: 1, op: '__proto__' }, { id: 1, op: 'set', source: ['rgb'] }]) {
    assert.equal(allowed(bad), false, JSON.stringify(bad));
  }
});
test('unknown extra fields on an otherwise-valid request are harmless (ignored, not rejected)', () => {
  assert.equal(allowed({ id: 1, op: 'status', extra: 'whatever' }), true);
});

// ---- argsFor ----
test('argsFor', () => {
  assert.deepEqual(argsFor({ op: 'status' }), ['status']);
  assert.deepEqual(argsFor({ op: 'set', source: 'rgb' }), ['set', 'rgb']);
  assert.deepEqual(argsFor({ op: 'set', source: 'mono' }), ['set', 'mono']);
});

// ---- parseResult ----
test('a well-formed reply passes through', () => {
  assert.deepEqual(parseResult('{"ok":true,"source":"mono"}\n', null), { ok: true, source: 'mono' });
});
test('the helper\'s own error JSON passes through even with a nonzero exit', () => {
  const error = new Error('Command failed'); error.code = 3;
  assert.deepEqual(parseResult('{"ok":false,"error":"interface missing"}\n', error), { ok: false, error: 'interface missing' });
});
test('a timeout (no usable stdout) is synthesised', () => {
  const error = new Error('killed'); error.killed = true;
  assert.deepEqual(parseResult('', error), { ok: false, error: 'the helper timed out' });
});
test('a crash with no JSON stdout is synthesised from the error message', () => {
  const error = new Error('spawn ENOENT');
  assert.deepEqual(parseResult(undefined, error), { ok: false, error: 'spawn ENOENT' });
});
test('garbage stdout with no error at all', () => {
  assert.deepEqual(parseResult('not json', null), { ok: false, error: 'the helper produced no output' });
  assert.deepEqual(parseResult('null', null), { ok: false, error: 'the helper produced no output' });
  assert.deepEqual(parseResult('"a string"', null), { ok: false, error: 'the helper produced no output' });
});

// ---- createQueue ----
await test('jobs run strictly one after another, in order', async () => {
  const run = createQueue();
  const order = [];
  const job = (n, ms) => async () => { order.push(`start ${n}`); await new Promise((r) => setTimeout(r, ms)); order.push(`end ${n}`); return n; };
  const results = await Promise.all([run(job(1, 30)), run(job(2, 0)), run(job(3, 10))]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
});
await test('a rejected job does not block the ones after it, and its own caller sees the rejection', async () => {
  const run = createQueue();
  const order = [];
  const p1 = run(async () => { order.push(1); throw new Error('boom'); });
  const p2 = run(async () => { order.push(2); return 'ok'; });
  await assert.rejects(p1, /boom/);
  assert.equal(await p2, 'ok');
  assert.deepEqual(order, [1, 2]);
});

console.log(`${passed} tests passed`);
