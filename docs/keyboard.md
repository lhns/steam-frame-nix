# Keyboard

Keyboard layout of the Steam session, and two patches of Steam's VR
keyboard: [extra keys](#extra-keys) and [swipe and suggestions](#swipe-and-suggestions).
All options: [options.md#keyboard](options.md#keyboard).

## Layout

`keyboard.layout`, `keyboard.variant`.

**Problem:** gamescope and its Xwayland displays use US unless
`XKB_DEFAULT_*` is set; KDE's layout only affects the nested desktop, and
`~/.config/environment.d` isn't read on the Frame.

**Fix:** a drop-in on `gamescope-session.service` setting
`XKB_DEFAULT_LAYOUT`/`VARIANT`; applies at the next Steam session start.

`keyboard.variant` picks a variant of the layout, e.g. for `de`: `null`
(standard, with dead keys: `^`, `` ` ``, `´` wait for the next key),
`"nodeadkeys"` (those are typed immediately), `"mac"`, `"neo"`, `"e1"`, `"us"`
(German letters on a US layout). List them with
`localectl list-x11-keymap-variants <layout>`.

**Remove when** SteamOS applies a layout setting to gamescope.

## Extra keys

`keyboard.vr.extraKeys.enable`.

**Problem:** Steam's VR keyboard has no Ctrl, Alt or Esc, can't press real
keys, and its text emulation only maps plain ASCII: non-ASCII and
AltGr/dead-key characters on the German keymap (`| @ { [ ] } \ ~ ^`,
backtick, `ä ö ü €`) come out as `1`.

**What it does:**

- Bottom row: `Esc Ctrl Alt [Space] AltGr ← ↑ ↓ → Close`, stable with Shift
  or AltGr.
- AltGr + arrows: Home, End, Page Up, Page Down (hinted on the keys);
  Shift + arrows select text.
- AltGr + the key left of Backspace (`´` on German, `=` on US): Delete,
  labelled like Steam's Delete key in its language (`Entf`; `Del` if that is
  longer), hinted on the key without AltGr; repeats while held. Layouts with
  an AltGr character on that key get none.
- Layouts without AltGr (US, Dvorak, Colemak, Bulgarian, Chinese, Japanese,
  Korean) get an `Fn` key right of the space bar: Steam's AltGr toggle
  (tap: once, tap twice: locked, hold), for Delete and Home/End/Page Up/Down.
- Ctrl/Alt chords and Esc are sent with `xdotool key` on `:0` (focus follows
  the VR-selected window); a toggled Ctrl/Alt is held down while the
  keyboard is open (e.g. Ctrl+scroll).
- Problem characters are typed with `xdotool type`; everything else goes
  through Steam.
- Enter always types Return (stock Steam may send it to a Steam search box).

**Layouts:** the character routing targets the German keymap; on others it
is harmless (those characters are typed by xdotool), and Esc/Ctrl/Alt/arrows
work regardless.

**Security:** the helper only accepts single-key Ctrl/Alt chords, the extra
keys, Ctrl/Alt hold/release and single non-ASCII/AltGr characters; it cannot
type ASCII text or press Enter.

**How it works:** the `steam-keyboard-patch` user service (`helper.mjs`)
injects a patch over DevTools (`127.0.0.1:8080`) and re-injects it after
Steam restarts; stopping it (or disabling the option) reverts the patch. No
reboot or Steam restart needed.

**Caveat:** found by signature (see
[finders and signatures](ui-patches.md#finders-and-signatures)); if one stops
matching, the keyboard stays stock and the journal says why (see
[after a Steam update](ui-patches.md#after-a-steam-update)). Tested with
Steam client 1790377368 (UI build 11041156).

**Remove when** Steam's VR keyboard gets these keys.

## Swipe and suggestions

`keyboard.vr.enable`; the sub-features (`swipe`, `autocorrect`,
`completions`, `backspaceDrag`, `haptics`) are on by default.

**Problem:** Steam's VR keyboard is tap-only: no swipe typing, no
suggestions, and deleting more than a few characters means many Backspace
taps.

**What it does:**

- **Swipe:** press the trigger on the first letter, sweep over the others,
  release on the last. The word is typed with a space before it if needed
  (`text.autoSpace`); alternatives show in the strip. `'` and `-` are typed,
  not swiped.
- **Suggestions** never change text by themselves: a finished tapped word
  that isn't in the dictionary gets corrections (itself first; `autocorrect`),
  a word being tapped gets completions (the typed letters first;
  `completions`). A pick replaces exactly what it typed and can be switched
  again.
- **Backspace drag:** drag Backspace left to delete one character per
  `pixelsPerChar`, with a detent (`wordDetentPixels`) at each word border
  and at the start of what the keyboard typed; drag back right to retype.
- **Strip** (`suggestions.position`): a SteamVR dashboard panel below or
  above the keyboard, or inside the keyboard over its number row. Its
  buttons take the keyboard's key style.
- **Haptics:** light ticks for drag steps and picks, a Snap at word detents.

**Dictionary** (`dictionary.*`): built from wordfreq frequency lists and
Hunspell, both from nixpkgs. By default the `keyboard.layout` language (de,
fr, es, it, nl, pt, sv) plus English, else English only; add or exclude
words and word lists, see [options](options.md#keyboard).

**Text memory:** the keyboard can't read the text field, so it remembers
what it typed itself (`text.bufferChars`); anything it can't follow (Enter,
arrows, extraKeys' xdotool keys, another field,
`text.resetAfterIdleSeconds`) resets that, and suggestions only replace text
the memory proves intact. Works with and without `keyboard.vr.extraKeys`
(with it, non-ASCII words are typed via its xdotool helper).

**Caveats:** found by signature (entries `vr-keyboard`, `vr-keyboard-panel`);
if one stops matching the keyboard stays stock. Accented words of other
languages are in the dictionary but only swipable where the layout has the
letters.

**How it works:** a Steam UI patch (`vr-keyboard`, injected like the other
[UI patches](ui-patches.md)). Words are matched by shape (SHARK2-style
template matching). The strip below/above is a patch of SteamVR's
`systemui`, with the `vr-keyboard-relay` user service carrying it between
the two pages.

**Tests:** `nix flake check` (checks `vr-keyboard`: text model, corrector,
decoder accuracy on German + English) and `keyboard.vr.checks` for the
configured dictionary. Debugging: `window.__sfuiSwipeLog` and
`__sfuiSwipePaths` in Steam's SharedJSContext (replay swipes with
`scripts/vr-keyboard-replay.mjs`).

**Remove when** Steam's VR keyboard gets swipe typing and suggestions.
