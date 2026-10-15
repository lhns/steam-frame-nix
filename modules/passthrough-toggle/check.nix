# Checks of the passthrough toggle (flake check `passthrough-toggle`):
# - steam-frame-nix-passthrough's ELF (NEEDED libc/libgcc_s/ld only, no
#   rpath, the system's own interpreter, GLIBC symbols at most 2.34);
# - every exit path of src/main.rs against tests/fake-vrclient.rs (a
#   stand-in vrclient.so, driven by VR_PATHREG_OVERRIDE, built here without
#   the interpreter patch so it runs in the sandbox) and Arcturus detection
#   against a fake sysfs/dev tree with tests/fake-ioctl.rs;
# - Rust unit tests of main.rs's pure helpers (`rustc --test`, no cargo);
# - request.mjs (relay.mjs's allowlist/args/parsing/queue;
#   tests/request.test.mjs) -- relay.mjs's own CDP session isn't unit
#   tested (same as steam-ui-patches/injector.mjs); verified live against
#   Steam's real DevTools during deployment instead (docs/passthrough-toggle.md);
# - patch.js in a fake SharedJSContext page built with the real
#   finders.js (tests/patch.test.mjs).
{ pkgs }:
let
  helper = pkgs.callPackage ./package.nix { };
in
pkgs.runCommandCC "passthrough-toggle-check" { nativeBuildInputs = [ pkgs.binutils pkgs.nodejs pkgs.rustc ]; } ''
  set -euo pipefail
  fail() { echo "FAIL: $*" >&2; exit 1; }
  has() { echo "$res" | grep -q -- "$1" || fail "$2: $res"; }
  PKG=${helper}/bin/steam-frame-nix-passthrough

  needed=$(readelf -dW "$PKG" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p')
  for lib in $needed; do case $lib in libc.so.6|libgcc_s.so.1|ld-linux*) ;; *) fail "needs $lib" ;; esac; done
  ! readelf -dW "$PKG" | grep -Eq '\((RPATH|RUNPATH)\)' || fail "has an rpath"
  interp=$(readelf -lW "$PKG" | sed -n 's/.*Requesting program interpreter: \(.*\)\]/\1/p')
  [ "$interp" = /lib/ld-linux-aarch64.so.1 ] || fail "interpreter: $interp"
  for v in $(objdump -T "$PKG" | grep -o 'GLIBC_[0-9.]*' | sort -u); do
    [ "$(printf '%s\n%s\n' "$v" GLIBC_2.34 | sort -V | tail -1)" = GLIBC_2.34 ] || fail "needs $v"
  done
  echo "ELF ok: NEEDED $needed, interpreter $interp"

  # Same main.rs, built plain (runnable in the sandbox; $PKG itself can't
  # be, since its patched interpreter points outside the store) against a
  # fake vrclient.so and a fake sysfs/dev tree.
  BIN=$PWD/steam-frame-nix-passthrough-test
  mkdir -p fakesys fakedev
  V4L_DIR="$PWD/fakesys" DEV_DIR="$PWD/fakedev" rustc --edition 2021 -O -C panic=abort -C linker="$CC" -o "$BIN" ${./src/main.rs}
  rustc --edition 2021 -O -C panic=abort -C linker="$CC" --crate-type cdylib -o fake-ioctl.so ${./tests/fake-ioctl.rs}
  rustc --edition 2021 -O -C panic=abort -C linker="$CC" --crate-type cdylib -o fake-vrclient.so ${./tests/fake-vrclient.rs}
  mkdir -p fakeruntime/bin/linuxarm64 && cp fake-vrclient.so fakeruntime/bin/linuxarm64/vrclient.so
  printf '{"runtime":["%s"]}' "$PWD/fakeruntime" > fakevrpath.json
  export VR_PATHREG_OVERRIDE=$PWD/fakevrpath.json

  run() { local want=$1; shift; local rc=0; res=$("$@") || rc=$?; [ "$rc" = "$want" ] || fail "$* exited $rc, wanted $want: $res"; echo "$res"; }

  res=$(FAKE_BYTES=1,0,0,0,0 run 0 "$BIN" status)
  has '"ok":true' status; has '"source":"mono"' "status source"; has '"changed":false' "status changed"

  # set rgb while enabled: changes, byte 2 only
  res=$(FAKE_BYTES=1,1,0,1,1 run 0 "$BIN" set rgb)
  has '"rgbSource":1' "set rgb"; has '"stereo":1' "set rgb touched stereo"
  has '"disableDevignetting":1' "set rgb touched other bytes"; has '"changed":true' "set rgb changed"

  res=$(FAKE_BYTES=1,0,0,0,0 run 0 "$BIN" set mono); has '"changed":false' "set mono unchanged"

  # camera subsystem not enabled: no write attempted, still exit 0
  res=$(FAKE_BYTES=0,0,0,0,0 run 0 "$BIN" set rgb); has '"enabled":0' disabled; has '"changed":false' "disabled changed"

  # Arcturus: no sensor nodes -> false; the Frame's nodes are v4l-subdevN
  # (not videoN), the fake /dev file's "0"/"1" is disconnected/connected.
  res=$(FAKE_BYTES=1,1,0,0,0 run 0 "$BIN" status); has '"arcturus":false' "arcturus without nodes"
  v4lnode() { mkdir -p fakesys/$1; echo "$2" > fakesys/$1/name; echo "$3" > fakedev/$1; }
  v4lnode video0 "other-sensor 1-0010" 1
  v4lnode v4l-subdev28 "arcimx616 0-0010" 0
  res=$(FAKE_BYTES=1,1,0,0,0 LD_PRELOAD=$PWD/fake-ioctl.so run 0 "$BIN" status); has '"arcturus":false' "arcturus disconnected"
  v4lnode v4l-subdev29 "arcimx616 0-001a" 1
  res=$(FAKE_BYTES=1,1,0,0,0 LD_PRELOAD=$PWD/fake-ioctl.so run 0 "$BIN" status); has '"arcturus":true' "arcturus on v4l-subdev"

  res=$(FAKE_INIT_ERROR=110 run 2 "$BIN" status); has '"ok":false' "no SteamVR"           # Init fails
  res=$(FAKE_INTERFACE_MISSING=1 run 3 "$BIN" status); has '"ok":false' "interface missing"
  res=$(FAKE_NO_CAMERA_SLOTS=1 run 3 "$BIN" status); has '"ok":false' "no camera slots"
  res=$(FAKE_BYTES=1,0,2,0,0 run 3 "$BIN" set rgb); has '"ok":false' "invalid byte"        # no write attempted
  res=$(FAKE_BYTES=1,0,0,0,0 FAKE_REJECT_WRITE=1 run 4 "$BIN" set rgb); has '"ok":false' "rejected write"

  run 4 "$BIN" >/dev/null; run 4 "$BIN" bogus >/dev/null; run 4 "$BIN" set >/dev/null; run 4 "$BIN" set bogus >/dev/null
  echo "camera helper ok"

  rustc --edition 2021 --test -C linker="$CC" -o rust-unit-tests ${./src/main.rs}
  ./rust-unit-tests

  node ${./tests/request.test.mjs} ${./request.mjs}
  node ${./tests/patch.test.mjs} ${./patch.js} ${./unpatch.js} ${../steam-ui-patches/lib/finders.js}

  touch $out
''
