# Tests of the extra keys (flake check `vr-keyboard-extra-keys`): the xdotool
# helper's allowlist (tests/allowlist.test.mjs).
{ pkgs }:
pkgs.runCommand "vr-keyboard-extra-keys-checks" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
  node ${./tests/allowlist.test.mjs} ${./allowlist.mjs} | tee $out
''
