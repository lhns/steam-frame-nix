# Tests of the VR keyboard (flake check `vr-keyboard`, also built before the
# patch by vr-keyboard.nix with the configured dictionary): text model,
# gesture input (two controllers), corrector and swipe-decoder accuracy
# (tests/*.test.mjs). The accuracy
# thresholds (German keyboard geometry, German and English words) fail the
# build only for German + English dictionaries, the default here.
{ pkgs
, dictionary ? {
    languages = map (l: l // { keepFrequentAbove = 4.0; }) [
      { language = "de"; hunspell = "de_DE"; words = 60000; frequencyOffset = 0.0; }
      { language = "en"; hunspell = "en_US"; words = 40000; frequencyOffset = -0.3; }
    ];
    contractions = true; extraWords = [ ]; extraWordsFrequency = 5.0; extraWordFiles = [ ]; excludeWords = [ ];
  }
}:
let
  inherit (pkgs) lib;
  words = import ./dictionary.nix { inherit pkgs dictionary; };
  strict = lib.sort lib.lessThan (map (l: l.language) dictionary.languages) == [ "de" "en" ];
in
pkgs.runCommand "vr-keyboard-checks" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
  set -o pipefail
  node ${./tests/textmodel.test.mjs} ${./textmodel.js}
  node ${./tests/gesture-input.test.mjs} ${./gesture-input.js} ${./tests/two-controllers.json}
  node ${./tests/corrector.test.mjs} ${./corrector.js} ${./swipe-decoder.js} ${words} ${lib.optionalString (!strict) "|| echo warning: corrector test failed"}
  node ${./tests/swipe-decoder.test.mjs} ${./swipe-decoder.js} ${words} 100 1 | tee $out ${lib.optionalString (!strict) "|| true"}
  node -e '
    const bad = require("fs").readFileSync(process.argv[1], "utf8").split("\n")
      .filter((l) => /sigma 0.25/.test(l) && +l.match(/top-3 ([\d.]+)%/)[1] < 85);
    if (bad.length) { console.error("decoder below 85 % top-3:", bad); process.exit(process.argv[2] === "strict" ? 1 : 0); }' \
    $out ${if strict then "strict" else "warn"}
''
