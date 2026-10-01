# VR pet models

How to add a model to the [VR pet](pet.md): the spec's one description (the
scripts in `modules/pet/` point here). Credits of the built-in models:
[README, Credits](../README.md#credits).

Every model is a folder with a `model.json` (its spec) and any files the
spec names (a texture, a `.glb`, a thumbnail, a Blender script). The
built-in ones are `modules/pet/models/<id>/`, found by `builtins.readDir`
(nothing else lists them). Your own go into `steamFrame.pet.extraModels`:
either such a folder (`corgi = ./pets/corgi;`) or the spec as an attrset,
with files as Nix paths (`calico = { name = "Calico"; png = ./calico.png; };`).
Rebuild, and the model shows up in the pet's ⋯ menu and in
`vr-pet models`. The id (folder or attribute name, `vr-pet model <id>`):
letters, digits, `-` and `_`.

An invalid spec fails the build with a message naming the model and the field
(index.py `validate()`, bake_gltf.py for the animal fields).

## Fields (every kind)

| field     | meaning |
|-----------|---------|
| `name`    | the text in the menu (required) |
| `kind`    | `base`, `recolor`, `texture` or `gltf` (required; an extraModels attrset with a `png` defaults to `texture`) |
| `order`   | the menu's order (the coats 0-4, the animals 10-19; default 100), then the name |
| `default` | `true` on the one model shown until another is picked (the Ginger cat); `steamFrame.pet.defaultModel = "<id>"` overrides it |
| `group`   | the menu puts a line between groups: `coats` (default for the cat's kinds) or `animals` (default for `gltf`) |
| `thumb`   | a picture of the model's own (a file of the folder) for the menu, instead of a render (thumb.py: the sitting animal, else the standing one; 48 px) |
| `private` | `true`: personal use only, never published ([below](#private-models)); must be a boolean; models.json carries it for every model (`false` by default) |
| `rights`  | who owns the character and why it is private (a text); a spec with `rights` must have `"private": true` |
| `extends` | another model's id: its spec with this one's fields on top ([below](#another-build-of-the-same-animal-extends-proportions-colors)) |

## The cat and its coats

- `base`: the Toon Cat, baked by bake.py (its sources are pinned in
  package.nix). There is one.
- `recolor`: a coat of the cat, skin.py moving the ginger fur to another
  ramp: `"fur": ["#rrggbb" (dark end), "#rrggbb" (light end)]`, optional
  `"white": ["chest", "muzzle", "paws"]` markings.
- `texture`: a coat of the cat with a texture of its own: `"png": "coat.png"`,
  a 64 x 64 PNG laid out like the cat's (start from an edited copy of
  `nix build github:lhns/steam-frame-nix#pet-models`/cat.png: the body's texels are a
  side view, columns along the length, each a dark-to-light ramp).

Coats share the cat's frames and behaviour; they switch in place.

## Other animals: kind `gltf`

A rigged, animated glTF (`.glb`, or `.gltf` with its files), baked by
bake_gltf.py into one OBJ per frame (as the cat) with its own behaviour set:
the core (core.js) gives an animal what its clips allow.

| field     | meaning |
|-----------|---------|
| `src`     | the glTF: a file of the folder (`"model.glb"`), `{ "url": ..., "hash": "sha256-..." }` (fetched, pinned) or `{ "path": ... }` (a file of the folder, e.g. downloaded by hand), optionally turned into a glTF (below) |
| `height`  | m, the standing animal's height (top of the ears) in its first idle frame; the cat is 0.30 |
| `feet`    | the four foot bones (their ends), for the walk speed: how fast the feet move back while on the floor |
| `zones`   | bones for the interaction points: `scruff` (the top of the skin it moves: where it is held from), `head`, `back` (the top of the skin above the joint: petting), `chin`, `tailBase` (`{ "bone": ..., "at": "joint" }`: the joint itself) |
| `follow`  | `{ bone: bone it moves with }`: bones outside the leg chains that the skin follows (IK targets, as the Quaternius feet); in hand-keyed poses they keep their place relative to that bone |
| `keys`    | hand-keyed poses (below) |
| `clips`   | the core's clip names -> how each is made (below); `idle` and `walk` are required |
| `species` | `{ "actions": { name: { "pose": "stand", "weight": 1, "cooldown": 30 } } }`: the animal's own idle actions (a clip of that name), chosen now and then in that pose like the cat's groom or stretch |
| `texture` | px, the width of a base colour texture in the atlas (default 256; 512 for a detailed face) |
| `proportions` | per bone `scale`, `rot`, `aim` on the rest pose: a reshaped animal (below) |
| `colors`  | flat materials' colours: a recoloured animal (below) |
| `thumbFrame` | the baked frame the menu's render shows instead, e.g. `"idle_0"` (the Dachshund: its long body shows standing) |
| `credit`  | the source and licence (a built-in model: also in [README, Credits](../README.md#credits)) |

### Sources that are not a glTF yet

`src` (`{url, hash}` or `{path}`) may also have (package.nix `gltfOf`); the
built-in models need none of them, a model from a `.blend` all three:

- `"unzip": "Dir/*"`: it is a zip; the members matching the glob are
  unpacked. For a fetched one the `hash` is of those unpacked files (a
  recursive hash), not of the zip (a service may zip it on the fly).
- `"blend": "Dir/model.blend"`: the .blend to open (its path in the zip).
- `"blender": "convert.py"`: a Blender script of the folder, run at build
  time as `blender -b <blend> --python convert.py -- <out.glb>`; it exports
  the glTF (and may clean it up: drop meshes, add bones, key clips,
  decimate). The build fails when the script does or writes nothing.
  Blender (`pkgs.blender`) is then a build input of that model only.

### Clips: how animations map

The core asks for clips by name. Each pose has a loop, transitions join
poses, actions are one-shot clips that start and end in their pose:

| pose   | loop      | into it (and back)                                  |
|--------|-----------|-----------------------------------------------------|
| stand  | `idle`    |                                                     |
| walk   | `walk`    | `walkstart` (stand -> walk; played backwards to stop) |
| sit    | `sit`     | `sitdown` (stand -> sit), `standup` (sit -> stand)  |
| lie    | `lie`     | `liedown` (stand -> lie; backwards to get up)       |
| sleep  | `sleep`   | `curl` (lie -> sleep; backwards to wake)            |
| petted | `purr`, `sitpurr`, `liepurr` | `purrin`, `sitpurrin`, `liepurrin` |
| held   | `dangle`  | (hangs from the scruff: `"hang": true`)             |
| dropped| `fall`    | `land` (an action: lands, ends standing)            |

Actions: `startle` (a fast hand close by; then it backs off), `land`, the
cat's `groom` (sitting), `stretch`, `shake`, and the animal's own
(`species.actions`).

Whatever is missing falls back: a pose without its loop is not there
(commands and a saved pose take the nearest: sit, lie -> stand, sleep ->
lie); a transition without its clip is a cut; an action without its clip is
never chosen; petting without a purr loop does nothing; no `startle` / `land`
clip: it backs off / goes on at once; `dangle` / `fall` without their loops
show the nearest (fall, then stand).

Each clip is one of:

- `"Walk"`: that clip of the glTF, sampled at the baked fps (looping for a
  pose loop).
- `{ "clip": "Jump_ToIdle", "start": 0.5, "end": 1.3, "fps": 12, "loop": false }`:
  a part of it, at its own fps (12 for slow ones: fewer frames).
- `{ "clip": "Jump_ToIdle", "hold": 0.5 }` (or `"hold": "last"`): one frame
  held (`"seconds"`, `"layers"` as below).
- `{ "key": "sit", "seconds": 3, "fps": 8, "layers": [...] }`: a hand-keyed
  pose held; with layers a loop (at half the fps, or `fps`).
- `{ "blend": ["stand", "sit"], "seconds": 0.9 }`: a transition from the first
  frame of one clip or key to another's.
- `{ "reverse": "sitdown" }`: another clip backwards.
- `"hang": true` on any: hung from the scruff (the dangle), not on the floor.
- `"lift": 0.12` on any: that many m above the floor (flying): a loop all
  the time; a one-shot rises over its first quarter and settles over its
  last (e.g. a flying animal's `hover` and `startle`).

A layer is a sine on top: `{ "bone": "Tail1", "rot": [0, 22, 0], "period": 0.4, "phase": 0.5 }`
(degrees about the body's axes: a wagging tail) or `"scale": [0.03, 0, 0.03]`
(breathing).

### Keys: hand-keyed poses

`{ "from": "Idle", "at": 0, "rot": { bone: [x, y, z] }, "aim": { bone: [x, y, z] } }`:
that frame of a glTF clip, with bones turned (degrees about the body's axes:
x its left, + = nose down; y up; z forward) and / or aimed (the bone, toward
its first child joint, pointed along a direction in the body's axes: `[0, -1, 0]`
straight down, `[0, -0.1, 1]` forward along the floor). Parents are done
first; a child turns with its parent. Every frame is put on the floor (its
lowest point), so fold the legs until the body rests where it should.

Check the poses by rendering frames (thumb.py renders an OBJ with the
texture; `nix run github:lhns/steam-frame-nix#pet-preview` plays them all).

Turn a head with the bone that carries it and its ears: in the Quaternius
rigs the ears hang from `Neck3`, not from `Head`, and the skull's top is
skinned to them, so turning `Head` alone twists the face under still ears.
The Shiba, Fox and Dachshund turn their heads at `Neck3` (with `Neck1` /
`Neck2` for the neck; the split keeps the head where a `Head` turn had put
it) and relax the ears on top at `Ear2` (sleep).

### Budget and texture

- **Faces:** at most 3000 triangles per frame (the cat has 2636): vrcompositor
  draws every mounted frame, and a few hundred are mounted. The bake fails
  above it: decimate the model first (e.g. Blender's Decimate modifier).
- **Texture:** a render model has one texture. bake_gltf.py makes it:
  flat material colours become a palette (one 8-texel column per material,
  a little darker toward the floor by the vertex's height when standing:
  baked shading like the Toon Cat's), a material's base colour texture is
  stacked below it (UVs in 0..1), `texture` px wide (default 256).
  Everything is `cat.png` / `cat.mtl` next to the frames (the file names
  are shared by all models).
- **Facing:** the glTF's +Z forward, +Y up (as Blender's glTF export).

### A full example (the Shiba Inu, shortened)

```json
{
  "name": "Shiba Inu", "kind": "gltf", "order": 10,
  "credit": "Shiba Inu, Ultimate Animated Animal Pack by Quaternius, CC0 1.0",
  "src": { "url": "https://static.poly.pizza/ba6d0ee3-bcc0-4ef0-9d3c-a3e245b41c77.glb",
           "hash": "sha256-nL1PHhL4UCQSbqtqLFcGwJkZbfGhDbdObItnusP/9Uo=" },
  "height": 0.35,
  "feet": ["FrontLowerLeg.L_end", "FrontLowerLeg.R_end", "BackLowerLeg.L_end", "BackLowerLeg.R_end"],
  "follow": { "IKFrontLeg.L": "FrontLowerLeg.L", "IKFrontLeg.R": "FrontLowerLeg.R",
              "IKBackLeg.L": "BackLowerLeg.L", "IKBackLeg.R": "BackLowerLeg.R" },
  "zones": { "scruff": "Neck2", "head": "Head", "back": "Torso2",
             "chin": { "bone": "Head", "at": "joint" }, "tailBase": { "bone": "Tail1", "at": "joint" } },
  "keys": {
    "stand": { "from": "Idle" },
    "sit": { "from": "Idle",
             "rot": { "Back": [-38, 0, 0], "Neck1": [8, 0, 0], "Neck2": [6, 0, 0], "Neck3": [18, 0, 0] },
             "aim": { "FrontUpperLeg.L": [0.03, -1, 0.05], "BackLeg.L": [0.2, -0.3, 1],
                      "BackUpperLeg.L": [0.05, -0.35, -1], "BackLowerLeg.L": [0.05, -0.2, 1] } }
  },
  "clips": {
    "idle": { "clip": "Idle", "fps": 12 },
    "walk": "Walk",
    "walkstart": { "blend": ["stand", "walk"], "seconds": 0.3 },
    "sit": { "key": "sit", "seconds": 3, "layers": [{ "bone": "Torso2", "scale": [0.025, 0, 0.025], "period": 3 }] },
    "sitdown": { "blend": ["stand", "sit"], "seconds": 0.9 },
    "standup": { "reverse": "sitdown" },
    "purr": { "key": "stand", "seconds": 1.2, "fps": 24,
              "layers": [{ "bone": "Tail1", "rot": [0, 22, 0], "period": 0.4 }] },
    "fall": { "clip": "Jump_ToIdle", "hold": 0.5 },
    "land": { "clip": "Jump_ToIdle", "start": 0.5 },
    "startle": { "clip": "Idle_HitReact_Left", "loop": false },
    "sniff": { "clip": "Eating", "fps": 12, "loop": false }
  },
  "species": { "actions": { "sniff": { "pose": "stand", "weight": 1.2, "cooldown": 45 } } }
}
```

The complete ones in `modules/pet/models/`: `shiba/model.json`,
`fox/model.json` (same rig), `dachshund/model.json` (the Shiba reshaped:
below).

### Another build of the same animal: `extends`, `proportions`, `colors`

`"extends": "<id>"` starts from another model's spec: this one's fields go
on top (an object field entry by entry, so `"keys": { "sit": … }` replaces
only that key; the other's `default` and `thumb` are not taken). Files are
looked up in this folder, then in that model's. With these two fields
(bake_gltf.py) the same glTF and clips make a different animal:

- `proportions`: `{ bone: { "scale": [x, y, z], "rot": [x, y, z], "aim": [x, y, z] } }`,
  kept in every clip. `scale`: the skin the bone moves, in the bone's own
  axes (y along the bone, toward its child), from its joint; its children's
  joints move with it but are not scaled (a longer back keeps its legs).
  `rot` / `aim`: the bone's rest pose turned / aimed as in a key (body
  axes), on top of the clip's own motion (ears hanging, a straight tail).
  `follow` bones (IK feet) stay where they were relative to their bone,
  that offset scaled with it, turned as in the clip (flat paws).
- `colors`: `{ material name: "#rrggbb" }`: a flat material's colour (the
  glTF's material names; the Quaternius dogs: `Main`, `Main_Light`,
  `Black`, `Eyes_*`).

The Dachshund (`dachshund/model.json`) is the Shiba Inu this way: back and
torso ×1.25-1.45 long, legs ×0.42-0.5, muzzle ×1.3, the ears longer and aimed
down and out, the tail straightened, black and tan; the Shiba's clips and
behaviour, with its own `sit` key (the Shiba's leans back too far for short
front legs to reach the floor). Short legs lift less, so a reshaped walk's
speed counts only the feet moving back. Check the face from the front too
when rendering frames (above): a bone's
`scale` / `rot` / `aim` also moves the skin weighted partly to it (the
Shiba's eyes and brow are about a fifth `Ear1`, so the Dachshund's ears
bend at `Ear2`, `Ear1` only tilted 20° out).

## Private models

A model of a character someone else owns (the licence of a fan model does
not cover the character) is for personal use only: its spec has
`"private": true` and a `rights` note saying whose it is. index.py checks
both (`private` a boolean; `rights` only with `"private": true`), and
models.json marks it (`"private": true`).

Such a model goes into `steamFrame.pet.extraModels` from your own
configuration (a folder in your repository), never into
`modules/pet/models/`: a built-in model with `"private": true` fails
evaluation (package.nix `builtinOf`; the `pet` check tests the refusal and
that a private extra model builds).
