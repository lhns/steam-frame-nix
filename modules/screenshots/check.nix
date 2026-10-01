# Checks of steam-frame-nix-screenshots (link.sh) on fake Steam and runtime
# dirs: account from loginusers.vdf (MostRecent, else latest timestamp),
# else the only userdata folder, else no link (an old one removed); an
# unchanged target isn't rewritten; no outer runtime dir is a no-op.
{ pkgs }:
let
  script = import ./package.nix {
    inherit (pkgs) lib; inherit pkgs;
    runtimeDir = "/nonexistent"; steam = "/nonexistent";
  };
in
pkgs.runCommand "screenshots-check" { nativeBuildInputs = [ script ]; } ''
  set -euo pipefail
  fail() { echo "FAIL: $*" >&2; exit 1; }
  export STEAM_FRAME_NIX_RUNTIME_DIR=$PWD/run STEAM_FRAME_NIX_STEAM_DIR=$PWD/steam
  S=$STEAM_FRAME_NIX_STEAM_DIR L=$STEAM_FRAME_NIX_RUNTIME_DIR/steam-frame-nix/screenshots
  target() { echo "$S/userdata/$1/760/remote/250820/screenshots"; }
  expect() { [ "$(readlink $L)" = "$(target $1)" ] || fail "$2: $(readlink $L || echo no link)"; }

  steam-frame-nix-screenshots 2>&1 | grep -q "doesn't exist" || fail "no runtime dir"
  [ ! -e run ] || fail "runtime dir created"
  mkdir -p run $S/config $S/userdata/0 $S/userdata/12345678

  # the only account folder ("0" is not an account)
  steam-frame-nix-screenshots; expect 12345678 "userdata"

  # MostRecent wins over a later timestamp
  cat > $S/config/loginusers.vdf <<'VDF'
"users"
{
	"76561197972611406"
	{
		"AccountName"		"a"
		"MostRecent"		"1"
		"timestamp"		"100"
	}
	"76561197960265729"
	{
		"AccountName"		"b"
		"MostRecent"		"0"
		"timestamp"		"200"
	}
}
VDF
  steam-frame-nix-screenshots; expect 12345678 "MostRecent"
  # unchanged: not rewritten
  res=$(steam-frame-nix-screenshots 2>&1); [ -z "$res" ] || fail "rewrote: $res"

  # no MostRecent (current Steam): latest timestamp
  sed -i '/MostRecent/d' $S/config/loginusers.vdf
  steam-frame-nix-screenshots; expect 1 "timestamp"

  # nothing to go by: link removed
  rm $S/config/loginusers.vdf; mkdir $S/userdata/42
  steam-frame-nix-screenshots 2>&1 | grep -q "no Steam account" || fail "no warning"
  [ ! -L $L ] || fail "link kept"
  touch $out
''
