// hooks.js: shared method hooks for runtime patches. Several patches can
// intercept the same method (e.g. SendMessage of the SteamVR dashboard's
// mailbox, which dashboard-windows and window-curvature both use to rewrite
// outgoing scene graphs) through ONE wrapper per method, instead of a chain
// of per-patch wrappers: a wrapper can't be taken out of the middle of a
// chain, so patches restarted in varying order would pile up inert wrappers
// (or run a rewrite twice).
//
// This file is a single expression. Evaluated in a page it installs the
// library as window.__sfuiHooks (unless an equal or newer VERSION is already
// there; a newer one takes over the registry) and evaluates to it;
// lib/default.nix (mkPatch) passes it to every patch as its 4th argument.
//
//   before(obj, method, name, fn)  registers (or replaces) hook `name` on
//       obj[method] (e.g. a class prototype): fn.call(this, args) runs before
//       the original with the call's arguments array (which it may modify in
//       place). Installs the wrapper if needed. Idempotent. A hook that
//       throws is skipped (count and last message in errors[name]).
//   remove(obj, method, name)      unregisters it; once no hook is left the
//       wrapper is removed too (if nothing wrapped the method since).
//   has(obj, method, name)         registered and the wrapper installed.
//
// The wrapper (marked fn.__sfuiHooks = method, original in fn.__sfuiOrig)
// looks the hooks up per call, so re-registering, removing and upgrading the
// library take effect in place. Hooks run once per call, even if a wrapper
// ended up in the method's chain twice (then also not for a call the method
// makes to itself). Hooks are called in registration order.
// Migration: per-patch wrappers from before this library (fn.__sfuiPatch ===
// name, original in fn.__sfuiOrig) on top of obj[method] are unwound when
// `name` registers.
(() => {
  const VERSION = 1;
  const G = globalThis;
  const have = G.__sfuiHooks;
  if (have && have.version >= VERSION) return have;

  // obj -> method -> Map(name -> fn). Taken over from an older version.
  const table = have?.table ?? new Map();
  const errors = have?.errors ?? {};
  const hooksOf = (obj, method) => table.get(obj)?.get(method);

  const inChain = (obj, method) => {
    for (let f = obj[method], i = 0; typeof f === 'function' && i < 50; f = f.__sfuiOrig, i++)
      if (f.__sfuiHooks === method) return true;
    return false;
  };

  function install(obj, method) {
    const names = hooksOf(obj, method);
    // Unwind legacy per-patch wrappers of registered names from the top.
    for (let f = obj[method], i = 0; typeof f === 'function' && typeof f.__sfuiPatch === 'string' &&
        typeof f.__sfuiOrig === 'function' && names?.has(f.__sfuiPatch) && i < 50; f = obj[method], i++)
      obj[method] = f.__sfuiOrig;
    if (inChain(obj, method)) return;
    const orig = obj[method];
    if (typeof orig !== 'function') throw new Error(`hooks: ${method} is not a function`);
    const wrapper = function (...args) {
      const lib = G.__sfuiHooks;
      const hs = lib?.table?.get(obj)?.get(method);
      // hs.busy: an outer wrapper of this method already ran the hooks.
      if (!hs?.size || hs.busy) return orig.apply(this, args);
      for (const [name, fn] of hs) {
        try { fn.call(this, args); } catch (e) {
          const er = (lib.errors[name] ??= { count: 0, last: null });
          er.count++; er.last = String(e?.stack ?? e);
        }
      }
      hs.busy = true;
      try { return orig.apply(this, args); } finally { hs.busy = false; }
    };
    Object.defineProperty(wrapper, 'name', { value: method });
    Object.assign(wrapper, { __sfuiHooks: method, __sfuiOrig: orig });
    obj[method] = wrapper;
  }

  function before(obj, method, name, fn) {
    if (typeof fn !== 'function') throw new Error(`hooks: hook ${name} is not a function`);
    let byMethod = table.get(obj);
    if (!byMethod) table.set(obj, (byMethod = new Map()));
    let hs = byMethod.get(method);
    if (!hs) byMethod.set(method, (hs = new Map()));
    hs.set(name, fn);
    install(obj, method);
  }

  function remove(obj, method, name) {
    const hs = hooksOf(obj, method);
    if (!hs?.delete(name) || hs.size) return;
    table.get(obj).delete(method);
    if (!table.get(obj).size) table.delete(obj);
    const f = obj[method];
    if (f?.__sfuiHooks === method) obj[method] = f.__sfuiOrig;   // else inert in its chain
  }

  const has = (obj, method, name) => !!hooksOf(obj, method)?.has(name) && inChain(obj, method);

  const lib = { version: VERSION, table, errors, before, remove, has };
  G.__sfuiHooks = lib;
  return lib;
})()
