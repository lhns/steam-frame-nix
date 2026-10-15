// fake-ioctl.rs: LD_PRELOAD shim for check.nix's Arcturus detection test:
// answers the helper's "connected" ioctl (0x800456C1) from the fake /dev
// node's contents ("1" or "0") instead of a real V4L2 sub-device. Any other
// request fails, same as the ioctl it replaces never being reached by this
// test (it is not forwarded to the real ioctl).
//
// Built with plain rustc as a cdylib (`--crate-type cdylib -C panic=abort`,
// no crates); only #[no_mangle] `ioctl` is exported, so it overrides libc's
// ioctl for anything preloading this .so.
//
// glibc's ioctl(2) is variadic, but on aarch64-linux (AAPCS64) a
// non-variadic `extern "C" fn(c_int, c_ulong, *mut c_void) -> c_int` is
// called through the exact same integer/pointer registers (x0/x1/x2) a
// three-argument variadic call would use, so this signature is ABI-sound
// for this target and this call shape (matches src/main.rs's own `ioctl`
// FFI declaration).

use std::os::raw::{c_int, c_ulong, c_void};

const ARCTURUS_CONNECTED: c_ulong = 0x800456C1;
const ENOTTY: c_int = 25;

extern "C" {
    fn pread(fd: c_int, buf: *mut c_void, count: usize, offset: i64) -> isize;
    fn __errno_location() -> *mut c_int;
}

#[no_mangle]
pub extern "C" fn ioctl(fd: c_int, request: c_ulong, arg: *mut c_void) -> c_int {
    let mut c: u8 = 0;
    let ok = request == ARCTURUS_CONNECTED
        && unsafe { pread(fd, &mut c as *mut u8 as *mut c_void, 1, 0) } == 1;
    if !ok {
        unsafe { *__errno_location() = ENOTTY };
        return -1;
    }
    unsafe { *(arg as *mut u32) = (c == b'1') as u32 };
    0
}
