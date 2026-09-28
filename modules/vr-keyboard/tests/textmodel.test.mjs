// textmodel.js against a simulated text field. Like patch.js: every emitted
// key reaches the model; a tapped key also freezes anchors first (the
// TypeKeyInternal hook). usage: node textmodel.test.mjs <textmodel.js>
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const T = (0, eval)(readFileSync(process.argv[2], 'utf8'));
let passed = 0;
function setup(size = 64) {
  const m = T.create({ size });
  const f = { text: '' };
  const raw = (key) => {
    if (key === 'Backspace') f.text = [...f.text].slice(0, -1).join('');
    else if ([...key].length === 1) f.text += key;
    else if (key === 'Enter') f.text += '\n';
    m.observe(key);
  };
  const out = (key) => { m.freeze(); raw(key); };   // a tapped key
  // Our output, with a pause after non-ASCII characters (as in the patch).
  const emit = async (k) => { raw(k); if (k.codePointAt(0) > 127) await new Promise((r) => setTimeout(r, 1)); };
  const tap = (s) => { for (const c of s) out(c); };
  // The last swipe, as patch.js tracks it.
  let last = null;
  const swipe = async (w) => { const r = await m.commitWord(emit, w); last = r.anchor; return r; };
  const replace = async (w) => { const a = await m.replaceAnchored(last, emit, w); if (a) last = a; return !!a; };
  return { m, f, out, emit, tap, swipe, replace };
}
async function test(name, fn) { await fn(); passed++; console.log('ok', name); }

