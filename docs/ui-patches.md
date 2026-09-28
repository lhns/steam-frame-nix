# UI patches

`uiPatches.patches`, `uiPatches.lib` (modules `steam-ui-patches`,
`steamvr-debugger`). For patch authors, and for fixing patches after a Steam
update. Options: [README, Options](../README.md#options).

## Problem

Steam's UI and SteamVR's dashboard can't be extended: their files belong to
Steam, and Steam overwrites them on every update.

## What you get

Steam's UI and SteamVR's dashboard (`vrwebhelper`) are CEF web pages with a
local DevTools port: `127.0.0.1:8080` for Steam (SteamOS passes
`-cef-enable-debugging`), `127.0.0.1:8087` for SteamVR once
[its debugger](steamvr-debugger.md) is on. The `steam-ui-patches` user
service (`injector.mjs`) patches the running pages through them; Steam's
files are never modified. The [launcher menu](launcher-menu.md),
[dashboard](#steamvr-dashboard-patches) and [VR keyboard](keyboard.md)
features are such patches (the extra keys have their own injector,
`steam-keyboard-patch`), and you can add your own.

Turning a feature off (or stopping the `steam-ui-patches` /
`steam-keyboard-patch` user services) restores the stock UI without a Steam
restart. Log: `journalctl --user -u steam-ui-patches -u steam-keyboard-patch`.

## Caveats and security

- Patches depend on Steam UI internals and can break with an update; find
  modules by signature, not id ([below](#finders-and-signatures)).
- Don't expose the DevTools ports ([DevTools on the LAN](#devtools-on-the-lan)).

### DevTools on the LAN

Steam's Developer Mode enables `steam-web-debug-portforward`
(`0.0.0.0:8081` → `8080`) and `steamvr-web-debug-portforward`
(`0.0.0.0:8088` → `8087`), and firewalld allows ports 1024-65535, so anyone
on the network could run code in Steam's UI. No patch needs Developer Mode,
so keep it off. If it was on while those units were masked, they may stay
enabled: check with
`systemctl is-enabled steam-web-debug-portforward steamvr-web-debug-portforward`
and `sudo systemctl disable` them.

## SteamVR dashboard patches

[Dashboard windows](dashboard-windows.md),
[Steam close button](steam-close-button.md),
[window curvature](window-curvature.md) and
[window control bar](window-control-bar.md) patch SteamVR's dashboard while
it runs. What they have in common:

- Each turns on the [SteamVR debugger](steamvr-debugger.md) (**the first
  time, restart SteamVR once**).
- They depend on SteamVR UI internals: each is found by signature (its entry
  in `modules/lib/signatures.json` has the patch's name); after an update
  that changes them the dashboard stays stock (see
  [after a Steam update](#after-a-steam-update)). Tested with SteamVR build
  11008059.
- All are laser-only: gamepad navigation sees the stock dashboard.
- All are `mkPatch` patches of `vrwebhelper` (page title `systemui`,
  DevTools `127.0.0.1:8087`, webpack chunk `webpackChunkvrwebui`),
  registered only when enabled. Sources: `modules/<name>/patch.js`, whose
  header comments go into more detail.

## Defining a patch

`steamFrame.uiPatches.patches` entries:

| Attribute | Default | Description |
|---|---|---|
| `name` | | Unique name (log). |
| `endpoint` | `"http://127.0.0.1:8080"` | DevTools base URL; `/json/list` is polled every 5 s. |
| `target.title` / `target.titleRegex` / `target.urlRegex` | `null` | Pages to patch; all given criteria must match (JS regexes). |
| `patch` | | JS file evaluated in every matching page (awaited). |
| `unpatch` | `null` | JS file evaluated when the service stops. |
| `state` | `false` | Give the patch one [persistent JSON value](#persistent-state). |

```nix
steamFrame.uiPatches.patches = [ {
  name = "my-patch";
  target.title = "SharedJSContext";   # Steam's main JS context
  patch = ./my-patch/patch.js;
  unpatch = ./my-patch/unpatch.js;
} ];
```

Patches are evaluated on attach, after new JS contexts (reloads) and every
15 s, so they must be idempotent: return e.g. `"patched"` once, then
`"unchanged"` (not logged); other results are logged when they change
(`journalctl --user -u steam-ui-patches`). On stop, `unpatch` restores the
stock UI. The service exists only while the list is non-empty and is
restarted on every switch.

## Persistent state

With `state = true`: a patch's choices made in the UI can't be kept in the
page's own storage, since SteamOS's `steamvr.service` runs
`rm -rf ~/.cache/SteamVR` (vrwebhelper's browser profile, incl.
localStorage) on every SteamVR start. So the service keeps one JSON value
per such patch in `~/.local/state/steam-frame-nix/ui-patches/<name>.json`
(`$XDG_STATE_HOME`):

- before each evaluation it defines `window.__sfuiStore.get(name)` /
  `.set(name, value)` in the page and fills `get` from the file only while
  the page has no value yet (a fresh page after a SteamVR restart, reboot or
  reload);
- `set` goes through the DevTools binding `window.__sfuiStoreSave`; the
  service writes the file atomically, only on change, only for that page's
  `state` patches, at most 64 KiB.

Used by the [window control bar](window-control-bar.md) and the
[Steam close button](steam-close-button.md). The file is user data, not
generated by Nix: it is kept when the patch is disabled or removed and
removed only by `steam-frame-nix-cleanup --all` or `install.sh uninstall`;
see [changes outside Nix](../README.md#changes-outside-nix-exceptions).

## Finders and signatures

Webpack module ids and export names change with every Steam UI build, so
patches never use them. `modules/lib/finders.js` (like Decky Loader's
`findModule`/`findInReactTree` or Vencord's `find`) locates by *signature*:

- a **module** by strings/regexes in its factory source;
- an **export** by shape: type, function source, arity, data properties,
  prototype methods or getters;
- **React** fibers by props (`findFiberUp`, `findFiberDown`,
  `findInReactTree`).

Every signature must match exactly once, otherwise the patch changes nothing
and reports it (e.g. `signature not found, Steam left unpatched:
layouts.currentLayout (module 40222): ambiguous export, candidates r_, xy`).
Results are cached per page.

Signatures live in `modules/lib/signatures.json`, shared by patches and the
offline checker. An entry can also list `expects` (strings the patch relies
on, checked offline only) or be `checkOnly` (anchors not used through the
finder, checked offline only; with `stylesheet` instead of `module` it is
matched against the bundle's CSS).

### mkPatch

`steamFrame.uiPatches.lib.mkPatch` wraps a patch file — a function
expression `(find, sigs, opts, hooks) => …` returning a status string — with
the finder library, its signatures, options and the shared hooks (details in
`modules/lib/default.nix`):

```nix
steamFrame.uiPatches.patches = [ {
  name = "my-patch";
  target.title = "SharedJSContext";
  patch = config.steamFrame.uiPatches.lib.mkPatch {
    name = "my-patch";
    src = ./my-patch/patch.js;          # ((find, sigs, opts, hooks) => { … })
    signatures.thing = {
      module.includes = [ "SomeUniqueString" ];
      exports.Thing = { type = "class"; protoMethods = [ "DoIt" ]; };
    };
    opts.factor = 2;
  };
  unpatch = ./my-patch/unpatch.js;
} ];
```

```js
((find, sigs, opts, hooks) => {
  let mods;
  try { mods = find.resolveAll(find.getWebpackRequire('webpackChunksteamui'), sigs); }
  catch (e) { return `not patched: ${e.message}`; }
  const Thing = mods.thing.exports.Thing;   // SteamVR dashboard: 'webpackChunkvrwebui'
  …
})
```

### Shared method hooks

`modules/lib/hooks.js`, argument `hooks`, also `window.__sfuiHooks`: patches
intercepting the same method (e.g. the dashboard mailbox's `SendMessage`,
used by [dashboard windows](dashboard-windows.md#how-it-works) and
[window curvature](window-curvature.md#how-it-works)) register named hooks;
one wrapper per method runs them in registration order, so patches can be
injected, upgraded and reverted in any order.

```js
hooks.before(Mailbox.prototype, 'SendMessage', 'my-patch', (args) => {
  if (args[1]?.type === 'update_scene_graph') rewrite(args[1].scene_graph);
});
hooks.remove(Mailbox.prototype, 'SendMessage', 'my-patch');   // in unpatch
```

Patches reacting to presses on the curvature controls follow the
[window curvature contract](window-curvature.md#contract-for-other-patches)
(`sfui-curv-*`).

## After a Steam update

If a Steam or SteamVR update changes Steam's code so a signature no longer
matches exactly once, that patch changes nothing: the feature stays stock
and the journal (see [above](#what-you-get)) says why, e.g.
`signature not found, Steam left unpatched: …`. Update steam-frame-nix
(`nix flake update steam-frame-nix`, then switch) once it supports the new
build.

Check the signatures offline (Steam need not run) from a checkout:

```sh
nix shell nixpkgs#nodejs -c node scripts/check-signatures.mjs
```

It loads Steam's UI bundle (`~/.local/share/Steam/steamui`) and SteamVR's
dashboard (`/opt/steamvr/resources/webinterface/dashboard/systemui.html`),
evaluates every signature with the patches' finder code (exports in an inert
sandbox) and prints per patch `found` (module id, export name), `ambiguous`
or `missing`, plus warnings for missing `expects`; exit status 1 if anything
is missing or ambiguous:

```
bundle steamui: 2827 modules in /home/deck/.local/share/Steam/steamui (build 11041156)

steam-keyboard-patch (steamui)
  layouts                found      module 40222 (chunk~2dcc5aaf7.js)
    .currentLayout        found      export r_
    …
OK: all signatures match exactly once
```

To fix a signature, inspect the new module sources
(`scripts/webpack-modules.mjs`), adjust `signatures.json` and bump the
patch's `VERSION` if its code changes. Flags: `--signatures FILE` (your own,
bundles `steamui` / `vrwebui-systemui`), `--dir steamui=DIR`,
`--patch NAME`, `--strict` (fail on warnings), `--json`.
