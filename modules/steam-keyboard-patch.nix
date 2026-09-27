# Esc/Ctrl/Alt and four arrow keys on Steam's VR keyboard.
# The keyboard is part of Steam's UI (hardcoded layouts in steamui JS), and in
# VR it can only send text; SteamClient.Input.ControllerKeyboardSetKeyState
# throws "Unknown method". So:
# - patch.js is injected at runtime into Steam's UI through its CEF
#   DevTools port (127.0.0.1:8080; SteamOS starts Steam with
#   -cef-enable-debugging). Steam's files are untouched, so updates don't undo
#   it. It rebuilds the bottom row and, while Ctrl/Alt is active (or for Esc),
#   hands the key combo to the helper instead of typing text. It also holds
#   the real Ctrl/Alt down while the toggle is on (Ctrl+scroll), and routes
#   characters Steam's key emulation turns into "1" (non-ASCII, AltGr/dead
#   keys on the de keymap: |@{[]}\~^`äöü€…) to the helper.
# - helper.mjs keeps that injection alive (Steam restarts, keyboard popup
#   recreated) and presses the combos with `xdotool key` on :0, where gamescope
#   keeps X focus on the window selected in VR. It only accepts ctrl/alt
#   chords and the extra keys, so the Steam UI can't use it to type text or
#   press Enter.
# Depends on Steam UI internals; tested with Steam client 1790377368.
{ config, pkgs, lib, ... }: {
  imports = [ ./session.nix ];

  options.steamFrame.steamKeyboardPatch.enable = lib.mkEnableOption ''
    the runtime patch of Steam's on-screen (VR) keyboard: Esc/Ctrl/Alt and four
    separate arrow keys, real Ctrl/Alt chords (held while toggled, e.g. for
    Ctrl+scroll), and working AltGr/non-ASCII characters. Injected into Steam's
    UI through its CEF DevTools port by an xdotool helper service; disabling
    it reverts the patch on the next switch
  '';

  config = lib.mkMerge [
  (lib.mkIf config.steamFrame.steamKeyboardPatch.enable {
    systemd.user.services.steam-keyboard-patch = {
      Unit.Description = "Modifier keys for Steam's VR keyboard (CEF patch + xdotool)";
      Service = {
        ExecStart = lib.escapeShellArgs [
          "${pkgs.nodejs}/bin/node"
          "${./steam-keyboard-patch/helper.mjs}"
          "${./steam-keyboard-patch/patch.js}"
          "${./steam-keyboard-patch/unpatch.js}"
          "${pkgs.xdotool}/bin/xdotool"
        ];
        Environment = "VRKBD_DISPLAY=:0";
        Restart = "always";
        RestartSec = 5;
        TimeoutStopSec = 5;   # the helper unpatches Steam's UI on SIGTERM
      };
      Install.WantedBy = [ "default.target" ];
    };

    # Restart on every switch so a changed patch is re-injected (it replaces
    # the older version).
    steamFrame.userServices.restart = [ "steam-keyboard-patch.service" ];
  })
  # Disabled: stop a still-running helper, which reverts the patch, so the
  # stock keyboard is back right away (no Steam restart or reboot).
  (lib.mkIf (!config.steamFrame.steamKeyboardPatch.enable) {
    steamFrame.userServices.stop = [ "steam-keyboard-patch.service" ];
  })
  ];
}
