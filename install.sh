#!/usr/bin/env bash
# Install or uninstall Nix + Home Manager on SteamOS (Steam Frame, Steam Deck),
# and clean up what steam-frame-nix wrote outside the Nix store.
#
#   curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- install
#   curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- uninstall
#   curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- cleanup --all
#
# Run `install.sh --help` for details. Works from a file or piped into bash
# (prompts read from /dev/tty).
set -euo pipefail

TEMPLATE="${STEAM_FRAME_NIX_TEMPLATE:-github:lhns/steam-frame-nix}"
NIX_INSTALLER_URL="${NIX_INSTALLER_URL:-https://artifacts.nixos.org/nix-installer}"
HM_FLAKE="${HM_FLAKE:-home-manager/master}"
NIX_PROFILE_SCRIPT=/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
NIX_RECEIPT=/nix/receipt.json
NIX_INSTALLER_BIN=/nix/nix-installer
FLAKES_LINE="experimental-features = nix-command flakes"

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
HM_CONFIG_LINK="$CONFIG_HOME/home-manager"
DEFAULT_CONFIG_DIR="$HOME/nix-config"
USER_NIX_CONF="$CONFIG_HOME/nix/nix.conf"
USER_UNIT_DIR="$CONFIG_HOME/systemd/user"

USER_NAME="$(id -un)"
USER_ID="$(id -u)"
OUTER_RUNTIME_DIR="${STEAM_FRAME_NIX_RUNTIME_DIR:-/run/user/$USER_ID}"

ASSUME_YES=0
RO_RELOCK=0

# --- output -----------------------------------------------------------------

if [[ -t 1 ]]; then B=$'\e[1m' G=$'\e[1;32m' Y=$'\e[1;33m' R=$'\e[1;31m' N=$'\e[0m'
else B='' G='' Y='' R='' N=''; fi

step() { printf '%s==>%s %s%s%s\n' "$G" "$N" "$B" "$*" "$N"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%swarning:%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Nix + Home Manager for SteamOS (Steam Frame, Steam Deck).

Usage: install.sh <command> [options]

Commands:
  install [--flake <dir-or-flakeref>] [--yes]
      Install Nix (NixOS nix-installer, steam-deck planner, flakes enabled) if
      it is missing, then activate a Home Manager configuration:
        --flake given        that flake (a directory or a flake reference)
        otherwise            ~/.config/home-manager
        neither exists       a new config in ~/nix-config from the
                             steam-frame-nix template, linked to
                             ~/.config/home-manager
      Existing dotfiles that conflict are renamed to *.hm-backup-<time>.
      Re-running just switches again.

  uninstall [--yes] [--keep-nix]
      Stop Home Manager's user services, run 'cleanup --all', uninstall Home
      Manager, uninstall Nix (unless --keep-nix) and remove per-user Nix
      leftovers. Your configuration directory is never deleted.

  cleanup [--dry-run] (--all | --orphans [--keep <artifact>]...)
      Remove what steam-frame-nix (any version) wrote outside the Nix store,
      only where it is provably its own; everything else is reported as
      "left alone". Safe to re-run. Needs bash, coreutils, findutils, jq.
        --all        everything, incl. the dashboard patches' saved choices
                     (~/.local/state/steam-frame-nix/ui-patches). Use after
                     rolling back to a generation without steam-frame-nix,
                     or before removing it.
        --orphans    what the configuration no longer uses (run by the Home
                     Manager module on every switch); keeps saved choices.
        --keep       still in use (with --orphans): debugger,
                     firefox-desktop-userjs=<profile>
        --dry-run    only print what would be done
        --quiet      print only actions, deferrals and warnings
      SteamVR's VRWebHelper.DebuggerEnabled can't be changed while SteamVR
      runs; it is then restored when SteamVR stops (a drop-in in
      /run/user/<uid>, gone at reboot).

  status
      Show Nix, Home Manager and user service state, and what
      'cleanup --all' would remove.

Options:
  --yes, -y      Don't ask; answer yes to every question.
  --help, -h     Show this help.

Piped:
  curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- install
EOF
}

# --- helpers ----------------------------------------------------------------

have_tty() { { : </dev/tty; } 2>/dev/null; }

confirm() {
  (( ASSUME_YES )) && return 0
  have_tty || die "no terminal to ask \"$1\"; re-run with --yes"
  local reply=''
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r reply </dev/tty || true
  [[ $reply == [yY]* ]]
}

need_not_root() {
  [[ $USER_ID -ne 0 ]] || die "run this as your normal user (e.g. steamos), not as root; it uses sudo where needed"
}

check_os() {
  local id=''
  # shellcheck disable=SC1091
  [[ -r /etc/os-release ]] && id="$(. /etc/os-release && printf '%s' "${ID:-}")"
  [[ $id == steamos ]] || warn "this does not look like SteamOS (ID=${id:-unknown}); continuing anyway"
}

need_sudo() {
  sudo -n true 2>/dev/null && return 0
  info "sudo needs your password. On SteamOS no password is set by default:"
  info "if you never set one, press Ctrl+C and run 'passwd' first."
  sudo -v || die "sudo failed. Set a password with 'passwd' (in a terminal), then re-run."
}

# Unlock SteamOS' read-only root for the (un)installer; relocked on exit.
ro_unlock() {
  command -v steamos-readonly >/dev/null 2>&1 || return 0
  (( RO_RELOCK )) && return 0
  if sudo steamos-readonly status >/dev/null 2>&1; then
    step "Temporarily disabling the read-only root filesystem"
    sudo steamos-readonly disable
    RO_RELOCK=1
  fi
}

ro_relock() {
  (( RO_RELOCK )) || return 0
  RO_RELOCK=0
  step "Re-enabling the read-only root filesystem"
  sudo steamos-readonly enable || warn "could not re-enable it; run: sudo steamos-readonly enable"
}

trap ro_relock EXIT
trap 'exit 130' INT TERM

# Make nix available in this shell, with flakes enabled for our own calls.
load_nix() {
  if ! command -v nix >/dev/null 2>&1 && [[ -r $NIX_PROFILE_SCRIPT ]]; then
    unset __ETC_PROFILE_NIX_SOURCED
    set +u
    # shellcheck disable=SC1090
    . "$NIX_PROFILE_SCRIPT"
    set -u
  fi
  if [[ ${NIX_CONFIG:-} != *"nix-command flakes"* ]]; then
    NIX_CONFIG="${NIX_CONFIG:+$NIX_CONFIG$'\n'}extra-experimental-features = nix-command flakes"
    export NIX_CONFIG
  fi
}

