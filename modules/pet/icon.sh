# steam-frame-nix-pet-icon (package.nix prepends runtime, state, icons, hicolor): points
# <runtime>/steam-frame-nix/vr-pet/icon.png (tmpfs), where the "+" menu entry's icon
# (hicolor/256x256/apps/vr-pet.png) links, to icons/<model>.png of the pet's
# current model: the "model" of the patch's state file, else (no file, no
# model, a model without an icon, e.g. a removed one) icons/default.txt's.
# The link is replaced atomically (temp link + rename, under a lock) and only
# when its target changes; then hicolor's mtime is bumped, so a running Steam
# rescans its icons (GTK rereads a theme only when its directory changed).
dir=$runtime/steam-frame-nix/vr-pet
link=$dir/icon.png
log() { echo "steam-frame-nix-pet-icon: $*" >&2; }

if [[ ! -d $runtime ]]; then
  log "$runtime doesn't exist (outer session not running?); skipped"
  exit 0
fi

default=$(<"$icons/default.txt")
model=''
if [[ -f $state ]]; then
  model=$(jq -r '.model? // empty | strings' "$state" 2>/dev/null) || model=''
fi
if [[ -z $model ]]; then
  model=$default
elif [[ ! $model =~ ^[A-Za-z0-9_-]+$ || ! -f $icons/$model.png ]]; then
  log "no icon for model ${model@Q}; using the default's ($default)"
  model=$default
fi
target=$icons/$model.png

mkdir -p "$dir"
exec 9>"$dir/.lock"
flock 9
[[ -L $link && $(readlink "$link") == "$target" ]] && exit 0
rm -f "$dir"/.icon.tmp.*
ln -sfn "$target" "$dir/.icon.tmp.$$"
mv -fT "$dir/.icon.tmp.$$" "$link"
log "$model: $link -> $target"
if [[ -d $hicolor ]]; then touch "$hicolor"; fi
