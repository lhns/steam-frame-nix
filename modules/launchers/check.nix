# Checks of steamFrame.launchers (lib.nix, rewrite.awk, generate.sh) on
# copies of real entries (fixtures/sources: Element, KRDC, Firefox, gedit
# (DBusActivatable) from /var/lib/flatpak, Jellyfin from the user
# installation, Claude from the claude-desktop package) and two made-up ones
# (quoting, an Exec without anchor):
# - the rewritten entries equal fixtures/expected (X-SteamFrameNix-Source
#   compared separately) and pass desktop-file-validate;
# - the generator: unchanged sources change nothing (mtimes kept, no touch of
#   the applications dir), a changed source is rewritten and touches it,
#   entries of removed launchers and of missing sources are removed, an
#   unknown Exec format gives the original entry with a warning, edits and
#   replaced links are reported, no outer runtime dir is a no-op;
# - a package without the entry fails to build.
# The rewritten entries end up in $out/actual (to update fixtures/expected).
{ pkgs }:
let
  inherit (pkgs) lib;
  L = import ./lib.nix { inherit lib pkgs; };
  src = ./fixtures/sources;
  shim = "/nix/store/00000000000000000000000000000000-mpv-hwdec-shim";

  fakeClaude = pkgs.runCommand "claude-desktop-fixture" { } ''
    mkdir -p $out/share/applications
    cp ${src}/com.anthropic.Claude.desktop $out/share/applications/
  '';
  noEntry = pkgs.runCommand "no-entry-fixture" { } "mkdir -p $out/share/applications";

  launchers = (lib.evalModules {
    modules = [ {
      options.launchers = lib.mkOption {
        type = lib.types.attrsOf (lib.types.submodule
          (L.launcherModule { bus = "unix:path=/run/user/1000/bus"; }));
      };
      config.launchers = {
        "im.riot.Riot" = {
          keyring = { enable = true; electron = true; };
          defaultFor = [ "x-scheme-handler/element" "x-scheme-handler/io.element.desktop" ];
        };
        "org.kde.krdc".keyring.enable = true;
        "org.mozilla.firefox" = {
          wrappers = [ "/nix/store/00000000000000000000000000000000-firefox-wrapper" ];
          defaultFor = [ "x-scheme-handler/http" "x-scheme-handler/https" "text/html" ];
        };
        "org.jellyfin.JellyfinDesktop" = {
          flatpakArgs = [ "--device=all" "--filesystem=${shim}:ro" ];
          env = { LD_PRELOAD = "${shim}/lib/mpv-hwdec-shim.so"; SFN_MPV_HWDEC = "v4l2m2m-copy,auto-copy"; };
        };
        "org.gnome.gedit" = {
          mimeTypes = [ "text/x-nix" "text/plain" ];
          settings = { Name = "gedit (test)"; Keywords = null; StartupWMClass = "gedit"; };
        };
        "org.example.NoAnchor" = { };
        "org.example.Quoting" = {
          source.file = "${src}/org.example.Quoting.desktop";
          wrappers = [ "/w/outer" "/w/in ner" ];
          hostEnv.A = "x y";
          env.B = "100%";
          args = [ "a b" "50%" "q\"uote" "$HOME" "back\\slash" "back`tick" "" ];
          settings.Keywords = "x;";
        };
        "com.anthropic.Claude" = {
          source.package = fakeClaude;
          keyring = { enable = true; electron = true; };
          defaultFor = [ "x-scheme-handler/claude" ];
        };
      };
    } ];
  }).config.launchers;
  all = lib.mapAttrs (id: l: l // { inherit id; }) launchers;
  runtime = lib.filterAttrs (_: l: L.kindOf l != "package") all;

  generator = L.generator {
    launchers = runtime;
    runtimeDir = "/nonexistent";          # overridden below
    applicationsDir = "/nonexistent";
    exportDirs = [ "/nonexistent" ];
  };
  empty = L.generator {
    launchers = { };
    runtimeDir = "/nonexistent";
    applicationsDir = "/nonexistent";
    exportDirs = [ "/nonexistent" ];
  };
  claude = L.packageEntry all."com.anthropic.Claude";
  missing = pkgs.testers.testBuildFailure (L.packageEntry (all."com.anthropic.Claude" // {
    source = all."com.anthropic.Claude".source // { package = noEntry; };
  }));
