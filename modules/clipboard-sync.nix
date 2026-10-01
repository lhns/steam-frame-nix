# clipboard-sync between the Steam session's X displays and the nested desktop
# (Xwayland :2). KDE autostart, not systemd: the nested desktop can't reach the
# user manager, and :2 must exist first. Built from source (upstream flake is
# x86-only); flake.nix passes the source in.
{ clipboard-sync-src }:
{ config, pkgs, lib, ... }:
let
  cfg = config.steamFrame.clipboardSync;
in {
  imports = [ ./cleanup.nix ];

  options.steamFrame.clipboardSync = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;   # without it the nested desktop's clipboard is isolated
      description = ''
        Run clipboard-sync between the Steam session and the nested desktop
        (KDE autostart; switch stops stale builds and duplicates).
      '';
    };
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

    # Keep one instance of the current build, preferably one started in the
    # nested desktop (it inherits the environment; one from a Steam-session
    # terminal has the wrong one). Kill stale builds and duplicates; start a new
    # one only when switching from the nested desktop (else autostart does).
    home.activation.startClipboardSync = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      want="${cfg.package}/bin/clipboard-sync"
      desktop=() other=()
      for pid in $(${pkgs.procps}/bin/pgrep -x clipboard-sync || true); do
        # clipboard-sync forks workers; only look at top-level instances.
        # Gone since pgrep (e.g. an exited worker): skip it.
        ppid="$(${pkgs.procps}/bin/ps -o ppid= -p "$pid" | tr -d ' ')" || continue
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
