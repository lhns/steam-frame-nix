# VR keyboard: how it works

Technical details of the two VR keyboard patches. What they do and how to
configure them: README, [extra keys](../README.md#steam-keyboard-patch-keyboardvrextrakeysenable)
and [swipe and suggestions](../README.md#vr-keyboard-swipe-and-suggestions-keyboardvr).

## Extra keys

`keyboard.vr.extraKeys.enable`, module `steam-keyboard-patch`.

- The `steam-keyboard-patch` user service (`helper.mjs`) injects a patch
  into Steam's `SharedJSContext` over DevTools (`127.0.0.1:8080`) and
  re-injects it after Steam restarts; stopping it (or disabling the option)
  runs the unpatch, so no reboot or Steam restart is needed.
- Ctrl/Alt chords and Esc are sent with `xdotool key` on `:0` (focus follows
  the VR-selected window); a toggled Ctrl/Alt is held down with `xdotool`
  while the keyboard is open.
- Problem characters (non-ASCII, AltGr/dead-key characters on the German
  keymap) are typed with `xdotool type`; everything else goes through
  Steam's own text emulation. On other keymaps those characters are still
  typed by xdotool, which is why the routing is harmless there.
- The helper's command set is deliberately narrow (see the README's
  security note): single-key Ctrl/Alt chords, the extra keys, Ctrl/Alt
  hold/release and single non-ASCII/AltGr characters.

Found by signature (see [finders and signatures](ui-patches.md#finders-and-signatures));
if one stops matching, the keyboard stays stock and the journal says why
(see [after a Steam update](ui-patches.md#after-a-steam-update)).

## Swipe and suggestions

`keyboard.vr.*`, module `vr-keyboard`.

- A Steam UI patch (`vr-keyboard`, injected by `steam-ui-patches` like the
  other [UI patches](ui-patches.md)).
- Swiped words are matched by shape (SHARK2-style template matching)
  against a dictionary built at build time from wordfreq frequency lists
  and Hunspell, both from nixpkgs (`dictionary.*`: per language the `words`
  most frequent wordfreq entries, shifted by `frequencyOffset`, filtered by
  Hunspell except words at or above `keepFrequentAbove`).
- The strip below/above the keyboard is a SteamVR dashboard panel
  (`panel.js`, a patch of SteamVR's `systemui` page on port 8087, via the
  [SteamVR debugger](steamvr-debugger.md)), fed by the `vr-keyboard-relay`
  user service (`relay.mjs`) between the two pages. With `inside` neither
  the panel nor the relay runs.
- With `extraKeys`, non-ASCII words are typed via its xdotool helper.

Found by signature (entries `vr-keyboard`, `vr-keyboard-panel`); if one
stops matching the keyboard stays stock.

**Tests:** `nix flake check` (checks `vr-keyboard`: text model, corrector,
decoder accuracy on German + English) and `keyboard.vr.checks` for the
configured dictionary.

**Debugging:** `window.__sfuiSwipeLog` and `__sfuiSwipePaths` in Steam's
SharedJSContext (replay swipes with `scripts/vr-keyboard-replay.mjs`).
