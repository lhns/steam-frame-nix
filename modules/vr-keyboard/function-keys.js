// function-keys.js: F1-F12 in the suggestion strip while AltGr is active
// (keyboard.vr.functionKeys; patch.js). Evaluates to
// { VERSION, KEYS, active, view, keyOf }.
//
// AltGr is Steam's toggle key (on layouts without one, keyboard.vr.extraKeys
// adds it labelled Fn). Its state has three bits: 1 one-shot (released by the
// next typed key), 2 locked (tapped twice), 4 held. Any of them shows the
// F-keys, so a tapped AltGr shows them until the next key or until it's
// tapped off; a held one while held.
//
// The F-keys only replace what the strip shows: the suggestions (patch.js
// `cur`) are neither changed nor recomputed meanwhile, so when AltGr goes off
// the strip shows the same items with the same selection again. An F-key
// is typed as Steam key VKX_F<n>, an extra key: keyboard.vr.extraKeys presses
// it with xdotool together with the active Ctrl/Alt/Shift and releases the
// one-shot toggles, and patch.js resets its text model for it, like for Esc.
(() => {
  const VERSION = 1;
  const KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);
  const FKEYS = { kind: 'fkeys' };                 // the source of an F-key view

  const active = (toggleStates) => ((toggleStates?.AltGr ?? 0) & 7) !== 0;

  // What the strip shows: { kind, items, index (the selected item, -1: none),
  // source (the suggestion object itself, or the F-key marker) } or null.
  // fnKeys: AltGr active and the keys can be sent; suggestions: patch.js
  // `cur` if it's shown ({ items, index }), else null.
  function view({ fnKeys, suggestions }) {
    if (fnKeys) return { kind: 'fkeys', items: KEYS, index: -1, source: FKEYS };
    if (suggestions) return { kind: 'suggestions', items: suggestions.items, index: suggestions.index, source: suggestions };
    return null;
  }

  // The Steam key of F-key button i, or null.
  const keyOf = (i) => (Number.isInteger(i) && KEYS[i] ? `VKX_${KEYS[i]}` : null);

  return { VERSION, KEYS, active, view, keyOf };
})()
