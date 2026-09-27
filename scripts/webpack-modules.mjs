// webpack-modules.mjs: extracts webpack module factories from built bundles
// without a browser and without executing the bundles (no dependencies).
//
//   import { loadBundles } from './webpack-modules.mjs';
//   const mods = loadBundles('/home/deck/.local/share/Steam/steamui');
//   // Map "<id>" -> { id, file, factory, source }
//
// Module maps are object literals of `<id>: <factory>`, found at
// `.push([[<chunk ids>],{…}` (chunk files) and `<x>={<id>:…` (the runtime's
// own modules). A small tokenizer finds the closing brace; the literal alone
// is evaluated in a fresh VM context (defines factories, runs nothing), so
// `source` equals Function.prototype.toString as a finder sees it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const KEYWORDS_BEFORE_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

// Index just past the bracket matching src[start] ('{', '(' or '[').
export function matchBracket(src, start) {
  const stack = [];                               // '{', '(', '[', or '`' (inside ${ } of a template)
  let i = start, prev = '(';                      // prev: last significant token ('w' word, ')' etc.)
  const n = src.length;
  const skipString = (q) => {
    for (i++; i < n; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (c === q) { i++; return; }
    }
    throw new Error('unterminated string');
  };
  // Template body from i (just after ` or }); stops after closing ` or at ${.
  const skipTemplate = () => {
    for (; i < n; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (c === '`') { i++; return false; }
      if (c === '$' && src[i + 1] === '{') { i += 2; return true; }
    }
    throw new Error('unterminated template');
  };
  const skipRegex = () => {
    let cls = false;
    for (i++; i < n; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (c === '\n') throw new Error('unterminated regex');
      if (cls) { if (c === ']') cls = false; continue; }
      if (c === '[') cls = true;
      else if (c === '/') { i++; while (i < n && /[a-z]/i.test(src[i])) i++; return; }
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") { skipString(c); prev = 'v'; continue; }
    if (c === '`') { i++; if (skipTemplate()) stack.push('`'); prev = 'v'; continue; }
    if (c === '/') {
      const regexOk = prev !== 'v' && prev !== ')' && prev !== ']' && prev !== '}' &&
        !(prev.startsWith('w') && !KEYWORDS_BEFORE_EXPR.has(prev.slice(1)));
      if (regexOk) { skipRegex(); prev = 'v'; continue; }
      i++; prev = '/'; continue;
    }
    if (/[A-Za-z0-9_$\u0080-\uffff]/.test(c)) {
      const s = i;
      while (i < n && /[A-Za-z0-9_$\u0080-\uffff.]/.test(src[i])) {
        if (src[i] === '.' && !/[0-9]/.test(src[s])) break;   // number like 1.5, not a.b
        i++;
      }
      prev = /[0-9]/.test(src[s]) ? 'v' : 'w' + src.slice(s, i);
      continue;
    }
    if (c === '{' || c === '(' || c === '[') { stack.push(c); i++; prev = c; continue; }
    if (c === '}' || c === ')' || c === ']') {
      const open = stack.pop();
      i++;
      if (open === '`') { if (skipTemplate()) stack.push('`'); prev = 'v'; continue; }
      if (stack.length === 0) return i;
      prev = c;
      continue;
    }
    i++; prev = c;
  }
  throw new Error('unbalanced');
}

// Factories of one bundle file: [{ id, factory, source }].
export function extractModules(src) {
  const out = [];
  const starts = [];
  for (const m of src.matchAll(/\.push\(\[\[[^\]]*\],\{/g)) starts.push(m.index + m[0].length - 1);
  for (const m of src.matchAll(/[\w$]=\{\d+:/g)) starts.push(m.index + 2);
  starts.sort((a, b) => a - b);
  let end = -1;
  for (const s of starts) {
    if (s < end) continue;                        // inside a map already extracted
    let e;
    try { e = matchBracket(src, s); } catch { continue; }
    let obj;
    try { obj = vm.runInNewContext('(' + src.slice(s, e) + ')'); } catch { continue; }
    const entries = Object.entries(obj ?? {});
    if (!entries.length || !entries.every(([k, v]) => /^\d+$/.test(k) && typeof v === 'function')) continue;
    end = e;
    for (const [id, factory] of entries) out.push({ id, factory, source: Function.prototype.toString.call(factory) });
  }
  return out;
}

// The bundle files a page loads, relative to dir: the <script src> files of
// its HTML and, if a script is a webpack runtime with lazily loaded chunks
// (`__webpack_require__.u = id => ({id: name}[id] || id) + ".js?contenthash=" +
// {id: hash}[id]`), every chunk file it can load. Stale files an update left
// behind are thus ignored.
export function pageFiles(dir, html) {
  const page = readFileSync(join(dir, html), 'utf8');
  const scripts = [...page.matchAll(/<script[^>]*\bsrc="\/?([^"?#]+)/g)].map((m) => m[1]);
  const files = [...scripts];
  const obj = (src, i) => vm.runInNewContext('(' + src.slice(i, matchBracket(src, i)) + ')');
  for (const f of scripts) {
    let src;
    try { src = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    const u = /\.u=([\w$]+)=>""\+\(\{/.exec(src);
    if (!u) continue;
    const names = obj(src, u.index + u[0].length - 1);
    const h = src.indexOf('contenthash="+{', u.index);
    const ids = h >= 0 && h - u.index < 200000 ? Object.keys(obj(src, h + 'contenthash="+'.length)) : Object.keys(names);
    for (const id of ids) {
      const file = (names[id] ?? id) + '.js';
      if (!files.includes(file)) files.push(file);
    }
  }
  return files;
}

// Factories of the bundle files in dir: Map id -> { id, file, factory, source }
// (file relative to dir). opts.files: the files to read, in this order
// (default: every *.js under dir, recursively); opts.exclude: RegExp of
// relative paths to skip. The first definition of an id wins (a module
// bundled into several chunks is minified separately in each, so their
// sources can differ in local names); such ids are listed in the map's
// `conflicts` property.
export function loadBundles(dir, { files, exclude } = {}) {
  const mods = new Map();
  mods.conflicts = [];
  files ??= readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.js')).sort();
  for (const f of files) {
    if (exclude?.test(f)) continue;
    const p = join(dir, f);
    if (!statSync(p).isFile()) continue;
    const src = readFileSync(p, 'utf8');
    if (!/webpackChunk|[\w$]=\{\d+:/.test(src)) continue;
    for (const m of extractModules(src)) {
      const had = mods.get(m.id);
      if (!had) mods.set(m.id, { ...m, file: f });
      else if (had.source !== m.source) mods.conflicts.push(m.id);
    }
  }
  return mods;
}
