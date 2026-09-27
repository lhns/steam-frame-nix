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
      (KDE autostart; on switch, stale builds and duplicates are stopped)
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

    # Keep exactly one instance of the current build, preferably one started in
    # the nested desktop (XDG_CURRENT_DESKTOP=KDE): it inherits the process
    # environment, so a copy started from a Steam-session terminal runs with
    # the wrong session's env. Stale builds and duplicate instances are
    # stopped (workers of an instance are left alone). A new
    # instance is only started when switching from the nested desktop;
    # otherwise the autostart entry starts it with the desktop.
    home.activation.startClipboardSync = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      want="${cfg.package}/bin/clipboard-sync"
      desktop=() other=()
      for pid in $(${pkgs.procps}/bin/pgrep -x clipboard-sync || true); do
        # clipboard-sync forks workers; only look at top-level instances.
        ppid="$(${pkgs.procps}/bin/ps -o ppid= -p "$pid" | tr -d ' ')"
        [ "$(cat "/proc/$ppid/comm" 2>/dev/null)" = clipboard-sync ] && continue
        if [ "$(readlink "/proc/$pid/exe" 2>/dev/null)" != "$want" ]; then
          run kill "$pid" || true                                  # stale build
        elif tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx 'XDG_CURRENT_DESKTOP=KDE'; then
          desktop+=("$pid")
        else
          other+=("$pid")
        fi
      done
      if [ ''${#desktop[@]} -gt 0 ]; then
        keep=("''${desktop[0]}")
      elif [ "''${XDG_CURRENT_DESKTOP:-}" = KDE ]; then
        keep=()
      else
        keep=("''${other[@]:0:1}")
      fi
      for pid in "''${desktop[@]}" "''${other[@]}"; do
        [[ " ''${keep[*]} " == *" $pid "* ]] || run kill "$pid" || true
      done
      if [ ''${#keep[@]} -eq 0 ]; then
        if [ "''${XDG_CURRENT_DESKTOP:-}" = KDE ]; then
          run ${pkgs.util-linux}/bin/setsid -f "$want" >/dev/null 2>&1
        else
          echo "clipboard-sync: not running; it starts with the nested desktop (autostart)"
        fi
      fi
    '';
  };
}
