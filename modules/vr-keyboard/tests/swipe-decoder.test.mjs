// Offline check of swipe-decoder.js with synthetic swipes on Steam's German VR
// keyboard (key centres measured in the keyboard popup, 854x280 CSS px).
// usage: node swipe-decoder.test.mjs <swipe-decoder.js> <dictionary.js>
//          [words-per-sample] [seed]
// Each word's path goes through its key centres with random offsets (up to
// about half a key), cuts corners (spline) and jitters. Prints top-1/top-3
// accuracy for frequent German and English words and a list of fixed words.
import { readFileSync } from 'node:fs';

const [, , decoderPath, dictPath, perLang = '300', seedArg = '1'] = process.argv;
const D = (0, eval)(readFileSync(decoderPath, 'utf8'));
const dict = D.parseDict(JSON.parse(readFileSync(dictPath, 'utf8')));

const KEYS = { ß: [659.0, 26.5], q: [93.8, 73.5], w: [154.4, 73.5], e: [214.9, 73.5], r: [275.5, 73.5], t: [336.1, 73.5], z: [396.7, 73.5], u: [457.2, 73.5], i: [517.8, 73.5], o: [578.4, 73.5], p: [638.9, 73.5], ü: [699.5, 73.5], a: [114.1, 120.5], s: [174.5, 120.5], d: [235.0, 120.5], f: [295.4, 120.5], g: [355.8, 120.5], h: [416.2, 120.5], j: [476.7, 120.5], k: [537.1, 120.5], l: [597.5, 120.5], ö: [658.0, 120.5], ä: [718.4, 120.5], y: [205.6, 167.5], x: [260.7, 167.5], c: [315.8, 167.5], v: [370.9, 167.5], b: [426.0, 167.5], n: [481.1, 167.5], m: [536.2, 167.5] };
const UNIT = 60.5;                                // key width (px)
const t0 = Date.now();
const lay = D.layout(dict, KEYS, UNIT);
console.log(`dictionary: ${dict.words.length} entries, layout ${Date.now() - t0} ms`);

let seed = +seedArg;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const clamp = (v, m) => Math.max(-m, Math.min(m, v));

let JITTER = 1.5;                                  // px per sample (laser shake)
function swipe(word, sigma) {
  const seq = [];
  for (const c of word.toLowerCase()) if (KEYS[c] && seq[seq.length - 1] !== c) seq.push(c);
  const way = seq.map((c) => [KEYS[c][0] + clamp(gauss() * sigma, 0.45) * UNIT, KEYS[c][1] + clamp(gauss() * sigma, 0.4) * 47]);
  // Catmull-Rom through the waypoints, ~3 px steps, plus jitter.
  const pts = [];
  const P = (i) => way[Math.max(0, Math.min(way.length - 1, i))];
  for (let i = 0; i < way.length - 1; i++) {
    const [p0, p1, p2, p3] = [P(i - 1), P(i), P(i + 1), P(i + 2)];
    const steps = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 3));
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      pts.push([f(p0[0], p1[0], p2[0], p3[0]) + gauss() * JITTER, f(p0[1], p1[1], p2[1], p3[1]) + gauss() * JITTER]);
    }
  }
  pts.push(way[way.length - 1]);
  return pts;
}

function evaluate(words, sigma, label, show = false) {
  let top1 = 0, top3 = 0, ms = 0;
  const misses = [];
  for (const w of words) {
    const t = performance.now();
    const res = D.decode(lay, swipe(w, sigma), { max: 5, unit: UNIT });
    ms += performance.now() - t;
    const rank = res.findIndex((r) => r.word === w);
    if (rank === 0) top1++;
    if (rank >= 0 && rank < 3) top3++;
    if (show || rank < 0 || rank >= 3) misses.push(`${w} -> ${res.slice(0, 3).map((r) => r.word).join(', ')}`);
  }
  const pc = (n) => `${((100 * n) / words.length).toFixed(1)}%`;
  console.log(`${label} (n=${words.length}, sigma ${sigma}): top-1 ${pc(top1)}, top-3 ${pc(top3)}, ${(ms / words.length).toFixed(1)} ms/word`);
  return misses;
}

// Frequent words per language: German ones contain an umlaut/ß or are in the
// de list's typical forms; simplest: take dictionary entries by rank and tell
// the language by a list check is not possible offline, so sample fixed ranges.
const pick = (from, to, n) => {
  const pool = dict.words.slice(from, to).filter((w) => [...w].length >= 2 && [...w].every((c) => KEYS[c.toLowerCase()] || "'-".includes(c)));
  const out = [];
  for (let i = 0; i < n && pool.length; i++) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
};
const n = +perLang;
const frequent = pick(0, 5000, n), mid = pick(5000, 30000, n);
const FIXED_DE = ['hallo', 'danke', 'bitte', 'Haus', 'schön', 'für', 'über', 'Straße', 'heute', 'morgen', 'wir', 'nicht', 'vielleicht', 'Tastatur', 'Wetter', 'gehen', 'können', 'möchte', 'Brille', 'spielen'];
const FIXED_EN = ["couldn't", "don't", "can't", "geht's", 'hello', 'thanks', 'the', 'keyboard', 'swipe', 'typing', 'world', 'would', 'should', 'because', 'people', 'something', 'window', 'games', 'steam'];
for (const sigma of [0.15, 0.25, 0.35]) {
  evaluate(frequent, sigma, 'rank <5000');
  evaluate(mid, sigma, 'rank 5000-30000');
}
const fixedMisses = evaluate([...FIXED_DE, ...FIXED_EN], 0.25, 'fixed de+en', true);
console.log(fixedMisses.join('\n'));
// Short words and contractions, several noisy paths each.
const SHORT = ["let's", "it's", "I'm", "that's", "don't", "can't", "he's", "we're", "geht's", "gibt's", 'lets', 'its', 'the', 'und', 'ist'];
const rep = []; for (let r = 0; r < 5; r++) rep.push(...SHORT);
console.log(evaluate(rep, 0.25, 'short words x5').join('\n'));
// Extra words from the configuration swipe like any other word.
for (const w of ['config', 'GitHub', 'SteamVR']) {
  if (!dict.words.includes(w)) continue;
  const top = D.decode(lay, swipe(w, 0.15), { max: 3, unit: UNIT }).map((r) => r.word);
  console.log(`${w}: ${top.join(', ')}`);
  if (top[0] !== w) { console.error(`${w} is not top-1 (sigma 0.15)`); process.exitCode = 1; }
}
// Words that share their letters with a contraction stay (is / i's, well / we'll).
{
  const must = (cond, msg) => { if (!cond) { console.error(msg); process.exitCode = 1; } };
  must(dict.words.includes('is'), '"is" missing from the dictionary');
  const is = D.decode(lay, swipe('is', 0), { max: 3, unit: UNIT }).map((r) => r.word);
  console.log(`is: ${is.join(', ')}`);
  must(is[0] === 'is', '"is" is not top-1 for an i-s swipe');
  const well = D.decode(lay, swipe('well', 0), { max: 5, unit: UNIT }).map((r) => r.word);
  console.log(`well: ${well.join(', ')}`);
  must(well.includes('well') && well.includes("we'll"), 'well and we\'ll not both offered');
}
// Shaky laser: 5 px jitter per sample.
JITTER = 5;
console.log(evaluate(rep, 0.25, 'short words x5, shaky').join('\n'));
evaluate(frequent, 0.25, 'rank <5000, shaky');
