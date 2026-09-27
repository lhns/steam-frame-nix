# clipboard-sync: bridges the clipboards of the Steam session's X displays and
# the nested Plasma desktop (own Wayland + Xwayland :2).
# Started via KDE autostart, not systemd: the nested desktop has no access to
# the user systemd instance, and clipboard-sync must start after :2 exists.
#
# Built from source with the consumer's pkgs (the upstream flake outputs are
# x86-only); flake.nix passes the source in through this closure.
{ clipboard-sync-src }:
{ config, pkgs, lib, ... }:
let
  cfg = config.steamFrame.clipboardSync;
in {
  options.steamFrame.clipboardSync = {
    enable = lib.mkEnableOption ''
      clipboard-sync between the Steam session and the nested desktop
      (KDE autostart; restarted on switch when the build changed)
    '';
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.rustPlatform.buildRustPackage {
        pname = "clipboard-sync";
        version = "git";
        src = clipboard-sync-src;
        cargoLock.lockFile = "${clipboard-sync-src}/Cargo.lock";
        nativeBuildInputs = [ pkgs.pkg-config ];
        buildInputs = [ pkgs.libxcb ];
      };
      defaultText = lib.literalMD "built from the `clipboard-sync-src` flake input";
      description = "The clipboard-sync package.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    xdg.configFile."autostart/clipboard-sync.desktop".text = ''
      [Desktop Entry]
      Type=Application
      Name=clipboard-sync
      Exec=${cfg.package}/bin/clipboard-sync
      X-KDE-autostart-phase=2
      NoDisplay=true
    '';

    # (Re)start on switch if not running the current build.
    # Run `home-manager switch` from a desktop terminal so it gets the desktop env.
    home.activation.startClipboardSync = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      want="${cfg.package}/bin/clipboard-sync"
      pid="$(${pkgs.procps}/bin/pgrep -x clipboard-sync | head -n1 || true)"
      have="$( [ -n "$pid" ] && readlink "/proc/$pid/exe" || true )"
      if [ "$have" != "$want" ]; then
        ${pkgs.procps}/bin/pkill -x clipboard-sync || true
        run ${pkgs.util-linux}/bin/setsid -f "$want" >/dev/null 2>&1
      fi
    '';
  };
}
