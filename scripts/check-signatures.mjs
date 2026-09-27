#!/usr/bin/env node
// check-signatures.mjs: checks offline (no Steam, no browser) that every
// signature in modules/lib/signatures.json still matches the installed Steam /
// SteamVR web UI bundles: module and export signatures exactly once,
// "expects" strings still present (warnings), "stylesheet" signatures exactly
// one file of the bundle's "styles" directory. Run it after a Steam update:
//
//   nix shell nixpkgs#nodejs -c node scripts/check-signatures.mjs
//
// options:
//   --signatures FILE   extra signatures file (same format, merged; e.g. for
//                       your own patches); repeatable
//   --dir BUNDLE=DIR    bundle directory override, e.g. --dir steamui=/path
//   --patch NAME        check only this patch; repeatable
//   --strict            also fail on "expects" warnings
//   --json              machine-readable result
// Exit status: 0 all found, 1 something missing/ambiguous (or a warning with
// --strict), 2 usage/IO error.
//
// Modules come from webpack-modules.mjs (factory sources as the page's
// Function.prototype.toString sees them). For export signatures the matched
// factory runs in a throwaway VM context where imports and unknown globals
// are inert stubs, and is matched with modules/lib/finders.js.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { loadBundles, pageFiles } from './webpack-modules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, '..', 'modules', 'lib');

// ---- arguments -----------------------------------------------------------------
const args = process.argv.slice(2);
const sigFiles = [join(libDir, 'signatures.json')];
const dirOverride = {}, onlyPatches = new Set();
let strict = false, asJson = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => { if (i + 1 >= args.length) usage(`${a} needs a value`); return args[++i]; };
  if (a === '--signatures') sigFiles.push(resolve(val()));
  else if (a === '--dir') { const [b, ...d] = val().split('='); dirOverride[b] = d.join('='); }
  else if (a === '--patch') onlyPatches.add(val());
  else if (a === '--strict') strict = true;
  else if (a === '--json') asJson = true;
  else usage(`unknown argument ${a}`);
}
function usage(msg) {
  console.error(`${msg}\nusage: check-signatures.mjs [--signatures FILE]... [--dir BUNDLE=DIR]... [--patch NAME]... [--strict] [--json]`);
  process.exit(2);
}

