// finders.js: signature-based lookup of webpack modules, exports and React
// fibers in Steam's and SteamVR's web UIs, so patches don't depend on module
// ids or minified names (which change with every Steam update). Like Decky
// Loader's @decky/ui finders and Vencord's `find`.
//
// Also small helpers every patch needs (resolvePatch, ensureStyle, logger,
// keyboardPopup).
//
// A single expression: installs window.__sfuiFind (unless an equal or newer
// VERSION is there) and evaluates to it; mkPatch passes it as `find`.
// scripts/check-signatures.mjs evaluates the same file in Node, so the
// offline check matches exactly like the patches.
//
// Signatures (plain JSON, see signatures.json):
//   text signature, matched against a source text (a module factory's or a
//   function's Function.prototype.toString):
//     { "includes": ["s1", ...],   all must occur
//       "excludes": ["s2", ...],   none may occur
//       "regex":    ["/re/flags" or "re", ...] }   all must match
//   module signature: { "module": <text signature>,
//                       "exports": { "<name>": <value signature>, ... } }
//   value signature (an export of the module), all given fields must hold:
//     { "type": "function" | "class" | "object" | "string" | "number" | ...,
//       "includes"/"excludes"/"regex": text signature on the source of a
//                   function/class (String(v) for strings),
//       "length": n                 function arity,
//       "props": { "k": value }     data properties (own or inherited) equal to
//                                   the given JSON primitives; getters never run,
//       "has": ["k", ...]           properties present (`in`, incl. getters),
//       "protoMethods": ["m", ...]  (class) methods on its prototype chain
//                                   (plain methods only: decorated ones, e.g.
//                                   MobX @action.bound, are getters in the
//                                   page, though methods offline),
//       "methods": ["m", ...]       (instance) methods on its prototype chain,
//       "getters": ["g", ...]       getters on its prototype chain }
//   Fields that only scripts/check-signatures.mjs uses: "expects" (strings the
//   module source should contain, i.e. property names the patch relies on;
//   reported as warnings), "checkOnly": true (not resolved by the patch) and,
//   in place of "module", "stylesheet": <text signature> (a checkOnly entry
//   matched against the bundle's CSS files instead of its modules).
//
// Every lookup must match exactly once; otherwise a FinderError names the
// signature, the part that failed and the candidates.
(() => {
  const VERSION = 3;
  const G = globalThis;
  const have = G.__sfuiFind;
  if (have && have.version >= VERSION) return have;

  class FinderError extends Error {
    constructor(signature, message, candidates) {
      super(`${signature}: ${message}`);
      this.name = 'FinderError';
      this.signature = signature;
      this.candidates = candidates;
    }
  }

  const fnSource = (f) => { try { return Function.prototype.toString.call(f); } catch { return ''; } };
  const regexes = new Map();
  const toRegExp = (r) => {
    let re = regexes.get(r);
    if (!re) {
      const m = /^\/(.*)\/([a-z]*)$/s.exec(r);
      re = m ? new RegExp(m[1], m[2]) : new RegExp(r);
      regexes.set(r, re);
    }
    return re;
  };
  const isTextSig = (sig) => !!(sig.includes || sig.excludes || sig.regex);
  // Short description of a signature for error messages.
  const describe = (sig) => JSON.stringify(sig, (k, v) => (k === 'expects' || k === 'checkOnly' ? undefined : v));

  function matchText(src, sig) {
    if (typeof src !== 'string') return false;
    for (const s of sig.includes ?? []) if (!src.includes(s)) return false;
    for (const s of sig.excludes ?? []) if (src.includes(s)) return false;
    for (const r of sig.regex ?? []) if (!toRegExp(r).test(src)) return false;
    return true;
  }

  // Property descriptor along the prototype chain (no getter is run).
  const descriptor = (o, k) => {
    for (let p = o, i = 0; p && i < 50; p = Object.getPrototypeOf(p), i++) {
      const d = Object.getOwnPropertyDescriptor(p, k);
      if (d) return d;
    }
    return undefined;
  };
  const isClass = (v) => typeof v === 'function' && (/^class\b/.test(fnSource(v)) ||
    (!!v.prototype && Object.getOwnPropertyNames(v.prototype).some((k) => k !== 'constructor')));
  const kindOf = (v) => (v === null ? 'null' : typeof v === 'function' ? (isClass(v) ? 'class' : 'function') : typeof v);

  function matchValue(v, sig) {
    if (sig.type) {
      const kind = kindOf(v);
      if (!(kind === sig.type || (sig.type === 'function' && kind === 'class'))) return false;
    }
    if (isTextSig(sig)) {
      const src = typeof v === 'function' ? fnSource(v) : typeof v === 'string' ? v : null;
      if (!matchText(src, sig)) return false;
    }
    if (sig.length !== undefined && (typeof v !== 'function' || v.length !== sig.length)) return false;
    const obj = v !== null && (typeof v === 'object' || typeof v === 'function');
    if ((sig.props || sig.has || sig.methods || sig.getters) && !obj) return false;
    for (const [k, want] of Object.entries(sig.props ?? {})) {
      const d = descriptor(v, k);
      if (!d || !('value' in d) || d.value !== want) return false;
    }
    for (const k of sig.has ?? []) if (!(k in v)) return false;
    for (const k of sig.methods ?? []) if (typeof descriptor(v, k)?.value !== 'function') return false;
    for (const k of sig.getters ?? []) if (typeof descriptor(v, k)?.get !== 'function') return false;
    if (sig.protoMethods) {
      const proto = typeof v === 'function' ? v.prototype : null;
      if (!proto) return false;
      for (const k of sig.protoMethods) if (typeof descriptor(proto, k)?.value !== 'function') return false;
    }
    return true;
  }

  // ---- webpack ----------------------------------------------------------------
  const requires = new Map();                     // chunk global name -> require
  // webpack's require function of the page, obtained by pushing an empty
  // chunk with a runtime callback onto its chunk array (once per page).
  // chunkGlobal: e.g. "webpackChunksteamui" (Steam), "webpackChunkvrwebui"
  // (SteamVR dashboard); default: the page's only webpackChunk* array.
  function getWebpackRequire(chunkGlobal) {
    let name = chunkGlobal;
    if (!name) {
      const names = Object.keys(G).filter((k) => k.startsWith('webpackChunk') && Array.isArray(G[k]));
      if (names.length !== 1) throw new FinderError('webpack', `expected one webpackChunk* global, found [${names}]`, names);
      name = names[0];
    }
    const cached = requires.get(name);
    if (cached && typeof cached === 'function' && cached.m) return cached;
    const chunks = G[name];
    if (!chunks || typeof chunks.push !== 'function') throw new FinderError('webpack', `${name} missing`);
    let req;
    chunks.push([[Symbol('sfui')], {}, (r) => { req = r; }]);
    if (typeof req !== 'function' || !req.m) throw new FinderError('webpack', `no require from ${name}`);
    requires.set(name, req);
    return req;
  }

  // Ids of all module factories whose source matches the text signature.
  function findAllModules(req, textSig) {
    const ids = [];
    for (const id of Object.keys(req.m)) if (matchText(fnSource(req.m[id]), textSig)) ids.push(id);
    return ids;
  }
  // The single module whose factory source matches: { id, exports }.
  // Requiring it initializes it if needed (it is normally loaded already).
  function findModule(req, textSig, name = 'module') {
    const ids = findAllModules(req, textSig);
    if (ids.length !== 1) {
      throw new FinderError(name, ids.length ? `ambiguous module, candidates ${ids.join(', ')}` :
        `no module matches ${describe(textSig)}`, ids);
    }
    return { id: ids[0], exports: req(ids[0]) };
  }

  // Candidate values of a module's exports: [[key, value]]. A module whose
  // exports object is itself a function (CommonJS) is included as "".
  const exportEntries = (exports) => {
    const out = [];
    if (exports == null) return out;
    if (typeof exports === 'function') out.push(['', exports]);
    if (typeof exports === 'object' || typeof exports === 'function') {
      for (const k of Object.keys(exports)) {
        let v;
        try { v = exports[k]; } catch { continue; }   // webpack getters; a TDZ one may throw
        out.push([k, v]);
      }
    }
    return out;
  };
  function findAllExports(exports, valueSig) {
    return exportEntries(exports).filter(([, v]) => { try { return matchValue(v, valueSig); } catch { return false; } });
  }
  // The single export matching: { key, value }.
  function findExport(exports, valueSig, name = 'export') {
    const hits = findAllExports(exports, valueSig);
    if (hits.length !== 1) {
      throw new FinderError(name, hits.length ? `ambiguous export, candidates ${hits.map(([k]) => k || '(module)').join(', ')}` :
        `no export matches ${describe(valueSig)}`, hits.map(([k]) => k));
    }
    return { key: hits[0][0], value: hits[0][1] };
  }

  // Module signature -> { id, module (exports object), exports: { name: value },
  // keys: { name: export key } }. Cached per page while the factory is still
  // registered and every export keeps its value.
  const cache = new Map();
  function resolve(req, sig, name = 'module') {
    const ck = name + '\n' + JSON.stringify(sig);
    const c = cache.get(ck);
    if (c && c.req === req && req.m[c.id] === c.factory &&
        Object.entries(c.keys).every(([n, k]) => (k === '' ? c.module : c.module?.[k]) === c.exports[n])) return c;
    cache.delete(ck);
    const { id, exports: module } = findModule(req, sig.module, `${name}.module`);
    const exports = {}, keys = {};
    for (const [n, vs] of Object.entries(sig.exports ?? {})) {
      const { key, value } = findExport(module, vs, `${name}.${n} (module ${id})`);
      exports[n] = value; keys[n] = key;
    }
    const r = { id, module, exports, keys, req, factory: req.m[id] };
    cache.set(ck, r);
    return r;
  }
  // All module signatures of a patch (except checkOnly ones):
  // { name: resolve(...) }. Throws on the first failure, before the patch
  // changes anything.
  function resolveAll(req, sigs, prefix = '') {
    const out = {};
    for (const [n, sig] of Object.entries(sigs ?? {})) if (!sig.checkOnly) out[n] = resolve(req, sig, prefix + n);
    return out;
  }

  // ---- React ------------------------------------------------------------------
  const fiberOf = (el) => {
    if (!el || typeof el !== 'object') return null;
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
    return k ? el[k] : null;
  };
  const propsOf = (el) => {
    const k = el && Object.keys(el).find((x) => x.startsWith('__reactProps$'));
    return k ? el[k] : null;
  };
  // First fiber from `start` (a fiber or DOM element) upwards (itself, then
  // .return) for which pred(fiber) holds, within max steps; else null.
  function findFiberUp(start, pred, max = 100) {
    let f = start?.nodeType ? fiberOf(start) : start;
    for (let i = 0; f && i < max; f = f.return, i++) if (pred(f)) return f;
    return null;
  }
  // First fiber in the subtree of `start` (depth first, child/sibling) for
  // which pred(fiber) holds, visiting at most max fibers; else null.
  function findFiberDown(start, pred, max = 20000) {
    const root = start?.nodeType ? fiberOf(start) : start;
    const stack = root ? [root] : [];
    for (let n = 0; stack.length && n < max; n++) {
      const f = stack.pop();
      if (pred(f)) return f;
      if (f.sibling && f !== root) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return null;
  }
  // Decky-style search through a React element / props tree: follows the
  // given keys (and array items), returns the first node with pred(node).
  function findInReactTree(node, pred, { walkable = ['props', 'children', 'child', 'sibling'], max = 20000 } = {}) {
    const seen = new Set();
    const stack = [node];
    for (let n = 0; stack.length && n < max; n++) {
      const x = stack.pop();
      if (!x || typeof x !== 'object' || seen.has(x)) continue;
      seen.add(x);
      try { if (pred(x)) return x; } catch { /* keep looking */ }
      if (Array.isArray(x)) { for (let i = x.length - 1; i >= 0; i--) stack.push(x[i]); continue; }
      for (const k of walkable) if (x[k] && typeof x[k] === 'object') stack.push(x[k]);
    }
    return null;
  }

  // ---- patch helpers ------------------------------------------------------------
  // resolveAll on the page's webpack chunk array, or the status string
  // "signature not found, <Steam|dashboard> left unpatched: <why>".
  function resolvePatch(chunkGlobal, sigs) {
    try { return resolveAll(getWebpackRequire(chunkGlobal), sigs); } catch (e) {
      return `signature not found, ${chunkGlobal === 'webpackChunkvrwebui' ? 'dashboard' : 'Steam'} left unpatched: ${e.message}`;
    }
  }
  // <style id> in doc's head with the given text (created or updated).
  function ensureStyle(doc, id, css) {
    let s = doc.getElementById(id);
    if (!s) {
      s = doc.createElement('style');
      s.id = id;
      (doc.head ?? doc.documentElement).appendChild(s);
    }
    if (s.textContent !== css) s.textContent = css;
    return s;
  }
  // Steam's VR keyboard popup (the g_PopupManager popup with [data-key]
  // elements), or null.
  const keyboardPopup = () =>
    [...(G.g_PopupManager?.GetPopups?.() || [])].find((p) => p.window?.document.querySelector('[data-key]')) ?? null;
  // log(msg, data?) appending { t, msg, data } to buf, keeping the last max.
  const logger = (buf, max = 200) => (msg, data) => {
    buf.push({ t: new Date().toISOString().slice(11, 23), msg, ...(data !== undefined ? { data } : {}) });
    if (buf.length > max) buf.splice(0, buf.length - max);
  };

  const lib = {
    version: VERSION, FinderError, fnSource, matchText, matchValue, kindOf,
    getWebpackRequire, findAllModules, findModule, findAllExports, findExport, resolve, resolveAll,
    fiberOf, propsOf, findFiberUp, findFiberDown, findInReactTree, cache, requires,
    resolvePatch, ensureStyle, logger, keyboardPopup,
  };
  G.__sfuiFind = lib;
  return lib;
})()
