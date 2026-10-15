# steam-frame-nix-passthrough (src/main.rs): built with nixpkgs' Rust
# toolchain but dlopens SteamVR's vrclient.so directly, a library built
# against the system's own glibc/libstdc++. Mixing that with nixpkgs' glibc
# in one process risks the same kind of ABI mismatch the Jellyfin hwdec shim
# avoids (see jellyfin/shim.nix): no rpath, and the ELF interpreter repointed
# at the system's own dynamic linker, so the whole process -- including
# whatever vrclient.so itself dlopens -- resolves against one consistent
# system libc.
# No third-party crates: Cargo.toml/Cargo.lock declare none, and there's
# nothing for cargo to fetch, so this calls rustc directly rather than going
# through cargo/buildRustPackage. rustc still shells out to a C linker
# driver (runCommandCC gives it one); panic = abort (see Cargo.toml), yet
# std still links libgcc_s, which SteamOS has;
# aarch64-only (main.rs asserts it at compile time, test builds of the pure
# helpers aside).
{ runCommandCC, rustc, patchelf }:
runCommandCC "steam-frame-nix-passthrough" { nativeBuildInputs = [ rustc patchelf ]; } ''
  mkdir -p $out/bin
  rustc --edition 2021 -O -C panic=abort -C linker="$CC" \
    -o $out/bin/steam-frame-nix-passthrough ${./src/main.rs}
  patchelf --remove-rpath --set-interpreter /lib/ld-linux-aarch64.so.1 $out/bin/steam-frame-nix-passthrough
''
