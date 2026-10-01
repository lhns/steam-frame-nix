# VR pet build: the cat's baked frames (bake.py, glTF helpers in rig.py),
# the model catalog (index.py: models/<id>/ and extraModels; coats by
# skin.py, animals by bake_gltf.py, thumbnails by thumb.py), the SteamVR
# patch (core.js + systemui.js), the `vr-pet` CLI (cli.mjs), the "+" menu
# entry and its icons (steam-frame-nix-pet-icon: icon.sh), the desktop preview (preview/)
# and the tests (tests/, the flake check pet). System-independent
# inputs (the model sources, in this repository: sources/ and
# models/<id>/; Python + numpy/pillow), so it also builds on x86_64.
# Credits and licences: README.md, "Credits".
{ pkgs, lib ? pkgs.lib
, height ? 0.30   # m, standing height of the cat (ears)
, fps ? 24        # baked frames per second, and core ticks per second
, catOptions ? { }   # core.js options (DEFAULTS there)
, mount ? "dynamic"  # systemui.js: "dynamic" | "all"
, finders ? null     # steam-frame-nix's lib/finders.js and lib/hooks.js
, hooks ? null       # (for the SteamVR patch)
, extraModels ? { }  # id -> a model folder (as models/<id>/) or a spec (attrset; files as paths)
, defaultModel ? null  # the model shown first (null: the spec with "default": true)
, runtimeDir ? "/run/user/1000"   # steam-frame-nix-pet-icon: its link's tmpfs (<runtimeDir>/steam-frame-nix/vr-pet)
, stateFile ? "/nonexistent"      # steam-frame-nix-pet-icon: the patch's state file (its "model")
, hicolor ? "/nonexistent"        # steam-frame-nix-pet-icon: the hicolor dir whose mtime it bumps
}:
let
  # The cat's sources, in this repository (sources/*/LICENSE.md):
  toonCat = ./sources/toon-cat/toon_cat_free.glb;   # Omabuarts, CC-BY 4.0
  tuxedo = ./sources/tuxedo-cat;                     # DreamNoms, CC-BY 4.0
  threeTgz = pkgs.fetchurl {   # MIT
    url = "https://registry.npmjs.org/three/-/three-0.170.0.tgz";
    hash = "sha256-SmCKNV3KunLg5Tg83IFDA/W2BgtDwjjN9pMtzraZI40=";
  };

  python = pkgs.python3.withPackages (p: [ p.numpy p.pillow ]);
  # Copies these files of this folder into src/ (a step's scripts import each
  # other; only the files it runs, so other edits don't rebuild it).
  srcOf = names: "mkdir -p src\n" + lib.concatMapStrings (n: "cp ${./. + "/${n}"} src/${n}\n") names;

  models = pkgs.runCommand "vr-pet-models" { nativeBuildInputs = [ python ]; } ''
    mkdir tuxedo
    cp ${tuxedo + "/scene.gltf"} tuxedo/scene.gltf
    cp ${tuxedo + "/scene.bin"} tuxedo/scene.bin
    ${srcOf [ "bake.py" "rig.py" ]}
    python3 src/bake.py ${toonCat} tuxedo/scene.gltf $out ${toString height} ${toString fps}
    cp ${credits} $out/CREDITS.md
  '';
  # Next to the baked frames (derived from CC-BY 4.0 models); the full
  # attributions: README.md, "Credits".
  credits = pkgs.writeText "CREDITS.md" ''
    Based on "Toon Cat FREE" by Omabuarts Studio
    (https://sketchfab.com/3d-models/toon-cat-free-b2bd1ee7858444bda366110a2d960386)
    and "Tuxedo Cat Animated 2.0" by DreamNoms
    (https://sketchfab.com/3d-models/tuxedo-cat-animated-20-783fcb78b55b4394a212c2b6392e1113),
    licensed under CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/);
    modified: retargeted and hand-keyed animations, baked per frame.
    Credits: https://github.com/lhns/steam-frame-nix#credits
  '';

  # The model catalog: one folder per model, models/<id>/model.json (and the
  # files it names), found here by readDir (no list of ids anywhere), plus
  # extraModels (a folder like those, or a spec as an attrset); built by
  # index.py into one directory per model and models.json (the index the
  # patch embeds). The kinds and fields: docs/pet-models.md. An animal's bake
  # is a derivation of its own (its spec, its glTF, bake_gltf.py, rig.py), so
  # editing one model's spec rebakes only that model (and those extending it).
  specError = id: msg: throw "vr-pet model ${id}: ${msg} (see docs/pet-models.md)";
  # id -> folder -> { id, spec, file: the spec's store path, at: a file of the folder }
  readModel = id: dir:
    let f = dir + "/model.json"; in
    if !(builtins.pathExists f) then specError id "no model.json in ${toString dir}"
    else { inherit id; spec = builtins.fromJSON (builtins.readFile f); file = f; at = name: dir + "/${name}"; };
  discover = root: lib.mapAttrsToList (id: _: readModel id (root + "/${id}"))
    (lib.filterAttrs (_: t: t == "directory") (builtins.readDir root));
  # The built-in models (models/<id>/) are published with steam-frame-nix:
  # one whose spec says "private": true (a character someone else owns,
  # personal use only) fails evaluation. Private models go into extraModels,
  # from the user's own configuration.
  builtinOf = root: let
    ms = discover root;
    private = map (m: m.id) (lib.filter (m: m.spec.private or false == true) ms);
  in if private != [ ] then throw ("vr-pet: built-in model(s) ${lib.concatStringsSep ", " private} say \"private\": true;"
    + " private models belong in steamFrame.pet.extraModels of your own configuration,"
    + " never in modules/pet/models/ (docs/pet-models.md, \"Private models\")")
  else ms;
  extra = lib.mapAttrsToList (id: m:
    if builtins.isPath m || builtins.isString m then readModel id m
    else let spec = { kind = "texture"; order = 100; } // m; in
      { inherit id spec; file = pkgs.writeText "${id}-model.json" (builtins.toJSON spec); at = p: p; }) extraModels;
  # "extends" (docs/pet-models.md): the other spec with this one's fields on
  # top, an object field entry by entry; files looked up here, then there.
  extend = all: m:
    if !(m.spec ? extends) then m else
    let
      b = extend all (lib.findFirst (x: x.id == m.spec.extends)
        (specError m.id "\"extends\": no model ${builtins.toJSON m.spec.extends}") all);
      over = n: v: if builtins.isAttrs v && builtins.isAttrs (b.spec.${n} or null) then b.spec.${n} // v else v;
      spec = builtins.removeAttrs (builtins.removeAttrs b.spec [ "default" "thumb" ] // lib.mapAttrs over m.spec) [ "extends" ];
    in {
      inherit (m) id;
      inherit spec;
      file = pkgs.writeText "${m.id}-model.json" (builtins.toJSON spec);
      at = name: if builtins.pathExists (m.at name) then m.at name else b.at name;
    };
  extendAll = all: map (extend all) all;
  # A spec with its files as store paths (index.py checks the rest).
  resolve = { id, spec, file, at }:
    let kind = spec.kind or (specError id "no \"kind\""); in
    spec // { inherit id; } // (
      if kind == "texture" then { png = "${at (spec.png or (specError id "kind texture needs \"png\""))}"; }
      else if kind == "gltf" then { baked = "${bakeGltf id file (spec.src or (specError id "kind gltf needs \"src\"")) at}"; }
      else { }) // lib.optionalAttrs (spec ? thumb) { thumb = "${at spec.thumb}"; };
  # An animal's frames: bake_gltf.py on its glTF (gltfOf).
  bakeGltf = id: file: src: at:
    let glb = gltfOf id src at; in
    pkgs.runCommand "vr-pet-${id}" { nativeBuildInputs = [ python ]; } ''
      ${srcOf [ "bake_gltf.py" "rig.py" ]}
      python3 src/bake_gltf.py ${file} ${glb} $out ${toString fps}
    '';
  # An animal's glTF from its "src" (docs/pet-models.md): a file of its
  # folder, {url, hash} (fetched) or {path}; optionally unzipped ("unzip",
  # a fetched one's hash is of the unpacked files) and turned into a glTF by
  # a Blender script ("blend", "blender": a derivation of its own, so it
  # reruns only when its source or script changes).
  gltfOf = id: src: at:
    if !(builtins.isAttrs src) then at src
    else let
      zip = src ? unzip;
      unzip = ''${pkgs.unzip}/bin/unzip -q "$zip" ${lib.escapeShellArg (src.unzip or "")} -d "$out" || [ $? -le 1 ]'';
      got = if src ? path then at src.path
        else pkgs.fetchurl ({ name = if zip || src ? blender then "${id}-src" else "${id}.glb"; inherit (src) url hash; }
          // lib.optionalAttrs zip { downloadToTemp = true; recursiveHash = true; postFetch = "zip=$downloadedFile; ${unzip}"; });
      unpacked = if zip && src ? path then pkgs.runCommand "${id}-src" { } "zip=${got}; ${unzip}" else got;
      input = if src ? blend then "${unpacked}/${src.blend}" else unpacked;
    in if src ? blender then
      pkgs.runCommand "${id}.glb" { nativeBuildInputs = [ pkgs.blender ]; } ''
        export HOME=$TMPDIR
        blender -b ${lib.escapeShellArg input} --python-exit-code 1 --python ${at src.blender} -- $out
        test -s $out
      ''
    else input;
  specOf = specs: pkgs.writeText "vr-pet-models-spec.json" (builtins.toJSON { default = defaultModel; models = map resolve specs; });
  catalogOf = specs: let
    spec = specOf specs;
  in pkgs.runCommand "vr-pet-catalog" { nativeBuildInputs = [ python ]; } ''
    ${srcOf [ "index.py" "skin.py" "thumb.py" ]}
    python3 src/index.py ${spec} ${models} $out
  '';
  specs = extendAll (builtinOf ./models ++ extra);
  catalog = catalogOf specs;
  # (tests: the same with the model folders of tests/models added, as
  # extraModels: a coat and a private one)
  testCatalog = catalogOf (extendAll (builtinOf ./models ++ extra ++ discover ./tests/models));
  # (tests: a private built-in model, tests/builtin-private, is refused)
  privateRefused = !(builtins.tryEval (builtinOf ./tests/builtin-private)).success;

  options = {
    inherit fps mount;
    cat = catOptions;
  };

  # ((opts, catalog, find, hooks) => { core; adapter; return vrPetSystemui(…); })
  #   (opts, models.json, finders.js, hooks.js)
  patch = assert finders != null && hooks != null; pkgs.runCommand "vr-pet.js" { } ''
    { echo '((opts, baked, find, hooks) => {'
      cat ${./core.js} ${./systemui.js}
      echo 'return vrPetSystemui(opts, baked, find, hooks);'
      echo '})('
      echo ${lib.escapeShellArg (builtins.toJSON options)}
      echo ','
      cat ${catalog}/models.json
      echo ','
      cat ${finders}
      echo ','
      cat ${hooks}
      echo ')'; } > $out
  '';

  # The "+" menu entry's icons: <id>.png for every model of the catalog (its
  # thumbnail's picture, 256 px, transparent) and default.txt (the default
  # model's id); steam-frame-nix-pet-icon links the current model's.
  icons = pkgs.runCommand "vr-pet-icons" { nativeBuildInputs = [ python ]; } ''
    ${srcOf [ "index.py" "skin.py" "thumb.py" ]}
    python3 src/index.py --icons ${specOf specs} ${catalog} $out
  '';

  # steam-frame-nix-pet-icon (icon.sh): points <runtimeDir>/steam-frame-nix/vr-pet/icon.png at the icon
  # of the model in the patch's state file (stateFile); bumps hicolor's
  # mtime when it changed. All four overridable by environment (the tests).
  iconLink = pkgs.writeShellApplication {
    name = "steam-frame-nix-pet-icon";
    runtimeInputs = [ pkgs.coreutils pkgs.jq pkgs.util-linux ];
    text = ''
      runtime=''${VR_PET_RUNTIME_DIR:-${lib.escapeShellArg runtimeDir}}
      state=''${VR_PET_STATE:-${lib.escapeShellArg stateFile}}
      icons=''${VR_PET_ICONS:-${icons}}
      hicolor=''${VR_PET_HICOLOR:-${lib.escapeShellArg hicolor}}
    '' + builtins.readFile ./icon.sh;
  };

  # The "+" menu entry: shows the pet (never hides it; the launcher's
  # debounce keeps a double click from launching twice); its icon is
  # steam-frame-nix-pet-icon's link.
  desktopEntry = pkgs.writeText "vr-pet.desktop" ''
    [Desktop Entry]
    Type=Application
    Name=Pet
    Comment=Bring the VR pet back
    Exec=${cli}/bin/vr-pet show
    Icon=vr-pet
    Terminal=false
    Categories=Game;Amusement;
  '';

  # vr-pet show [--summon] | hide | status | models | model <id> (cli.mjs). Also run by Steam's
  # "+" menu, hence no inherited LD_PRELOAD / LD_LIBRARY_PATH; its output also
  # goes to the journal (vr-pet).
  cli = pkgs.writeShellApplication {
    name = "vr-pet";
    runtimeInputs = [ pkgs.nodejs pkgs.systemd ];
    text = ''
      unset LD_PRELOAD LD_LIBRARY_PATH
      rc=0
      out=$(node ${./cli.mjs} "$@" 2>&1) || rc=$?
      if [[ -n $out ]]; then printf '%s\n' "$out"; fi
      { printf 'vr-pet %s: ' "$*"; printf '%s\n' "''${out:-(no output)} (exit $rc)"; } | systemd-cat -t vr-pet 2>/dev/null || true
      exit "$rc"
    '';
  };

  three = pkgs.runCommand "three-0.170.0" { } ''
    mkdir $out
    tar -xzf ${threeTgz} --strip-components=1 -C $out package/build/three.module.js package/LICENSE
    mv $out/build/three.module.js $out/
    rmdir $out/build
  '';

  site = pkgs.runCommand "vr-pet-preview-site" { } ''
    mkdir $out
    cp ${./preview/index.html} $out/index.html
    cp ${./preview/preview.js} $out/preview.js
    cp ${./core.js} $out/core.js
    echo ${lib.escapeShellArg (builtins.toJSON { inherit fps; cat = catOptions; })} > $out/config.json
    ln -s ${models} $out/models
    ln -s ${catalog} $out/catalog
    ln -s ${three} $out/three
  '';

  # Headless tests (flake check `pet`): the core with scripted hands
  # (core, species: every frame set of the catalog), the SteamVR adapter in a
  # fake systemui page (systemui), the CLI with a fake DevTools transport,
  # the catalog (models), the glTF reshaping (gltf), the "+" menu's icons,
  # entry and steam-frame-nix-pet-icon (icons, entry, icon link), the
  # refusal of a private built-in model (private).
  tests = pkgs.runCommand "pet-tests" { nativeBuildInputs = [ pkgs.nodejs python pkgs.desktop-file-utils iconLink ]; } ''
    mkdir -p src/tests
    ${srcOf [ "core.js" "systemui.js" "unpatch.js" "cli.mjs" "skin.py" "index.py" "thumb.py" "bake_gltf.py" "rig.py"
      "tests/sim.js" "tests/core.test.js" "tests/species.test.js" "tests/systemui.test.js" "tests/cli.test.mjs"
      "tests/models.test.py" "tests/gltf.test.py" ]}
    cp -r ${./models} src/models
    { echo '# core'; node src/tests/core.test.js ${models}/frames.json; } > core.log || { cat core.log; exit 1; }
    { echo '# species'; node src/tests/species.test.js ${catalog}/models.json; } > species.log || { cat species.log; exit 1; }
    { echo '# systemui'; node src/tests/systemui.test.js ${catalog}/models.json; } > systemui.log || { cat systemui.log; exit 1; }
    { echo '# cli'; node src/tests/cli.test.mjs; } > cli.log || { cat cli.log; exit 1; }
    { echo '# models'; python3 src/tests/models.test.py ${catalog} ${models} ${testCatalog}; } > models.log || { cat models.log; exit 1; }
    { echo '# gltf'; python3 src/tests/gltf.test.py; } > gltf.log || { cat gltf.log; exit 1; }
    { echo '# icons'; python3 ${./tests/icons.test.py} ${./models} ${icons}; } > icons.log || { cat icons.log; exit 1; }
    { echo '# entry'; desktop-file-validate ${desktopEntry} && echo 'ok  desktop-file-validate vr-pet.desktop'; } > entry.log 2>&1 || { cat entry.log; exit 1; }
    { echo '# icon link'; bash ${./tests/icon.test.sh}; } > link.log 2>&1 || { cat link.log; exit 1; }
    { echo '# private'; ${if privateRefused then "echo 'ok  a private built-in model (tests/builtin-private) fails evaluation'"
      else "echo 'FAIL a private built-in model (tests/builtin-private) was not refused'; exit 1"}; } > private.log || { cat private.log; exit 1; }
    cat core.log species.log systemui.log cli.log models.log gltf.log icons.log entry.log link.log private.log | tee $out
  '';

  preview = pkgs.writeShellApplication {
    name = "vr-pet-preview";
    runtimeInputs = [ pkgs.python3 ];
    text = ''
      port="''${1:-8765}"
      echo "VR pet preview: http://127.0.0.1:$port/  (Ctrl+C stops)"
      exec python3 -m http.server --bind 127.0.0.1 --directory ${site} "$port"
    '';
  };
in {
  inherit models catalog patch site preview tests icons iconLink desktopEntry cli;
}
