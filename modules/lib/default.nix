# Shared helpers of the runtime Steam UI patches:
# - finders.js: signature-based lookup of webpack modules/exports and fibers;
# - signatures.json: per-patch signatures, also read by
#   scripts/check-signatures.mjs (run it after a Steam update);
# - hooks.js: one shared wrapper per hooked method (e.g. SendMessage);
# - mkPatch: builds the expression the injector evaluates.
#
# Patch convention: a patch file is a function expression
#   (find, sigs, opts, hooks) => <status string or Promise of one>
# (trailing parameters may be omitted), called as
#   (<patch>)(<finders.js>, <signatures>, <opts>, <hooks.js>)
# with find = lib/finders.js, sigs = its module signatures, opts = the JSON
# options from its module, hooks = lib/hooks.js. The injector re-evaluates it
# on every new JS context and periodically, so it must be idempotent: keep
# state on a window.__sfui* global (or on the wrapped function), return
# "unchanged" when already applied (not logged) and tear down/re-apply when
# its VERSION or options differ. Bump VERSION whenever the patch code changes.
# A matching unpatch.js (plain expression) reverts it when the service stops.
# Patches needing none of the arguments may be plain expressions without
# mkPatch (e.g. launcher-menu/order).
{ pkgs }:
let
  sigFile = builtins.fromJSON (builtins.readFile ./signatures.json);
in {
  signatures = sigFile;
  finders = ./finders.js;
  hooks = ./hooks.js;

  # name: file name (and default signatures entry); src: the patch file;
  # signatures: `sigs` (default: signatures.json entry `name`, else none);
  # opts: JSON-serialisable options.
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
