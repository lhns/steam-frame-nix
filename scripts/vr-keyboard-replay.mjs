// Replays recorded swipes (window.__sfuiSwipePaths of Steam's SharedJSContext,
// saved as JSON) through the decoder: top candidates and the cost terms of
// the expected word. The dictionary is the built vr-keyboard-dictionary.js.
// usage: node scripts/vr-keyboard-replay.mjs modules/vr-keyboard/swipe-decoder.js
//          <dictionary.js> <paths.json> [word]
import { readFileSync } from 'node:fs';
const [, , decoderPath, dictPath, pathsPath, expected] = process.argv;
const D = (0, eval)(readFileSync(decoderPath, 'utf8'));
const dict = D.parseDict(JSON.parse(readFileSync(dictPath, 'utf8')));
for (const [i, p] of JSON.parse(readFileSync(pathsPath, 'utf8')).entries()) {
  const lay = D.layout(dict, p.keys, p.unit);
  const res = D.decode(lay, p.pts, { unit: p.unit, max: 8 });
  console.log(`#${i}: recorded ${p.top.join(' ')}\n  now ${res.map((r) => `${r.word} ${r.cost.toFixed(2)}`).join(', ')}`);
  if (expected) {
    const f = D.decode(lay, p.pts, { unit: p.unit, features: true }).find((x) => x.word === expected);
    console.log(`  ${expected}: ${f ? JSON.stringify(f.f) : 'pruned (start/end key or a letter too far from the path)'}`);
  }
}
