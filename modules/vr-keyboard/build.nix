# Build-time parts of the VR keyboard: the dictionary and the tests. Used by
# vr-keyboard.nix and by the flake's checks.<system>.vr-keyboard.
{ pkgs, dictionary }:
let
  inherit (pkgs) lib;
  d = dictionary;
  words = pkgs.runCommand "vr-keyboard-dictionary.js" { } ''
    ${pkgs.python3.withPackages (ps: [ ps.wordfreq ])}/bin/python3 ${./gen-dict.py} $out ${pkgs.hunspell}/bin/hunspell \
      ${pkgs.writeText "vr-keyboard-dictionary.json" (builtins.toJSON {
        languages = map (l: {
          inherit (l) words keepFrequentAbove;
          lang = l.language;
          offset = l.frequencyOffset;
          dict = if l.hunspell == null then null else "${pkgs.hunspellDicts.${l.hunspell}}/share/hunspell/${l.hunspell}";
        }) d.languages;
        extra = map (w: [ w d.extraWordsFrequency ]) d.extraWords;
        extraFiles = map toString d.extraWordFiles;
        extraZipf = d.extraWordsFrequency;
        exclude = d.excludeWords;
        inherit (d) contractions;
      })}
  '';
  # The accuracy thresholds (German keyboard geometry, German and English
  # words) fail the build only for German + English dictionaries.
  strict = lib.sort lib.lessThan (map (l: l.language) d.languages) == [ "de" "en" ];
in {
  dictionary = words;
  checks = pkgs.runCommand "vr-keyboard-checks" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    set -o pipefail
    node ${./tests/textmodel.test.mjs} ${./textmodel.js}
    node ${./tests/corrector.test.mjs} ${./corrector.js} ${./decoder.js} ${words} ${lib.optionalString (!strict) "|| echo warning: corrector test failed"}
    node ${./tests/decoder.test.mjs} ${./decoder.js} ${words} 100 1 | tee $out ${lib.optionalString (!strict) "|| true"}
    node -e '
      const bad = require("fs").readFileSync(process.argv[1], "utf8").split("\n")
        .filter((l) => /sigma 0.25/.test(l) && +l.match(/top-3 ([\d.]+)%/)[1] < 85);
      if (bad.length) { console.error("decoder below 85 % top-3:", bad); process.exit(process.argv[2] === "strict" ? 1 : 0); }' \
      $out ${if strict then "strict" else "warn"}
  '';
}