nix_works() {
  command -v nix >/dev/null 2>&1 && nix --version >/dev/null 2>&1 || return 1
  nix store info >/dev/null 2>&1
}

# experimental-features as configured (without our NIX_CONFIG)
nix_features() {
  env -u NIX_CONFIG nix config show experimental-features 2>/dev/null
}

receipt_planner() { jq -r '.planner.planner // empty' "$NIX_RECEIPT" 2>/dev/null; }

# systemctl --user of the outer (Steam/VR) session; the nested desktop
# can't reach the user manager with its own environment.
outer_systemctl() {
  XDG_RUNTIME_DIR="$OUTER_RUNTIME_DIR" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$OUTER_RUNTIME_DIR/bus" \
    /usr/bin/systemctl --user "$@"
}

outer_bus_ok() { [[ -S $OUTER_RUNTIME_DIR/bus && -x /usr/bin/systemctl ]]; }

HM_PROFILE="${XDG_STATE_HOME:-$HOME/.local/state}/nix/profiles/home-manager"
hm_installed() { [[ -e $HM_PROFILE || -L $HM_PROFILE ]]; }

# The home-manager command: the installed one (matches the config), else master.
hm() {
  if command -v home-manager >/dev/null 2>&1; then
    home-manager "$@"
  else
    nix run "$HM_FLAKE" -- "$@"
  fi
}

# --- install ----------------------------------------------------------------

install_nix() {
  need_sudo
  ro_unlock
  step "Installing Nix (planner steam-deck, flakes enabled)"
  local tmp
  tmp="$(mktemp)"
  curl -fsSL -o "$tmp" "$NIX_INSTALLER_URL" || { rm -f "$tmp"; die "could not download $NIX_INSTALLER_URL"; }
  if ! sh "$tmp" install steam-deck --no-confirm --enable-flakes; then
    rm -f "$tmp"
    die "the Nix installer failed. Remove a half-finished install with: sudo $NIX_INSTALLER_BIN uninstall --no-confirm"
  fi
  rm -f "$tmp"
  ro_relock
}

uninstall_nix() {
  need_sudo
  ro_unlock
  step "Uninstalling Nix"
  sudo "$NIX_INSTALLER_BIN" uninstall --no-confirm
  ro_relock
}

ensure_nix() {
  step "Checking Nix"
  load_nix
  if nix_works; then
    info "$(nix --version)"
  else
    if [[ -e $NIX_RECEIPT ]]; then
      warn "Nix is installed ($NIX_RECEIPT) but not working"
      confirm "Uninstall and reinstall Nix?" || die "aborted"
      [[ -x $NIX_INSTALLER_BIN ]] || die "$NIX_INSTALLER_BIN is missing; can't uninstall the broken Nix"
      uninstall_nix
    elif [[ -d /nix ]] && [[ -n $(ls -A /nix 2>/dev/null) ]]; then
      die "/nix exists but was not installed by nix-installer (no $NIX_RECEIPT); remove it or fix that Nix first"
    fi
    install_nix
    load_nix
    nix_works || die "Nix was installed but doesn't work in this shell; open a new terminal and re-run"
    info "$(nix --version)"
  fi

  # Nix installed some other way may lack flakes; enable them for this user.
  local features
  features="$(nix_features || true)"
  if [[ " $features " != *" flakes "* || " $features " != *" nix-command "* ]]; then
    step "Enabling flakes in $USER_NIX_CONF"
    mkdir -p "${USER_NIX_CONF%/*}"
    printf '%s\n' "$FLAKES_LINE" >>"$USER_NIX_CONF"
  fi
}

# Replace `name = "...";` in the template's let block.
set_let() { # file name value
  local file=$1 name=$2 value=$3
  grep -q "^ *$name = \"[^\"]*\";" "$file" || die "template: '$name' not found in $file"
  sed -i "s|^\( *$name = \)\"[^\"]*\";|\1\"$value\";|" "$file"
}

create_config() {
  local dir=$1 system
  if [[ -e $dir ]] && [[ -n $(ls -A "$dir" 2>/dev/null) ]]; then
    if [[ -e $dir/flake.nix ]]; then
      die "$dir already contains a flake. Use it with: install.sh install --flake $dir"
    fi
    die "$dir exists and is not empty; move it away or pass --flake <your config>"
  fi
  [[ $USER_NAME =~ ^[a-z_][a-z0-9_-]*$ ]] || die "unsupported user name '$USER_NAME' for the template"
  [[ $HOME =~ ^/[A-Za-z0-9._/-]+$ ]] || die "unsupported home directory '$HOME' for the template"

  confirm "No Home Manager configuration found. Create one in $dir from the steam-frame-nix template?" \
    || die "aborted; pass --flake <your config> to use an existing one"

  step "Creating a Home Manager configuration in $dir"
  mkdir -p "$dir"
  (cd "$dir" && nix flake init -t "$TEMPLATE")
  system="$(nix eval --impure --raw --expr builtins.currentSystem)"
  set_let "$dir/flake.nix" username "$USER_NAME"
  set_let "$dir/flake.nix" homeDirectory "$HOME"
  set_let "$dir/flake.nix" system "$system"
  info "user $USER_NAME, home $HOME, system $system"

  # Flakes in a git repository only see tracked files.
  if command -v git >/dev/null 2>&1; then
    git -C "$dir" init -q
    git -C "$dir" add -A
    nix flake lock "$dir"
    git -C "$dir" add flake.lock
  else
    warn "git not found; $dir is used as a plain directory"
    nix flake lock "$dir"
  fi

  mkdir -p "${HM_CONFIG_LINK%/*}"
  ln -s "$dir" "$HM_CONFIG_LINK"
  info "linked $HM_CONFIG_LINK -> $dir"
}