in
pkgs.runCommand "launchers-check" {
  nativeBuildInputs = [ generator pkgs.desktop-file-utils pkgs.diffutils ];
  passthru = { inherit generator claude; };
} ''
  set -euo pipefail
  fail() { echo "FAIL: $*" >&2; exit 1; }
  root=$PWD
  export STEAM_FRAME_NIX_RUNTIME_DIR=$root/run
  export STEAM_FRAME_NIX_APPLICATIONS_DIR=$root/apps
  export STEAM_FRAME_NIX_FLATPAK_EXPORTS=$root/user:$root/system
  out_dir=$root/run/steam-frame-nix/applications
  mkdir -p $root/user $root/system $root/apps
  for id in im.riot.Riot org.kde.krdc org.mozilla.firefox org.gnome.gedit org.example.NoAnchor; do
    cp ${src}/$id.desktop $root/system/
  done
  cp ${src}/org.jellyfin.JellyfinDesktop.desktop $root/user/
  # a user installation wins over the system one
  cp ${src}/org.jellyfin.JellyfinDesktop.desktop $root/system/
  chmod u+w $root/system/* $root/user/*
  sed -i 's/^Name=Jellyfin$/Name=system copy/' $root/system/org.jellyfin.JellyfinDesktop.desktop

  run() { steam-frame-nix-launchers 2> $root/log || fail "status $?: $(cat $root/log)"; cat $root/log >&2; }
  logged() { grep -qF -- "$1" $root/log || fail "log lacks '$1': $(cat $root/log)"; }
  mt() { stat -c %Y "$1"; }
  old() { touch -d @1000000000 "$@"; }

  # no outer runtime dir: nothing happens
  run; logged "doesn't exist"; [ ! -e $root/run ] || fail "created the runtime dir"

  mkdir -p $root/run
  old $root/apps
  run
  [ "$(mt $root/apps)" != 1000000000 ] || fail "applications dir not touched"
  logged "org.example.NoAnchor: unknown Exec format"
  cmp -s ${src}/org.example.NoAnchor.desktop $out_dir/org.example.NoAnchor.desktop || fail "unknown Exec format: not the original"

  mkdir -p $out/actual
  for id in ${lib.concatStringsSep " " (lib.attrNames runtime)}; do
    [ $id = org.example.NoAnchor ] && continue
    cp $out_dir/$id.desktop $out/actual/
  done
  cp ${claude} $out/actual/com.anthropic.Claude.desktop
  grep -qx "X-SteamFrameNix-Source=$root/user/org.jellyfin.JellyfinDesktop.desktop" $out/actual/org.jellyfin.JellyfinDesktop.desktop \
    || fail "Jellyfin not from the user installation"
  grep -qx "X-SteamFrameNix-Source=$root/system/org.kde.krdc.desktop" $out/actual/org.kde.krdc.desktop || fail "KRDC source"
  grep -qx "X-SteamFrameNix-Source=${src}/org.example.Quoting.desktop" $out/actual/org.example.Quoting.desktop || fail "file source"
  grep -qx "X-SteamFrameNix-Source=${fakeClaude}/share/applications/com.anthropic.Claude.desktop" $out/actual/com.anthropic.Claude.desktop || fail "package source"
  sed -i 's|^X-SteamFrameNix-Source=.*|X-SteamFrameNix-Source=@SOURCE@|' $out/actual/*.desktop
  desktop-file-validate --no-hints $out/actual/*.desktop || fail "desktop-file-validate"
  for f in ${./fixtures/expected}/*.desktop; do
    diff -u $f $out/actual/''${f##*/} || fail "''${f##*/} differs from fixtures/expected"
  done
  [ "$(ls ${./fixtures/expected} | wc -l)" = "$(ls $out/actual | wc -l)" ] || fail "expected/actual count"

  # unchanged: nothing written, applications dir untouched
  old $root/apps $out_dir/*.desktop
  run
  [ "$(mt $root/apps)" = 1000000000 ] || fail "unchanged run touched the applications dir"
  for f in $out_dir/*.desktop; do [ "$(mt $f)" = 1000000000 ] || fail "unchanged run rewrote $f"; done

  # changed source: rewritten, dir touched
  echo '# changed' >> $root/system/org.kde.krdc.desktop
  run
  logged "org.kde.krdc: entry written"
  [ "$(mt $out_dir/org.kde.krdc.desktop)" != 1000000000 ] || fail "changed source not rewritten"
  [ "$(mt $out_dir/im.riot.Riot.desktop)" = 1000000000 ] || fail "other entry rewritten"
  [ "$(mt $root/apps)" != 1000000000 ] || fail "changed run didn't touch the applications dir"
  grep -qx '# changed' $out_dir/org.kde.krdc.desktop || fail "comment not kept"

  # launcher no longer configured, source gone: removed
  echo stale > $out_dir/org.example.Old.desktop; echo x > $out_dir/.org.example.Old.desktop.sum
  rm $root/system/org.gnome.gedit.desktop
  old $root/apps
  run
  [ ! -e $out_dir/org.example.Old.desktop ] && [ ! -e $out_dir/.org.example.Old.desktop.sum ] || fail "stale entry kept"
  [ ! -e $out_dir/org.gnome.gedit.desktop ] || fail "entry without source kept"
  logged "org.gnome.gedit: entry removed (no source entry"
  [ "$(mt $root/apps)" != 1000000000 ] || fail "removal didn't touch the applications dir"

  # edited entry (e.g. KDE's editor writing through the link): overwritten
  cp $out_dir/im.riot.Riot.desktop $root/riot
  echo 'Name[de]=Edited' >> $out_dir/im.riot.Riot.desktop
  run
  logged "im.riot.Riot.desktop was edited"
  cmp -s $root/riot $out_dir/im.riot.Riot.desktop || fail "edit not overwritten"
  # replaced link: reported; our own link: not
  ln -s $out_dir/im.riot.Riot.desktop $root/apps/im.riot.Riot.desktop
  echo '[Desktop Entry]' > $root/apps/org.kde.krdc.desktop
  run
  logged "org.kde.krdc.desktop no longer leads to"
  ! grep -q "im.riot.Riot.desktop no longer" $root/log || fail "own link reported"

  # no launchers left (the activation runs it anyway): all entries removed
  old $root/apps
  ${lib.getExe empty} 2> $root/log || fail "empty: $(cat $root/log)"
  [ -z "$(ls $out_dir)" ] || fail "entries left: $(ls $out_dir)"
  [ "$(mt $root/apps)" != 1000000000 ] || fail "removal didn't touch the applications dir"

  # a package without the entry: the build fails
  [ -e ${missing}/testBuildFailure.log ] && grep -q "has no share/applications/com.anthropic.Claude.desktop" ${missing}/testBuildFailure.log \
    || fail "package without the entry built"
  echo ok
''
