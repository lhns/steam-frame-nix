# shellcheck shell=bash
# Hicolor fallbacks for desktop entry icons that only Breeze has.
#
# Usage: steam-frame-icon-fallbacks [EXTRA_NAME...]
#   BREEZE_APPS=<breeze-icons>/share/icons/breeze/apps: link the Icon= names
#     of the desktop entries Steam sees (plus EXTRA_NAMEs) that no hicolor
#     theme dir has but Breeze does, as
#     $XDG_DATA_HOME/icons/hicolor/scalable/apps/<name>.svg -> Breeze's SVG.
#   BREEZE_APPS unset: remove all links made before (disabled).
# Links made are listed in a manifest; only those, and only while they still
# point into a breeze-icons store path, are ever removed. Nothing else in the
# icon dir is touched.

data_home=${XDG_DATA_HOME:-$HOME/.local/share}
dest=$data_home/icons/hicolor/scalable/apps
manifest=${XDG_STATE_HOME:-$HOME/.local/state}/steam-frame-nix/icon-fallbacks
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

ours() { [[ -L $1 && $(readlink "$1") == /nix/store/*-breeze-icons-*/* ]]; }

# Does Steam already find <name> (hicolor in any data dir, or pixmaps)?
# Our own links don't count.
resolves() {
  local d f
  for d in "$HOME/.icons" "${data_dirs[@]/%//icons}"; do
    for f in "$d"/hicolor/*/*/"$1".{png,svg,xpm}; do
      ours "$f" || return 0
    done
  done
  for d in "${data_dirs[@]}"; do
    for f in "$d"/pixmaps/"$1".{png,svg,xpm}; do [[ ! -e $f ]] || return 0; done
  done
  return 1
}

# Largest Breeze app icon for <name> (Breeze's app icons are all SVG).
breeze() {
  local size
  for size in 64 48 32 24 22 16; do
    if [[ -e $BREEZE_APPS/$size/$1.svg ]]; then echo "$BREEZE_APPS/$size/$1.svg"; return; fi
  done
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

# Wanted: extra names, and the icons of the entries Steam sees (the first
# entry with a given desktop-file ID wins, like in the menu).
declare -A wanted=() seen=()
if [[ -n ${BREEZE_APPS:-} ]]; then
  for name in "$@"; do wanted[$name]=extra; done
  for d in "${data_dirs[@]}"; do
    [[ -d $d/applications ]] || continue
    while IFS= read -r -d '' f; do
      id=${f#"$d/applications/"}; id=${id//\//-}
      [[ -z ${seen[$id]:-} ]] || continue
      seen[$id]=1
      icon=$(entry_icon "$f")
      [[ -z $icon ]] || wanted[$icon]=${wanted[$icon]:-$id}
    done < <(find -L "$d/applications" -name '*.desktop' -print0 2>/dev/null)
  done
fi

changed=
linked=()
for name in "${!wanted[@]}"; do
  resolves "$name" && continue
  if ! src=$(breeze "$name"); then
    [[ ${wanted[$name]} != extra ]] || echo "icon fallbacks: Breeze has no app icon \"$name\" (extra)" >&2
    continue
  fi
  link=$dest/$name.svg
  if [[ -e $link || -L $link ]] && ! ours "$link"; then continue; fi   # not ours
  linked+=("$name")
  [[ $(readlink "$link") == "$src" ]] && continue
  mkdir -p "$dest"
  ln -sfn "$src" "$link"
  echo "icon fallbacks: linked $name (${wanted[$name]})"
  changed=1
done

# Remove links from earlier runs that are no longer wanted.
if [[ -f $manifest ]]; then
  while IFS= read -r name; do
    [[ -n $name && " ${linked[*]} " != *" $name "* ]] || continue
    if ours "$dest/$name.svg"; then
      rm -f "$dest/$name.svg"
      echo "icon fallbacks: removed $name"
      changed=1
    fi
  done < "$manifest"
fi

if (( ${#linked[@]} )); then
  mkdir -p "${manifest%/*}"
  printf '%s\n' "${linked[@]}" | sort > "$manifest"
else
  rm -f "$manifest"
fi

# GTK rescans an icon theme only when a theme dir's mtime changes; bump it
# so a running Steam sees the change.
if [[ -n $changed && -d $data_home/icons/hicolor ]]; then touch "$data_home/icons/hicolor"; fi
