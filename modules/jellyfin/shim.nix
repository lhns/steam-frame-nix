# The mpv hwdec shim (mpv-hwdec-shim.c) as lib/mpv-hwdec-shim.so. It runs
# against the Flatpak runtime's glibc, so it links only libc (no rpath) and
# must not need symbols newer than GLIBC_2.34 (dlsym's version; see check.nix).
{ runCommandCC, patchelf }:
runCommandCC "mpv-hwdec-shim" { nativeBuildInputs = [ patchelf ]; } ''
  mkdir -p $out/lib
  $CC -shared -fPIC -O2 -Wall -Wextra -Werror -o $out/lib/mpv-hwdec-shim.so ${./mpv-hwdec-shim.c}
  patchelf --remove-rpath $out/lib/mpv-hwdec-shim.so
''
