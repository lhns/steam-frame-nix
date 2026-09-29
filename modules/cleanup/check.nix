# Checks of `install.sh cleanup` on fake home and runtime dirs: every
# artifact any version wrote (removed or restored) next to look-alikes that
# aren't ours (left alone), --dry-run changes nothing, a second run changes
# nothing, SteamVR running defers the debugger key to a runtime drop-in.
{ pkgs }:
let
  cleanup = pkgs.callPackage ./package.nix { };
in
pkgs.runCommand "cleanup-check" { nativeBuildInputs = [ cleanup pkgs.jq ]; } ''
  set -euo pipefail
  fail() { echo "FAIL: $*" >&2; exit 1; }
  export HOME XDG_RUNTIME_DIR STEAM_FRAME_NIX_RUNTIME_DIR STEAM_FRAME_NIX_SYSTEMCTL
  unset XDG_STATE_HOME XDG_DATA_HOME XDG_CONFIG_HOME

  # systemctl stub: SteamVR's state from $STUB/state, calls logged.
  STUB=$PWD/stub; mkdir -p $STUB
  cat > $STUB/systemctl <<'SH'
  #!/usr/bin/env bash
  echo "$*" >> "$STUB/log"
  case "$*" in *"show -p ActiveState --value steamvr.service"*) cat "$STUB/state" ;; esac
  SH
  chmod +x $STUB/systemctl
  sed -i "1s|.*|#!${pkgs.bash}/bin/bash|" $STUB/systemctl
  export STUB
  STEAM_FRAME_NIX_SYSTEMCTL=$STUB/systemctl

  fresh() {
    root=$PWD/$1; rm -rf $root; mkdir -p $root/home $root/run
    HOME=$root/home XDG_RUNTIME_DIR=$root/run STEAM_FRAME_NIX_RUNTIME_DIR=$root/run
    : > $STUB/log; echo inactive > $STUB/state
    S=$HOME/.local/state/steam-frame-nix
    V=$HOME/.config/openvr/config/steamvr.vrsettings
    I=$HOME/.local/share/icons/hicolor/scalable/apps
    F=$HOME/.var/app/org.mozilla.firefox/config/mozilla/firefox
    O=$HOME/.local/share/flatpak/overrides
    mkdir -p $S/ui-patches ''${V%/*} $I $F $O
  }
  snap() { (cd $root && find . -printf '%p %y %m %l %T@\n' | sort; find . -type f -exec sha256sum {} + | sort) ; }
  has() { grep -qF -- "$2" <<< "$1" || fail "output lacks '$2':"$'\n'"$1"; }
  hasnt() { ! grep -qF -- "$2" <<< "$1" || fail "output has '$2':"$'\n'"$1"; }
  gone() { for p; do [ ! -e "$p" ] && [ ! -L "$p" ] || fail "still there: $p"; done; }
  there() { for p; do [ -e "$p" ] || [ -L "$p" ] || fail "missing: $p"; done; }
  noop() { # a further run changes nothing
    local before; before=$(snap); res=$(steam-frame-nix-cleanup "$@")
    [ "$(snap)" = "$before" ] || fail "second run changed files"
    ! grep -Eq '^ +(removed|rewrote|wrote|migrated|touched) | restored \(' <<< "$res" || fail "second run acted:"$'\n'"$res"
  }

  # --- A: --all, SteamVR stopped: everything ---
  fresh a
  printf '{\n   "VRWebHelper" : {\n      "DebuggerEnabled" : true,\n      "DebuggerPort" : 8087\n   },\n   "steamvr" : {}\n}\n' > $V
  chmod 600 $V
  touch $S/steamvr-debugger                         # marker of the first version
  mkdir -p $root/run/steam-frame-nix $root/run/systemd/user/steamvr.service.d
  echo old > $root/run/steam-frame-nix/steamvr-debugger-restore
  mkdir -p $root/run/steam-frame-nix/applications       # steamFrame.launchers
  echo '[Desktop Entry]' > $root/run/steam-frame-nix/applications/im.riot.Riot.desktop
  echo x > $root/run/steam-frame-nix/applications/.im.riot.Riot.desktop.sum
  : > $root/run/steam-frame-nix/applications/.lock
  echo old > $root/run/systemd/user/steamvr.service.d/50-steam-frame-nix-debugger.conf
  echo keep > $root/run/systemd/user/steamvr.service.d/other.conf
  ln -s /nix/store/00000000000000000000000000000000-breeze-icons-6.30.0/share/icons/breeze/apps/64/utilities-terminal.svg $I/utilities-terminal.svg
  ln -s /nix/store/00000000000000000000000000000000-home-manager-files/.local/share/icons/hicolor/scalable/apps/hm.svg $I/hm.svg
  ln -s /somewhere/else.svg $I/other.svg
  printf 'utilities-terminal\n' > $S/icon-fallbacks
  mkdir -p $F/desktop $F/a.default $F/b.old $F/c.mine $F/d.busy $F/e.fresh
  ln -s /app/etc/firefox/steam-frame-nix-desktop-user.js $F/desktop/user.js
  printf 'user_pref("full-screen-api.ignore-widgets", false);\nuser_pref("other", 1);\n' > $F/desktop/prefs.js
  printf '%s\nuser_pref("a.b", true);\n' '// Managed by steam-frame-nix (steamFrame.firefox); rewritten on switch.' > $F/a.default/user.js
  printf 'user_pref("a.b", true);\nuser_pref("c.d", 2);\n' > $F/a.default/prefs.js
  ln -s /nix/store/00000000000000000000000000000000-firefox-user.js $F/b.old/user.js
  echo 'user_pref("mine", 1);' > $F/c.mine/user.js
  printf '%s\nuser_pref("a.b", true);\n' '// Managed by steam-frame-nix (steamFrame.firefox); rewritten on switch.' > $F/d.busy/user.js
  printf 'user_pref("a.b", true);\n' > $F/d.busy/prefs.js; touch $F/d.busy/.parentlock
  ln -s /app/etc/firefox/steam-frame-nix-desktop-user.js $F/e.fresh/user.js
  printf '[Context]\ndevices=all;\nfilesystems=/nix/store/00000000000000000000000000000000-mpv-hwdec-shim:ro;xdg-music:ro;\n\n[Environment]\nLD_PRELOAD=/nix/store/00000000000000000000000000000000-mpv-hwdec-shim/lib/mpv-hwdec-shim.so\nSFN_MPV_HWDEC=v4l2m2m-copy,auto-copy\nFOO=bar\n' > $O/org.jellyfin.JellyfinDesktop
  printf '[Context]\ndevices=all;\n' > $O/org.example.Other
  mkdir -p $HOME/.var/app/org.jellyfin.JellyfinDesktop
  echo so > $HOME/.var/app/org.jellyfin.JellyfinDesktop/mpv-hwdec-shim.so; touch $S/jellyfin-hwdec-shim
  echo '{"a":1}' > $S/ui-patches/frame-controls.json; echo '{' > $S/ui-patches/vr-cat.json.tmp
  echo mine > $S/ui-patches/notes.txt

  exec 9< $F/d.busy/.parentlock                     # Firefox "uses" d.busy
  before=$(snap)
  res=$(steam-frame-nix-cleanup --dry-run --all)
  [ "$(snap)" = "$before" ] || fail "--dry-run changed files"
  has "$res" "would remove $I/utilities-terminal.svg"
  has "$res" "would restore VRWebHelper.DebuggerEnabled"
  hasnt "$res" "removed "
  ! grep -q daemon-reload $STUB/log || fail "--dry-run reloaded systemd"

  res=$(steam-frame-nix-cleanup --all); echo "$res"
  # debugger: key gone (value before: absent), other keys kept, 3-space indent, mode kept
  [ "$(jq -c .VRWebHelper $V)" = '{"DebuggerPort":8087}' ] || fail "vrsettings: $(cat $V)"
  grep -q '^   "VRWebHelper"' $V || fail "indent"
  [ "$(stat -c %a $V)" = 600 ] || fail "mode"
  gone $S/steamvr-debugger $S/steamvr-debugger.armed $root/run/steam-frame-nix \
    $root/run/systemd/user/steamvr.service.d/50-steam-frame-nix-debugger.conf
  there $root/run/systemd/user/steamvr.service.d/other.conf
  grep -q daemon-reload $STUB/log || fail "no daemon-reload after removing the drop-in"
  # icons
  gone $I/utilities-terminal.svg $S/icon-fallbacks
  there $I/hm.svg $I/other.svg
  has "$res" "left alone: $F/c.mine/user.js"
  # firefox
  gone $F/desktop/user.js $F/a.default/user.js $F/b.old/user.js $F/e.fresh
  [ "$(cat $F/desktop/prefs.js)" = 'user_pref("other", 1);' ] || fail "desktop prefs.js: $(cat $F/desktop/prefs.js)"
  [ "$(cat $F/a.default/prefs.js)" = 'user_pref("c.d", 2);' ] || fail "a.default prefs.js"
  there $F/c.mine/user.js $F/d.busy/user.js
  grep -q a.b $F/d.busy/prefs.js || fail "busy profile changed"
  has "$res" "deferred: $F/d.busy/user.js: Firefox is using profile d.busy"
  # jellyfin
  [ "$(cat $O/org.jellyfin.JellyfinDesktop)" = "$(printf '[Context]\nfilesystems=xdg-music:ro;\n\n[Environment]\nFOO=bar')" ] \
    || fail "override: $(cat $O/org.jellyfin.JellyfinDesktop)"
  has "$res" "devices=all goes too"
  there $O/org.example.Other
  gone $HOME/.var/app/org.jellyfin.JellyfinDesktop/mpv-hwdec-shim.so $S/jellyfin-hwdec-shim
  # ui state: ours gone, foreign file kept (so the dirs stay)
  gone $S/ui-patches/frame-controls.json $S/ui-patches/vr-cat.json.tmp
  there $S/ui-patches/notes.txt
  noop --all
  exec 9<&-
  res=$(steam-frame-nix-cleanup --all)
  gone $F/d.busy/user.js
  [ ! -s $F/d.busy/prefs.js ] || [ -z "$(tr -d '[:space:]' < $F/d.busy/prefs.js)" ] || fail "busy prefs.js after close"
  rm $S/ui-patches/notes.txt
  res=$(steam-frame-nix-cleanup --all)
  gone $S
  there $HOME/.local/share/icons/hicolor/scalable/apps/hm.svg
  noop --all
  echo "A ok"

  # --- B: SteamVR running: deferred to the runtime drop-in ---
  fresh b
  printf '{\n   "VRWebHelper" : {\n      "DebuggerEnabled" : true\n   }\n}\n' > $V
  echo false > $S/steamvr-debugger.armed
  echo active > $STUB/state
  res=$(steam-frame-nix-cleanup --all); echo "$res"
  has "$res" "deferred: VRWebHelper.DebuggerEnabled"
  [ "$(jq .VRWebHelper.DebuggerEnabled $V)" = true ] || fail "changed while running"
  there $S/steamvr-debugger.armed $root/run/steam-frame-nix/steamvr-debugger-restore
  grep -qx 'ExecStopPost=-/usr/bin/bash %t/steam-frame-nix/steamvr-debugger-restore' \
    $root/run/systemd/user/steamvr.service.d/50-steam-frame-nix-debugger.conf || fail "drop-in"
  [ "$(grep -c daemon-reload $STUB/log)" = 1 ] || fail "daemon-reload count"
  noop --all
  [ "$(grep -c daemon-reload $STUB/log)" = 1 ] || fail "second run reloaded again"
  # SteamVR stops: ExecStopPost runs the script
  bash $root/run/steam-frame-nix/steamvr-debugger-restore
  [ "$(jq -c .VRWebHelper $V)" = '{"DebuggerEnabled":false}' ] || fail "restore: $(cat $V)"
  gone $S/steamvr-debugger.armed
  echo inactive > $STUB/state
  res=$(steam-frame-nix-cleanup --all)
  gone $root/run/steam-frame-nix $root/run/systemd $S
  noop --all
  echo "B ok"

  # --- C: --orphans with keeps ---
  fresh c
  printf '{"VRWebHelper":{"DebuggerEnabled":true}}\n' > $V
  echo absent > $S/steamvr-debugger.armed
  mkdir -p $F/desktop $F/x.default
  ln -s /app/etc/firefox/steam-frame-nix-desktop-user.js $F/desktop/user.js
  touch $F/desktop/.parentlock; exec 8< $F/desktop/.parentlock   # the wrapper's, Firefox running
  ln -s /app/etc/firefox/steam-frame-nix-desktop-user.js $F/x.default/user.js
  printf '[Context]\ndevices=all;\nfilesystems=/nix/store/00000000000000000000000000000000-mpv-hwdec-shim:ro;\n\n[Environment]\nLD_PRELOAD=/nix/store/00000000000000000000000000000000-mpv-hwdec-shim/lib/mpv-hwdec-shim.so\nSFN_MPV_HWDEC=x\n' > $O/org.jellyfin.JellyfinDesktop
  mkdir -p $HOME/.var/app/org.jellyfin.JellyfinDesktop
  echo so > $HOME/.var/app/org.jellyfin.JellyfinDesktop/mpv-hwdec-shim.so   # no marker: not ours
  echo '{"a":1}' > $S/ui-patches/frame-controls.json; echo '{}' > $S/ui-patches/vr-cat.json
  echo '{' > $S/ui-patches/x.json.tmp; touch -d '-1 hour' $S/ui-patches/x.json.tmp
  echo '{' > $S/ui-patches/y.json.tmp                # being written: kept
  echo active > $STUB/state
  res=$(steam-frame-nix-cleanup --orphans --keep debugger); echo "$res"
  hasnt "$res" "deferred"                             # kept: the next start re-arms it
  there $root/run/systemd/user/steamvr.service.d/50-steam-frame-nix-debugger.conf $S/steamvr-debugger.armed
  there $F/desktop/user.js $S/ui-patches/frame-controls.json $S/ui-patches/vr-cat.json $S/ui-patches/y.json.tmp
  gone $F/x.default/user.js $O/org.jellyfin.JellyfinDesktop $S/ui-patches/x.json.tmp
  there $HOME/.var/app/org.jellyfin.JellyfinDesktop/mpv-hwdec-shim.so
  has "$res" "left alone: $HOME/.var/app/org.jellyfin.JellyfinDesktop/mpv-hwdec-shim.so"
  noop --orphans --keep debugger
  # SteamVR stopped (e.g. after a power loss): the key is restored, hook kept
  echo inactive > $STUB/state
  res=$(steam-frame-nix-cleanup --orphans --keep debugger)
  [ "$(jq -c . $V)" = '{}' ] || fail "orphans restore: $(cat $V)"
  gone $S/steamvr-debugger.armed
  there $root/run/systemd/user/steamvr.service.d/50-steam-frame-nix-debugger.conf
  # debugger no longer kept: runtime pieces go
  res=$(steam-frame-nix-cleanup --orphans)
  gone $root/run/steam-frame-nix $root/run/systemd
  noop --orphans
  there $S/ui-patches/frame-controls.json $HOME/.local/share/icons/hicolor/scalable/apps  # not ours
  exec 8<&-                                            # Firefox closed
  res=$(steam-frame-nix-cleanup --orphans)
  gone $F/desktop/user.js
  ! steam-frame-nix-cleanup --all --keep debugger 2>/dev/null || fail "--all --keep accepted"
  ! steam-frame-nix-cleanup --orphans --keep bogus 2>/dev/null || fail "unknown --keep accepted"
  echo "C ok"

  # --- D: the user's own key is never touched ---
  fresh d
  printf '{"VRWebHelper":{"DebuggerEnabled":true}}\n' > $V
  res=$(steam-frame-nix-cleanup --all)
  has "$res" "left alone: VRWebHelper.DebuggerEnabled = true"
  [ "$(jq -c . $V)" = '{"VRWebHelper":{"DebuggerEnabled":true}}' ] || fail "user's key changed"
  echo "D ok"

  # --- E: steamvr-debugger-arm (before each SteamVR start) ---
  arm() { bash ${../../install.sh} steamvr-debugger-arm; }
  fresh e
  printf '{\n   "steamvr" : {}\n}\n' > $V
  echo activating > $STUB/state
  res=$(arm); echo "$res"
  [ "$(cat $S/steamvr-debugger.armed)" = absent ] || fail "armed"
  [ "$(jq -c .VRWebHelper $V)" = '{"DebuggerEnabled":true}' ] || fail "arm: $(cat $V)"
  there $root/run/steam-frame-nix/steamvr-debugger-restore
  [ "$(grep -c daemon-reload $STUB/log)" = 1 ] || fail "arm reload"
  before=$(snap); res=$(arm)
  [ "$(snap)" = "$before" ] || fail "second arm changed files"
  [ "$(grep -c daemon-reload $STUB/log)" = 1 ] || fail "second arm reloaded"
  bash $root/run/steam-frame-nix/steamvr-debugger-restore   # SteamVR stops
  [ "$(jq -c . $V)" = '{"steamvr":{}}' ] || fail "arm restore: $(cat $V)"
  gone $S/steamvr-debugger.armed
  res=$(arm)                                          # restart: armed again
  [ "$(cat $S/steamvr-debugger.armed)" = absent ] || fail "re-arm"
  bash $root/run/steam-frame-nix/steamvr-debugger-restore
  # the user's own true: never armed, never restored
  printf '{"VRWebHelper":{"DebuggerEnabled":true}}\n' > $V
  res=$(arm); has "$res" "not set by steam-frame-nix"
  gone $S/steamvr-debugger.armed
  # no file yet: created, and removed again if nothing else was added
  rm $V; res=$(arm)
  [ "$(cat $S/steamvr-debugger.armed)" = nofile ] || fail "nofile"
  bash $root/run/steam-frame-nix/steamvr-debugger-restore
  gone $V $S/steamvr-debugger.armed
  echo "E ok"
  touch $out
''
