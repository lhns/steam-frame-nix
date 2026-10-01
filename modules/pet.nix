# A 3D pet in SteamVR's scene, next to the windows (docs/pet.md): the Toon
# Cat in five coats, a Shiba Inu, a Fox, a Dachshund, and your own models
# (pet.extraModels). SteamVR dashboard patch "vr-pet" (pet/systemui.js +
# pet/core.js, built by pet/package.nix; "systemui" on 127.0.0.1:8087),
# registered only when enabled; enables steamvr-debugger.nix (one SteamVR
# restart the first time).
#
# Also, when enabled: the `vr-pet` command (pet/cli.mjs), the "+" menu entry
# "Pet" (vr-pet.desktop) and its icon: hicolor/256x256/apps/vr-pet.png links
# to <session.runtimeDir>/steam-frame-nix/vr-pet/icon.png (tmpfs), which
# steam-frame-nix-pet-icon (pet/icon.sh; on switch, at login and when the
# patch's state file changes: path unit) points to the current model's icon.
# Off removes the patch, the command, the entry and the units; the next
# switch's cleanup removes the tmpfs link. The saved state
# (ui-patches/vr-pet.json) is kept until `steam-frame-nix-cleanup --all`.
{ config, lib, pkgs, ... }:
let
  cfg = config.steamFrame.pet;
  dataDir = lib.removePrefix "${config.home.homeDirectory}/" config.xdg.dataHome;   # .local/share
  inherit (lib) mkOption mkEnableOption types;
  runtimeDir = config.steamFrame.session.runtimeDir;
  stateFile = "${config.xdg.stateHome}/steam-frame-nix/ui-patches/vr-pet.json";
  pkg = import ./pet/package.nix {
    inherit pkgs lib runtimeDir stateFile;
    hicolor = "${config.xdg.dataHome}/icons/hicolor";
    inherit (cfg) mount fps extraModels defaultModel;
    inherit (import ./steam-ui-patches/lib { inherit pkgs; }) finders hooks;
    catOptions = cfg.options // { demo = cfg.debug.demo; };
  };
in {
  imports = [ ./cleanup.nix ./steam-ui-patches.nix ./steamvr-debugger.nix ];

  options.steamFrame.pet = {
    enable = mkEnableOption ''
      the VR pet in SteamVR's dashboard scene, the `vr-pet` command and the
      "+" menu entry "Pet" (docs/pet.md). Builds its models on the first
      switch (about 0.5 GB in the store, no Blender for the built-in ones)'';
    options = mkOption {
      type = types.attrsOf types.anything;
      default = { };
      example = { walkSpeed = 0.3; follow = 3; };
      description = "Behaviour options of pet/core.js (DEFAULTS there).";
    };
    extraModels = mkOption {
      type = types.attrsOf (types.either types.path (types.attrsOf types.anything));
      default = { };
      example = lib.literalExpression ''{
        calico = { name = "Calico"; png = ./calico.png; };   # a coat: the cat with this texture
        corgi = ./pets/corgi;   # a folder like pet/models/<id>/ (model.json and its files)
      }'';
      description = ''
        More models, next to the built-in ones (pet/models/<id>/): each a
        folder with a model.json (and the files it names), or its spec as an
        attrset (files as paths; without "kind" a coat with its own "png", a
        64 x 64 texture laid out like the Toon Cat's cat.png: start from an
        edited copy of `nix build github:lhns/steam-frame-nix#pet-models`/cat.png).
        The spec fields and a full example: docs/pet-models.md. A model may
        be "private": true (personal use only, never published); the built-in
        ones may not. Listed in the
        pet's menu and `vr-pet models` by "order" (built-in coats 0-4,
        animals 10-19; default 100), then name.
      '';
    };
    defaultModel = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "shiba";
      description = ''
        The model shown until another is picked (its id); null: the one whose
        spec says "default": true (the Ginger cat).
      '';
    };
    fps = mkOption {
      type = types.ints.between 4 60;
      default = 24;
      description = ''
        Animation frames per second (baked frames and scene graph updates;
        slow breathing loops use 1/2 or 1/3 of it). More is smoother and
        costs more frames kept loaded in vrcompositor and more scene graph
        updates.
      '';
    };
    mount = mkOption {
      type = types.enum [ "dynamic" "all" ];
      default = "dynamic";
      description = ''
        Which baked frames stay mounted in SteamVR's scene graph (each one
        is drawn): only the clips the cat needs now or next, or all of them
        (pet/systemui.js).
      '';
    };
    debug = {
      demo = mkEnableOption "the demo tour (cycles through all poses and activities)";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ pkg.cli ];
    steamFrame.cleanup.keep = [ "pet" ];

    # The dashboard "+" menu's entry ("Pet", package.nix desktopEntry) and
    # its icon: a link to steam-frame-nix-pet-icon's link to the current model's icon.
    xdg.dataFile."applications/vr-pet.desktop".source = pkg.desktopEntry;
    xdg.dataFile."icons/hicolor/256x256/apps/vr-pet.png".source =
      config.lib.file.mkOutOfStoreSymlink "${runtimeDir}/steam-frame-nix/vr-pet/icon.png";

    systemd.user.services.steam-frame-nix-pet-icon = {
      Unit.Description = "steam-frame-nix: the VR pet's \"+\" menu icon (the current model's)";
      Service = {
        Type = "oneshot";
        ExecStart = lib.getExe pkg.iconLink;
      };
      Install.WantedBy = [ "default.target" ];
    };
    systemd.user.paths.steam-frame-nix-pet-icon = {
      Unit.Description = "steam-frame-nix: update the VR pet's \"+\" menu icon when the model changes";
      Path = {
        PathChanged = [ stateFile ];
        Unit = "steam-frame-nix-pet-icon.service";
      };
      Install.WantedBy = [ "default.target" ];
    };
    steamFrame.session.services.start = [ "steam-frame-nix-pet-icon.path" ];

    # On switch: the icon link (new icons, a new link). GTK (Steam) rescans
    # an icon theme only when its directory's mtime changes: steam-frame-nix-pet-icon
    # bumps it when its link changed, this when the hicolor link is new.
    home.activation.steamFrameNixPetIcon = lib.hm.dag.entryAfter [ "writeBoundary" "linkGeneration" "steamFrameNixCleanup" ] ''
      if [[ -v DRY_RUN ]]; then
        echo "would run: ${lib.getExe pkg.iconLink}"
      else
        ${lib.getExe pkg.iconLink} || true
        hicolor=${lib.escapeShellArg "${dataDir}/icons/hicolor"}
        f=$hicolor/256x256/apps/vr-pet.png
        if [[ -d $HOME/$hicolor && ! -L ''${oldGenPath:-/nonexistent}/home-files/$f ]]; then
          touch "$HOME/$hicolor"
        fi
      fi
    '';

    steamFrame.uiPatches.patches = [ {
      name = "vr-pet";
      endpoint = "http://127.0.0.1:8087";
      target.title = "systemui";
      patch = pkg.patch;
      unpatch = ./pet/unpatch.js;
      state = true;                 # spot, pose, model, hidden
    } ];
  };
}
