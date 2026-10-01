# Tests of the controller bridge (flake check `vr-keyboard-controllers`):
# tip and laser relative to the keyboard, the hub's page px
# (tests/geometry.test.mjs).
{ pkgs }:
pkgs.runCommand "vr-keyboard-controllers-checks" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
  node ${./tests/geometry.test.mjs} ${./geometry.js} ${./hub.js} | tee $out
''
