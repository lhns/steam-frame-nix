# Checks of `install.sh cleanup` on fake home and runtime dirs: every
# artifact any version wrote (removed or restored) next to look-alikes that
# aren't ours (left alone), --dry-run changes nothing, a second run changes
# nothing, SteamVR running defers the debugger key to a runtime drop-in.
# Also `install.sh restart-check` (what waits for a session/SteamVR restart).
# Also `install.sh install --clone` (argument parsing and the clone step),
# against local bare repositories through a logging git, without network.
# Also `install.sh uninstall` removing Nix while programs from the Nix store
# run (a fake /proc, a logging nix-installer).
{ pkgs }:
let
  cleanup = pkgs.callPackage ./package.nix { };
in
pkgs.runCommand "cleanup-check" { nativeBuildInputs = [ cleanup pkgs.jq pkgs.git ]; } ''
  set -euo pipefail
  fail() { echo "FAIL: $*" >&2; exit 1; }
  export HOME XDG_RUNTIME_DIR STEAM_FRAME_NIX_RUNTIME_DIR STEAM_FRAME_NIX_SYSTEMCTL
  unset XDG_STATE_HOME XDG_DATA_HOME XDG_CONFIG_HOME

  # systemctl stub: SteamVR's state from $STUB/state, calls logged.
  STUB=$PWD/stub; mkdir -p $STUB
  cat > $STUB/systemctl <<'SH'
  #!/usr/bin/env bash
  echo "$*" >> "$STUB/log"
  case "$*" in
    *"show -p ActiveState --value steamvr.service"*) cat "$STUB/state" ;;
    *"show -p ActiveState --value gamescope-session.service"*) cat "$STUB/gs-state" ;;
    *"show -p ControlGroup --value gamescope-session.service"*) echo /gs.service ;;
  esac
  SH
  chmod +x $STUB/systemctl
  sed -i "1s|.*|#!${pkgs.bash}/bin/bash|" $STUB/systemctl
  export STUB
  STEAM_FRAME_NIX_SYSTEMCTL=$STUB/systemctl

  fresh() {
    root=$PWD/$1; rm -rf $root; mkdir -p $root/home $root/run
    HOME=$root/home XDG_RUNTIME_DIR=$root/run STEAM_FRAME_NIX_RUNTIME_DIR=$root/run
    : > $STUB/log; echo inactive > $STUB/state; echo inactive > $STUB/gs-state
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
  echo '[Desktop Entry]' > $root/run/steam-frame-nix/applications/org.example.App.desktop
  echo x > $root/run/steam-frame-nix/applications/.org.example.App.desktop.sum
  : > $root/run/steam-frame-nix/applications/.lock
  ln -s $HOME/.local/share/Steam/userdata/1/760/remote/250820/screenshots \
    $root/run/steam-frame-nix/screenshots               # steamFrame.screenshots
  mkdir -p $root/run/steam-frame-nix/vr-pet             # steamFrame.pet
  ln -s /nix/store/00000000000000000000000000000000-vr-pet-icons/ginger.png $root/run/steam-frame-nix/vr-pet/icon.png
  : > $root/run/steam-frame-nix/vr-pet/.lock
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
  echo '{"model":"shiba"}' > $S/ui-patches/vr-pet.json
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
  gone $S/ui-patches/frame-controls.json $S/ui-patches/vr-cat.json.tmp $S/ui-patches/vr-pet.json
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
  # screenshots link: kept while used, a foreign link left alone
  mkdir -p $root/run/steam-frame-nix
  ln -s /x/userdata/1/760/remote/250820/screenshots $root/run/steam-frame-nix/screenshots
  res=$(steam-frame-nix-cleanup --orphans --keep screenshots)
  there $root/run/steam-frame-nix/screenshots
  res=$(steam-frame-nix-cleanup --orphans)
  gone $root/run/steam-frame-nix/screenshots
  mkdir -p $root/run/steam-frame-nix; ln -s /elsewhere $root/run/steam-frame-nix/screenshots
  res=$(steam-frame-nix-cleanup --orphans)
  has "$res" "left alone: $root/run/steam-frame-nix/screenshots"
  rm -r $root/run/steam-frame-nix
  # VR pet icon link: kept while used, a foreign link and file left alone
  P=$root/run/steam-frame-nix/vr-pet; mkdir -p $P
  ln -s /nix/store/00000000000000000000000000000000-vr-pet-icons/fox.png $P/icon.png
  : > $P/.lock; ln -s /nix/store/00000000000000000000000000000000-vr-pet-icons/fox.png $P/.icon.tmp.123
  res=$(steam-frame-nix-cleanup --orphans --keep pet)
  there $P/icon.png $P/.lock $P/.icon.tmp.123
  res=$(steam-frame-nix-cleanup --orphans)
  gone $P
  noop --orphans
  mkdir -p $P; ln -s /elsewhere.png $P/icon.png; echo mine > $P/notes
  res=$(steam-frame-nix-cleanup --orphans)
  has "$res" "left alone: $P/icon.png"
  there $P/icon.png $P/notes
  rm -r $root/run/steam-frame-nix
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

  # --- F: restart-check (settings read only at a process start) ---
  export STEAM_FRAME_NIX_PROC STEAM_FRAME_NIX_CGROUP
  rc() { bash ${../../install.sh} restart-check 2>&1; }
  fresh f
  STEAM_FRAME_NIX_PROC=$root/proc STEAM_FRAME_NIX_CGROUP=$root/cg
  U=$HOME/.config/systemd/user
  mkdir -p $U/gamescope-session.service.d $U/steamvr.service.d $root/cg/gs.service $root/proc/net $root/proc/10 $root/proc/11
  printf '[Service]\nEnvironment=XKB_DEFAULT_LAYOUT=de\n' > $U/gamescope-session.service.d/keyboard.conf
  printf '[Unit]\nWants=steamvr-webhelper-debugger.service\n' > $U/steamvr.service.d/webhelper-debugger.conf
  printf '10\n11\n' > $root/cg/gs.service/cgroup.procs
  : > $root/proc/10/environ; chmod 000 $root/proc/10/environ   # gamescope: unreadable, skipped
  printf 'HOME=/h\0XKB_DEFAULT_LAYOUT=us\0' > $root/proc/11/environ
  tcp() { printf '  sl  local_address rem_address   st\n'; for l; do printf '   0: %s 00000000:0000 0A\n' "$l"; done; }
  tcp 0100007F:1F90 > $root/proc/net/tcp                # only Steam's 8080
  # nothing runs: nothing waits
  res=$(rc); [ -z "$res" ] || fail "restart-check while stopped: $res"
  # fresh install into a running session: both wait
  echo active > $STUB/gs-state; echo active > $STUB/state
  res=$(rc); echo "$res"
  has "$res" "keyboard layout de (the running Steam session has us): from the next start of the Steam session"
  has "$res" "SteamVR dashboard patches"
  # after the restarts: nothing waits
  printf 'XKB_DEFAULT_LAYOUT=de\0' > $root/proc/11/environ
  tcp 0100007F:1F90 0100007F:1F97 > $root/proc/net/tcp
  res=$(rc); [ -z "$res" ] || fail "restart-check after restart: $res"
  # a variant change waits; no layout configured: no check
  printf '[Service]\nEnvironment=XKB_DEFAULT_LAYOUT=de\nEnvironment=XKB_DEFAULT_VARIANT=nodeadkeys\n' > $U/gamescope-session.service.d/keyboard.conf
  res=$(rc); has "$res" "keyboard layout de (nodeadkeys) (the running Steam session has de)"
  rm -r $U/gamescope-session.service.d $U/steamvr.service.d; : > $root/proc/net/tcp
  res=$(rc); [ -z "$res" ] || fail "restart-check without the drop-ins: $res"
  echo "F ok"

  # --- G: install --clone ---
  INSTALL=${../../install.sh}
  export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
  fresh g
  R=$root/remotes; mkdir -p $R
  for repo in config other; do
    git init -q -b main $R/src-$repo
    echo "{ outputs = _: { }; }" > $R/src-$repo/flake.nix
    git -C $R/src-$repo add -A; git -C $R/src-$repo commit -qm init
    git -C $R/src-$repo branch dev
    git clone -q --bare $R/src-$repo $R/$repo.git
  done
  # The URL forms reach the bare repositories; a git that logs its arguments.
  export GIT_CONFIG_GLOBAL=$root/gitconfig GITLOG=$root/gitlog
  git config --global url."file://$R/config.git".insteadOf https://github.com/owner/config.git
  git config --global --add url."file://$R/config.git".insteadOf git@github.com:owner/config
  git config --global url."file://$R/other.git".insteadOf https://example.org/other.git
  mkdir -p $root/bin
  printf '#!%s\necho "$*" >> "$GITLOG"\nexec %s "$@"\n' ${pkgs.bash}/bin/bash ${pkgs.git}/bin/git > $root/bin/git
  chmod +x $root/bin/git
  PATH=$root/bin:$PATH
  # sourced: run one function with fresh state
  sfn() { (. $INSTALL; "$@"); }
  # install with Nix, curl and home-manager stubbed
  inst() {
    : > $GITLOG
    (. $INSTALL; ASSUME_YES=1; ensure_nix() { :; }; curl() { :; }; hm() { echo "hm $*"; }; cmd_install "$@")
  }

  # parsing
  res=$(bash $INSTALL install --clone github:owner/config --flake /x 2>&1) && fail "--clone --flake accepted"
  has "$res" "--clone and --flake exclude each other"
  res=$(bash $INSTALL install --dir /x 2>&1) && fail "--dir without --clone accepted"
  has "$res" "--dir and --ref need --clone"
  res=$(bash $INSTALL install --clone github:owner/config/dev 2>&1) && fail "github:o/r/x accepted"
  has "$res" "expected github:owner/repo"
  res=$(bash $INSTALL install --clone 2>&1) && fail "--clone without URL accepted"
  [ "$(sfn clone_url github:owner/config)" = https://github.com/owner/config.git ] || fail clone_url
  [ "$(sfn clone_url git@github.com:owner/config)" = git@github.com:owner/config ] || fail clone_url-ssh
  [ "$(sfn repo_id git@GitHub.com:owner/config.git)" = "$(sfn repo_id https://github.com/owner/config/)" ] || fail repo_id
  [ "$(sfn repo_id ssh://git@github.com/owner/config)" = github.com/owner/config ] || fail repo_id-ssh

  # each URL form: the git command, the flake dir, the link
  for url in github:owner/config https://github.com/owner/config.git git@github.com:owner/config; do
    rm -rf $HOME/nix-config $HOME/.config/home-manager
    res=$(inst --clone $url)
    want=$(sfn clone_url $url)
    grep -qxF -- "clone -- $want $HOME/nix-config" $GITLOG || fail "$url: git: $(cat $GITLOG)"
    has "$res" "hm switch --flake $HOME/nix-config -b"
    [ "$(readlink $HOME/.config/home-manager)" = $HOME/nix-config ] || fail "$url: link"
    [ "$(git -C $HOME/nix-config branch --show-current)" = main ] || fail "$url: branch"
  done

  # reuse: same repository in another URL form, pulled (--yes)
  res=$(inst --clone https://github.com/owner/config.git)
  has "$res" "Using the existing clone in $HOME/nix-config"
  grep -qxF -- "-C $HOME/nix-config pull --ff-only" $GITLOG || fail "no pull: $(cat $GITLOG)"
  ! grep -q "^clone" $GITLOG || fail "cloned again"
  has "$res" "hm switch --flake $HOME/nix-config -b"

  # --dir (relative) and --ref; the existing link stays
  res=$(cd $HOME && inst --clone github:owner/config --dir cfg --ref dev)
  grep -qxF -- "clone --branch dev -- https://github.com/owner/config.git $HOME/cfg" $GITLOG || fail "ref: $(cat $GITLOG)"
  [ "$(git -C $HOME/cfg branch --show-current)" = dev ] || fail "ref branch"
  has "$res" "hm switch --flake $HOME/cfg -b"
  [ "$(readlink $HOME/.config/home-manager)" = $HOME/nix-config ] || fail "link replaced"
  res=$(inst --clone github:owner/config --dir $HOME/cfg --ref main 2>&1) && fail "other branch reused"
  has "$res" "is on dev, not main"

  # refused: another repository, not a clone, a subdirectory of a clone
  res=$(inst --clone https://example.org/other.git 2>&1) && fail "other repo reused"
  has "$res" "is a clone of git@github.com:owner/config, not https://example.org/other.git"
  mkdir $HOME/plain; echo x > $HOME/plain/x
  res=$(inst --clone github:owner/config --dir $HOME/plain 2>&1) && fail "plain dir used"
  has "$res" "is not a git clone"
  mkdir $HOME/cfg/sub; echo x > $HOME/cfg/sub/x
  res=$(inst --clone github:owner/config --dir $HOME/cfg/sub 2>&1) && fail "subdir used"
  has "$res" "is not a git clone"
  # a failed clone: the hint
  res=$(inst --clone https://example.org/missing.git --dir $HOME/m 2>&1) && fail "missing repo"
  has "$res" "gh auth login"
  echo "G ok"

  # --- H: uninstall: Nix goes while programs from the store still run ---
  fresh h
  export -f fail has hasnt gone
  export root INSTALL
  # In a process of its own: in the sandbox $$ is PID 1.
  bash <<'SH'
  set -euo pipefail
  P=$root/proc
  # pid name ppid pgid exe: a fake /proc entry
  fake() {
    mkdir -p $P/$1/fd; echo $2 > $P/$1/comm; printf '%s\0-x\0' $5 > $P/$1/cmdline
    ln -sfn $5 $P/$1/exe; ln -sfn /home $P/$1/cwd
    printf 'Name:\t%s\nPPid:\t%s\n' $2 $3 > $P/$1/status
    echo "$1 ($2 x) S $3 $4 0" > $P/$1/stat
    echo "00400000-00401000 r-xp 00000000 00:01 1 $5" > $P/$1/maps
  }
  fake $$ bash 30 $$ /usr/bin/bash                          # this uninstall
  fake 30 zsh 1 30 /nix/store/a-zsh/bin/zsh                 # its terminal's shell
  fake 31 curl 30 $$ /nix/store/b-curl/bin/curl             # its pipeline: skipped
  fake 32 sort $$ 32 /nix/store/c-coreutils/bin/sort        # its subshell: skipped
  fake 40 app 1 40 /usr/bin/app                             # a library from /nix
  echo "7f00-7f01 r-xp 0 00:01 2 /nix/store/d-lib/lib/libx.so" >> $P/40/maps
  fake 41 cwd 1 41 /usr/bin/cwd; ln -sfn /nix/store/e $P/41/cwd
  fake 42 fd 1 42 /usr/bin/fd; ln -s /nix/store/f/file $P/42/fd/3
  fake 43 clean 1 43 /usr/bin/clean
  # nix-installer: logs its arguments and the lazy-unmount drop-in it sees
  D=$root/run-system/nix.mount.d/50-steam-frame-nix-lazy-unmount.conf
  export D LOG=$root/log RC=0
  printf '#!%s\n[ "$1" = --version ] && exit 0\necho "nix-installer $*" >> $LOG\ncat $D >> $LOG 2>/dev/null || echo "no drop-in" >> $LOG\nexit $RC\n' \
    "$(command -v bash)" > $root/nix-installer
  chmod +x $root/nix-installer
  uninst() { # mounted: 1|0
    local m=$1
    : > $LOG; rm -rf $HOME/.config; mkdir -p $HOME/.config; ln -s $HOME/cfg $HOME/.config/home-manager
    (STEAM_FRAME_NIX_PROC=$P STEAM_FRAME_NIX_SYSTEM_RUNTIME=$root/run-system; . $INSTALL
     ASSUME_YES=1 NIX_INSTALLER_BIN=$root/nix-installer
     # sudo without root: systemctl only logged
     sudo() {
       case $1 in -v) return 0 ;; -n) shift ;; esac
       echo "sudo $*" >> $LOG
       [ "$1" = systemctl ] || "$@"
     }
     nix_mounted() { [ "$m" = 1 ]; }
     cmd_uninstall </dev/null) 2>&1
  }
  res=$(uninst 1) || fail "uninstall failed: $res"
  echo "$res"
  for p in "zsh (PID 30)" "app (PID 40)" "cwd (PID 41)" "fd (PID 42)" "keep running until you log out or reboot"; do has "$res" "$p"; done
  for p in "PID 31" "PID 32" "PID 43" "PID $$" "Not done yet"; do hasnt "$res" "$p"; done
  log=$(cat $LOG)
  has "$log" "nix-installer uninstall --no-confirm"
  has "$log" "LazyUnmount=yes"     # the drop-in was there while it ran
  [ "$(grep -c '^sudo systemctl daemon-reload$' $LOG)" = 2 ] || fail "daemon-reloads: $log"
  gone $D ''${D%/*} $HOME/.config/home-manager
  # /nix not a mount point: no drop-in
  res=$(uninst 0) || fail "uninstall failed: $res"
  has "$(cat $LOG)" "no drop-in"
  # the uninstaller fails: Nix stays, the drop-in goes
  res=$(RC=1 uninst 1) && fail "uninstall succeeded: $res"
  has "$res" "its uninstaller failed. Reboot, then run uninstall again"
  gone $D $HOME/.config/home-manager
  SH
  echo "H ok"
  touch $out
''
