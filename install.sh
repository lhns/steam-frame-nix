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

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
HM_CONFIG_LINK="$CONFIG_HOME/home-manager"
DEFAULT_CONFIG_DIR="$HOME/nix-config"
USER_NIX_CONF="$CONFIG_HOME/nix/nix.conf"
USER_UNIT_DIR="$CONFIG_HOME/systemd/user"

USER_NAME="$(id -un)"
USER_ID="$(id -u)"
OUTER_RUNTIME_DIR="${STEAM_FRAME_NIX_RUNTIME_DIR:-/run/user/$USER_ID}"
SFN_PROC="${STEAM_FRAME_NIX_PROC:-/proc}"   # tests: a fake /proc
SFN_TTY="${STEAM_FRAME_NIX_TTY:-/dev/tty}"  # tests: a file
# uninstall_nix: nix.mount detaches lazily (tests: another directory)
NIX_MOUNT_DROPIN="${STEAM_FRAME_NIX_SYSTEM_RUNTIME:-/run/systemd/system}/nix.mount.d/50-steam-frame-nix-lazy-unmount.conf"

ASSUME_YES=0
RO_RELOCK=0
CLONE_TMP=''      # an unfinished --clone, removed on exit
NIX_DROPIN=0      # NIX_MOUNT_DROPIN written, removed on exit

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
  install [--flake <dir-or-flakeref> | --clone <git-url> [--dir <path>]
          [--ref <branch>]] [--yes]
      Install Nix (NixOS nix-installer, steam-deck planner, flakes enabled) if
      it is missing, then activate a Home Manager configuration:
        --flake given        that flake (a directory or a flake reference)
        --clone given        your config's git repository (git@host:owner/repo,
                             https://..., github:owner/repo), cloned into
                             --dir (default ~/nix-config) on branch --ref
                             (anything there but the unchanged template is
                             used as it is), then used like --flake <dir>.
                             Private repositories: see the README
        otherwise            ~/.config/home-manager; without it the flake
                             in ~/nix-config, else a new config there from
                             the steam-frame-nix template (either linked to
                             ~/.config/home-manager)
      Existing dotfiles that conflict are renamed to *.hm-backup-<time>.
      Re-running just switches again.

  uninstall [--yes] [--keep-nix]
      Stop Home Manager's user services, run 'cleanup --all', uninstall Home
      Manager, uninstall Nix (unless --keep-nix) and remove per-user Nix
      leftovers. /nix is detached lazily: programs started from the Nix
      store (listed) keep running until you log out or reboot. Your
      configuration directory (also a --clone) is never deleted.

  cleanup [--dry-run] [--quiet] (--all | --orphans [--keep <artifact>]...)
      Remove what steam-frame-nix (any version) wrote outside the Nix store,
      only where it is provably its own; everything else is reported as
      "left alone". Safe to re-run.
        --all        everything, incl. the dashboard patches' saved choices
                     (~/.local/state/steam-frame-nix/ui-patches). Use after
                     rolling back to a generation without steam-frame-nix,
                     or before removing it.
        --orphans    what the configuration no longer uses (run by the Home
                     Manager module on every switch); keeps saved choices.
        --keep       still in use (with --orphans): debugger, screenshots, pet
        --dry-run    only print what would be done
        --quiet      print only actions, deferrals and warnings
      While SteamVR runs, VRWebHelper.DebuggerEnabled is restored when it
      stops.

  status
      Show Nix, Home Manager and user service state, and what
      'cleanup --all' would remove.

  steamvr-debugger-arm
      Internal (run before each SteamVR start by steamFrame.steamvrDebugger):
      set VRWebHelper.DebuggerEnabled until SteamVR stops.

  restart-check
      Internal (run on every switch, and by install): name the settings
      that wait for a restart of the Steam session or SteamVR.

Options:
  --yes, -y      Don't ask; answer yes to every question.
  --help, -h     Show this help.

Piped:
  curl -fsSL https://steam-frame-nix.lhns.de | bash -s -- install
EOF
}

# --- helpers ----------------------------------------------------------------

