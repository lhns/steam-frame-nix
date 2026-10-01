# steam-frame-nix-pet-icon (icon.sh) on a fake runtime dir, state file, icons and hicolor:
# no runtime dir is a no-op; the state's model is linked, else the default
# (no file, no "model", a model without an icon, invalid JSON); an unchanged
# target is neither rewritten nor bumps hicolor; a changed one does.
set -euo pipefail
fail() { echo "FAIL: $*" >&2; exit 1; }
cd "$(mktemp -d)"
mkdir icons hicolor
touch icons/ginger.png icons/shiba.png icons/fox.png
echo ginger > icons/default.txt
export VR_PET_RUNTIME_DIR=$PWD/run VR_PET_STATE=$PWD/state/vr-pet.json VR_PET_ICONS=$PWD/icons VR_PET_HICOLOR=$PWD/hicolor
L=$VR_PET_RUNTIME_DIR/steam-frame-nix/vr-pet/icon.png
old() { touch -d '2000-01-01' hicolor; }
bumped() { [ "$(stat -c %Y hicolor)" -gt 946684800 ]; }
expect() { [ "$(readlink "$L")" = "$PWD/icons/$1.png" ] || fail "$2: $(readlink "$L" || echo no link)"; echo "ok  $2"; }

out=$(steam-frame-nix-pet-icon 2>&1); [[ $out == *"doesn't exist"* ]] || fail "no runtime dir: $out"
[ ! -e run ] || fail "runtime dir created"
echo "ok  no runtime dir: skipped"
mkdir run state

old; steam-frame-nix-pet-icon 2>/dev/null; expect ginger "no state file: the default"
bumped || fail "first link: hicolor not bumped"; echo "ok  first link bumps hicolor"

echo '{"x":1,"hidden":true,"model":"shiba"}' > state/vr-pet.json
old; steam-frame-nix-pet-icon 2>/dev/null; expect shiba "the state's model"
bumped || fail "change: hicolor not bumped"; echo "ok  change bumps hicolor"

echo '{"x":2,"hidden":false,"model":"shiba"}' > state/vr-pet.json
old; out=$(steam-frame-nix-pet-icon 2>&1); [ -z "$out" ] || fail "unchanged: $out"
expect shiba "unchanged model"
! bumped || fail "unchanged: hicolor bumped"; echo "ok  unchanged: no rewrite, no bump"

echo '{"model":"fox"}' > state/vr-pet.json; steam-frame-nix-pet-icon 2>/dev/null; expect fox "switch to another model"
echo '{"model":"unicorn"}' > state/vr-pet.json
out=$(steam-frame-nix-pet-icon 2>&1); [[ $out == *"no icon for model 'unicorn'"* ]] || fail "unknown model: no warning: $out"; expect ginger "unknown model: the default"
echo '{"model":"fox"}' > state/vr-pet.json; steam-frame-nix-pet-icon 2>/dev/null
echo '{"x":1}' > state/vr-pet.json; steam-frame-nix-pet-icon 2>/dev/null; expect ginger "no model in the state: the default"
echo '{"model":"../fox"}' > state/vr-pet.json; steam-frame-nix-pet-icon 2>/dev/null; expect ginger "a model that isn't an id: the default"
echo '{"model":"fox"}' > state/vr-pet.json; steam-frame-nix-pet-icon 2>/dev/null
echo '{"model":' > state/vr-pet.json; steam-frame-nix-pet-icon 2>/dev/null; expect ginger "invalid JSON: the default"
echo '[1]' > state/vr-pet.json; steam-frame-nix-pet-icon 2>/dev/null; expect ginger "not an object: the default"
rm -rf hicolor; echo '{"model":"fox"}' > state/vr-pet.json; steam-frame-nix-pet-icon 2>/dev/null; expect fox "no hicolor dir: still linked"
[ ! -e hicolor ] || fail "hicolor created"
ls -A run/steam-frame-nix/vr-pet | grep -q tmp && fail "temp link left"
echo "ok  no temp links left"