cmd_install() {
  local flake='' ref dir=''
  while (( $# )); do
    case $1 in
      --flake) [[ $# -ge 2 ]] || die "--flake needs an argument"; flake=$2; shift 2 ;;
      -y|--yes) ASSUME_YES=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "install: unknown option '$1' (see --help)" ;;
    esac
  done

  need_not_root
  check_os
  command -v curl >/dev/null 2>&1 || die "curl not found"

  ensure_nix

  step "Finding the Home Manager configuration"
  if [[ -n $flake ]]; then
    if [[ -d ${flake%%#*} ]]; then
      dir="$(cd "${flake%%#*}" && pwd -P)"
      [[ -e $dir/flake.nix ]] || die "$dir has no flake.nix"
      ref="$dir${flake#"${flake%%#*}"}"
      if [[ ! -e $HM_CONFIG_LINK && ! -L $HM_CONFIG_LINK ]]; then
        mkdir -p "${HM_CONFIG_LINK%/*}"
        ln -s "$dir" "$HM_CONFIG_LINK"
        info "linked $HM_CONFIG_LINK -> $dir"
      fi
    else
      ref=$flake
    fi
  elif [[ -e $HM_CONFIG_LINK/flake.nix ]]; then
    dir="$(readlink -f "$HM_CONFIG_LINK")"
    ref=$dir
  elif [[ -e $HM_CONFIG_LINK || -L $HM_CONFIG_LINK ]]; then
    die "$HM_CONFIG_LINK exists but has no flake.nix; pass --flake <your config>"
  else
    dir=$DEFAULT_CONFIG_DIR
    create_config "$dir"
    ref="$dir#$USER_NAME"
  fi
  info "using $ref"

  if [[ -n $dir ]] && git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local untracked
    untracked="$(git -C "$dir" ls-files --others --exclude-standard -- '*.nix' | head -n5)"
    [[ -z $untracked ]] || warn "untracked files are invisible to the flake (git add them): $(echo "$untracked" | tr '\n' ' ')"
  fi

  # Unique per run: Home Manager aborts if a backup from an earlier run exists.
  local backup
  backup="hm-backup-$(date +%Y%m%d-%H%M%S)"
  step "Activating Home Manager (conflicting files are renamed to *.$backup)"
  hm switch --flake "$ref" -b "$backup"

  local switch_cmd="home-manager switch --flake $ref" edit="your configuration"
  if [[ -n $dir ]]; then
    edit="$dir/home.nix"
    if [[ $(readlink -f "$HM_CONFIG_LINK" 2>/dev/null) == "$dir" ]] \
       && [[ $ref == "$dir" || $ref == "$dir#$USER_NAME" ]]; then
      switch_cmd="home-manager switch"
    fi
  fi

  step "Done"
  cat <<EOF

Next steps:
  - Open a new terminal so that nix and home-manager are on your PATH.
  - Edit $edit (e.g. uncomment the steamFrame block),
    then apply it with:
      $switch_cmd
    Run it from a terminal in the nested desktop. Flakes only see files
    tracked by git: 'git add' new files first.
  - Konsole in the Steam session's "+" menu needs Steam Developer Mode
    (Steam Settings > System > Enable Developer Mode) or
    steamFrame.launcherMenu.showAllApps = true.
  - Status: install.sh status. Remove everything: install.sh uninstall
EOF
}

# --- cleanup ----------------------------------------------------------------
#
# Everything steam-frame-nix (any version) ever wrote outside the Nix store
# and Home Manager's own links, and how it is proven to be ours:
#
#   debugger   VRWebHelper.DebuggerEnabled in steamvr.vrsettings. Proof:
#              $SFN_STATE/steamvr-debugger.armed (holds the value before;
#              older versions: the empty marker steamvr-debugger, value
#              before = absent). Restored once SteamVR is stopped; while it
#              runs a runtime drop-in restores it when SteamVR stops.
#              Also the runtime drop-in and restore script themselves.
#   icons      links hicolor/scalable/apps/<name>.svg -> Breeze in the store
#              (the icon-fallbacks script of 2026-09; manifest
#              $SFN_STATE/icon-fallbacks).
#   firefox    user.js in Firefox profiles: links to the desktop profile's
#              /app/etc/firefox/steam-frame-nix-desktop-user.js, older links
#              to *-firefox-*user.js and copies starting with FF_MARKER, and
#              the values they left in prefs.js (only with Firefox closed).
#   jellyfin   the hwdec shim entries in the Jellyfin Flatpak's user override
#              (nix-flatpak), an empty override file, and the shim copy of
#              earlier versions (marker $SFN_STATE/jellyfin-hwdec-shim).
#   ui-state   the dashboard patches' saved choices
#              ($SFN_STATE/ui-patches/<name>.json; --all only, never
#              --orphans) and stray *.json.tmp files.
#   dirs       $SFN_STATE and $OUTER_RUNTIME_DIR/steam-frame-nix when empty.
#
# --orphans keeps what the current configuration still uses (--keep ...);
# the Home Manager module runs it on every switch. Anything not proven ours
# is reported as "left alone" and never touched.

SFN_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/steam-frame-nix"
SFN_DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
SFN_RUNTIME="$OUTER_RUNTIME_DIR/steam-frame-nix"
VRSETTINGS="$HOME/.config/openvr/config/steamvr.vrsettings"
DEBUGGER_ARMED="$SFN_STATE/steamvr-debugger.armed"
DEBUGGER_MARKER_V1="$SFN_STATE/steamvr-debugger"
DEBUGGER_RESTORE="$SFN_RUNTIME/steamvr-debugger-restore"
DEBUGGER_DROPIN="$OUTER_RUNTIME_DIR/systemd/user/steamvr.service.d/50-steam-frame-nix-debugger.conf"
ICON_DIR="$SFN_DATA/icons/hicolor/scalable/apps"
ICON_MANIFEST="$SFN_STATE/icon-fallbacks"
FF_DIR="$HOME/.var/app/org.mozilla.firefox/config/mozilla/firefox"
FF_DESKTOP_JS=/app/etc/firefox/steam-frame-nix-desktop-user.js
FF_MARKER="// Managed by steam-frame-nix (steamFrame.firefox); rewritten on switch."
JF_APP=org.jellyfin.JellyfinDesktop
JF_OVERRIDE="$SFN_DATA/flatpak/overrides/$JF_APP"
JF_SHIM_COPY="$HOME/.var/app/$JF_APP/mpv-hwdec-shim.so"
JF_SHIM_MARKER="$SFN_STATE/jellyfin-hwdec-shim"
UI_STATE="$SFN_STATE/ui-patches"

CLEAN_DRY=0
CLEAN_QUIET=0
CLEAN_HEADER=''
CLEAN_ACTIONS=0
CLEAN_DEFERRED=()
declare -A CLEAN_GONE=()

# Output; the header only before the first line (--quiet).
c_line()  { if [[ -n $CLEAN_HEADER ]]; then step "$CLEAN_HEADER"; CLEAN_HEADER=''; fi; info "$1"; }
c_do()    { CLEAN_ACTIONS=$((CLEAN_ACTIONS + 1)); if (( CLEAN_DRY )); then c_line "would $1"; return 1; fi; }
c_done()  { c_line "$1"; }
c_left()  { (( CLEAN_QUIET )) || c_line "left alone: $1"; }
c_defer() { CLEAN_DEFERRED+=("$1"); c_line "deferred: $1"; }

c_rm() { # path why
  c_do "remove $1 ($2)" || { CLEAN_GONE[$1]=1; return 0; }
  rm -f -- "$1" && CLEAN_GONE[$1]=1 && c_done "removed $1 ($2)"
}

# Empty, or will be once the planned removals are done (dry run).
c_empty_after() {
  local e
  while IFS= read -r -d '' e; do
    [[ -n ${CLEAN_GONE[$e]:-} ]] || return 1
  done < <(find "$1" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
}

c_rmdir() { # dir: removed if empty (after the planned removals)
  [[ -d $1 && ! -L $1 ]] && c_empty_after "$1" || return 0
  c_do "remove empty directory $1" || { CLEAN_GONE[$1]=1; return 0; }
  rmdir -- "$1" && CLEAN_GONE[$1]=1 && c_done "removed empty directory $1"
}

c_write() { # path why: replace the contents with stdin (same inode and mode)
  local tmp
  if (( CLEAN_DRY )); then cat >/dev/null; c_do "rewrite $1 ($2)" || true; return 0; fi
  c_do "rewrite $1 ($2)"
  tmp="$(mktemp "$1.sfn-XXXXXX")"
  cat >"$tmp" && cat "$tmp" >"$1"
  rm -f -- "$tmp"
  c_done "rewrote $1 ($2)"
}

# systemctl --user of the outer session (overridable for tests).
c_systemctl() {
  if [[ -n ${STEAM_FRAME_NIX_SYSTEMCTL:-} ]]; then "$STEAM_FRAME_NIX_SYSTEMCTL" --user "$@"
  elif outer_bus_ok; then outer_systemctl "$@"
  else return 1; fi
}

# running | stopped | unknown
steamvr_state() {
  local s
  if s="$(c_systemctl show -p ActiveState --value steamvr.service 2>/dev/null)" && [[ -n $s ]]; then
    case $s in inactive|failed) echo stopped ;; *) echo running ;; esac
  elif pgrep -u "$USER_ID" -x vrserver >/dev/null 2>&1; then echo running
  else echo unknown; fi
}

# --- the SteamVR debugger key ---

# Puts VRWebHelper.DebuggerEnabled back to the value in <armed> ("absent",
# "false"; "nofile": the file didn't exist) if it is still true, then removes
# <armed>. Standalone (also written into the runtime restore script): bash,
# coreutils and jq only.
debugger_restore() { # vrsettings armed
  local f=$1 armed=$2 prior cur tmp filter
  [[ -f $armed ]] || return 0
  prior="$(tr -d '[:space:]' <"$armed")"
  case $prior in
    false) filter='.VRWebHelper.DebuggerEnabled = false' ;;
    absent|nofile|'') filter='.VRWebHelper |= del(.DebuggerEnabled) | if .VRWebHelper == {} then del(.VRWebHelper) else . end' ;;
    *) echo "steam-frame-nix: $armed holds '$prior', not a value it writes; left as is" >&2; return 1 ;;
  esac
  if [[ -f $f ]]; then
    cur="$(jq -r '.VRWebHelper.DebuggerEnabled // "absent"' "$f")" || { echo "steam-frame-nix: can't read $f" >&2; return 1; }
    if [[ $cur == true ]]; then
      tmp="$(mktemp "$f.XXXXXX")" || return 1
      if ! jq --indent 3 "$filter" "$f" >"$tmp"; then rm -f "$tmp"; return 1; fi
      chmod --reference="$f" "$tmp"
      mv -f "$tmp" "$f"
      if [[ $prior == nofile && $(jq -c . "$f") == '{}' ]]; then
        rm -f "$f"
        echo "steam-frame-nix: removed $f (created only for VRWebHelper.DebuggerEnabled)"
      else
        echo "steam-frame-nix: VRWebHelper.DebuggerEnabled in $f restored (${prior/nofile/absent})"
      fi
    else
      echo "steam-frame-nix: VRWebHelper.DebuggerEnabled in $f is $cur (changed since); left as is"
    fi
  fi
  rm -f "$armed"
}

debugger_restore_script() {
  # shellcheck disable=SC2016  # literal lines of the script
  printf '%s\n' '#!/usr/bin/bash' \
    '# steam-frame-nix: puts SteamVR'"'"'s VRWebHelper.DebuggerEnabled back to its' \
    '# value from before steam-frame-nix set it. Run by the runtime drop-in' \
    '# steamvr.service.d/50-steam-frame-nix-debugger.conf when SteamVR stops;' \
    '# both live in $XDG_RUNTIME_DIR until reboot. /usr/bin tools only.' \
    'PATH=/usr/bin:/bin${PATH:+:$PATH}'
  declare -f debugger_restore
  printf 'debugger_restore %q %q\n' "$VRSETTINGS" "$DEBUGGER_ARMED"
}

debugger_dropin() {
  printf '%s\n' '# steam-frame-nix: restores VRWebHelper.DebuggerEnabled when SteamVR stops.' \
    '# Runtime only (gone at reboot).' \
    '[Service]' \
    'ExecStopPost=-/usr/bin/bash %t/steam-frame-nix/steamvr-debugger-restore'
}

# Runtime drop-in + script so that stopping SteamVR restores the key, even
# after Nix and Home Manager are gone. Returns 0 if it (would have) changed.
debugger_ensure_hook() {
  local changed=1
  if [[ $(cat "$DEBUGGER_RESTORE" 2>/dev/null) != "$(debugger_restore_script)" ]]; then
    changed=0
    if c_do "write the restore script $DEBUGGER_RESTORE"; then
      mkdir -p "$SFN_RUNTIME"
      debugger_restore_script >"$DEBUGGER_RESTORE"
      c_done "wrote the restore script $DEBUGGER_RESTORE"
    fi
  fi
  if [[ $(cat "$DEBUGGER_DROPIN" 2>/dev/null) != "$(debugger_dropin)" ]]; then
    changed=0
    if c_do "write the runtime drop-in $DEBUGGER_DROPIN"; then
      mkdir -p "${DEBUGGER_DROPIN%/*}"
      debugger_dropin >"$DEBUGGER_DROPIN"
      c_done "wrote the runtime drop-in $DEBUGGER_DROPIN"
      c_systemctl daemon-reload || warn "could not reload the user manager; the restore on SteamVR stop needs: systemctl --user daemon-reload"
    fi
  fi
  return $changed
}

debugger_remove_hook() {
  [[ -f $DEBUGGER_RESTORE ]] && c_rm "$DEBUGGER_RESTORE" "debugger restore script"
  c_rmdir "$SFN_RUNTIME"
  [[ -f $DEBUGGER_DROPIN ]] || return 0
  c_rm "$DEBUGGER_DROPIN" "runtime drop-in of the debugger restore"
  # The directories only if they held nothing but the drop-in.
  c_rmdir "${DEBUGGER_DROPIN%/*}"
  c_rmdir "$OUTER_RUNTIME_DIR/systemd/user"
  c_rmdir "$OUTER_RUNTIME_DIR/systemd"
  (( CLEAN_DRY )) || c_systemctl daemon-reload || true
  return 0
}

clean_debugger() { # keep
  local keep=$1 prior='' state cur out
  if [[ -f $DEBUGGER_ARMED ]]; then
    prior="$(tr -d '[:space:]' <"$DEBUGGER_ARMED")"
    [[ -e $DEBUGGER_MARKER_V1 ]] && c_rm "$DEBUGGER_MARKER_V1" "old debugger marker, superseded by ${DEBUGGER_ARMED##*/}"
  elif [[ -f $DEBUGGER_MARKER_V1 ]]; then
    prior=absent
    if c_do "migrate $DEBUGGER_MARKER_V1 to $DEBUGGER_ARMED (value before: absent)"; then
      printf 'absent\n' >"$DEBUGGER_ARMED"
      rm -f -- "$DEBUGGER_MARKER_V1"
      c_done "migrated $DEBUGGER_MARKER_V1 to $DEBUGGER_ARMED (value before: absent)"
    else
      CLEAN_GONE[$DEBUGGER_MARKER_V1]=1
    fi
  fi

  if [[ -z $prior ]]; then
    if [[ -f $VRSETTINGS ]] && command -v jq >/dev/null 2>&1 \
       && [[ $(jq -r '.VRWebHelper.DebuggerEnabled // empty' "$VRSETTINGS" 2>/dev/null) == true ]] \
       && (( ! keep )); then
      c_left "VRWebHelper.DebuggerEnabled = true in $VRSETTINGS (not set by steam-frame-nix)"
    fi
    (( keep )) || debugger_remove_hook
    return 0
  fi

  command -v jq >/dev/null 2>&1 || { warn "jq not found; VRWebHelper.DebuggerEnabled left as is"; return 0; }
  state="$(steamvr_state)"
  if [[ $state == stopped ]]; then
    cur="$(jq -r '.VRWebHelper.DebuggerEnabled // "absent"' "$VRSETTINGS" 2>/dev/null || echo '?')"
    if [[ $cur == true ]]; then
      if c_do "restore VRWebHelper.DebuggerEnabled in $VRSETTINGS (${prior/nofile/absent})"; then
        out="$(debugger_restore "$VRSETTINGS" "$DEBUGGER_ARMED" 2>&1)" \
          || warn "restoring VRWebHelper.DebuggerEnabled failed; $DEBUGGER_ARMED kept"
        [[ -z $out ]] || c_line "${out//steam-frame-nix: /}"
      fi
    fi
    if [[ -f $DEBUGGER_ARMED && ( $cur != true || CLEAN_DRY -eq 1 ) ]]; then
      c_rm "$DEBUGGER_ARMED" "proof of the debugger key, no longer needed"
    fi
    (( keep )) || debugger_remove_hook
  else
    # Running (or unknown): SteamVR rewrites the file from memory; restore
    # when it stops.
    if [[ $state == unknown ]] && ! c_systemctl --version >/dev/null 2>&1; then
      c_defer "VRWebHelper.DebuggerEnabled ($VRSETTINGS): user manager not reachable; run this again from the Steam session or with SteamVR stopped"
      return 0
    fi
    debugger_ensure_hook || true
    (( keep )) || c_defer "VRWebHelper.DebuggerEnabled ($VRSETTINGS) is restored to ${prior/nofile/absent} when SteamVR stops"
  fi
  return 0
}

# --- icon fallback links ---

clean_icons() {
  local l t removed=0
  for l in "$ICON_DIR"/*.svg; do
    [[ -L $l ]] || continue
    t="$(readlink "$l")"
    case $t in
      /nix/store/*-breeze-icons-*/share/icons/breeze/apps/*) c_rm "$l" "icon fallback link to Breeze"; removed=1 ;;
      *-home-manager-files/*) ;;
    esac
  done
  [[ -e $ICON_MANIFEST ]] && c_rm "$ICON_MANIFEST" "icon fallback manifest" && removed=1
  (( removed )) || return 0
  # The directories only if they held nothing but our links.
  c_rmdir "$ICON_DIR"
  c_rmdir "${ICON_DIR%/*}"
  c_rmdir "${ICON_DIR%/*/*}"
  # GTK (Steam) rescans a theme only when a theme dir's mtime changes.
  if [[ -d ${ICON_DIR%/*/*} && -z ${CLEAN_GONE[${ICON_DIR%/*/*}]:-} ]]; then
    if c_do "touch ${ICON_DIR%/*/*} (mtime only, so Steam rescans icons)"; then
      touch -- "${ICON_DIR%/*/*}"; c_done "touched ${ICON_DIR%/*/*} (mtime only, so Steam rescans icons)"
    fi
  fi
  return 0
}

