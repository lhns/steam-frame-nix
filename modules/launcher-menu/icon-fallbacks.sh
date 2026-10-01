# shellcheck shell=bash
# Hints for launcherMenu.iconFallbacks; read-only.
# Usage: BREEZE_APPS=<breeze-icons>/share/icons/breeze/apps \
#          steam-frame-icon-fallbacks --suggest [CONFIGURED_NAME...]
# Prints
# - Icon= names of the desktop entries Steam sees that no hicolor dir (nor
#   pixmaps) has but Breeze does, and that aren't configured: candidates for
#   iconFallbacks.extra;
# - configured names that hicolor has anyway (apart from our links): no
#   longer needed.

[[ ${1:-} == --suggest ]] || { echo "usage: steam-frame-icon-fallbacks --suggest [NAME...]" >&2; exit 2; }
shift
: "${BREEZE_APPS:?BREEZE_APPS is not set}"

data_home=${XDG_DATA_HOME:-$HOME/.local/share}
# Steam's data dirs (XDG_DATA_HOME, then its XDG_DATA_DIRS on SteamOS), not
# the caller's: switches usually run from the nested desktop session.
data_dirs=(
  "$data_home"
  "$HOME/.local/share/flatpak/exports/share"
  /var/lib/flatpak/exports/share
  /usr/local/share
  /usr/share
  "$HOME/.nix-profile/share"
  /nix/var/nix/profiles/default/share
)
shopt -s nullglob

# Our fallbacks: links that end up in a Breeze store path.
ours() { [[ -L $1 && $(readlink -f "$1") == /nix/store/*-breeze-icons-*/* ]]; }

# Where Steam finds <name> (hicolor in any data dir, or pixmaps), ours aside.
resolves() {
  local d f
  for d in "$HOME/.icons" "${data_dirs[@]/%//icons}"; do
    for f in "$d"/hicolor/*/*/"$1".{png,svg,xpm}; do
      ours "$f" || { echo "$f"; return 0; }
    done
  done
  for d in "${data_dirs[@]}"; do
    for f in "$d"/pixmaps/"$1".{png,svg,xpm}; do [[ ! -e $f ]] || { echo "$f"; return 0; }; done
  done
  return 1
}

in_breeze() {
  local size
  for size in 64 48 32 24 22 16; do [[ -e $BREEZE_APPS/$size/$1.svg ]] && return 0; done
  return 1
}

# Icon= of a desktop entry, unless it is Hidden/NoDisplay or not a plain icon
# name (e.g. an absolute path).
entry_icon() {
  awk -F= '
    /^\[/ { group = ($0 ~ /^\[Desktop Entry\][[:space:]]*$/); next }
    !group { next }
    { key = $1; sub(/[[:space:]]+$/, "", key); val = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]\r]+$/, "", val) }
    (key == "Hidden" || key == "NoDisplay") && val == "true" { skip = 1 }
    key == "Icon" { icon = val }
    END { if (!skip && icon ~ /^[A-Za-z0-9._+-]+$/) print icon }
  ' "$1"
}

declare -A configured=() seen=() missing=()
for name in "$@"; do configured[$name]=1; done

# The entries Steam sees (the first with a given desktop-file ID wins, like
# in the menu).
for d in "${data_dirs[@]}"; do
  [[ -d $d/applications ]] || continue
  while IFS= read -r -d '' f; do
    id=${f#"$d/applications/"}; id=${id//\//-}
    [[ -z ${seen[$id]:-} ]] || continue
    seen[$id]=1
    # Unreadable, e.g. a launcher's link while its app isn't installed.
    icon=$(entry_icon "$f" 2>/dev/null) || continue
    [[ -n $icon && -z ${configured[$icon]:-} && -z ${missing[$icon]:-} ]] || continue
    if ! resolves "$icon" >/dev/null && in_breeze "$icon"; then missing[$icon]=${id%.desktop}; fi
  done < <(find -L "$d/applications" -name '*.desktop' -print0 2>/dev/null)
done

for icon in "${!missing[@]}"; do
  echo "icon fallbacks: \"$icon\" (${missing[$icon]}) shows without icon in Steam's \"+\" menu; Breeze has it: add it to steamFrame.launcherMenu.iconFallbacks.extra"
done
for name in "${!configured[@]}"; do
  if f=$(resolves "$name"); then
    echo "icon fallbacks: \"$name\" is in hicolor anyway ($f); the fallback is no longer needed"
  fi
done
exit 0
