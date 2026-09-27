#!/usr/bin/env bash
# Install or uninstall Nix + Home Manager on SteamOS (Steam Frame, Steam Deck).
#
#   curl -fsSL https://raw.githubusercontent.com/lhns/steam-frame-nix/main/install.sh | bash -s -- install
#   curl -fsSL https://raw.githubusercontent.com/lhns/steam-frame-nix/main/install.sh | bash -s -- uninstall
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
OUTER_RUNTIME_DIR="/run/user/$USER_ID"

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
      Existing dotfiles that conflict are renamed to *.backup. Re-running
      just switches again.

  uninstall [--yes] [--keep-nix]
      Stop Home Manager's user services, uninstall Home Manager, uninstall
      Nix (unless --keep-nix) and remove per-user Nix leftovers. Your
      configuration directory is never deleted.

  status
      Show Nix, Home Manager and steam-frame-nix service state.

Options:
  --yes, -y      Don't ask; answer yes to every question.
  --help, -h     Show this help.

Piped:
  curl -fsSL https://raw.githubusercontent.com/lhns/steam-frame-nix/main/install.sh | bash -s -- install
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
  if ! command -v nix >/dev/null 2>&1 && [[ -x /nix/var/nix/profiles/default/bin/nix ]]; then
    PATH="$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"
  fi
  if [[ ${NIX_CONFIG:-} != *"nix-command flakes"* ]]; then
    NIX_CONFIG="${NIX_CONFIG:+$NIX_CONFIG$'\n'}extra-experimental-features = nix-command flakes"
    export NIX_CONFIG
  fi
}

nix_works() {
  command -v nix >/dev/null 2>&1 && nix --version >/dev/null 2>&1 || return 1
  nix store info >/dev/null 2>&1 || nix store ping >/dev/null 2>&1
}

# experimental-features as configured (without our NIX_CONFIG)
nix_features() {
  env -u NIX_CONFIG nix config show experimental-features 2>/dev/null \
    || env -u NIX_CONFIG nix show-config 2>/dev/null | sed -n 's/^experimental-features = //p'
}

receipt_planner() {
  [[ -r $NIX_RECEIPT ]] || return 1
  if command -v jq >/dev/null 2>&1; then
    jq -r '.planner.planner // empty' "$NIX_RECEIPT"
  else
    grep -o '"planner"[[:space:]]*:[[:space:]]*"[^"]*"' "$NIX_RECEIPT" | head -n1 | sed 's/.*"\([^"]*\)"$/\1/'
  fi
}

# systemctl --user of the outer (Steam/VR) session; the nested desktop
# can't reach the user manager with its own environment.
outer_systemctl() {
  XDG_RUNTIME_DIR="$OUTER_RUNTIME_DIR" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$OUTER_RUNTIME_DIR/bus" \
    /usr/bin/systemctl --user "$@"
}

outer_bus_ok() { [[ -S $OUTER_RUNTIME_DIR/bus && -x /usr/bin/systemctl ]]; }

hm_profile() {
  local p
  for p in "${XDG_STATE_HOME:-$HOME/.local/state}/nix/profiles/home-manager" \
           "/nix/var/nix/profiles/per-user/$USER_NAME/home-manager"; do
    [[ -e $p || -L $p ]] && { printf '%s\n' "$p"; return 0; }
  done
  return 1
}

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
      --flake=*) flake=${1#--flake=}; shift ;;
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

  step "Activating Home Manager (conflicting files are renamed to *.backup)"
  hm switch --flake "$ref" -b backup

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
    (Steam Settings > System > Enable Developer Mode).
  - Status: install.sh status. Remove everything: install.sh uninstall
EOF
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
  if ! hm_profile >/dev/null; then info "no Home Manager profile found"; return 0; fi
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
    for pid in "${pids[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
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
    die "this shell's bash is from Nix; run: curl -fsSL https://raw.githubusercontent.com/lhns/steam-frame-nix/main/install.sh | /usr/bin/bash -s -- uninstall"
  fi

  if (( keep_nix )); then
    step "This uninstalls Home Manager (its files and services); Nix stays"
  else
    step "This uninstalls Home Manager (its files and services) and Nix (/nix, /home/nix)"
  fi
  confirm "Continue?" || die "aborted"

  load_nix
  stop_hm_services
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
  - files Home Manager renamed to *.backup
  - app data, e.g. ~/.local/share/docker, and Flatpak apps
Log out or reboot so running sessions drop the removed tweaks.
EOF
}

# --- status -----------------------------------------------------------------

cmd_status() {
  local p gen target features ro unit
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
  if p="$(hm_profile)"; then
    target="$(readlink -f "$p")"
    gen="$(readlink "$p")"; gen="${gen##*/}"; gen="${gen#home-manager-}"; gen="${gen%-link}"
    info "generation: $gen ($target)"
    info "activated:  $(stat -c %y "$p" | cut -d. -f1)"
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

  step "steam-frame-nix services"
  if outer_bus_ok; then
    for unit in steam-keyboard-patch.service docker.service; do
      if [[ $unit == docker.service && ! -e $USER_UNIT_DIR/$unit ]]; then continue; fi
      info "$(printf '%-30s %s' "$unit" "$(outer_systemctl is-active "$unit" 2>/dev/null || true)")"
    done
  else
    info "user manager not reachable at $OUTER_RUNTIME_DIR"
  fi
  info "$(printf '%-30s %s' clipboard-sync "$(pgrep -u "$USER_ID" -x clipboard-sync >/dev/null && echo running || echo 'not running')")"
}

# --- main -------------------------------------------------------------------

main() {
  local cmd=${1:-}
  (( $# )) && shift
  case $cmd in
    install) cmd_install "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    status) cmd_status "$@" ;;
    -h|--help|help) usage ;;
    '') usage >&2; exit 2 ;;
    *) printf 'unknown command: %s\n\n' "$cmd" >&2; usage >&2; exit 2 ;;
  esac
}

# Run unless sourced (piped into bash counts as run).
(return 0 2>/dev/null) || main "$@"
