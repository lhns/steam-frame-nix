// Reverts patch.js in Steam's SharedJSContext; evaluated by helper.mjs
// when it stops (service stopped, module disabled). Every patched function
// keeps its original as __vrkbdOrig; the patched objects Steam doesn't expose
// globally were remembered by patch.js (window.__vrkbdRefs, __vrkbdLayouts,
// __vrkbdProto, __vrkbdInst). Safe to run when nothing is patched.
(() => {
  const refs = window.__vrkbdRefs;
  if (!refs && !window.__vrkbdProto && !window.__vrkbdLayouts) return 'not patched';
  const unwrap = (obj, name) => {
    const f = obj?.[name];
    if (f?.__vrkbdOrig) obj[name] = f.__vrkbdOrig;
  };
  for (const l of window.__vrkbdLayouts || []) unwrap(l, 'rgLayout');
  unwrap(SteamClient.Input, 'ControllerKeyboardSendText');
  unwrap(window.__vrkbdProto, 'TypeKeyInternal');
  unwrap(refs?.Manager, 'GetEnterKeyLabel');
  unwrap(refs?.Manager, 'HandleVirtualKeyDown');
  clearInterval(window.__vrkbdHoldTimer);

  const inst = window.__vrkbdInst;
  if (inst) {
    delete inst.__vrkbd;
    if (refs?.currentLayout) inst.setState({ standardLayout: refs.currentLayout() });
    inst.forceUpdate();
  }
  for (const p of g_PopupManager.GetPopups?.() || []) p.window?.document.getElementById('vrkbd-style')?.remove();
  for (const k of ['__vrkbdHoldTimer', '__vrkbdHeld', '__vrkbdInst', '__vrkbdProto', '__vrkbdLayouts', '__vrkbdRefs']) delete window[k];
  return 'unpatched';
})()