# --- Firefox user.js ---

ff_keys() { sed -n 's/^[[:space:]]*user_pref(\("[^"]*"\),.*/\1/p' "$1" 2>/dev/null || true; }
ff_in_use() { find /proc/[0-9]*/fd -lname "$1/.parentlock" -print -quit 2>/dev/null | grep -q .; }

clean_firefox() { # keep_profile ('' = none)
  local keep=$1 prof name u t kind keys pats left
  [[ -d $FF_DIR ]] || return 0
  for prof in "$FF_DIR"/*/; do
    prof=${prof%/}; name=${prof##*/}; u=$prof/user.js
    [[ -e $u || -L $u ]] || continue
    keys=''
    if [[ -L $u ]]; then
      t="$(readlink "$u")"
      case $t in
        "$FF_DESKTOP_JS")
          [[ $name == "$keep" ]] && continue
          kind="desktop profile user.js link"; keys='"full-screen-api.ignore-widgets"' ;;
        /nix/store/*-firefox-user.js|/nix/store/*-firefox-desktop-user.js)
          kind="user.js link of an older version"; keys="$(ff_keys "$u")"
          [[ -e $u ]] || c_line "note: $t is gone; values it set stay in $prof/prefs.js" ;;
        *) c_left "$u (link to $t)"; continue ;;
      esac
    elif [[ -f $u && $(head -n1 "$u") == "$FF_MARKER" ]]; then
      kind="user.js copy of an older version"; keys="$(ff_keys "$u")"
    else
      c_left "$u (not written by steam-frame-nix)"; continue
    fi
    # Firefox stored the values the file set in prefs.js; take them out too.
    # shellcheck disable=SC2001  # per line
    pats="$(sed 's/.*/user_pref(&,/' <<<"$keys")"
    if [[ -n $keys && -f $prof/prefs.js ]] && grep -qF "$pats" "$prof/prefs.js"; then
      if ff_in_use "$prof"; then
        c_defer "$u: Firefox is using profile $name; close it and run this again"
        continue
      fi
      left="$(grep -vF "$pats" "$prof/prefs.js" || true)"
      printf '%s\n' "$left" | c_write "$prof/prefs.js" "values of the $kind: ${keys//$'\n'/ }"
    fi
    c_rm "$u" "$kind"
    c_rmdir "$prof"
  done
  return 0
}

