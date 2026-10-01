# Tests of touch typing (flake check `vr-keyboard-touch`): controller tip ->
# keyboard surface -> key, press/release hysteresis, two hands
# (tests/tracker.test.mjs).
{ pkgs }:
pkgs.runCommand "vr-keyboard-touch-checks" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
  node ${./tests/tracker.test.mjs} ${./tracker.js} ${../vr-keyboard-controllers/geometry.js} | tee $out
''