const bundles = {}, patches = {};
for (const f of sigFiles) {
  let j;
  try { j = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { console.error(`${f}: ${e.message}`); process.exit(2); }
  Object.assign(bundles, j.bundles);
  Object.assign(patches, j.patches);
}
const find = vm.runInNewContext(readFileSync(join(libDir, 'finders.js'), 'utf8'), {});

// ---- offline module execution ------------------------------------------------------
// An inert value: any property, call or construction yields a stub again.
// Calls with a single function argument return it (HOCs, class decorators),
// (target, key, descriptor) calls return the descriptor (member decorators).
function makeStub() {
  let stub;
  const handler = {
    get(t, k) {
      if (k === Symbol.toPrimitive) return (hint) => (hint === 'number' ? 0 : '');
      if (k === Symbol.iterator) return function* () { for (let i = 0; i < 4; i++) yield stub; };
      if (k === 'then') return undefined;
      if (k === 'length') return 0;
      if (k === 'name') return 'stub';
      return stub;
    },
    set: () => true,
    apply(t, self, a) {
      if (a.length === 1 && typeof a[0] === 'function') return a[0];
      if (a.length === 3 && typeof a[1] === 'string' && a[2] && typeof a[2] === 'object') return a[2];
      return stub;
    },
    construct: () => stub,
  };
  stub = new Proxy(function stub() {}, handler);
  return stub;
}

function webpackRequire(stub) {
  const own = Object.prototype.hasOwnProperty;
  const helpers = {
    d(e, defs) { for (const k in defs) if (own.call(defs, k) && !own.call(e, k)) Object.defineProperty(e, k, { enumerable: true, get: defs[k] }); },
    o: (o, k) => own.call(o, k),
    r(e) {
      if (typeof Symbol !== 'undefined' && Symbol.toStringTag) Object.defineProperty(e, Symbol.toStringTag, { value: 'Module' });
      Object.defineProperty(e, '__esModule', { value: true });
    },
    n(m) { const g = m && m.__esModule ? () => m.default : () => m; helpers.d(g, { a: g }); return g; },
    nmd: (m) => m, hmd: (m) => m,
  };
  const req = function () { return stub; };
  return new Proxy(req, { get: (t, k) => (k in helpers ? helpers[k] : k === 'prototype' ? t.prototype : stub) });
}

// Runs a module factory in a fresh context: { exports, error }.
function runModule(mod) {
  const stub = makeStub();
  const ctx = vm.createContext({});
  vm.runInContext('var window = globalThis, self = globalThis;', ctx);
  for (const g of ['document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'SteamClient', 'history'])
    ctx[g] = stub;
  const factory = vm.runInContext('(' + mod.source + ')', ctx);
  let module;
  for (let tries = 0; tries < 200; tries++) {
    module = { id: mod.id, loaded: false, exports: {} };
    ctx.__sfui = { factory, module, req: webpackRequire(stub) };
    try {
      vm.runInContext('__sfui.factory.call(__sfui.module.exports, __sfui.module, __sfui.module.exports, __sfui.req)', ctx, { timeout: 5000 });
      return { exports: module.exports };
    } catch (e) {
      const m = e?.name === 'ReferenceError' && /^([\w$]+) is not defined$/.exec(e.message);
      if (m && !(m[1] in ctx)) { ctx[m[1]] = stub; continue; }
      return { exports: module.exports, error: `${e?.name}: ${e?.message}` };
    }
  }
  return { exports: module.exports, error: 'too many undefined globals' };
}

// ---- checking ------------------------------------------------------------------------
const expand = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const loaded = {};
function bundle(name) {
  if (name in loaded) return loaded[name];
  const b = bundles[name];
  if (!b) return (loaded[name] = { error: `unknown bundle ${name}` });
  const dir = expand(dirOverride[name] ?? b.dir);
  if (!existsSync(dir)) return (loaded[name] = { error: `${dir} missing` });
  const files = b.html ? pageFiles(dir, b.html) : undefined;
  const mods = loadBundles(dir, { files, exclude: b.exclude && new RegExp(b.exclude) });
  const req = { m: Object.fromEntries([...mods].map(([id, m]) => [id, m.factory])) };
  // Stylesheets: [{ file (relative to dir), source }].
  const stylesDir = b.styles && join(dir, b.styles);
  const styles = stylesDir && existsSync(stylesDir)
    ? readdirSync(stylesDir, { recursive: true }).filter((f) => f.endsWith('.css'))
      .map((f) => ({ file: join(b.styles, f), source: readFileSync(join(stylesDir, f), 'utf8') }))
    : [];
  const changelist = join(dir, 'changelist.txt');
  let version = existsSync(changelist) ? readFileSync(changelist, 'utf8').trim() || null : null;
  for (const f of files ?? []) {
    if (version) break;
    try { version = /\bCLSTAMP="(\d+)"/.exec(readFileSync(join(dir, f), 'utf8'))?.[1] ?? null; } catch { /* missing file */ }
  }
  if (!version) {
    for (const m of mods.values()) {
      const v = /CLSTAMP="(\d+)"/.exec(m.source) ?? /\b[\w$]="(\d{7,9})"/.exec(m.source);
      if (v) { version = v[1]; break; }
    }
  }
  return (loaded[name] = { dir, mods, req, styles, version });
}

const report = { ok: true, warnings: 0, patches: {} };
for (const [pname, p] of Object.entries(patches)) {
  if (onlyPatches.size && !onlyPatches.has(pname)) continue;
  const b = bundle(p.bundle);
  const pr = report.patches[pname] = { bundle: p.bundle, modules: {} };
  if (b.error) { pr.skipped = b.error; continue; }
  for (const [mname, sig] of Object.entries(p.modules ?? {})) {
    if (sig.stylesheet) {
      const files = b.styles.filter((f) => find.matchText(f.source, sig.stylesheet)).map((f) => f.file);
      const status = files.length === 1 ? 'found' : files.length ? 'ambiguous' : 'missing';
      pr.modules[mname] = { checkOnly: true, stylesheet: true, signature: sig.stylesheet, ids: [], files, status };
      if (status !== 'found') report.ok = false;
      continue;
    }
    const r = pr.modules[mname] = { checkOnly: !!sig.checkOnly, signature: sig.module };
    const ids = find.findAllModules(b.req, sig.module);
    r.ids = ids;
    r.files = ids.map((id) => b.mods.get(id).file);
    r.status = ids.length === 1 ? 'found' : ids.length ? 'ambiguous' : 'missing';
    if (r.status !== 'found') { report.ok = false; continue; }
    const mod = b.mods.get(ids[0]);
    r.missingExpects = (sig.expects ?? []).filter((s) => !mod.source.includes(s));
    if (r.missingExpects.length) report.warnings++;
    if (!sig.exports) continue;
    const run = runModule(mod);
    if (run.error) r.runError = run.error;
    r.exports = {};
    for (const [ename, esig] of Object.entries(sig.exports)) {
      const hits = find.findAllExports(run.exports, esig).map(([k]) => k);
      const status = hits.length === 1 ? 'found' : hits.length ? 'ambiguous' : run.error ? 'unverified' : 'missing';
      r.exports[ename] = { status, keys: hits, signature: esig };
      if (status === 'ambiguous' || status === 'missing') report.ok = false;
      if (status === 'unverified') report.warnings++;
    }
  }
}
if (strict && report.warnings) report.ok = false;

if (asJson) {
  console.log(JSON.stringify({ ...report, bundles: Object.fromEntries(Object.entries(loaded).map(([k, v]) =>
    [k, v.error ? { error: v.error } : { dir: v.dir, modules: v.mods.size, version: v.version }])) }, null, 2));
} else {
  for (const [k, v] of Object.entries(loaded)) {
    if (v.error) console.log(`bundle ${k}: skipped (${v.error})`);
    else console.log(`bundle ${k}: ${v.mods.size} modules in ${v.dir}${v.version ? ` (build ${v.version})` : ''}`);
  }
  for (const [pname, pr] of Object.entries(report.patches)) {
    console.log(`\n${pname} (${pr.bundle})${pr.skipped ? `: skipped, ${pr.skipped}` : ''}`);
    for (const [mname, r] of Object.entries(pr.modules)) {
      const kind = r.stylesheet ? 'stylesheet' : 'module';
      const where = r.stylesheet ? r.files.join(', ') : r.ids.map((id, i) => `${id} (${r.files[i]})`).join(', ');
      console.log(`  ${mname.padEnd(22)} ${r.status.padEnd(10)} ${r.status === 'missing' ? `no ${kind} matches ` + JSON.stringify(r.signature) : `${kind} ` + where}${r.checkOnly ? '  [check only]' : ''}`);
      for (const [ename, e] of Object.entries(r.exports ?? {}))
        console.log(`    .${ename.padEnd(20)} ${e.status.padEnd(10)} ${e.keys.length ? 'export ' + e.keys.map((k) => k || '(module.exports)').join(', ') : 'no export matches ' + JSON.stringify(e.signature)}`);
      if (r.runError) console.log(`    note: module factory threw offline (${r.runError}); unresolved exports are "unverified"`);
      if (r.missingExpects?.length) console.log(`    WARNING: module no longer contains ${r.missingExpects.map((s) => JSON.stringify(s)).join(', ')}`);
    }
  }
  console.log(`\n${report.ok ? 'OK' : 'FAILED'}: ${report.ok ? 'all signatures match exactly once' : 'some signatures are missing or ambiguous'}` +
    (report.warnings ? `, ${report.warnings} warning(s)` : ''));
}
process.exit(report.ok ? 0 : 1);
