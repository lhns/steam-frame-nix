# Shared helpers of the runtime Steam UI patches.
# - finders.js: signature-based lookup of webpack modules/exports and React
#   fibers (no module ids or minified names);
# - signatures.json: the signatures the patches use, per patch, also read by
#   scripts/check-signatures.mjs (run it after a Steam update);
# - hooks.js: shared method hooks (one wrapper per method for all patches,
#   e.g. the SteamVR dashboard mailbox's SendMessage);
# - mkPatch: turns a patch written as a function expression
#   `(find, sigs, opts, hooks) => …` into the single expression the injectors
#   evaluate: (<patch>)(<finders.js>, <signatures>, <opts>, <hooks.js>).
{ pkgs }:
let
  sigFile = builtins.fromJSON (builtins.readFile ./signatures.json);
in {
  signatures = sigFile;
  finders = ./finders.js;
  hooks = ./hooks.js;

  # name: file name (and default signatures entry); src: the patch file;
  # signatures: module signatures passed as `sigs` (default: the entry `name`
  # of signatures.json, else none); opts: JSON-serialisable options.
  mkPatch = { name, src, signatures ? sigFile.patches.${name}.modules or { }, opts ? { } }:
    pkgs.writeText "${name}.js" ''
      (${builtins.readFile src}
      )(${builtins.readFile ./finders.js}
      , ${builtins.toJSON signatures}
      , ${builtins.toJSON opts}
      , ${builtins.readFile ./hooks.js}
      )
    '';
}
