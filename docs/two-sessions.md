# Two sessions

The Frame runs two graphical sessions at once; most workarounds exist because
of their differences:

| | Steam / VR session | Nested Plasma desktop |
|---|---|---|
| Compositor | gamescope | KWin (nested, shown as a VR window) |
| Displays | X display `:0` (apps show as floating VR windows) | own Wayland + Xwayland `:2` |
| D-Bus | the outer session bus, `/run/user/1000/bus` | a private bus |
| `XDG_RUNTIME_DIR` | `/run/user/1000` | its own |
| systemd user manager | yes | not reachable |

Consequences:

- **Wallet:** there should be one `kwalletd6`, on the outer bus; apps started
  from the desktop would otherwise start a second one whose secrets VR can't
  see. Prefix launchers' `Exec=` with `steamFrame.session.busEnv`
  ([session settings](desktop-integration.md#session-settings-and-services)).
- **User services:** home-manager skips `reloadSystemd` when switching from
  the desktop terminal, so `steamFrame.session.services` talks to the outer
  user manager directly.
- **Launchers:** the "+" menu only sees `~/.local/share/applications` (not
  `~/.nix-profile/share`), so entries are written there, shadowing
  Flatpak/package entries with the same ID.
- **Keyboard layout:** KDE's layout only affects the nested desktop
  ([keyboard layout](keyboard.md#layout)).
- **Clipboard:** separate per session ([clipboard sync](desktop-integration.md#clipboard-sync)).
- **Firefox:** the sessions can't see each other's Firefox, so a second
  instance stops at the locked profile ([desktop profile](firefox.md#options)).

Switch (`home-manager switch`) from a terminal **in the nested desktop**, so
clipboard-sync restarts with the desktop's environment.
