# Runtime patch of Steam's on-screen (VR) keyboard. Steam's layouts are
# hardcoded in its UI, and in VR it can only send text (no Ctrl/Alt/Esc;
# SteamClient.Input.ControllerKeyboardSetKeyState throws "Unknown method").
# - patch.js is injected into Steam's running UI through its CEF DevTools port
#   (127.0.0.1:8080; SteamOS starts Steam with -cef-enable-debugging); Steam's
#   files are untouched. Bottom row: Esc Ctrl Alt [space] AltGr ← ↑ ↓ →, with
#   AltGr + arrows = Pos1/PgUp/PgDn/End. Chords, Shift+arrows and characters
#   Steam's key emulation turns into "1" (non-ASCII, AltGr/dead keys on the
#   de keymap) are handed to the helper; Ctrl/Alt are held while toggled.
# - helper.mjs keeps the injection alive (Steam restarts, popup recreated),
#   performs those requests with xdotool on :0 (X focus follows the window
#   selected in VR) and reverts the patch when stopped (unpatch.js). Its
#   allowlist can't type ASCII text or press Enter.
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
