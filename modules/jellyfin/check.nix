# Checks of the Jellyfin hardware decoding pieces: the mpv hwdec shim's ELF
# (libc only, no rpath, GLIBC <= 2.34) and rewriting (against a fake libmpv
# that prints what it receives).
{ pkgs }:
let
  shim = pkgs.callPackage ./shim.nix { };
in
pkgs.runCommandCC "jellyfin-check" { nativeBuildInputs = [ pkgs.binutils ]; } ''
  set -euo pipefail
  so=${shim}/lib/mpv-hwdec-shim.so
  fail() { echo "FAIL: $*" >&2; exit 1; }

  needed=$(readelf -dW $so | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p')
  for lib in $needed; do
    case $lib in libc.so.6|ld-linux*) ;; *) fail "needs $lib" ;; esac
  done
  ! readelf -dW $so | grep -Eq '\((RPATH|RUNPATH)\)' || fail "has an rpath"
  glibc=$(readelf -VW $so | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)
  [ "$(printf '%s\n' "$glibc" GLIBC_2.34 | sort -V | tail -1)" = GLIBC_2.34 ] ||
    fail "needs $glibc"
  echo "ELF ok: NEEDED" $needed", newest $glibc"

  cat > mpv.c <<'C'
  #include <stdio.h>
  #include <stdint.h>
  typedef struct { union { char *string; } u; int format; } mpv_node;
  static void show(const char *n, int f, void *d) {
    printf("%s=%s\n", n, f == 1 ? *(char **)d : ((mpv_node *)d)->u.string);
  }
  int mpv_set_property(void *c, const char *n, int f, void *d) { show(n, f, d); return 0; }
  int mpv_set_option(void *c, const char *n, int f, void *d) { show(n, f, d); return 0; }
  int mpv_set_property_async(void *c, uint64_t u, const char *n, int f, void *d) { show(n, f, d); return 0; }
  int mpv_set_property_string(void *c, const char *n, const char *d) { printf("%s=%s\n", n, d); return 0; }
  int mpv_set_option_string(void *c, const char *n, const char *d) { printf("%s=%s\n", n, d); return 0; }
  C
  cat > app.c <<'C'
  #include <stdint.h>
  typedef struct { union { char *string; } u; int format; } mpv_node;
  int mpv_set_property(void *, const char *, int, void *);
  int mpv_set_option(void *, const char *, int, void *);
  int mpv_set_property_async(void *, uint64_t, const char *, int, void *);
  int mpv_set_property_string(void *, const char *, const char *);
  int mpv_set_option_string(void *, const char *, const char *);
  int main(void) {
    char *s = "auto-copy", *no = "no";
    mpv_node node = { { "auto" }, 1 };
    mpv_set_property_string(0, "hwdec", "auto-copy");
    mpv_set_option_string(0, "hwdec", "auto");
    mpv_set_property(0, "hwdec", 1, &s);
    mpv_set_option(0, "hwdec", 6, &node);
    mpv_set_property_async(0, 0, "hwdec", 1, &s);
    mpv_set_property(0, "hwdec", 1, &no);
    mpv_set_property_string(0, "vo", "auto");
    return 0;
  }
  C
  $CC -shared -fPIC -o libmpv.so mpv.c
  $CC -o app app.c -L. -lmpv -Wl,-rpath,$PWD

  h=v4l2m2m-copy,auto-copy
  expect="hwdec=$h hwdec=$h hwdec=$h hwdec=$h hwdec=$h hwdec=no vo=auto"
  got=$(LD_PRELOAD=$so ./app 2> err)
  [ "$(echo $got)" = "$expect" ] || fail "got: $(echo $got)"
  [ "$(grep -c mpv-hwdec-shim: err)" = 1 ] || fail "logged: $(cat err)"
  got=$(SFN_MPV_HWDEC=vaapi LD_PRELOAD=$so ./app 2> /dev/null)
  [ "$(echo $got)" = "$(echo "$expect" | sed "s/$h/vaapi/g")" ] || fail "SFN_MPV_HWDEC: $(echo $got)"
  # Processes without libmpv (preloaded all over the sandbox) are unaffected.
  [ "$(LD_PRELOAD=$so ${pkgs.coreutils}/bin/echo ok)" = ok ] || fail "without libmpv"
  echo "rewrite ok"
  touch $out
''
