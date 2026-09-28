# The VR keyboard's dictionary (vr-keyboard-dictionary.js, passed to patch.js;
# also used by check.nix), built by gen-dict.py from wordfreq frequency lists,
# filtered and cased by Hunspell. `dictionary`: the
# steamFrame.keyboard.vr.dictionary options.
{ pkgs, dictionary }:
let
  d = dictionary;
in
pkgs.runCommand "vr-keyboard-dictionary.js" { } ''
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
''