# --- Jellyfin ---

# The override with our entries taken out: LD_PRELOAD of the shim,
# SFN_MPV_HWDEC, the shim's filesystems entry and, only if one of these was
# there, devices=all. Prints "devices=<0|1>" (devices=all removed), then the
# result; exit 3 if nothing of ours was found.
jf_strip() {
  awk '
    function trim(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
    function drop(list, pat,   n, a, i, out) {
      n = split(list, a, ";"); out = ""
      for (i = 1; i <= n; i++) { a[i] = trim(a[i]); if (a[i] == "") continue
        if (a[i] ~ pat) { hit = 1; continue } out = out a[i] ";" }
      return out }
    FNR == 1 { pass++; sec = "" }
    /^[[:space:]]*\[/ { sec = trim($0); if (pass == 2) { hdr[++nh] = sec; body[nh] = "" } next }
    {
      line = $0; key = trim(substr(line, 1, index(line, "=") - 1)); val = substr(line, index(line, "=") + 1)
      hit = 0
      if (sec == "[Environment]" && key == "LD_PRELOAD" && val ~ /^\/nix\/store\/[^\/]*mpv-hwdec-shim[^\/]*\/lib\/mpv-hwdec-shim\.so$/) { hit = 1; line = "" }
      else if (sec == "[Environment]" && key == "SFN_MPV_HWDEC") { hit = 1; line = "" }
      else if (sec == "[Context]" && key == "filesystems") {
        v = drop(val, "^/nix/store/[^/]*mpv-hwdec-shim[^/]*(:ro)?$"); line = (v == "" ? "" : key "=" v) }
      else if (sec == "[Context]" && key == "devices" && pass == 2 && ours) {
        v = drop(val, "^all$"); if (hit) devs = 1; line = (v == "" ? "" : key "=" v); hit = 0 }
      if (pass == 1) { if (hit) ours = 1; next }
      if (trim(line) == "") next
      body[nh] = body[nh] line "\n"
    }
    END {
      if (!ours) exit 3
      print "devices=" (devs ? 1 : 0)
      for (i = 0; i <= nh; i++) if (body[i] != "") { if (i) printf "%s\n", hdr[i]; printf "%s\n", body[i] }
    }
  ' "$1" "$1"
}

clean_jellyfin() {
  local out rc t
  if [[ -L $JF_OVERRIDE ]]; then
    t="$(readlink "$JF_OVERRIDE")"
    [[ $t == *-home-manager-files/* ]] || c_left "$JF_OVERRIDE (link to $t)"
  elif [[ -f $JF_OVERRIDE ]]; then
    if [[ -z $(tr -d '[:space:]' <"$JF_OVERRIDE") ]]; then
      c_rm "$JF_OVERRIDE" "empty Flatpak override"
    else
      rc=0; out="$(jf_strip "$JF_OVERRIDE")" || rc=$?
      if (( rc == 0 )); then
        [[ ${out%%$'\n'*} == devices=1 ]] && c_line "devices=all goes too (it came with the hwdec shim entries)"
        out=${out#*$'\n'}; [[ $out == devices=? ]] && out=''
        if [[ -z $(tr -d '[:space:]' <<<"$out") ]]; then
          c_rm "$JF_OVERRIDE" "Flatpak override with only the hwdec shim entries"
        else
          printf '%s\n' "$out" | c_write "$JF_OVERRIDE" "hwdec shim entries"
          warn "$JF_OVERRIDE keeps entries of its own: $(grep -v '^\[' <<<"$out" | grep . | tr '\n' ' ')"
        fi
      elif (( rc == 3 )); then
        c_left "$JF_OVERRIDE (no hwdec shim entries)"
      else
        warn "could not read $JF_OVERRIDE; left as is"
      fi
    fi
  fi
  if [[ -e $JF_SHIM_MARKER ]]; then
    [[ -e $JF_SHIM_COPY || -L $JF_SHIM_COPY ]] && c_rm "$JF_SHIM_COPY" "hwdec shim copy of an older version"
    c_rm "$JF_SHIM_MARKER" "its marker"
  elif [[ -e $JF_SHIM_COPY ]]; then
    c_left "$JF_SHIM_COPY (no marker $JF_SHIM_MARKER)"
  fi
  return 0
}

# --- dashboard patch state ---

clean_ui_state() { # all
  local f n age=(-mmin +1)   # --orphans: not one being written right now
  [[ -d $UI_STATE ]] || return 0
  (( $1 )) && age=()
  while IFS= read -r -d '' f; do
    c_rm "$f" "unfinished write of the dashboard patch state"
  done < <(find "$UI_STATE" -maxdepth 1 -type f -name '*.json.tmp' "${age[@]}" -print0)
  if (( $1 )); then
    for f in "$UI_STATE"/*.json; do
      [[ -f $f ]] || continue
      n=${f##*/}; c_rm "$f" "saved choices of the dashboard patch ${n%.json}"
    done
  fi
  c_rmdir "$UI_STATE"
  return 0
}

cmd_cleanup() {
  local mode='' keep_debugger=0 keep_ff='' keeps=0 k
  while (( $# )); do
    case $1 in
      --all) mode=all; shift ;;
      --orphans) mode=orphans; shift ;;
      --dry-run|-n) CLEAN_DRY=1; shift ;;
      --quiet|-q) CLEAN_QUIET=1; shift ;;
      --keep)
        [[ $# -ge 2 ]] || die "--keep needs an artifact"
        k=$2; shift 2; keeps=$((keeps + 1))
        case $k in
          debugger) keep_debugger=1 ;;
          firefox-desktop-userjs=?*) keep_ff=${k#*=} ;;
          *) die "cleanup: unknown artifact '$k' for --keep (debugger, firefox-desktop-userjs=<profile>)" ;;
        esac ;;
      -h|--help) usage; exit 0 ;;
      *) die "cleanup: unknown option '$1' (see --help)" ;;
    esac
  done
  [[ -n $mode ]] || die "cleanup: --all or --orphans is required (see --help)"
  [[ $mode == all && $keeps -gt 0 ]] && die "cleanup: --keep only goes with --orphans"
  need_not_root

  CLEAN_ACTIONS=0; CLEAN_DEFERRED=(); CLEAN_GONE=()
  CLEAN_HEADER="steam-frame-nix: cleaning up files outside Nix ($mode"
  if (( CLEAN_DRY )); then CLEAN_HEADER+=", dry run)"; else CLEAN_HEADER+=")"; fi
  if (( ! CLEAN_QUIET )); then step "$CLEAN_HEADER"; CLEAN_HEADER=''; fi
  clean_debugger "$keep_debugger"
  clean_icons
  clean_firefox "$keep_ff"
  clean_jellyfin
  clean_ui_state "$([[ $mode == all ]] && echo 1 || echo 0)"
  c_rmdir "$SFN_STATE"
  if [[ $mode == all ]]; then c_rmdir "$SFN_RUNTIME"; fi
  (( CLEAN_ACTIONS || ${#CLEAN_DEFERRED[@]} || CLEAN_QUIET )) || info "nothing to clean up"
  return 0
}

# --- uninstall --------------------------------------------------------------

# User units installed by Home Manager (unit files resolving into /nix/store).
hm_user_units() {
  local f
  [[ -d $USER_UNIT_DIR ]] || return 0
  for f in "$USER_UNIT_DIR"/*; do
    [[ -L $f && -f $f ]] || continue
    case ${f##*/} in
      *@.*) continue ;;
      *.service|*.socket|*.timer|*.path) ;;
      *) continue ;;
    esac
    [[ $(readlink -f "$f") == /nix/store/* ]] && printf '%s\n' "${f##*/}"
  done
  return 0
}

