# Tests of the controller bridge (flake check `vr-keyboard-controllers`):
# tip and laser relative to the keyboard, the hub's page px
# (tests/geometry.test.mjs); the bridge's adaptive tick, demand and
# touch-off mode with a fake clock, a fast approach through
# vr-keyboard-touch's tracker.js (tests/bridge.test.mjs).
{ pkgs }:
pkgs.runCommand "vr-keyboard-controllers-checks" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
  set -o pipefail
  node ${./tests/geometry.test.mjs} ${./geometry.js} ${./hub.js} | tee $out
  node ${./tests/bridge.test.mjs} ${./bridge-patch.js} ${./geometry.js} ${../vr-keyboard-touch/tracker.js} | tee -a $out
''
