# steam-frame-nix-cleanup: `install.sh cleanup` (see there) with its tools
# from nixpkgs. `nix run github:lhns/steam-frame-nix#cleanup -- --all`.
{ writeShellApplication, bash, coreutils, findutils, jq, gnugrep, gnused, gawk, procps }:
writeShellApplication {
  name = "steam-frame-nix-cleanup";
  runtimeInputs = [ bash coreutils findutils jq gnugrep gnused gawk procps ];
  text = ''
    exec bash ${../../install.sh} cleanup "$@"
  '';
}
