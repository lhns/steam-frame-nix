// Reverts patch.js in Steam's SharedJSContext; evaluated by helper.mjs
// when it stops (service stopped, module disabled). Every patched function
// keeps its original as __vrkbdOrig. Safe to run when nothing is patched.
(() => {
  if (!window.__vrkbdWr) return 'not patched';
  const unwrap = (obj, name) => {
    const f = obj?.[name];
    if (f?.__vrkbdOrig) obj[name] = f.__vrkbdOrig;
  };
  for (const l of window.__vrkbdLayouts || []) unwrap(l, 'rgLayout');
  unwrap(SteamClient.Input, 'ControllerKeyboardSendText');
  unwrap(window.__vrkbdProto, 'TypeKeyInternal');
  clearInterval(window.__vrkbdHoldTimer);

  const inst = window.__vrkbdInst;
  if (inst) {
    delete inst.__vrkbd;
    inst.setState({ standardLayout: window.__vrkbdWr(40222).r_() });
    inst.forceUpdate();
  }
  for (const p of g_PopupManager.GetPopups?.() || []) p.window?.document.getElementById('vrkbd-style')?.remove();
  for (const k of ['__vrkbdHoldTimer', '__vrkbdHeld', '__vrkbdInst', '__vrkbdProto', '__vrkbdLayouts']) delete window[k];
  return 'unpatched';
})()
