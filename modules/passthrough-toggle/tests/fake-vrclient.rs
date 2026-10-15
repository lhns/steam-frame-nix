// fake-vrclient.rs: a minimal stand-in for SteamVR's vrclient.so, loaded by
// steam-frame-nix-passthrough (src/main.rs) in check.nix instead of the real
// one (via VR_PATHREG_OVERRIDE), to drive every path of the helper without
// SteamVR. Only the vtable shape (slots 0-3 of IVRClientCore, 9/10
// of IVRCameraPassthroughInternal_001) and the version strings mimic the
// real library; behaviour is controlled by environment variables:
//   FAKE_INIT_ERROR=<n>        IVRClientCore::Init returns this (0 = ok)
//   FAKE_INTERFACE_MISSING=1   IsInterfaceVersionValid/GetGenericInterface
//                              both fail the camera interface
//   FAKE_NO_CAMERA_SLOTS=1     the camera object's get/set vtable slots are
//                              left null (interface present, but unusable)
//   FAKE_BYTES=a,b,c,d,e       initial 5-byte camera configuration
//                              (default 1,0,0,0,0)
//   FAKE_REJECT_WRITE=1        set() is a no-op (simulates SteamVR rejecting
//                              a change)
//
// Built with plain rustc as a cdylib (`--crate-type cdylib -C panic=abort`,
// no crates), same as src/main.rs's own binary build in package.nix; cdylib
// hides everything but #[no_mangle] symbols, so the .so exports only
// VRClientCoreFactory, as the real vrclient.so would.

use std::ffi::CStr;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr::{addr_of, addr_of_mut};
use std::sync::Once;

// An Itanium-ABI C++ object: its first (only, here) field is a pointer to
// its vtable -- an array of function pointers stored as `*const c_void`,
// read back through main.rs's `ffi::vtable_slot`.
#[repr(C)]
struct Object {
    vtable: *const *const c_void,
}

// ---- IVRCameraPassthroughInternal_001 (slot 9 get / slot 10 set) ----
static mut G_BYTES: [u8; 5] = [1, 0, 0, 0, 0];
static mut G_REJECT_WRITE: bool = false;

extern "C" fn camera_get(_self: *mut c_void, out: *mut u8) -> c_int {
    unsafe { std::ptr::copy_nonoverlapping(addr_of!(G_BYTES) as *const u8, out, 5) };
    1
}

extern "C" fn camera_set(_self: *mut c_void, input: *const u8) {
    unsafe {
        if G_REJECT_WRITE {
            return;
        }
        std::ptr::copy_nonoverlapping(input, addr_of_mut!(G_BYTES) as *mut u8, 5);
    }
}

static mut CAMERA_VTABLE: [*const c_void; 11] = [std::ptr::null(); 11];
static mut G_CAMERA: Object = Object { vtable: std::ptr::null() };

// ---- IVRClientCore (slot 0 Init, 1 Cleanup, 2 IsInterfaceVersionValid,
// 3 GetGenericInterface) ----
static mut G_INIT_ERROR: i32 = 0;
static mut G_INTERFACE_MISSING: bool = false;

const CAMERA_INTERFACE_VERSION: &[u8] = b"IVRCameraPassthroughInternal_001";

extern "C" fn core_init(_self: *mut c_void, _app_type: i32, _startup_info: *const c_char) -> i32 {
    unsafe { G_INIT_ERROR }
}

extern "C" fn core_cleanup(_self: *mut c_void) {}

extern "C" fn core_is_valid(_self: *mut c_void, version: *const c_char) -> i32 {
    unsafe {
        if G_INTERFACE_MISSING {
            return 1;
        }
        if CStr::from_ptr(version).to_bytes() != CAMERA_INTERFACE_VERSION {
            return 1;
        }
        0
    }
}

extern "C" fn core_get_generic(
    _self: *mut c_void,
    version: *const c_char,
    error: *mut i32,
) -> *mut c_void {
    unsafe {
        if G_INTERFACE_MISSING || CStr::from_ptr(version).to_bytes() != CAMERA_INTERFACE_VERSION {
            if !error.is_null() {
                *error = 1;
            }
            return std::ptr::null_mut();
        }
        if !error.is_null() {
            *error = 0;
        }
        addr_of_mut!(G_CAMERA) as *mut c_void
    }
}

static mut CORE_VTABLE: [*const c_void; 4] = [std::ptr::null(); 4];
static mut G_CORE: Object = Object { vtable: std::ptr::null() };

fn env_int(name: &str, fallback: i32) -> i32 {
    std::env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .and_then(|v| v.parse().ok())
        .unwrap_or(fallback)
}

fn parse_fake_bytes() -> Option<[u8; 5]> {
    let raw = std::env::var("FAKE_BYTES").ok().filter(|v| !v.is_empty())?;
    let parts: Vec<&str> = raw.split(',').collect();
    if parts.len() != 5 {
        return None;
    }
    let mut values = [0u8; 5];
    for (i, part) in parts.iter().enumerate() {
        values[i] = part.trim().parse::<i32>().ok()? as u8;
    }
    Some(values)
}

static INIT: Once = Once::new();

fn init_once() {
    INIT.call_once(|| unsafe {
        G_INIT_ERROR = env_int("FAKE_INIT_ERROR", 0);
        G_INTERFACE_MISSING = env_int("FAKE_INTERFACE_MISSING", 0) != 0;
        let no_camera_slots = env_int("FAKE_NO_CAMERA_SLOTS", 0) != 0;
        G_REJECT_WRITE = env_int("FAKE_REJECT_WRITE", 0) != 0;

        if let Some(bytes) = parse_fake_bytes() {
            G_BYTES = bytes;
        }

        CORE_VTABLE[0] = core_init as *const c_void;
        CORE_VTABLE[1] = core_cleanup as *const c_void;
        CORE_VTABLE[2] = core_is_valid as *const c_void;
        CORE_VTABLE[3] = core_get_generic as *const c_void;
        G_CORE.vtable = addr_of!(CORE_VTABLE) as *const *const c_void;

        if !no_camera_slots {
            CAMERA_VTABLE[9] = camera_get as *const c_void;
            CAMERA_VTABLE[10] = camera_set as *const c_void;
        }
        G_CAMERA.vtable = addr_of!(CAMERA_VTABLE) as *const *const c_void;
    });
}

#[no_mangle]
pub extern "C" fn VRClientCoreFactory(interface_name: *const c_char, return_code: *mut i32) -> *mut c_void {
    init_once();
    unsafe {
        if CStr::from_ptr(interface_name).to_bytes() != b"IVRClientCore_003" {
            if !return_code.is_null() {
                *return_code = 1;
            }
            return std::ptr::null_mut();
        }
        if !return_code.is_null() {
            *return_code = 0;
        }
        addr_of_mut!(G_CORE) as *mut c_void
    }
}
