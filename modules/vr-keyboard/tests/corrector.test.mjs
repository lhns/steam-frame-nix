// Offline check of corrector.js on the built dictionary.
// usage: node corrector.test.mjs <corrector.js> <decoder.js> <dictionary.js>
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const C = (0, eval)(readFileSync(process.argv[2], 'utf8'));
const D = (0, eval)(readFileSync(process.argv[3], 'utf8'));
const dict = D.parseDict(JSON.parse(readFileSync(process.argv[4], 'utf8')));
let t = performance.now();
const c = C.create(dict);
console.log(`index: ${dict.words.length} words, ${(performance.now() - t).toFixed(0)} ms`);
// German QWERTZ key centres in key widths (as patch.js passes them).
const KEYS = { q: [93.8, 73.5], w: [154.4, 73.5], e: [214.9, 73.5], r: [275.5, 73.5], t: [336.1, 73.5], z: [396.7, 73.5], u: [457.2, 73.5], i: [517.8, 73.5], o: [578.4, 73.5], p: [638.9, 73.5], a: [114.1, 120.5], s: [174.5, 120.5], d: [235.0, 120.5], f: [295.4, 120.5], g: [355.8, 120.5], h: [416.2, 120.5], j: [476.7, 120.5], k: [537.1, 120.5], l: [597.5, 120.5], y: [205.6, 167.5], x: [260.7, 167.5], c: [315.8, 167.5], v: [370.9, 167.5], b: [426.0, 167.5], n: [481.1, 167.5], m: [536.2, 167.5] };
c.setLayout(Object.fromEntries(Object.entries(KEYS).map(([k, [x, y]]) => [k, [x / 60.5, y / 60.5]])));
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('ok', name); };
const top = (w, n = 3) => c.corrections(w).slice(0, n);
const timed = [];
const corr = (w) => { const s = performance.now(); const r = c.corrections(w); timed.push(performance.now() - s); return r; };

ok('corrections in the top 3', () => {
  for (const [typed, want] of [['hsllo', 'hallo'], ['teh', 'the'], ['schoen', 'schön'], ['strasse', 'Straße'], ['cant', "can't"],
    ['dont', "don't"], ['vielleciht', 'vielleicht'], ['keyboad', 'keyboard'], ['Tastatrr', 'Tastatur'], ['gehst', null]]) {
    const r = corr(typed);
    if (want === null) { assert.deepEqual(r, [], typed); continue; }
    assert.ok(r.slice(0, 3).includes(want), `${typed} -> ${r.join(', ')}`);
  }
});
ok('no suggestions for valid words', () => {
  for (const w of ['hallo', 'Haus', 'haus', 'schön', 'Straße', "can't", 'the', 'keyboard', 'Wetter', 'über', 'gehen']) assert.deepEqual(corr(w), [], w);
});
ok('capitalisation kept', () => {
  assert.ok(top('Hsllo').includes('Hallo'), top('Hsllo').join());
  assert.ok(top('HSLLO').includes('HALLO'), top('HSLLO').join());
  assert.ok(top('Schoen').includes('Schön'));
});
ok('completions', () => {
  const s = performance.now();
  const r = c.completions('Hal');
  timed.push(performance.now() - s);
  assert.ok(r.includes('Hallo') || r.includes('Halle') || r.includes('Hälfte'), r.join());
  assert.ok(r.every((w) => w[0] === 'H'), r.join());
  assert.ok(c.completions('schö').includes('schön'), c.completions('schö').join());
  assert.ok(c.completions('could').includes("couldn't"), c.completions('could').join());
  assert.ok(c.completions('the').length > 0 && !c.completions('the').includes('the'));
  assert.deepEqual(c.completions('xqzv'), []);
});
ok('fast enough', () => {
  const words = ['hsllo', 'teh', 'vielleciht', 'Donaudampfschifffahrt', 'abcdefghijklmn', 'strasse', 'ich', 'Wettr', 'schreibn', 'kannst'];
  for (const w of words) corr(w);
  timed.sort((a, b) => a - b);
  const p = timed[Math.floor(timed.length * 0.9)], maxT = timed[timed.length - 1];
  console.log(`  ${timed.length} lookups: median ${timed[timed.length >> 1].toFixed(1)} ms, p90 ${p.toFixed(1)} ms, max ${maxT.toFixed(1)} ms`);
  assert.ok(p < 60, `p90 ${p} ms`);
});
ok('max is respected (candidates = 1 leaves no room for corrections)', () => {
  assert.deepEqual(c.corrections('hsllo', { max: 0 }), []);
  assert.equal(c.corrections('hsllo', { max: 1 }).length, 1);
  assert.deepEqual(c.completions('Hal', { max: 0 }), []);
});
ok('single letters and non-letters: nothing', () => {
  assert.deepEqual(c.corrections('x'), []);
  assert.deepEqual(c.corrections('123'), []);
  assert.deepEqual(c.completions(''), []);
});
console.log(`${passed} corrector tests passed`);
