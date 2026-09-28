// Reverts patch.js in Steam's SharedJSContext (evaluated by the
// steam-ui-patches service when it stops): removes the listeners, the trail
// canvas and the candidate strip from every keyboard popup it was attached
// to, and the globals. Safe when nothing is patched.
(() => {
  const S = window.__sfuiSwipe;
  if (!S) return 'not patched';
  for (const detach of S.docs?.values() || []) { try { detach(); } catch { /* popup gone */ } }
  delete window.__sfuiSwipe;
  // __sfuiSwipeLog / __sfuiSwipePaths (debugging data) are kept, so a switch
  // doesn't lose the evidence of a misrecognition.
  return 'unpatched';
})()
