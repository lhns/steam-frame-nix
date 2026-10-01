// Allowlist of xdotool-helper.mjs: requests come from Steam's UI JS, so the
// helper must not be able to type ASCII text or press Enter on its behalf.
// Accepted:
//  key:<combo>  the extra keys (Esc, Del, Home, End, PgUp/PgDn, arrows,
//               F1-F12 from keyboard.vr.functionKeys), optionally with
//               modifiers; ctrl and/or alt (+ optional
//               shift) with one key; or shift+Tab
//  type:<char>  one character Steam's key emulation can't produce: non-ASCII
//               (äöüß€§°´…) or | @ { [ ] } \ ~ ^ `
//  down:<mod> / up:<mod>   hold/release ctrl or alt (checked in the helper)
const SPECIAL = new Set(['Escape', 'Delete', 'Home', 'End', 'Prior', 'Next', 'Left', 'Right', 'Up', 'Down',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);
const KEY = /^([a-z0-9]|space|BackSpace|Tab|period|comma|minus|plus|numbersign|less|slash|ssharp|udiaeresis|odiaeresis|adiaeresis)$/;

export function allowedCombo(combo) {
  const parts = combo.split('+');
  const key = parts.pop();
  const mods = new Set(parts);
  if (parts.length !== mods.size || ![...mods].every((m) => ['ctrl', 'alt', 'shift'].includes(m))) return false;
  if (SPECIAL.has(key)) return true;
  if (key === 'Tab' && mods.size === 1 && mods.has('shift')) return true;   // backwards focus
  return KEY.test(key) && (mods.has('ctrl') || mods.has('alt'));
}

export function allowedChar(c) {
  if ([...c].length !== 1) return false;
  const cp = c.codePointAt(0);
  return (cp > 0xa0 && !/\s|\p{C}/u.test(c)) || '|@{[]}\\~^`'.includes(c);
}
