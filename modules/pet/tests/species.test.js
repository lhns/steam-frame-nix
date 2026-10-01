// Headless tests of the behaviour core (core.js) with other animals: a
// synthetic species (the cat's frames without sit, groom, dangle, ...), and
// every frame set of the model catalog (the cat, the animals): the core only
// ever asks for clips that are baked (the world: sim.js).
// usage: node species.test.js <models.json>   (exit 1 on failure)
// Run by the flake check `pet` (package.nix `tests`).
'use strict';
const fs = require('fs');
const { sim, test, assert, done } = require('./sim.js');
const catalog = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));   // index.py's models.json

// The cat's frame set with clips taken away (and an action of its own).
const catBaked = catalog.frameSets[catalog.models[catalog.order.find((id) => catalog.models[id].kind === 'base')].frames];
function without(names, extra = {}) {
  const b = JSON.parse(JSON.stringify(catBaked));
  for (const n of names) delete b.clips[n];
  delete b.poseZones.dangle;
  Object.assign(b, extra);
  return b;
}
const NO_SIT = ['sit', 'sitdown', 'standup', 'sitpurr', 'sitpurrin', 'groom', 'dangle'];
const synthetic = () => {
  const b = without(NO_SIT);
  b.clips.sniff = { ...b.clips.stretch };   // (an action of its own: any one-shot clip standing)
  b.species = { actions: { sniff: { pose: 'stand', weight: 4, cooldown: 20 } } };
  return b;
};
// A slow stroke along the back for `s` seconds (the hand follows the cat).
const stroke = (a) => (t) => { const b = a.cat.zone('back'); return b && { x: b.x + 0.02 * Math.sin(t * 3), y: b.y + 0.03, z: b.z, press: 0 }; };

// ---------------------------------------------------------------------------

test('synthetic species (no sit, groom, dangle): a calm hour uses only its clips, its own action', () => {
  const b = synthetic();
  const s = sim(b, 31);
  const sp = s.cat.species();
  assert(!sp.poses.includes('sit') && sp.poses.includes('lie') && sp.actions.includes('sniff') && !sp.actions.includes('groom'),
    `species: ${JSON.stringify(sp)}`);
  assert(sp.clips.every((c) => b.clips[c]), `species clips all baked (${sp.clips.filter((c) => !b.clips[c])})`);
  s.run(60 * 60, (x) => assert(x.pose !== 'sit' && x.goal !== 'sit', `sat (${x.pose} / ${x.goal})`));
  const shown = s.clipsShown();
  for (const c of shown) assert(b.clips[c], `showed ${c}`);
  for (const c of s.asked) assert(b.clips[c], `prefetched ${c}`);
  const n = s.logs.filter((l) => l.endsWith('action sniff')).length;
  assert(n >= 1, `sniffs now and then (${n})`);
  assert(shown.has('lie') || shown.has('walk'), `lives (${[...shown]})`);
});

test('synthetic species: commands fall back (sit -> stand), missing actions ignored, its action runs', () => {
  const s = sim(synthetic(), 32);
  s.run(1);
  s.cat.command('sit');
  let st = s.run(3);
  assert(st.pose === 'stand' && st.goal === 'stand', `sit -> stand (${st.pose})`);
  s.cat.command('groom');
  st = s.run(0.5);
  assert(st.action === null && st.pending === null, `groom ignored (${st.action})`);
  assert(s.logs.some((l) => l.includes('no clip groom')), 'logged');
  s.cat.command('sniff');
  st = s.run(0.2);
  assert(st.action === 'sniff' || st.pending === 'sniff', `sniff runs (${st.action}/${st.pending})`);
  s.cat.command('lie');
  st = s.run(4);
  assert(st.pose === 'lie', `lies (${st.pose})`);
});

test('synthetic species: dragged by the laser without a dangle clip (shows the fall loop), lands', () => {
  const s = sim(synthetic(), 33);
  s.run(1);
  s.setScript(() => ({ x: 0.3, y: 1.0, z: 0.5, press: 1 }));
  let st = s.run(1);
  const last = s.shown[s.shown.length - 1];
  assert(st.held && st.pose === 'dangle' && last.clip === 'fall', `held, the fall loop shown (${st.pose} ${last.clip})`);
  s.setScript(() => null);
  st = s.run(2);
  assert(!st.held && !st.falling && st.y === 0, `landed (${st.pose} ${st.y})`);
});

test('synthetic species: petting purrs (its purr loop); without purr loops petting does nothing', () => {
  const s = sim(synthetic(), 34);
  s.run(1);
  s.setScript(stroke(s));
  let st = s.run(3);
  assert(st.purring && st.pose === 'purr', `purrs (${st.pose})`);
  const none = sim(without([...NO_SIT, 'purr', 'purrin', 'liepurr', 'liepurrin']), 35);
  none.run(1);
  none.setScript(stroke(none));
  none.run(4, (x) => assert(!x.purring, 'purred without a purr loop'));
  assert(!none.cat.species().poses.includes('purr'), 'no purr pose');
});

test('a missing transition is a cut; a saved pose it lacks loads as the nearest', () => {
  const s = sim(without(['liedown']), 36);
  s.run(1);
  s.cat.command('lie');
  const st = s.run(1);
  assert(st.pose === 'lie' && !s.clipsShown().has('liedown'), `lies at once (${st.pose})`);
  assert(s.logs.some((l) => l.includes('no clip liedown (cut)')), 'logged');
  const t = sim(synthetic(), 37, { saved: { x: 0.2, z: 0.4, yaw: 1, pose: 'sit' } });
  assert(t.cat.state().pose === 'stand' && t.cat.state().x === 0.2, `saved sit -> stand at its spot (${t.cat.state().pose})`);
});

// Every frame set of the catalog: the cat and each animal.
for (const [name, baked] of Object.entries(catalog.frameSets)) {
  test(`${name}: every clip the core can ask for is baked; commands, petting, a drag, an hour`, () => {
    const s = sim(baked, 41);
    const sp = s.cat.species();
    for (const c of sp.clips) assert(baked.clips[c], `core may ask for ${c}: not baked`);
    for (const p of sp.poses) {
      if (['stand', 'sit', 'lie', 'sleep', 'fall', 'dangle'].includes(p)) assert(baked.poseZones?.[p]?.scruff, `zones of ${p}`);
    }
    const cmds = ['sit', 'lie', 'sleep', 'stand', 'groom', 'stretch', 'shake', 'purr', 'startle', 'drop', 'dangle', 'summon', 'wander', 'follow', 'turn',
      ...Object.keys(baked.species?.actions ?? {})];
    for (const c of cmds) { s.cat.command(c); s.run(6); }
    s.cat.command('stand');
    s.run(2);
    s.setScript(stroke(s));
    const st = s.run(3);
    assert(st.purring === sp.poses.includes('purr'), `petting: purring ${st.purring}`);
    s.setScript((t) => (t % 60 < 1.5 ? { x: 0.3, y: 1.0, z: 0.5, press: 1 } : null));   // a drag every minute
    s.run(60 * 60);
    for (const c of s.clipsShown()) assert(baked.clips[c], `showed ${c}`);
    for (const c of s.asked) assert(baked.clips[c], `prefetched ${c}`);
    const poses = new Set(s.shown.map((x) => x.clip));
    console.log(`     ${name}: poses ${sp.poses.join(' ')}; actions ${sp.actions.join(' ')}; shown ${poses.size}/${Object.keys(baked.clips).length} clips`);
  });
}

done();
