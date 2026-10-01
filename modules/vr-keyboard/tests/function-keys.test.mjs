// function-keys.js (keyboard.vr.functionKeys): when the strip shows F1-F12
// and that it shows the same suggestions again afterwards; the keys it types
// pass the extra keys' xdotool allowlist with any modifiers; the text model
// stays as it was while only AltGr changes and is reset by an F-key, like by
// Esc. usage: node function-keys.test.mjs <function-keys.js> <textmodel.js> <allowlist.mjs>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const F = (0, eval)(readFileSync(process.argv[2], 'utf8'));
const T = (0, eval)(readFileSync(process.argv[3], 'utf8'));
const { allowedCombo } = await import(pathToFileURL(process.argv[4]).href);
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok', name); }

// extraKeys' patch: VKX_<keysym> is sent as key:[ctrl+][alt+][shift+]<keysym>.
const sent = (key, { ctrl, alt, shift } = {}) =>
  [ctrl && 'ctrl', alt && 'alt', shift && 'shift', key.startsWith('VKX_') && key.slice(4)].filter(Boolean).join('+');

test('AltGr active: one-shot, locked, held (Steam toggle bits 1, 2, 4)', () => {
  for (const v of [1, 2, 4, 5, 6]) assert.equal(F.active({ AltGr: v }), true, `AltGr ${v}`);
  for (const ts of [{ AltGr: 0 }, {}, undefined, { Shift: 1, Control: 2, Alt: 4 }]) assert.equal(F.active(ts), false, JSON.stringify(ts));
});

test('the strip switches to F1-F12 and back to the same suggestions', () => {
  const cur = { kind: 'complete', items: ['hal', 'hallo', 'halt', 'halb'], index: 2, anchor: {} };
  const snapshot = structuredClone({ items: cur.items, index: cur.index });
  const before = F.view({ fnKeys: false, suggestions: cur });
  assert.deepEqual([before.kind, before.items, before.index], ['suggestions', cur.items, 2]);
  assert.equal(before.source, cur);
  const fk = F.view({ fnKeys: true, suggestions: cur });
  assert.deepEqual([fk.kind, fk.items, fk.index], ['fkeys', F.KEYS, -1]);
  assert.deepEqual(F.KEYS, ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);
  assert.notEqual(fk.source, cur);
  assert.equal(F.view({ fnKeys: true, suggestions: null }).source, fk.source, 'one F-key source (stale picks are detected by identity)');
  const after = F.view({ fnKeys: false, suggestions: cur });
  assert.deepEqual(after, before, 'same items, selection and source');
  assert.deepEqual({ items: cur.items, index: cur.index }, snapshot, 'suggestions untouched');
});

test('F-keys without suggestions; nothing without either', () => {
  assert.equal(F.view({ fnKeys: true, suggestions: null }).kind, 'fkeys');
  assert.equal(F.view({ fnKeys: false, suggestions: null }), null);
});

test('buttons type VKX_F1..F12, accepted by the helper with any modifiers', () => {
  for (let i = 0; i < 12; i++) {
    const key = F.keyOf(i);
    assert.equal(key, `VKX_F${i + 1}`);
    for (const ctrl of [false, true]) for (const alt of [false, true]) for (const shift of [false, true]) {
      const combo = sent(key, { ctrl, alt, shift });
      assert.equal(allowedCombo(combo), true, combo);
    }
  }
  for (const i of [-1, 12, 1.5, '1', null, undefined]) assert.equal(F.keyOf(i), null, String(i));
  assert.equal(allowedCombo('ctrl+alt+shift+Return'), false, 'never Enter');
});

test('text model: kept while AltGr toggles, reset by an F-key like by Esc', () => {
  const m = T.create({ size: 64 });
  for (const c of 'Hallo') { m.freeze(); m.observe(c); }
  const a = m.anchor(5);
  // AltGr on and off: a toggle, nothing reaches the model (patch.js skips toggles).
  assert.equal(m.anchorIntact(a), true);
  // An F-key is an extra key (VKX_): patch.js resets the model for those, as for VKX_Escape.
  for (const key of [F.keyOf(4), 'VKX_Escape']) {
    assert.ok(key.startsWith('VKX_'), key);
    const m2 = T.create({ size: 64 });
    for (const c of 'Hallo') { m2.freeze(); m2.observe(c); }
    const a2 = m2.anchor(5);
    m2.reset(`key ${key}`);
    assert.equal(m2.anchorIntact(a2), false, key);
    assert.equal(m2.text, '', key);
  }
});

console.log(`function-keys: ${passed} tests passed`);
