# Swipe typing, suggestions and a Backspace drag for Steam's VR keyboard.
# - vr-keyboard/patch.js (Steam UI, 8080): swipe gestures (decoder.js), a
#   model of what the keyboard typed (textmodel.js), suggestions (swipe
#   alternatives, corrections and completions, corrector.js; never changing
#   text by themselves), Backspace drag (left: delete with a detent at word
#   borders; right: retype), haptic ticks.
# - The suggestion strip: over the number row ("inside"), or a SteamVR
#   dashboard panel above/below the keyboard (panel.js in systemui, 8087),
#   fed by relay.mjs (user service vr-keyboard-relay).
# - Dictionary: built by gen-dict.py from wordfreq frequency lists, filtered
#   and cased by Hunspell (nixpkgs' hunspellDicts).
# Works alongside keyboard.vr.extraKeys (both hook the same keyboard; this
# one resets its text model on the extra keys it can't follow). Tests: the
# checks below (also flake check `vr-keyboard`).
{ config, pkgs, lib, ... }:
let
  cfg = config.steamFrame.keyboard.vr;
  inherit (lib) mkOption mkEnableOption types;
  uiLib = import ./lib { inherit pkgs; };

  on = cfg.enable && (cfg.swipe.enable || cfg.autocorrect.enable || cfg.completions.enable || cfg.backspaceDrag.enable);
  panel = on && cfg.suggestions.position != "inside";

  # Default dictionary: the language of keyboard.layout (if listed here) plus
  # English, else English only.
  layoutLanguages = {
    de = "de_DE"; fr = "fr-moderne"; es = "es_ES"; it = "it_IT"; nl = "nl_NL"; pt = "pt_PT"; sv = "sv_SE";
  };
  layoutLanguage = let l = config.steamFrame.keyboard.layout; in
    if l != null && layoutLanguages ? ${builtins.head (lib.splitString "," l)} then builtins.head (lib.splitString "," l) else null;
  defaultLanguages =
    lib.optional (layoutLanguage != null)
      { language = layoutLanguage; hunspell = layoutLanguages.${layoutLanguage}; words = 60000; frequencyOffset = 0.0; }
    ++ [ { language = "en"; hunspell = "en_US"; words = if layoutLanguage != null then 40000 else 60000;
           frequencyOffset = if layoutLanguage != null then -0.3 else 0.0; } ];

  built = import ./vr-keyboard/build.nix { inherit pkgs; inherit (cfg) dictionary; };
  patch = pkgs.runCommand "vr-keyboard.js" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    : ${built.checks}
    cp ${uiLib.mkPatch {
      name = "vr-keyboard";
      src = ./vr-keyboard/patch.js;
      opts = {
        swipe = cfg.swipe.enable;
        inherit (cfg.text) autoSpace bufferChars resetAfterIdleSeconds;
        inherit (cfg.suggestions) position count;
        autocorrect = cfg.autocorrect.enable;
        inherit (cfg.autocorrect) maxEditDistance;
        completions = cfg.completions.enable;
        inherit (cfg.completions) minPrefix;
        pixelsPerChar = if cfg.backspaceDrag.enable then cfg.backspaceDrag.pixelsPerChar else 0;
        inherit (cfg.backspaceDrag) wordDetentPixels;
        inherit (cfg) haptics;
      };
      extraArgs = [ ./vr-keyboard/decoder.js ./vr-keyboard/textmodel.js ./vr-keyboard/corrector.js built.dictionary ];
    }} $out
    node --check $out
  '';

  languageType = types.submodule {
    options = {
      language = mkOption { type = types.str; example = "fr"; description = "wordfreq language (de, en, fr, es, it, nl, pt, sv, ...)."; };
      hunspell = mkOption {
        type = types.nullOr types.str;
        example = "fr-moderne";
        description = ''
          pkgs.hunspellDicts attribute that filters the words and sets their
          casing; null: all words of the frequency list, lowercase.
        '';
      };
      words = mkOption { type = types.ints.positive; description = "Most frequent words taken."; };
      frequencyOffset = mkOption {
        type = types.number;
        default = 0.0;
        description = "Added to the words' zipf frequency, e.g. -0.3 for a second language.";
      };
      keepFrequentAbove = mkOption {
        type = types.nullOr types.number;
        default = 4.0;
        description = ''
          Words Hunspell rejects are kept from this zipf frequency on ("ok",
          "lol"; 3+ letters unless zipf >= 5); null: Hunspell only.
        '';
      };
    };
  };