tilde() { # path, as ~/... below $HOME
  if [[ $1 == "$HOME" || $1 == "$HOME"/* ]]; then printf '%s\n' "~${1#"$HOME"}"; else printf '%s\n' "$1"; fi
}

have_tty() { { : <"$SFN_TTY"; } 2>/dev/null; }

confirm() { # question [default answer: n|y]
  (( ASSUME_YES )) && return 0
  have_tty || die "no terminal to ask \"$1\"; re-run with --yes"
  local reply='' def=${2:-n}
  printf '%s [%s] ' "$1" "$([[ $def == y ]] && echo Y/n || echo y/N)" >"$SFN_TTY"
  read -r reply <"$SFN_TTY" || true
  [[ ${reply:-$def} == [yY]* ]]
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

on_exit() {
  [[ -z $CLONE_TMP ]] || rm -rf -- "$CLONE_TMP"
  nix_dropin_remove
  ro_relock
}
trap on_exit EXIT
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

# systemctl --user of the outer (Steam/VR) session: the nested desktop
# can't reach the user manager with its own environment. Fails if it isn't
# reachable. Tests: STEAM_FRAME_NIX_SYSTEMCTL.
user_systemctl() {
  if [[ -n ${STEAM_FRAME_NIX_SYSTEMCTL:-} ]]; then "$STEAM_FRAME_NIX_SYSTEMCTL" --user "$@"
  elif [[ -S $OUTER_RUNTIME_DIR/bus && -x /usr/bin/systemctl ]]; then
    XDG_RUNTIME_DIR="$OUTER_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="unix:path=$OUTER_RUNTIME_DIR/bus" \
      /usr/bin/systemctl --user "$@"
  else return 1; fi
}

user_manager_ok() { user_systemctl --version >/dev/null 2>&1; }

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

nix_mounted() { mountpoint -q /nix 2>/dev/null; }

nix_dropin_remove() {
  (( NIX_DROPIN )) || return 0
  NIX_DROPIN=0
  sudo rm -f "$NIX_MOUNT_DROPIN"
  sudo rmdir "${NIX_MOUNT_DROPIN%/*}" 2>/dev/null || true
  sudo systemctl daemon-reload || true
}

uninstall_nix() {
  local rc=0 bin='' users=()
  need_sudo
  ro_unlock
  step "Uninstalling Nix"
  mapfile -t users < <(nix_users)
  if (( ${#users[@]} )); then
    info "Started from the Nix store, these keep running until you log out or reboot:"
    printf '      - %s\n' "${users[@]}"
  fi
  # From a root-owned copy outside /nix.
  if ! bin="$(sudo mktemp)" || ! sudo cp "$NIX_INSTALLER_BIN" "$bin" \
     || ! sudo chmod 700 "$bin" || ! sudo "$bin" --version >/dev/null 2>&1; then
    [[ -n $bin ]] && sudo rm -f "$bin"
    bin=$NIX_INSTALLER_BIN
  fi
  # Programs started from the Nix store keep /nix busy, so the uninstaller's
  # `systemctl stop nix.mount` would fail. With LazyUnmount= that stop
  # detaches /nix; the programs keep their open files until they exit.
  if nix_mounted; then
    NIX_DROPIN=1
    sudo mkdir -p "${NIX_MOUNT_DROPIN%/*}" \
      && printf '%s\n' '# steam-frame-nix: removing Nix detaches /nix while programs use it.' \
           '[Mount]' 'LazyUnmount=yes' | sudo tee "$NIX_MOUNT_DROPIN" >/dev/null \
      && sudo systemctl daemon-reload \
      || warn "could not add $NIX_MOUNT_DROPIN; removing Nix fails if a program still uses /nix"
  fi
  sudo "$bin" uninstall --no-confirm || rc=$?
  [[ $bin == "$NIX_INSTALLER_BIN" ]] || sudo rm -f "$bin"
  nix_dropin_remove
  hash -r   # commands found in /nix are gone
  ro_relock
  return "$rc"
}

ensure_nix() {
  step "Checking Nix"
  load_nix
  if nix_works; then
    info "$(nix --version): installed already"
  else
    if [[ -e $NIX_RECEIPT ]]; then
      warn "Nix is installed ($NIX_RECEIPT) but not working"
      confirm "Uninstall and reinstall Nix?" || die "aborted"
      [[ -x $NIX_INSTALLER_BIN ]] || die "$NIX_INSTALLER_BIN is missing; can't uninstall the broken Nix"
      uninstall_nix || die "the Nix uninstall failed (see above)"
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
    echo "experimental-features = nix-command flakes" >>"$USER_NIX_CONF"
  fi
}

# Replace `name = "...";` in the template's let block.
set_let() { # file name value
  local file=$1 name=$2 value=$3
  grep -q "^ *$name = \"[^\"]*\";" "$file" || die "template: '$name' not found in $file"
  sed -i "s|^\( *$name = \)\"[^\"]*\";|\1\"$value\";|" "$file"
}

# create_config's marker in .git: the hash of the files it wrote, so
# `install --clone` replaces the template only while it is unchanged.
TEMPLATE_MARK=steam-frame-nix-template

config_hash() { # dir: its files without .git
  (cd "$1" && find . -path ./.git -prune -o ! -type d -print0 | LC_ALL=C sort -z \
     | xargs -0 -r sha256sum | sha256sum) | cut -d' ' -f1
}

# The marker matches the files, at most one commit.
template_untouched() { # dir
  local m=$1/.git/$TEMPLATE_MARK n
  [[ -f $m ]] || return 1
  n="$(git_any -C "$1" rev-list --count HEAD 2>/dev/null || echo 0)"
  [[ $(<"$m") == "$(config_hash "$1")" ]] && (( n <= 1 ))
}

create_config() { # dir [question]
  local dir=$1 system
  if [[ -e $dir ]] && [[ -n $(ls -A "$dir" 2>/dev/null) ]]; then
    die "$dir exists and is not empty; move it away or pass --flake <your config>"
  fi
  [[ $USER_NAME =~ ^[a-z_][a-z0-9_-]*$ ]] || die "unsupported user name '$USER_NAME' for the template"
  [[ $HOME =~ ^/[A-Za-z0-9._/-]+$ ]] || die "unsupported home directory '$HOME' for the template"

  confirm "${2:-No Home Manager configuration found. Create one in $dir from the steam-frame-nix template?}" \
    || die "aborted; pass --flake <your config> to use an existing one"

  step "Creating a Home Manager configuration in $dir"
  mkdir -p "$dir"
  (cd "$dir" && nix flake init -t "$TEMPLATE")
  system="$(nix eval --impure --raw --expr builtins.currentSystem)"
  set_let "$dir/flake.nix" username "$USER_NAME"
  set_let "$dir/flake.nix" homeDirectory "$HOME"
  set_let "$dir/flake.nix" system "$system"
  info "user $USER_NAME, home $HOME, system $system"

  # Locked as a path (not the git repository: no "dirty" warning), then
  # one commit, since flakes in a git repository only see tracked files.
  nix flake lock "path:$dir"
  git_any -C "$dir" init -q
  git_any -C "$dir" add -A
  local id=()   # the user's git identity, else one for this commit only
  git_any -C "$dir" config user.name >/dev/null || id+=(-c "user.name=$USER_NAME")
  git_any -C "$dir" config user.email >/dev/null || id+=(-c "user.email=$USER_NAME@localhost")
  git_any -C "$dir" "${id[@]}" -c commit.gpgsign=false commit -q --no-verify \
    -m "Configuration from the steam-frame-nix template"
  config_hash "$dir" >"$dir/.git/$TEMPLATE_MARK"

  link_config "$dir"
}

link_config() { # dir
  mkdir -p "${HM_CONFIG_LINK%/*}"
  ln -s "$1" "$HM_CONFIG_LINK"
  info "linked $HM_CONFIG_LINK -> $1"
}

# git, or Nix's when SteamOS has none (only after ensure_nix).
git_any() {
  if command -v git >/dev/null 2>&1; then git "$@"
  else nix run nixpkgs#git -- "$@"; fi
}

# git URL for --clone: github:owner/repo -> https://github.com/owner/repo.git
clone_url() {
  case $1 in
    github:*)
      [[ ${1#github:} =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
        || die "--clone: expected github:owner/repo, got '$1' (use --ref for a branch)"
      printf 'https://github.com/%s.git\n' "${1#github:}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# Whether git has a credential helper (the template's: gh, store).
git_has_helpers() {
  git_any config --global --get-regexp '^credential\..*helper$' 2>/dev/null \
    | awk 'NF > 1 { f = 1 } END { exit !f }'
}

# `gh auth login` with gh from the Home Manager profile (the template's),
# for an HTTPS URL on github.com and only with a terminal.
gh_login() { # url
  local gh=$HM_PROFILE/home-path/bin/gh
  [[ $1 == https://github.com/* ]] && have_tty || return 1
  [[ -x $gh ]] || gh="$(command -v gh)" || return 1
  confirm "Log in to GitHub now with 'gh auth login'?" y || return 1
  "$gh" auth login --hostname github.com --git-protocol https <"$SFN_TTY"
}

# --clone, resumable: only a missing (or empty) <dir> or the untouched
# template there gets the clone. The steps: docs/cleanup.md.
clone_config() { # url dir ref
  local url dir=$2 ref=$3 tmpl=0 parent link=''
  url="$(clone_url "$1")"
  if [[ -e $dir ]] && [[ -n $(ls -A "$dir" 2>/dev/null) ]]; then
    if ! template_untouched "$dir"; then
      step "$dir already exists and isn't the untouched template: using it as it is (not cloning)"
      return 0
    fi
    tmpl=1
  fi

  if [[ -L $HM_CONFIG_LINK || -e $HM_CONFIG_LINK ]]; then
    link="$(readlink -f "$HM_CONFIG_LINK" || true)"
  fi
  if [[ -z $link ]]; then
    if (( tmpl )); then   # an earlier run's template; the link was removed
      link_config "$dir"
    else
      create_config "$dir" "No Home Manager configuration found. Activate the steam-frame-nix template in $dir first (for git's credentials), then replace it with the clone of $url?"
      tmpl=1
    fi
    hm_activate "$dir#$USER_NAME" || die "the switch to the template failed (see above); run install --clone again to continue"
  elif (( tmpl )) && [[ $link -ef $dir ]]; then
    if hm_installed && git_has_helpers; then
      step "The template in $dir is active with git's credential helpers (skipped)"
    else
      hm_activate "$dir#$USER_NAME" || die "the switch to the template failed (see above); run install --clone again to continue"
    fi
  fi

  parent="$(mkdir -p "${dir%/*}" && cd "${dir%/*}" && pwd)"
  CLONE_TMP="$(mktemp -d "$parent/.${dir##*/}.clone.XXXXXX")"
  chmod "$(umask -S)" "$CLONE_TMP"
  step "Cloning $url"
  # Credential helpers only: git never asks for a password.
  if ! GIT_TERMINAL_PROMPT=0 git_any clone ${ref:+--branch "$ref"} -- "$url" "$CLONE_TMP" \
     && ! { gh_login "$url" && GIT_TERMINAL_PROMPT=0 git_any clone ${ref:+--branch "$ref"} -- "$url" "$CLONE_TMP"; }; then
    (( tmpl )) && warn "the steam-frame-nix template stays active in $dir; install --clone replaces it while it is unchanged"
    die "git clone failed. For a private repository log in to GitHub with \
'gh auth login' or use an SSH URL (git@github.com:owner/repo) with a key \
your account knows, then run install --clone again: it continues where it stopped."
  fi
  if (( tmpl )); then
    template_untouched "$dir" || die "$dir was changed while cloning; the clone is not used"
    rm -rf -- "$dir"
    info "removed the template in $dir (only needed for the clone)"
  elif [[ -d $dir ]]; then
    rmdir -- "$dir"   # empty
  fi
  mv -T -- "$CLONE_TMP" "$dir"
  CLONE_TMP=''
  info "cloned into $dir"
}

# home-manager switch; files in its way are renamed to *.hm-backup-<time>
# (unique per run: Home Manager aborts if a backup from an earlier run exists).
hm_activate() { # flake ref
  local backup
  backup="hm-backup-$(date +%Y%m%d-%H%M%S)"
  step "Activating Home Manager (conflicting files are renamed to *.$backup)"
  hm switch --flake "$1" -b "$backup"
}

cmd_install() {
  local flake='' ref dir='' clone='' clone_dir='' clone_ref=''
  while (( $# )); do
    case $1 in
      --flake) [[ $# -ge 2 ]] || die "--flake needs an argument"; flake=$2; shift 2 ;;
      --clone) [[ $# -ge 2 ]] || die "--clone needs an argument"; clone=$2; shift 2 ;;
      --dir) [[ $# -ge 2 ]] || die "--dir needs an argument"; clone_dir=$2; shift 2 ;;
      --ref) [[ $# -ge 2 ]] || die "--ref needs an argument"; clone_ref=$2; shift 2 ;;
      -y|--yes) ASSUME_YES=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "install: unknown option '$1' (see --help)" ;;
    esac
  done
  if [[ -n $clone ]]; then
    [[ -z $flake ]] || die "install: --clone and --flake exclude each other"
    clone_url "$clone" >/dev/null
    clone_dir=${clone_dir:-$DEFAULT_CONFIG_DIR}
    [[ $clone_dir == /* ]] || clone_dir=$PWD/$clone_dir
    clone_dir=${clone_dir%"${clone_dir##*[!/]}"}   # no trailing /
    [[ -n ${clone_dir%/*} ]] || die "--dir: '$clone_dir' is not below a directory"
  elif [[ -n $clone_dir || -n $clone_ref ]]; then
    die "install: --dir and --ref need --clone"
  fi

  need_not_root
  check_os
  command -v curl >/dev/null 2>&1 || die "curl not found"

  ensure_nix

  if [[ -n $clone ]]; then
    clone_config "$clone" "$clone_dir" "$clone_ref"
    flake=$clone_dir
  fi

  step "Finding the Home Manager configuration"
  if [[ -z $flake && ! -e $HM_CONFIG_LINK && ! -L $HM_CONFIG_LINK && -e $DEFAULT_CONFIG_DIR/flake.nix ]]; then
    info "$DEFAULT_CONFIG_DIR already exists: using it as it is"
    flake=$DEFAULT_CONFIG_DIR
  fi
  if [[ -n $flake ]]; then
    if [[ -d ${flake%%#*} ]]; then
      dir="$(cd "${flake%%#*}" && pwd -P)"
      [[ -e $dir/flake.nix ]] || die "$dir has no flake.nix"
      ref="$dir${flake#"${flake%%#*}"}"
      [[ -e $HM_CONFIG_LINK || -L $HM_CONFIG_LINK ]] || link_config "$dir"
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
    # || true: with pipefail, head closing the pipe early fails git.
    untracked="$(git -C "$dir" ls-files --others --exclude-standard -- '*.nix' | head -n5 || true)"
    [[ -z $untracked ]] || warn "untracked files are invisible to the flake (git add them): $(echo "$untracked" | tr '\n' ' ')"
  fi

  hm_activate "$ref" || die "home-manager switch failed (see above)${clone:+; fix $dir and run install --clone again: it continues with this switch}"

  # Settings read only at a process start (the activation warned already).
  local pending=()
  mapfile -t pending < <(restart_pending)

  local switch_cmd="home-manager switch --flake $ref" config=$ref
  if [[ -n $dir ]]; then
    config="$(tilde "$dir")"
    [[ -e $dir/home.nix ]] && config+=" (home.nix)"
    if [[ $(readlink -f "$HM_CONFIG_LINK" 2>/dev/null) == "$dir" ]] \
       && [[ $ref == "$dir" || $ref == "$dir#$USER_NAME" ]]; then
      switch_cmd="home-manager switch"
    fi
  fi

  step "Done"
  if (( ${#pending[@]} )); then
    printf '\n%sRestart once%s (reboot, or restart the Steam session) for:\n' "$Y" "$N"
    printf '  - %s\n' "${pending[@]}"
    printf '%s\n' "  Everything else already works in the running session."
  fi
  cat <<EOF

Open a new terminal so that nix and home-manager are on your PATH.
Your configuration: $config. After changing it, apply it with
'$switch_cmd' (from a terminal in the nested desktop; new files need 'git add').
EOF
}

# --- cleanup ----------------------------------------------------------------
#
# One clean_<artifact> per artifact any version wrote outside the Nix store;
# how each is proven ours: docs/cleanup.md. Anything else is "left alone".

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
c_left()  { (( CLEAN_QUIET )) || c_line "left alone: $1"; }
c_defer() { CLEAN_DEFERRED+=("$1"); c_line "deferred: $1"; }

c_rm() { # path why
  c_do "remove $1 ($2)" || { CLEAN_GONE[$1]=1; return 0; }
  rm -f -- "$1" && CLEAN_GONE[$1]=1 && c_line "removed $1 ($2)"
}

# A link to <glob> is removed, any other link left alone.
c_rm_link() { # path glob why
  [[ -L $1 ]] || return 0
  local t; t="$(readlink "$1")"
  # shellcheck disable=SC2053  # $2 is a glob
  if [[ $t == $2 ]]; then c_rm "$1" "$3"; else c_left "$1 (link to $t)"; fi
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
  rmdir -- "$1" && CLEAN_GONE[$1]=1 && c_line "removed empty directory $1"
}

# Not fed through a pipe: a pipe's subshell would lose CLEAN_ACTIONS and the
# --quiet header state.
c_write() { # path why content: replace the contents (same inode and mode)
  c_do "rewrite $1 ($2)" || return 0
  printf '%s\n' "$3" >"$1"
  c_line "rewrote $1 ($2)"
}

# running | stopped | unknown
steamvr_state() {
  local s
  if s="$(user_systemctl show -p ActiveState --value steamvr.service 2>/dev/null)" && [[ -n $s ]]; then
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
    cur="$(jq -r '.VRWebHelper.DebuggerEnabled | if . == null then "absent" else tostring end' "$f")" || { echo "steam-frame-nix: can't read $f" >&2; return 1; }
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
# after Nix and Home Manager are gone. Best effort: called with `|| true`
# (no errexit inside).
debugger_ensure_hook() {
  if [[ $(cat "$DEBUGGER_RESTORE" 2>/dev/null) != "$(debugger_restore_script)" ]]; then
    if c_do "write the restore script $DEBUGGER_RESTORE"; then
      mkdir -p "$SFN_RUNTIME"
      debugger_restore_script >"$DEBUGGER_RESTORE"
      c_line "wrote the restore script $DEBUGGER_RESTORE"
    fi
  fi
  if [[ $(cat "$DEBUGGER_DROPIN" 2>/dev/null) != "$(debugger_dropin)" ]]; then
    if c_do "write the runtime drop-in $DEBUGGER_DROPIN"; then
      mkdir -p "${DEBUGGER_DROPIN%/*}"
      debugger_dropin >"$DEBUGGER_DROPIN"
      c_line "wrote the runtime drop-in $DEBUGGER_DROPIN"
      user_systemctl daemon-reload || warn "could not reload the user manager; the restore on SteamVR stop needs: systemctl --user daemon-reload"
    fi
  fi
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
  (( CLEAN_DRY )) || user_systemctl daemon-reload || true
  return 0
}

# Before each SteamVR start (the steamvr-webhelper-debugger oneshot of
# steamFrame.steamvrDebugger): remember the key's value in
# steamvr-debugger.armed, set it to true and make sure the runtime drop-in
# puts it back when SteamVR stops. A key that is already true (without
# .armed) is the user's own and never touched.
cmd_debugger_arm() {
  local cur tmp
  need_not_root
  command -v jq >/dev/null 2>&1 || die "jq not found"
  if [[ ! -f $DEBUGGER_ARMED ]]; then
    if [[ -f $VRSETTINGS ]]; then
      cur="$(jq -r 'if (.VRWebHelper | type) == "object" and (.VRWebHelper | has("DebuggerEnabled"))
                    then .VRWebHelper.DebuggerEnabled | tostring else "absent" end' "$VRSETTINGS")" \
        || die "can't read $VRSETTINGS"
    else
      cur=nofile
    fi
    case $cur in
      true) info "VRWebHelper.DebuggerEnabled is already true (not set by steam-frame-nix): left as is"; return 0 ;;
      false|absent|nofile) ;;
      *) warn "VRWebHelper.DebuggerEnabled is $cur; left as is"; return 0 ;;
    esac
    mkdir -p "$SFN_STATE"
    printf '%s\n' "$cur" >"$DEBUGGER_ARMED"
  fi
  if [[ ! -f $VRSETTINGS ]]; then
    mkdir -p "${VRSETTINGS%/*}"
    printf '{}\n' >"$VRSETTINGS"
  fi
  if [[ $(jq '.VRWebHelper.DebuggerEnabled' "$VRSETTINGS") != true ]]; then
    tmp="$(mktemp "$VRSETTINGS.XXXXXX")"
    jq --indent 3 '.VRWebHelper.DebuggerEnabled = true' "$VRSETTINGS" >"$tmp" || { rm -f "$tmp"; die "can't write $VRSETTINGS"; }
    chmod --reference="$VRSETTINGS" "$tmp"
    mv -f "$tmp" "$VRSETTINGS"
    info "VRWebHelper.DebuggerEnabled set to true until SteamVR stops (before: $(<"$DEBUGGER_ARMED"))"
  else
    info "VRWebHelper.DebuggerEnabled already true (set by steam-frame-nix)"
  fi
  debugger_ensure_hook || true
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
      c_line "migrated $DEBUGGER_MARKER_V1 to $DEBUGGER_ARMED (value before: absent)"
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
    if [[ $state == unknown ]] && ! user_manager_ok; then
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
  local l removed=0
  for l in "$ICON_DIR"/*.svg; do
    [[ -L $l ]] || continue
    # Home Manager's own links (to *-home-manager-files) are left as they are.
    if [[ $(readlink "$l") == /nix/store/*-breeze-icons-*/share/icons/breeze/apps/* ]]; then
      c_rm "$l" "icon fallback link to Breeze"; removed=1
    fi
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
      touch -- "${ICON_DIR%/*/*}"; c_line "touched ${ICON_DIR%/*/*} (mtime only, so Steam rescans icons)"
    fi
  fi
  return 0
}

# --- Firefox user.js ---

ff_keys() { sed -n 's/^[[:space:]]*user_pref(\("[^"]*"\),.*/\1/p' "$1" 2>/dev/null || true; }
# Not `find | grep -q`: find fails on other users' /proc/<pid>/fd, and with
# pipefail that would make every profile look unused.
ff_in_use() { [[ -n $(find /proc/[0-9]*/fd -lname "$1/.parentlock" -print -quit 2>/dev/null) ]]; }

clean_firefox() { # all
  local all=$1 prof name u t kind keys pats left rc
  [[ -d $FF_DIR ]] || return 0
  for prof in "$FF_DIR"/*/; do
    prof=${prof%/}; name=${prof##*/}; u=$prof/user.js
    [[ -e $u || -L $u ]] || continue
    keys=''
    if [[ -L $u ]]; then
      t="$(readlink "$u")"
      case $t in
        "$FF_DESKTOP_JS")
          # The wrapper's, while Firefox runs in the desktop profile.
          if ff_in_use "$prof"; then
            (( all )) && c_defer "$u: Firefox is using profile $name; close it and run this again"
            continue
          fi
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
      rc=0; left="$(grep -vF "$pats" "$prof/prefs.js")" || rc=$?
      if (( rc > 1 )); then warn "could not read $prof/prefs.js; left as is"; continue; fi
      c_write "$prof/prefs.js" "values of the $kind: ${keys//$'\n'/ }" "$left"
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
          c_write "$JF_OVERRIDE" "hwdec shim entries" "$out"
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

# --- launcher entries (tmpfs) ---

clean_launchers() {
  local d=$SFN_RUNTIME/applications f
  [[ -d $d && ! -L $d ]] || return 0
  while IFS= read -r -d '' f; do
    c_rm "$f" "generated launcher entry"
  done < <(find "$d" -mindepth 1 -maxdepth 1 -type f -print0)
  c_rmdir "$d"
}

# --- screenshots link (tmpfs) ---

clean_screenshots() { # keep
  (( $1 )) || c_rm_link "$SFN_RUNTIME/screenshots" '*/userdata/*/760/remote/250820/screenshots' \
    "link to the SteamVR screenshots"
}

# --- VR pet "+" menu icon link (tmpfs) ---

clean_pet() { # keep
  local d=$SFN_RUNTIME/vr-pet f
  (( $1 )) && return 0
  [[ -d $d && ! -L $d ]] || return 0
  c_rm_link "$d/icon.png" '/nix/store/*-vr-pet-icons/*.png' "link to the VR pet's \"+\" menu icon"
  while IFS= read -r -d '' f; do
    c_rm "$f" "the VR pet icon's lock or unfinished link"
  done < <(find "$d" -mindepth 1 -maxdepth 1 \( -name .lock -type f -empty -o -name '.icon.tmp.*' -type l \) -print0)
  c_rmdir "$d"
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
  local mode='' all=0 keep_debugger=0 keep_screenshots=0 keep_pet=0 keeps=0 k
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
          screenshots) keep_screenshots=1 ;;
          pet) keep_pet=1 ;;
          *) die "cleanup: unknown artifact '$k' for --keep (debugger, screenshots, pet)" ;;
        esac ;;
      -h|--help) usage; exit 0 ;;
      *) die "cleanup: unknown option '$1' (see --help)" ;;
    esac
  done
  [[ -n $mode ]] || die "cleanup: --all or --orphans is required (see --help)"
  [[ $mode == all && $keeps -gt 0 ]] && die "cleanup: --keep only goes with --orphans"
  need_not_root
  [[ $mode == all ]] && all=1

  CLEAN_ACTIONS=0; CLEAN_DEFERRED=(); CLEAN_GONE=()
  CLEAN_HEADER="steam-frame-nix: cleaning up files outside Nix ($mode"
  if (( CLEAN_DRY )); then CLEAN_HEADER+=", dry run)"; else CLEAN_HEADER+=")"; fi
  if (( ! CLEAN_QUIET )); then step "$CLEAN_HEADER"; CLEAN_HEADER=''; fi
  clean_debugger "$keep_debugger"
  clean_icons
  clean_firefox "$all"
  clean_jellyfin
  clean_ui_state "$all"
  c_rmdir "$SFN_STATE"
  clean_screenshots "$keep_screenshots"
  clean_pet "$keep_pet"
  (( all )) && clean_launchers
  c_rmdir "$SFN_RUNTIME"
  (( CLEAN_ACTIONS || ${#CLEAN_DEFERRED[@]} || CLEAN_QUIET )) || info "nothing to clean up"
  return 0
}

# --- what waits for a restart -------------------------------------------------
#
# Read only at a process start, compared with the running session: the
# keyboard layout (gamescope) and SteamVR's DevTools port (the dashboard
# patches need it). See docs/cleanup.md.

SFN_CGROUP="${STEAM_FRAME_NIX_CGROUP:-/sys/fs/cgroup}"
LAYOUT_DROPIN="$USER_UNIT_DIR/gamescope-session.service.d/keyboard.conf"
DEBUGGER_HM_DROPIN="$USER_UNIT_DIR/steamvr.service.d/webhelper-debugger.conf"
DEBUGGER_PORT=8087

# Value of Environment=<name>=... in a unit file (empty if unset).
unit_env() { # file name
  sed -n "s/^Environment=$2=//p" "$1" 2>/dev/null | tail -n1
}

# XKB_DEFAULT_<what> of the running gamescope session: from the first
# process of gamescope-session.service whose environment is readable
# (gamescope itself isn't: it has capabilities). Fails if unknown.
session_xkb() { # LAYOUT|VARIANT
  local cg pid env found=1
  [[ $(user_systemctl show -p ActiveState --value gamescope-session.service 2>/dev/null) == active ]] || return 1
  cg="$(user_systemctl show -p ControlGroup --value gamescope-session.service 2>/dev/null)" && [[ -n $cg ]] || return 1
  [[ -r $SFN_CGROUP$cg/cgroup.procs ]] || return 1
  while read -r pid; do
    env="$( { tr '\0' '\n' <"$SFN_PROC/$pid/environ"; } 2>/dev/null)" || continue
    [[ -n $env ]] || continue
    sed -n "s/^XKB_DEFAULT_$1=//p" <<<"$env" | tail -n1
    found=0
    break
  done <"$SFN_CGROUP$cg/cgroup.procs"
  return $found
}

# Whether something listens on 127.0.0.1/::1/any :<port> (/proc/net/tcp*).
port_listening() { # port
  local hex f files=()
  printf -v hex '%04X' "$1"
  for f in "$SFN_PROC/net/tcp" "$SFN_PROC/net/tcp6"; do [[ -r $f ]] && files+=("$f"); done
  (( ${#files[@]} )) || return 1
  awk -v p=":$hex" 'FNR > 1 && $4 == "0A" && substr($2, length($2) - 4) == p { f = 1 } END { exit !f }' "${files[@]}"
}

# One line per setting that waits for a restart.
restart_pending() {
  local want_l want_v run_l run_v
  if [[ -e $LAYOUT_DROPIN ]]; then
    want_l="$(unit_env "$LAYOUT_DROPIN" XKB_DEFAULT_LAYOUT)"
    want_v="$(unit_env "$LAYOUT_DROPIN" XKB_DEFAULT_VARIANT)"
    if run_l="$(session_xkb LAYOUT)" && run_v="$(session_xkb VARIANT)" \
       && [[ $run_l != "$want_l" || $run_v != "$want_v" ]]; then
      echo "keyboard layout ${want_l:-us}${want_v:+ ($want_v)} (the running Steam session has ${run_l:-us}${run_v:+ ($run_v)}): from the next start of the Steam session"
    fi
  fi
  if [[ -e $DEBUGGER_HM_DROPIN && $(steamvr_state) == running ]] && ! port_listening "$DEBUGGER_PORT"; then
    echo "SteamVR dashboard patches (e.g. the VR pet, the VR keyboard's suggestion strip; DevTools port $DEBUGGER_PORT not open yet): from the next SteamVR start"
  fi
  return 0
}

cmd_restart_check() {
  local pending=()
  need_not_root
  mapfile -t pending < <(restart_pending)
  (( ${#pending[@]} )) || return 0
  warn "steam-frame-nix: some settings take effect only after a restart (reboot once, or restart the Steam session):"
  printf '  - %s\n' "${pending[@]}" >&2
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
  if ! user_manager_ok; then
    warn "user manager not reachable at $OUTER_RUNTIME_DIR; not stopping: ${units[*]}"
    return 0
  fi
  info "${units[*]}"
  user_systemctl stop -- "${units[@]}" || warn "some units failed to stop"
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

  user_systemctl daemon-reload || true
  user_systemctl reset-failed >/dev/null 2>&1 || true
}

# --- programs from the Nix store ---
#
# Listed before Nix goes, for information (uninstall_nix detaches /nix
# lazily). See docs/cleanup.md.

proc_ppid() { # pid
  local k v
  { while read -r k v; do [[ $k == PPid: ]] && { echo "$v"; return 0; }; done <"$SFN_PROC/$1/status"; } 2>/dev/null
  return 0
}

proc_pgid() { # pid
  local s
  { read -r s <"$SFN_PROC/$1/stat"; } 2>/dev/null || return 0
  s=${s##*) }               # after "pid (comm) "; comm may contain spaces
  read -r _ _ s _ <<<"$s"   # state ppid pgrp
  echo "$s"
}

# "<name> (PID <pid>)" per process using /nix.
nix_users() {
  local p pid name argv0 self=$$ pgid
  pgid="$(proc_pgid "$self")"
  { find "$SFN_PROC"/[0-9]*/{exe,cwd,root} "$SFN_PROC"/[0-9]*/fd -maxdepth 1 -lname '/nix/*' 2>/dev/null || true
    grep -ls '[[:space:]]/nix/' "$SFN_PROC"/[0-9]*/maps || true
  } | while IFS= read -r p; do p=${p#"$SFN_PROC"/}; echo "${p%%/*}"; done | sort -un \
    | while read -r pid; do
      [[ $pid != "$self" ]] || continue
      { read -r name <"$SFN_PROC/$pid/comm"; } 2>/dev/null || continue   # exited
      # argv[0]'s name says more than comm (often a thread name)
      argv0=''; { IFS= read -r -d '' argv0 <"$SFN_PROC/$pid/cmdline"; } 2>/dev/null || true
      [[ ${argv0##*/} == '' || ${argv0##*/} == exe ]] || name=${argv0##*/}
      [[ -n $pgid && $(proc_pgid "$pid") == "$pgid" ]] && continue      # our pipeline
      p=$pid
      while [[ $p =~ ^[0-9]+$ && $p != "$self" ]] && (( p > 1 )); do p="$(proc_ppid "$p")"; done
      [[ $p == "$self" ]] && continue                                    # our subshells
      echo "$name (PID $pid)"
    done
}

remove_path() {
  if [[ -e $1 || -L $1 ]]; then rm -rf -- "$1"; info "removed $1"; fi
}

# Files Home Manager renamed out of its way (hm_activate's -b); kept.
hm_backups() {
  { find "$HOME" -maxdepth 4 \( -path "$HOME/.cache" -o -path "$HOME/.var" -o -path "$HOME/.steam" \
      -o -path "$HOME/.local/share/Steam" -o -path "$HOME/.local/share/docker" \) -prune \
      -o -name '*.hm-backup-*' -print 2>/dev/null || true; } | LC_ALL=C sort
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
  local keep_nix=0
  while (( $# )); do
    case $1 in
      -y|--yes) ASSUME_YES=1; shift ;;
      --keep-nix) keep_nix=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "uninstall: unknown option '$1' (see --help)" ;;
    esac
  done
  need_not_root

  if (( keep_nix )); then
    step "This uninstalls Home Manager (its files and services); Nix stays"
  else
    step "This uninstalls Home Manager (its files and services) and Nix (/nix, /home/nix)"
  fi
  confirm "Continue?" || die "aborted"

  # The configuration, for the closing message (its link goes).
  local cfg=$DEFAULT_CONFIG_DIR again=install f backups=()
  if [[ -L $HM_CONFIG_LINK ]]; then cfg="$(readlink -f "$HM_CONFIG_LINK" || true)"
  elif [[ -d $HM_CONFIG_LINK ]]; then cfg=$HM_CONFIG_LINK; fi

  load_nix
  stop_hm_services
  cmd_cleanup --all
  remove_hm
  hash -r   # commands found in Home Manager's profile are gone

  # A failed Nix uninstall must not skip the rest: Home Manager is gone by
  # now, so its config link goes regardless; the per-user Nix files stay
  # for the Nix that is still there.
  local nix_failed=0
  if (( ! keep_nix )); then
    if [[ -x $NIX_INSTALLER_BIN ]]; then
      if ! uninstall_nix; then
        warn "the Nix uninstall failed (see above)"
        nix_failed=1 keep_nix=1
      fi
    elif command -v nix >/dev/null 2>&1; then
      warn "Nix wasn't installed by nix-installer ($NIX_INSTALLER_BIN missing); not removing it"
      keep_nix=1
    else
      info "Nix is not installed"
    fi
  fi

  remove_leftovers "$keep_nix"

  step "Done"
  echo
  if [[ -n $cfg && -e $cfg/flake.nix ]]; then
    [[ $cfg -ef $DEFAULT_CONFIG_DIR || $cfg -ef $HM_CONFIG_LINK ]] || again="install --flake $(tilde "$cfg")"
    echo "Your configuration stays in $(tilde "$cfg") ($again uses it again)."
  fi
  mapfile -t backups < <(hm_backups)
  if (( ${#backups[@]} )); then
    echo "Home Manager kept these files it had renamed when it was installed:"
    for f in "${backups[@]}"; do printf '  - %s\n' "$(tilde "$f")"; done
  fi
  echo "Log out or reboot: programs that were started from Nix restart without it."
  if (( ${#CLEAN_DEFERRED[@]} || nix_failed )); then
    printf '\nNot done yet:\n'
    (( ${#CLEAN_DEFERRED[@]} )) && printf '  - %s\n' "${CLEAN_DEFERRED[@]}"
    (( nix_failed )) && printf '%s\n' \
      "  - Nix: its uninstaller failed. Reboot, then run uninstall again;" \
      "    it also removes ~/.nix-profile and ~/.local/state/nix."
  fi
  (( ! nix_failed ))
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
    info "installer:  nix-installer, planner $(jq -r '.planner.planner // "?"' "$NIX_RECEIPT" 2>/dev/null || echo '?')"
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
  elif user_manager_ok; then
    for unit in "${units[@]}"; do
      info "$(printf '%-30s %s' "$unit" "$(user_systemctl is-active "$unit" 2>/dev/null || true)")"
    done
  else
    info "user manager not reachable at $OUTER_RUNTIME_DIR"
  fi
  # steamFrame.clipboardSync (off by default): its autostart link or a process
  if pgrep -u "$USER_ID" -x clipboard-sync >/dev/null; then
    info "$(printf '%-30s %s' clipboard-sync running)"
  elif [[ -e $CONFIG_HOME/autostart/clipboard-sync.desktop ]]; then
    info "$(printf '%-30s %s' clipboard-sync 'not running')"
  fi

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
    steamvr-debugger-arm) cmd_debugger_arm "$@" ;;
    restart-check) cmd_restart_check "$@" ;;
    -h|--help|help) usage ;;
    '') usage >&2; exit 2 ;;
    *) printf 'unknown command: %s\n\n' "$cmd" >&2; usage >&2; exit 2 ;;
  esac
}

# Run unless sourced (piped into bash counts as run).
(return 0 2>/dev/null) || main "$@"
