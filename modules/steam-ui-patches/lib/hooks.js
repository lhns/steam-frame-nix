// hooks.js: shared method hooks. Patches that intercept the same method (e.g.
// the SteamVR dashboard mailbox's SendMessage, used by dashboard-windows and
// window-curvature) share ONE wrapper per method: a wrapper can't be removed
// from the middle of a chain, so per-patch wrappers restarted in varying
// order would pile up (or run a rewrite twice).
//
// A single expression: installs window.__sfuiHooks (unless an equal or newer
// VERSION is there; a newer one takes over the registry) and evaluates to it;
// mkPatch passes it to every patch as `hooks`.
//   before(obj, method, name, fn)  register/replace hook `name`:
//       fn.call(this, args) runs before the original and may modify the args
//       array in place. Idempotent. Throwing hooks are skipped and counted in
//       errors[name].
//   remove(obj, method, name)      unregister; the wrapper goes with the last
//       hook (if nothing wrapped the method since).
//   has(obj, method, name)         registered and wrapper installed.
// The wrapper (fn.__sfuiHooks = method, original in fn.__sfuiOrig) looks hooks
// up per call, in registration order, and runs them once per call even if it
// is in the chain twice.
(() => {
  const VERSION = 2;
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