in {
  imports = [ ./session.nix ./steam-ui-patches.nix ./keyboard-layout.nix ];

  options.steamFrame.keyboard.vr = {
    enable = mkEnableOption ''
      swipe typing, suggestions (swipe alternatives, corrections, completions)
      and a Backspace drag on Steam's VR keyboard (a Steam UI patch; the
      sub-features below are on by default)'';

    swipe.enable = mkEnableOption "swipe typing" // { default = true; };

    dictionary = {
      languages = mkOption {
        type = types.listOf languageType;
        default = defaultLanguages;
        defaultText = lib.literalMD ''
          the language of `steamFrame.keyboard.layout` (de, fr, es, it, nl, pt,
          sv; 60000 words) plus English (40000, frequency -0.3), else English
          only (60000)'';
        description = "Dictionary languages.";
      };
      contractions = mkOption {
        type = types.bool;
        default = true;
        description = ''Words with apostrophes ("couldn't", "geht's"), swiped by their letters.'';
      };
      extraWords = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "SteamVR" "E-Mail" ];
        description = "Words always included (casing as given; ' and - are typed, not swiped).";
      };
      extraWordsFrequency = mkOption { type = types.number; default = 5.0; description = "Zipf frequency of extra words."; };
      extraWordFiles = mkOption {
        type = types.listOf types.path;
        default = [ ];
        description = ''Word lists: one "word" or "word<TAB>zipf" per line.'';
      };
      excludeWords = mkOption { type = types.listOf types.str; default = [ ]; description = "Words never suggested (any casing)."; };
    };

    text = {
      bufferChars = mkOption { type = types.ints.between 8 1024; default = 64; description = "Characters of typed text remembered."; };
      resetAfterIdleSeconds = mkOption {
        type = types.ints.unsigned;
        default = 30;
        description = "Forget the remembered text after this long without typing (0: never).";
      };
      autoSpace = mkOption {
        type = types.bool;
        default = true;
        description = "Space before a swiped word after a known non-space, non-opening character.";
      };
    };

    suggestions = {
      position = mkOption {
        type = types.enum [ "below" "inside" "above" ];
        default = "below";
        description = ''
          Suggestion strip: a SteamVR dashboard panel "below" or "above" the
          keyboard, moving with it, or "inside" the keyboard over the number
          row.
        '';
      };
      count = mkOption { type = types.ints.between 1 8; default = 5; description = "Suggestions shown."; };
    };

    autocorrect = {
      enable = mkEnableOption "correction suggestions for finished tapped words not in the dictionary" // { default = true; };
      maxEditDistance = mkOption { type = types.ints.between 1 3; default = 2; description = "Largest edit distance (neighbouring keys, swaps: 0.5)."; };
    };
    completions = {
      enable = mkEnableOption "completions of the tapped word" // { default = true; };
      minPrefix = mkOption { type = types.ints.between 1 10; default = 2; description = "Letters typed before completions show."; };
    };

    backspaceDrag = {
      enable = mkEnableOption "Backspace drag: drag left to delete, back right to retype" // { default = true; };
      pixelsPerChar = mkOption { type = types.ints.positive; default = 25; description = "Travel per character (keyboard px; a key is ~60)."; };
      wordDetentPixels = mkOption {
        type = types.ints.unsigned;
        default = 90;
        description = "Detent at a word border: extra travel to delete across it (0: none).";
      };
    };

    haptics = mkOption {
      type = types.bool;
      default = true;
      description = "Haptic ticks: Backspace-drag steps, a stronger one at word detents, suggestion picks.";
    };

    checks = mkOption {
      type = types.package;
      readOnly = true;
      default = built.checks;
      defaultText = lib.literalMD "the tests, built with the configured dictionary";
      description = "The tests (also built with the patch).";
    };
  };

  config = lib.mkMerge [
    {
      assertions = map (l: {
        assertion = l.hunspell == null || pkgs.hunspellDicts ? ${l.hunspell};
        message = "steamFrame.keyboard.vr.dictionary.languages: no pkgs.hunspellDicts.${toString l.hunspell}.";
      }) cfg.dictionary.languages;

      steamFrame.uiPatches.patches = lib.optional on {
        name = "vr-keyboard";
        target.title = "SharedJSContext";
        inherit patch;
        unpatch = ./vr-keyboard/unpatch.js;
      } ++ lib.optional panel {
        name = "vr-keyboard-panel";
        endpoint = "http://127.0.0.1:8087";
        target.title = "systemui";
        patch = pkgs.writeText "vr-keyboard-panel.js" "(${builtins.readFile ./vr-keyboard/panel.js})()";
        unpatch = ./vr-keyboard/unpatch-panel.js;
      };
      steamFrame.session.services.${if panel then "restart" else "stop"} = [ "vr-keyboard-relay.service" ];
    }
    (lib.mkIf panel {
      systemd.user.services.vr-keyboard-relay = {
        Unit.Description = "Relay of the VR keyboard's suggestion strip (Steam UI <-> SteamVR dashboard)";
        Service = { ExecStart = "${pkgs.nodejs}/bin/node ${./vr-keyboard/relay.mjs}"; Restart = "always"; RestartSec = 5; };
        Install.WantedBy = [ "default.target" ];
      };
    })
  ];
}
