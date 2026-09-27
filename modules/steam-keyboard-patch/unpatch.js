// Reverts patch.js in Steam's SharedJSContext; evaluated by helper.mjs
// when it stops (service stopped, module disabled). Every patched function
// keeps its original as __vrkbdOrig. Safe to run when nothing is patched.
(() => {
  const wr = window.__vrkbdWr;
  if (!wr) return 'not patched';
  const unwrap = (obj, name) => {
    const f = obj?.[name];
    if (f && f.__vrkbdOrig) obj[name] = f.__vrkbdOrig;
  };
  const Layouts = wr(40222);
  for (const l of [...(Layouts.G$() || []), Layouts.r_()]) unwrap(l, 'rgLayout');
  unwrap(SteamClient.Input, 'ControllerKeyboardSendText');
  unwrap(wr(5363).PE.prototype, 'DispatchKeypress');

  clearInterval(window.__vrkbdHoldTimer);
  const inst = window.__vrkbdInst;
  if (inst) {
    let proto = Object.getPrototypeOf(inst);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'TypeKeyInternal')) proto = Object.getPrototypeOf(proto);
    unwrap(proto, 'TypeKeyInternal');
    delete inst.__vrkbd;
    inst.setState({ standardLayout: Layouts.r_() });
    inst.forceUpdate();
  }
  for (const p of g_PopupManager.GetPopups?.() || []) p.window?.document.getElementById('vrkbd-style')?.remove();
  for (const k of ['__vrkbdHoldTimer', '__vrkbdHeld', '__vrkbdInst', '__vrkbdPatched']) delete window[k];
  return 'unpatched';
})()
