# VR pet

`pet.*`, module `pet` ([options](../README.md#options)).

A [SteamVR dashboard patch](ui-patches.md#steamvr-dashboard-patches).

## What you get

A 3D pet in SteamVR's scene, next to your windows: the Toon Cat in five
coats (Ginger, Tuxedo, Blue, Cream, Snow), a Shiba Inu, a Fox and a
Dachshund, plus your own models (`pet.extraModels`). It lives in the
dashboard's scene, so it is there in SteamVR Home and over games while the
dashboard runs.

- **On its own** it walks around you, sits, lies down, sleeps, follows you
  beyond 2.5 m and reappears in front of you beyond 8 m. The cat also
  grooms, stretches and shakes; the dogs and the fox sniff and look around.
- **Pick it up:** point the laser just above it (a grip bar shows up, like
  a window's), press and drag like a window (the thumbstick pushes and
  pulls). It dangles by the scruff, turns with the controller and falls
  where you let go. No controller button is read; a falling pet is not
  caught.
- **Pet it:** rest or move a controller slowly (< 0.4 m/s) on its head or
  back (within 10 cm) for 0.6 s: it purrs (a dog wags its tail) while the
  strokes go on. A fast swipe (> 1 m/s) close by startles it.
- **Its controls**, below the grip bar: X hides it (kept across SteamVR
  restarts); ⋯ opens its menu: the models (a check on the current one, kept
  across restarts), then Summon (1 m in front of you), Sit, Lie down,
  Sleep. Buttons act on a press and a release on them, not during a drag or
  0.3 s after. The menu closes on a pick, a press elsewhere, 1 s after the
  laser left it, and when the pet hides.
- **Bring it back:** "Pet" in the dashboard's "+" menu (its icon is the
  current model's), i.e. `vr-pet show`: at its spot while that is within
  3 m and in view, else 1 m in front of you.

The `vr-pet` command:

```text
vr-pet show [--summon]   show it (--summon: always 1 m in front of you)
vr-pet hide | status     hide it; its state as JSON
vr-pet models            the models (* the current one)
vr-pet model <id>        switch (a hidden pet switches too)
```

## Configuration

```nix
steamFrame.pet.enable = true;
# steamFrame.pet.defaultModel = "shiba";
# steamFrame.pet.options = { walkSpeed = 0.3; follow = 3; };   # core.js DEFAULTS
# steamFrame.pet.extraModels.corgi = ./pets/corgi;              # a model folder
```

The first switch bakes the models: a few minutes on the Frame and about
0.5 GB in the store (1.1 GB without `auto-optimise-store`, which hardlinks
the coats' copies of the cat's frames); the model sources are in this
repository (no model download, no Blender needed for the built-in models). Adding your own model, the spec and the
animation mapping: [VR pet models](pet-models.md). A model of a character
someone else owns belongs in your own `extraModels` with `"private": true`
([private models](pet-models.md#private-models)), never in this repository.

Without a headset: `nix run github:lhns/steam-frame-nix#pet-preview` plays
the pet in a browser (mouse as the hands, a debug panel).

## Limitations

- vrcompositor draws every mounted frame: a few hundred static OBJs per
  model, mounted gradually (`pet.mount`); switching to another animal takes
  a few seconds to load.
- The pet is drawn by the dashboard's page: it is gone while SteamVR's
  dashboard process restarts, and the patch reattaches within 15 s.
- It walks on the floor of the standing space and knows nothing of your
  room's furniture.
- The "+" menu icon changes when the model does; a running Steam picks it
  up when it rescans its icons (a few seconds).

## Credits

The models' authors and licences: [README, Credits](../README.md#credits).

## How it works

`vr-pet`, with [persistent state](ui-patches.md#persistent-state) (the
spot, pose, model and whether it is hidden). Debugging in the `systemui`
page: `window.__sfuiPet.cat.command('sit' | 'summon' | …)`,
`.cat.state()`, `.stats()`; the CLI calls only `window.__sfuiPet.api`.
Journal: `journalctl --user -t vr-pet -u steam-ui-patches`.

- **Build** (`modules/pet/package.nix`): bake.py retargets and hand-keys
  the Toon Cat's clips and bakes one OBJ per animation frame; bake_gltf.py
  does the same for a rigged glTF (the Quaternius animals); index.py makes
  the catalog (coats as recoloured textures of the cat's frames, one
  directory per model, 48 px thumbnails) and the "+" menu icons. Each
  animal is a derivation of its own.
- **Behaviour** (`core.js`): poses, clips and transitions, wandering,
  following, petting, the scruff drag and the fall, independent of where
  it is drawn (also used by the preview and the tests).
- **Drawing** (`systemui.js`): every frame is a render model node under one
  world-locked root in the dashboard's scene graph; the frames a clip needs
  are mounted ahead, unused ones dropped. Each change resends the
  dashboard's last scene graph message with only the pet's subtree
  replaced. The grip bar is a panel like a window's handle; while dragged
  the root is parented to the controller, so the compositor carries it.
- **"+" menu icon:** `~/.local/share/icons/hicolor/256x256/apps/vr-pet.png`
  links to `/run/user/1000/steam-frame-nix/vr-pet/icon.png`, which the
  oneshot user service `steam-frame-nix-pet-icon` points to the current
  model's icon: on switch, at login and when the state file changes (path
  unit); it bumps hicolor's mtime so a running Steam rescans. Lifetime and
  cleanup: [Changes outside Nix](../README.md#changes-outside-nix-exceptions).
