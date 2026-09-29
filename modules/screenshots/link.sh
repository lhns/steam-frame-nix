# steam-frame-nix-screenshots (the module prepends runtime, steam): points
# <runtime>/steam-frame-nix/screenshots (tmpfs), where ~/Pictures/<name>
# links, to the SteamVR screenshot folder of the Steam account last logged
# in:
# 1. the user marked MostRecent "1" in config/loginusers.vdf, else the one
#    with the latest "timestamp" (SteamID64 - 76561197960265728 = account
#    ID, the folder in userdata);
# 2. else the only account folder in userdata;
# 3. else no link (warning).
# The link is replaced atomically and only when its target changes.
link=$runtime/steam-frame-nix/screenshots
log() { echo "steam-frame-nix-screenshots: $*" >&2; }

if [[ ! -d $runtime ]]; then
  log "$runtime doesn't exist (outer session not running?); skipped"
  exit 0
fi

id=''
if [[ -f $steam/config/loginusers.vdf ]]; then
  id64=$(awk '
    { gsub(/"/, " ") }
    $1 == "{" { depth++; next }
    $1 == "}" { depth--; next }
    depth == 1 && $1 ~ /^[0-9]+$/ && NF == 1 { user = $1; next }
    depth == 2 && tolower($1) == "mostrecent" && $2 == "1" { recent = user }
    depth == 2 && tolower($1) == "timestamp" && $2 + 0 > best { best = $2 + 0; latest = user }
    END { print recent != "" ? recent : latest }
  ' "$steam/config/loginusers.vdf")
  if [[ $id64 =~ ^[0-9]{17}$ ]] && (( id64 > 76561197960265728 )); then
    id=$(( id64 - 76561197960265728 ))
  fi
fi
if [[ -z $id ]]; then
  dirs=()
  for d in "$steam"/userdata/*/; do
    d=${d%/}; d=${d##*/}
    [[ $d =~ ^[1-9][0-9]*$ ]] && dirs+=("$d")
  done
  (( ${#dirs[@]} == 1 )) && id=${dirs[0]}
fi

if [[ -z $id ]]; then
  log "no Steam account found in $steam (log in to Steam, or set steamFrame.screenshots.steamUserId); no link"
  [[ -L $link ]] && rm -f "$link"
  exit 0
fi

target=$steam/userdata/$id/760/remote/250820/screenshots
[[ -L $link && $(readlink "$link") == "$target" ]] && exit 0
mkdir -p "${link%/*}"
ln -sfn "$target" "$link.tmp.$$"
mv -fT "$link.tmp.$$" "$link"
log "$link -> $target"