stop_hm_services() {
  step "Stopping Home Manager user services"
  local units=()
  mapfile -t units < <(hm_user_units)
  if (( ${#units[@]} == 0 )); then info "none found"; return 0; fi
  if ! outer_bus_ok; then
    warn "user manager not reachable at $OUTER_RUNTIME_DIR; not stopping: ${units[*]}"
    return 0
  fi
  info "${units[*]}"
  outer_systemctl stop -- "${units[@]}" || warn "some units failed to stop"
}

remove_hm() {
  step "Uninstalling Home Manager"
  if ! hm_installed; then info "no Home Manager profile found"; return 0; fi
  if ! nix_works; then warn "Nix doesn't work; skipping 'home-manager uninstall'"; return 0; fi

  # `home-manager uninstall` builds an empty config with <nixpkgs>; take the
  # nixpkgs the current config uses (already in the store), else the registry.
  local nixpkgs='' dir
  if [[ -e $HM_CONFIG_LINK/flake.nix ]]; then
    dir="$(readlink -f "$HM_CONFIG_LINK")"
    nixpkgs="$(nix eval --raw "$dir#homeConfigurations.\"$USER_NAME\".pkgs.path" 2>/dev/null || true)"
  fi
  [[ -n $nixpkgs ]] || nixpkgs=flake:nixpkgs

  # It asks "Really uninstall Home Manager? [y/n]" (one character from stdin);
  # we already asked.
  printf 'y' | hm -I "nixpkgs=$nixpkgs" uninstall \
    || die "'home-manager uninstall' failed; fix the error and re-run (Nix was not touched)"

  if outer_bus_ok; then
    outer_systemctl daemon-reload || true
    outer_systemctl reset-failed >/dev/null 2>&1 || true
  fi
}

# Processes still running from /nix/store would keep /nix busy.
stop_nix_processes() {
  local skip=" " p=$$ pid exe pids=()
  while [[ -n $p && $p -gt 1 ]]; do
    skip+="$p "
    p="$(awk '/^PPid:/ {print $2}' "/proc/$p/status" 2>/dev/null || true)"
  done
  for pid in /proc/[0-9]*; do
    pid=${pid#/proc/}
    [[ -O /proc/$pid && $skip != *" $pid "* ]] || continue
    exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
    [[ $exe == /nix/store/* ]] && pids+=("$pid")
  done
  (( ${#pids[@]} )) || return 0

  step "Processes still running from /nix"
  ps -o pid=,args= -p "$(IFS=,; echo "${pids[*]}")" | cut -c1-120 | sed 's/^/    /' || true
  if confirm "Stop them (Nix can't be unmounted while they run)?"; then
    kill -TERM "${pids[@]}" 2>/dev/null || true
    sleep 2
    for pid in "${pids[@]}"; do    # only if it's still the same /nix process
      [[ $(readlink "/proc/$pid/exe" 2>/dev/null || true) == /nix/store/* ]] && kill -KILL "$pid" 2>/dev/null || true
    done
  else
    warn "left running; the Nix uninstall may fail to unmount /nix"
  fi
  for p in $skip; do
    [[ $(readlink "/proc/$p/exe" 2>/dev/null || true) == /nix/store/* ]] \
      && warn "process $p (a parent shell) runs from /nix; if the uninstall can't unmount /nix, re-run from a terminal whose shell is /usr/bin/bash"
  done
  return 0
}

remove_path() {
  if [[ -e $1 || -L $1 ]]; then rm -rf -- "$1"; info "removed $1"; fi
}

remove_leftovers() { # keep_nix
  step "Removing per-user leftovers"
  local state="${XDG_STATE_HOME:-$HOME/.local/state}"
  if (( ! $1 )); then
    remove_path "$HOME/.nix-profile"
    remove_path "$HOME/.nix-defexpr"
    remove_path "$HOME/.nix-channels"
    remove_path "$state/nix"
    remove_path "${XDG_CACHE_HOME:-$HOME/.cache}/nix"
    if [[ -f $USER_NIX_CONF ]]; then
      if [[ -z $(grep -Ev '^[[:space:]]*(#|$)' "$USER_NIX_CONF" \
                 | grep -Ev '^[[:space:]]*(extra-)?experimental-features[[:space:]]*=[[:space:]]*(nix-command[[:space:]]+flakes|flakes[[:space:]]+nix-command|flakes)[[:space:]]*$' || true) ]]; then
        remove_path "$USER_NIX_CONF"
        rmdir "${USER_NIX_CONF%/*}" 2>/dev/null || true
      else
        info "kept $USER_NIX_CONF (has more than the flakes setting)"
      fi
    fi
  fi
  remove_path "$state/home-manager"
  if [[ -L $HM_CONFIG_LINK ]]; then
    info "$HM_CONFIG_LINK pointed to $(readlink "$HM_CONFIG_LINK")"
    remove_path "$HM_CONFIG_LINK"
  elif [[ -e $HM_CONFIG_LINK ]]; then
    info "kept $HM_CONFIG_LINK (a real directory, your configuration)"
  fi
}

cmd_uninstall() {
  local keep_nix=0 orig_args=("$@")
  while (( $# )); do
    case $1 in
      -y|--yes) ASSUME_YES=1; shift ;;
      --keep-nix) keep_nix=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "uninstall: unknown option '$1' (see --help)" ;;
    esac
  done
  need_not_root

  # A bash from Nix (e.g. via /usr/bin/env) would keep /nix busy.
  if (( ! keep_nix )) && [[ $(readlink /proc/$$/exe) == /nix/store/* ]]; then
    if [[ -f ${BASH_SOURCE[0]:-} && -x /usr/bin/bash ]]; then
      exec /usr/bin/bash "${BASH_SOURCE[0]}" uninstall "${orig_args[@]}"
    fi
    die "this shell's bash is from Nix; run: curl -fsSL https://steam-frame-nix.lhns.de | /usr/bin/bash -s -- uninstall"
  fi

  if (( keep_nix )); then
    step "This uninstalls Home Manager (its files and services); Nix stays"
  else
    step "This uninstalls Home Manager (its files and services) and Nix (/nix, /home/nix)"
  fi
  confirm "Continue?" || die "aborted"

  load_nix
  stop_hm_services
  cmd_cleanup --all
  remove_hm

  if (( ! keep_nix )); then
    if [[ -x $NIX_INSTALLER_BIN ]]; then
      stop_nix_processes
      uninstall_nix
    elif command -v nix >/dev/null 2>&1; then
      warn "Nix wasn't installed by nix-installer ($NIX_INSTALLER_BIN missing); not removing it"
      keep_nix=1
    else
      info "Nix is not installed"
    fi
  fi

  remove_leftovers "$keep_nix"

  step "Done"
  cat <<EOF

Intentionally left in place:
  - your configuration (e.g. $DEFAULT_CONFIG_DIR)
  - files Home Manager renamed to *.hm-backup-<time>
  - app data, e.g. ~/.local/share/docker, Firefox profiles, and Flatpak apps
Log out or reboot so running sessions drop the removed tweaks.
EOF
  if (( ${#CLEAN_DEFERRED[@]} )); then
    printf '\nNot done yet:\n'
    printf '  - %s\n' "${CLEAN_DEFERRED[@]}"
  fi
}

# --- status -----------------------------------------------------------------

cmd_status() {
  local gen target features ro unit units=()
  load_nix

  step "Nix"
  if nix_works; then
    info "version:    $(nix --version)"
  elif command -v nix >/dev/null 2>&1; then
    info "version:    $(nix --version 2>/dev/null || echo '?') (daemon not reachable)"
  else
    info "not installed"
  fi
  if [[ -r $NIX_RECEIPT ]]; then
    info "installer:  nix-installer, planner $(receipt_planner || echo '?')"
  fi
  if command -v nix >/dev/null 2>&1; then
    features="$(nix_features || true)"
    info "features:   ${features:-?}"
  fi
  info "daemon:     nix-daemon.socket $(systemctl is-active nix-daemon.socket 2>/dev/null || true)"
  if command -v btrfs >/dev/null 2>&1; then
    ro="$(btrfs property get / ro 2>/dev/null || true)"
    [[ -n $ro ]] && info "root fs:    $([[ $ro == ro=true ]] && echo read-only || echo read-write)"
  fi

  step "Home Manager"
  if hm_installed; then
    target="$(readlink -f "$HM_PROFILE")"
    gen="$(readlink "$HM_PROFILE")"; gen="${gen##*/}"; gen="${gen#home-manager-}"; gen="${gen%-link}"
    info "generation: $gen ($target)"
    info "activated:  $(stat -c %y "$HM_PROFILE" | cut -d. -f1)"
  else
    info "not installed"
  fi
  if [[ -L $HM_CONFIG_LINK ]]; then
    info "config:     $HM_CONFIG_LINK -> $(readlink -f "$HM_CONFIG_LINK")"
  elif [[ -e $HM_CONFIG_LINK ]]; then
    info "config:     $HM_CONFIG_LINK"
  else
    info "config:     none at $HM_CONFIG_LINK"
  fi

  step "User services from Home Manager"
  mapfile -t units < <(hm_user_units)
  if (( ${#units[@]} == 0 )); then
    info "none"
  elif outer_bus_ok; then
    for unit in "${units[@]}"; do
      info "$(printf '%-30s %s' "$unit" "$(outer_systemctl is-active "$unit" 2>/dev/null || true)")"
    done
  else
    info "user manager not reachable at $OUTER_RUNTIME_DIR"
  fi
  info "$(printf '%-30s %s' clipboard-sync "$(pgrep -u "$USER_ID" -x clipboard-sync >/dev/null && echo running || echo 'not running')")"

  cmd_cleanup --dry-run --all
}

# --- main -------------------------------------------------------------------

main() {
  local cmd=${1:-}
  (( $# )) && shift
  case $cmd in
    install) cmd_install "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    status) cmd_status "$@" ;;
    cleanup) cmd_cleanup "$@" ;;
    -h|--help|help) usage ;;
    '') usage >&2; exit 2 ;;
    *) printf 'unknown command: %s\n\n' "$cmd" >&2; usage >&2; exit 2 ;;
  esac
}

# Run unless sourced (piped into bash counts as run).
(return 0 2>/dev/null) || main "$@"