await test('switch 3 -> 7 -> 2 letters, no space at start', async () => {
  const { m, f, emit, swipe, replace } = setup();
  await swipe('die');
  assert.equal(f.text, 'die');
  assert.ok(await replace('dienten'));
  assert.equal(f.text, 'dienten');
  assert.ok(await replace('du'));
  assert.equal(f.text, 'du');
});
await test('auto-space after a swipe, replacement keeps it', async () => {
  const { m, f, emit, swipe, replace } = setup();
  await swipe('Hallo');
  await swipe('die');
  assert.equal(f.text, 'Hallo die');
  await replace('dienten'); await replace('du');
  assert.equal(f.text, 'Hallo du');
});
await test('umlauts and ß count as one character each', async () => {
  const { m, f, emit, tap, swipe, replace } = setup();
  tap('Ja');
  await swipe('schön');
  assert.equal(f.text, 'Ja schön');
  await replace('Straße'); assert.equal(f.text, 'Ja Straße');
  await replace('für'); assert.equal(f.text, 'Ja für');
  await replace('übergrößen'); assert.equal(f.text, 'Ja übergrößen');
});
await test('auto-space rules', async () => {
  for (const [before, space] of [['Hallo', true], ['Hallo ', false], ['Hallo.', true], ['Hallo,', true], ['wirklich?', true],
    ['(', false], ['„', false], ['"', false], ['a-', false], ['', false]]) {
    const { m, f, emit, tap, swipe, replace } = setup();
    tap(before);
    await swipe('du');
    assert.equal(f.text, before + (space ? ' ' : '') + 'du', `after ${JSON.stringify(before)}`);
  }
});
await test('manual Backspace inside the word freezes it; buffer stays right', async () => {
  const { m, f, emit, out, swipe, replace } = setup();
  await swipe('Hallo'); await swipe('Welt');
  out('Backspace');
  assert.equal(f.text, 'Hallo Wel');
  assert.equal(await replace('du'), false);
  assert.equal(f.text, 'Hallo Wel');
  // Delete the rest of the word: the auto-space stays, the next swipe adds none.
  for (let i = 0; i < 3; i++) out('Backspace');
  assert.equal(f.text, 'Hallo ');
  await swipe('du');
  assert.equal(f.text, 'Hallo du');
  // And after deleting the space too, one space again.
  for (let i = 0; i < 3; i++) out('Backspace');
  await swipe('du');
  assert.equal(f.text, 'Hallo du');
  assert.ok(await replace('die')); assert.equal(f.text, 'Hallo die');
});
await test('a tap after the word freezes it; next swipe spaced', async () => {
  const { m, f, emit, tap, swipe, replace } = setup();
  await swipe('Hallo');
  tap('!');
  assert.equal(await replace('Halle'), false);
  assert.equal(f.text, 'Hallo!');
  await swipe('wie');
  assert.equal(f.text, 'Hallo! wie');
  tap(' ');
  await swipe('geht');
  assert.equal(f.text, 'Hallo! wie geht');
});
await test('tap, then Backspace of that tap: word still frozen (never mangles)', async () => {
  const { m, f, emit, tap, out, swipe, replace } = setup();
  await swipe('Hallo');
  tap('x'); out('Backspace');
  assert.equal(await replace('Halle'), false);
  assert.equal(f.text, 'Hallo');
});
await test('Enter resets: no space, no replacement', async () => {
  const { m, f, emit, out, swipe, replace } = setup();
  await swipe('Hallo');
  out('Enter');
  assert.equal(await replace('Halle'), false);
  await swipe('du');
  assert.equal(f.text, 'Hallo\ndu');
});
await test('reset (idle, keyboard closed, target change): no space, frozen', async () => {
  const { m, f, emit, swipe, replace } = setup();
  await swipe('Hallo');
  m.reset('idle');
  await swipe('du');
  assert.equal(f.text, 'Hallodu');
  assert.ok(await replace('die')); assert.equal(f.text, 'Hallodie');
});
await test('other keys (arrows, Tab) reset', async () => {
  const { m, f, emit, out, swipe, replace } = setup();
  await swipe('Hallo');
  out('ArrowLeft');
  assert.equal(await replace('Halle'), false);
  await swipe('du');
  assert.equal(f.text, 'Hallodu');
});
await test('buffer overflow: bounded, long word beyond the buffer frozen', async () => {
  const { m, f, emit, tap, swipe, replace } = setup(8);
  tap('abcdefghijklmnop');
  assert.equal(m.text, 'ijklmnop');
  await swipe('du');
  assert.equal(f.text, 'abcdefghijklmnop du');
  assert.equal(m.text.length, 8);
  assert.ok(await replace('die'));
  await swipe('Donaudampfschiff');     // 1 + 16 > 8: can't prove it intact
  assert.equal(await replace('x'), false);
  assert.equal(f.text, 'abcdefghijklmnop die Donaudampfschiff');
});
await test('deleting past the known text: unknown, no auto-space', async () => {
  const { m, f, emit, tap, out, swipe, replace } = setup();
  tap('ab'); out('Backspace'); out('Backspace'); out('Backspace');
  await swipe('du');
  assert.equal(f.text, 'du');
});
await test("contractions: apostrophes count as characters", async () => {
  const { m, f, emit, tap, swipe, replace } = setup();
  tap('I');
  await swipe("couldn't");
  assert.equal(f.text, "I couldn't");
  assert.ok(await replace('could')); assert.equal(f.text, 'I could');
  assert.ok(await replace("can't")); assert.equal(f.text, "I can't");
  assert.ok(await replace('E-Mail')); assert.equal(f.text, 'I E-Mail');
  tap("'");
  await swipe('geht');
  assert.equal(f.text, "I E-Mail'geht", "' may open a quote: no space");
});
// A Backspace drag as patch.js does it: characters deleted after `travel`
// px, with px per character and a detent of detentPx before a word border.
function dragDeletes(borders, travel, px = 25, detentPx = 90) {
  let need = 0, k = 0;
  for (;;) {
    need += px + (borders[k] ? detentPx : 0);
    if (need > travel) return k;
    k++;
  }
}
await test('Backspace drag: word borders', async () => {
  for (const [typed, expect] of [['Hallo wie', 'Hallo '], ['Hallo wie ', 'Hallo '], ['Hallo wie. ', 'Hallo '], ['Hallo wie?', 'Hallo '],
    ["I couldn't", 'I '], ['per E-Mail', 'per '], ['Hallo', ''], ['Hallo, ', ''], ['a  b  ', 'a  '], ['x(y', 'x(']]) {
    const { m, f, tap, out, swipe, replace } = setup();
    tap(typed);
    const b = m.wordBorders();
    const stop = b.indexOf(true);
    // Far past the word (up to 100 px more), but not the 25 + 90 px of the border.
    const n = dragDeletes(b, 25 * (stop === -1 ? b.length : stop) + 100);
    if (stop !== -1) assert.equal(n, stop, JSON.stringify(typed));
    for (let i = 0; i < Math.min(n, b.length); i++) out('Backspace');
    assert.equal(f.text, expect, JSON.stringify(typed));
  }
});
await test('Backspace drag: crossing a border with enough travel, consecutive drags', async () => {
  const { m, f, tap, out, swipe, replace } = setup();
  tap('Hallo wie geht');
  const drag = (travel) => { const n = dragDeletes(m.wordBorders(), travel); for (let i = 0; i < n; i++) out('Backspace'); };
  drag(200);                                   // "geht" = 4 x 25 = 100 px; the space needs 25 + 90 more
  assert.equal(f.text, 'Hallo wie ');
  drag(25 + 90 + 3 * 25 + 10);                 // across the border: the space and "wie", stops before the next
  assert.equal(f.text, 'Hallo ');
  drag(25 + 25);                               // only what's before the cursor's space goes first: " " then "o"
  assert.equal(f.text, 'Hall');
  drag(1000); assert.equal(f.text, '');
  const b = m.wordBorders();
  assert.deepEqual(b, [], 'nothing known: no borders (plain per character)');
  f.text = 'unbekannt';
  drag(5 * 25); assert.equal(f.text, 'unbe', 'unknown text: plain per character');
});
await test('Backspace drag: swiped word and its auto-space', async () => {
  const { m, f, emit, out, swipe, replace } = setup();
  await swipe('Hallo'); await swipe('wie');
  const n = dragDeletes(m.wordBorders(), 150);
  for (let i = 0; i < n; i++) out('Backspace');
  assert.equal(f.text, 'Hallo ', 'the swiped word; its auto-space stays (border)');
});
// A drag gesture as patch.js runs it: move to `travel`, deletes/restores.
async function dragTo(m, g, emit, travel) {
  const t = g.target(travel);
  while (g.applied < t) await m.dragDelete(g, emit);
  while (g.applied > t) if (!(await m.dragRestore(g, emit))) break;
}
await test('drag back right restores: 5 -> 3 -> 5 -> 0', async () => {
  const { m, f, tap, emit, swipe, replace } = setup();
  tap('Hallo Welt');
  const g = m.dragStart({ px: 25, detentPx: 90 });
  await dragTo(m, g, emit, 5 * 25 + 89); assert.equal(f.text, 'Hallo ', 'Welt, stuck before the space');
  await dragTo(m, g, emit, 25 + 5); assert.equal(f.text, 'Hallo Wel', 'restore to 1 deleted');
  await dragTo(m, g, emit, 3 * 25); assert.equal(f.text, 'Hallo W');
  await dragTo(m, g, emit, 5 * 25 + 90); assert.equal(f.text, 'Hallo', 'across the border');
  await dragTo(m, g, emit, -50); assert.equal(f.text, 'Hallo Welt', 'all restored, not more');
  assert.equal(m.text, 'Hallo Welt');
});
await test('drag restore across a word border (symmetric detent)', async () => {
  const { m, f, tap, emit, swipe, replace } = setup();
  tap('ab cd');
  const g = m.dragStart({ px: 25, detentPx: 90 });
  await dragTo(m, g, emit, 2 * 25 + 90 + 24); assert.equal(f.text, 'ab ', 'at the border: 25 + 90 px more needed');
  await dragTo(m, g, emit, 2 * 25 + 90 + 25); assert.equal(f.text, 'ab', 'over the border');
  await dragTo(m, g, emit, 2 * 25 + 90 + 24); assert.equal(f.text, 'ab ', 'back over the border (same distance)');
  await dragTo(m, g, emit, 0); assert.equal(f.text, 'ab cd');
});
await test('drag: after an unknown delete nothing is retyped; umlauts are', async () => {
  const { m, f, tap, emit, swipe, replace } = setup();
  f.text = 'alt ';                                  // not typed by the keyboard
  tap('für');
  const g = m.dragStart({ px: 25, detentPx: 90 });
  await dragTo(m, g, emit, 3 * 25); assert.equal(f.text, 'alt ');
  await dragTo(m, g, emit, 3 * 25 + 114); assert.equal(f.text, 'alt ', 'stuck at the start of the known text');
  await dragTo(m, g, emit, 3 * 25 + 115 + 25); assert.equal(f.text, 'al', 'blind deletes past the known text');
  await dragTo(m, g, emit, 0); assert.equal(f.text, 'al', 'strict: unknown deleted, nothing retyped');
  const { m: m2, f: f2, tap: tap2, emit: emit2 } = setup();
  tap2('Grüße');
  const g2 = m2.dragStart({ px: 25, detentPx: 90 });
  await dragTo(m2, g2, emit2, 4 * 25); assert.equal(f2.text, 'G');
  await dragTo(m2, g2, emit2, 0); assert.equal(f2.text, 'Grüße');
});
await test('drag: something else typed in between stops restoring', async () => {
  const { m, f, tap, emit, swipe, replace } = setup();
  tap('Hallo');
  const g = m.dragStart({ px: 25, detentPx: 90 });
  await dragTo(m, g, emit, 2 * 25); assert.equal(f.text, 'Hal');
  tap('x');
  await dragTo(m, g, emit, 0); assert.equal(f.text, 'Halx');
});
await test('drag over a swiped word: restored or not, it stays frozen', async () => {
  const { m, f, emit, swipe, replace } = setup();
  await swipe('Hallo'); await swipe('wie');
  const g = m.dragStart({ px: 25, detentPx: 90 });
  await dragTo(m, g, emit, 50); await dragTo(m, g, emit, 0);
  assert.equal(f.text, 'Hallo wie');
  assert.equal(await replace('die'), false, 'touched: frozen');
});
await test('tap-typed words: whole only when the start is known', async () => {
  const { m, tap, out, swipe, replace } = setup();
  tap('hsllo ');
  assert.equal(m.endedWord(), null, 'after an idle/unknown start the word may be longer');
  out('Enter');                                 // boundary
  tap('hsllo ');
  assert.deepEqual(m.endedWord(), { word: 'hsllo', term: ' ', n: 6 });
  tap('Wie');
  assert.deepEqual(m.currentWord(), { text: 'Wie', n: 3 });
  tap('?');
  assert.deepEqual(m.endedWord(), { word: 'Wie', term: '?', n: 4 });
  tap(' ');
  assert.equal(m.endedWord(), null, 'two terminators: the word is not "just finished"');
  m.reset('opened', { boundary: true }); tap('ab');
  assert.deepEqual(m.currentWord(), { text: 'ab', n: 2 });
});
await test('correction replace keeps the terminator; edits freeze the anchor', async () => {
  const { m: m2, f: f2, emit: e2, tap: t2, out: o2, swipe, replace } = setup();
  o2('Enter'); f2.text = '';
  t2('Ich sage hsllo,');
  const w = m2.endedWord();
  assert.deepEqual([w.word, w.term, w.n], ['hsllo', ',', 6]);
  let a = m2.anchor(w.n);
  a = await m2.replaceAnchored(a, e2, 'hallo' + w.term); assert.equal(f2.text, 'Ich sage hallo,');
  a = await m2.replaceAnchored(a, e2, 'Hallen' + w.term); assert.equal(f2.text, 'Ich sage Hallen,');
  a = await m2.replaceAnchored(a, e2, 'hsllo' + w.term); assert.equal(f2.text, 'Ich sage hsllo,', 'back to the original');
  t2(' ');
  assert.equal(await m2.replaceAnchored(a, e2, 'hallo,'), null, 'typed after it: frozen');
  o2('Backspace');
  assert.equal(await m2.replaceAnchored(a, e2, 'hallo,'), null, 'a tap froze it, even once deleted again');
  assert.equal(f2.text, 'Ich sage hsllo,');
  assert.equal(await m2.replaceAnchored(m2.anchor(0), e2, 'x'), null, 'empty anchor');
  const b = m2.anchor(6); m2.observe('Backspace'); m2.observe(',');   // untagged re-typing, no freeze
  assert.equal(await m2.replaceAnchored(b, e2, 'x'), null, 'retyped terminator: new characters, not provably the same');
});
await test('completion: prefix -> word (no space), switchable incl. back to the prefix, next swipe auto-spaced', async () => {
  const { m, f, emit, tap, out, swipe } = setup();
  out('Enter'); f.text = '';
  tap('Das ist schö');
  const cw = m.currentWord();
  assert.deepEqual(cw, { text: 'schö', n: 4 });
  let a = await m.replaceAnchored(m.anchor(cw.n), emit, 'schön');
  assert.equal(f.text, 'Das ist schön');
  a = await m.replaceAnchored(a, emit, 'schöne');
  assert.equal(f.text, 'Das ist schöne', 'another completion replaces the picked one exactly');
  a = await m.replaceAnchored(a, emit, 'schö');
  assert.equal(f.text, 'Das ist schö', 'back to the typed prefix (first strip entry)');
  a = await m.replaceAnchored(a, emit, 'schöne');
  await swipe('Tag');
  assert.equal(f.text, 'Das ist schöne Tag', 'the next swipe gets its auto-space');
});
await test('idle reset is a word boundary (suggestions for the next word)', async () => {
  const { m, tap } = setup();
  tap('abc');
  m.reset('idle', { boundary: true });
  tap('hsllo ');
  assert.deepEqual(m.endedWord(), { word: 'hsllo', term: ' ', n: 6 });
});
await test('drag: "hello world" stops at "hello ", then at the known start', async () => {
  const { m, f, tap, emit } = setup();
  m.reset('opened', { boundary: true }); f.text = 'alt ';          // text before the keyboard's
  tap('hello world');
  const g = m.dragStart({ px: 25, detentPx: 90 });
  await dragTo(m, g, emit, 5 * 25 + 114); assert.equal(f.text, 'alt hello ', 'world gone, stuck before the space');
  await dragTo(m, g, emit, 5 * 25 + 115 + 5 * 25 + 114); assert.equal(f.text, 'alt ', 'space + hello gone, stuck at the known start');
  await dragTo(m, g, emit, 5 * 25 + 115 + 5 * 25 + 115); assert.equal(f.text, 'alt', 'across the start: unknown text');
  assert.equal(g.stats.unknown, 1);
  await dragTo(m, g, emit, 0); assert.equal(f.text, 'alt', 'strict: after an unknown delete nothing is retyped');
  assert.deepEqual([g.stats.restored, g.stats.stop], [0, 'unknown deleted']);
  const { m: m2, f: f2, tap: tap2, emit: emit2 } = setup();
  m2.reset('opened', { boundary: true }); f2.text = 'alt ';
  tap2('hello world');
  const g2 = m2.dragStart({ px: 25, detentPx: 90 });
  await dragTo(m2, g2, emit2, 5 * 25 + 115 + 5 * 25 + 114); assert.equal(f2.text, 'alt ', 'at the known start');
  await dragTo(m2, g2, emit2, 0); assert.equal(f2.text, 'alt hello world', 'no unknown delete: full restore');
  assert.deepEqual([g2.stats.restored, g2.stats.stop], [11, '']);
});
await test('drag: start of a line (after Enter) is a border too', async () => {
  const { m, f, out, emit } = setup();
  out('Enter');
  const g = m.dragStart({ px: 25, detentPx: 90 });
  await dragTo(m, g, emit, 110); assert.equal(f.text, '\n', 'not yet: 25 + 90 px');
  await dragTo(m, g, emit, 115); assert.equal(f.text, '');
});
await test('drag: suggestion lookups during the drag do not stop restoring', async () => {
  const { m, f, tap, emit } = setup();
  m.reset('opened', { boundary: true });
  tap('hello wor');
  const g = m.dragStart({ px: 25, detentPx: 90 });
  await dragTo(m, g, emit, 50);
  m.currentWord(); m.endedWord(); m.anchor(2);   // what suggest() reads
  await dragTo(m, g, emit, 0); assert.equal(f.text, 'hello wor');
  assert.equal(g.stats.stop, '');
});
console.log(`${passed} text model tests passed`);
