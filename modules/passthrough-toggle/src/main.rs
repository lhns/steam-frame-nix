// steam-frame-nix-passthrough: switches the Steam Frame's Arcturus RGB
// passthrough camera between colour and monochrome by calling SteamVR's
// private camera interface directly -- the same vrclient.so path OpenVR's
// own openvr_api.so uses internally: dlopen it, VRClientCoreFactory ->
// IVRClientCore_003, Init as a background app, GetGenericInterface
// ("IVRCameraPassthroughInternal_001"), then get/set through its vtable.
// No OpenVR SDK, nothing vendored from Valve: slots/names below are plain
// integers/strings, verified against the OpenVR SDK's own loader
// (ivrclientcore.h, openvr_api_public.cpp) and the installed
// vrclient.so/camera driver. Byte layout adapted from
// KominoVR/frame-passthrough-shortcuts (README Credits); new Rust, std +
// hand-rolled libc FFI only, no third-party crates.
//
// usage: status | set rgb | set mono. status prints one JSON line with the
// current 5-byte camera config, "source" (rgb/mono, byte 2) and "arcturus"
// (an RGB camera physically attached); set additionally tries to change
// byte 2 -- only while byte 0 (enabled) is already 1, and only that byte,
// else left alone ("changed":false). Never writes to disk.
// Exit codes: 0 ok; 2 SteamVR unreachable; 3 interface missing or holds
// values outside 0/1 (nothing written either way); 4 anything else (bad
// usage, or a write SteamVR did not retain).

// Enforced for real builds only: unit tests of the pure helpers below must
// still run on whatever host is doing the testing.
#[cfg(not(test))]
#[cfg(not(all(target_os = "linux", target_arch = "aarch64")))]
compile_error!(
    "steam-frame-nix-passthrough talks to SteamVR's private camera interface on the Steam Frame's aarch64 Linux runtime only"
);

use std::ffi::{CStr, CString, OsStr, OsString};
use std::fs;
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::raw::c_void;
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;
use std::process::exit;

const EXIT_OK: i32 = 0;
const EXIT_NO_STEAMVR: i32 = 2;
const EXIT_INTERFACE: i32 = 3;
const EXIT_OTHER: i32 = 4;

/// An exit code plus the message that goes on stdout. Not `String`/
/// `Display`: a message can come from `dlerror()`, which makes no UTF-8
/// promise, so it's carried as raw bytes throughout.
type HelperError = (i32, Vec<u8>);
type HelperResult<T> = Result<T, HelperError>;

// ---- raw ABI surface: libdl/libc declarations and the Itanium vtable call
// convention, stated once here rather than at each call site. ----
mod ffi {
    use std::os::raw::{c_char, c_int, c_void};

    // Linked explicitly against libdl for parity with glibcs that still ship
    // dlopen/dlsym/dlclose/dlerror there (glibc merged libdl into libc at
    // 2.34; -ldl is a harmless no-op against a merged libc and required
    // against an older, separate one).
    #[link(name = "dl")]
    extern "C" {
        pub fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
        pub fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        pub fn dlerror() -> *mut c_char;
        pub fn dlclose(handle: *mut c_void) -> c_int;
    }

    // open(2)'s mode argument is only consulted with O_CREAT, never passed
    // below; ioctl(2) is variadic in glibc's header, but this arity matches
    // the calling convention glibc uses when it reads this many args.
    extern "C" {
        pub fn open(path: *const c_char, flags: c_int) -> c_int;
        pub fn ioctl(fd: c_int, request: u64, arg: *mut c_void) -> c_int;
    }

    pub const RTLD_NOW: c_int = 2;
    pub const RTLD_LOCAL: c_int = 0;
    pub const O_RDWR: c_int = 0o2;
    pub const O_NONBLOCK: c_int = 0o4000;
    pub const O_CLOEXEC: c_int = 0o2_000_000;

    /// SAFETY: `ptr` must be non-null and come from `dlerror()` (a static,
    /// NUL-terminated message libdl owns; never freed by the caller).
    pub unsafe fn dlerror_message(ptr: *mut c_char) -> Vec<u8> {
        if ptr.is_null() {
            b"dlopen failed".to_vec()
        } else {
            std::ffi::CStr::from_ptr(ptr).to_bytes().to_vec()
        }
    }

    /// Slot `slot` of a live Itanium-ABI C++ object's vtable (`instance`'s
    /// first pointer-sized field), cast to whichever `*Fn` type the caller
    /// expects. Every virtual call this program makes goes through this one
    /// function, so its safety contract lives here, not at each call site.
    ///
    /// SAFETY: `instance` points at a live object built by vrclient.so;
    /// `slot` is in range for that vtable and holds a non-null `T`.
    pub unsafe fn vtable_slot<T>(instance: *mut c_void, slot: usize) -> T {
        let vtable = *(instance as *const *const *const c_void);
        std::mem::transmute_copy(&*vtable.add(slot))
    }

    // Function-pointer shapes for the vtable slots called below (IVRClientCore's
    // Init/Cleanup/IsInterfaceVersionValid/GetGenericInterface, the camera
    // interface's get/set); which slot each belongs to is next to its lookup.
    pub type FactoryFn = unsafe extern "C" fn(*const c_char, *mut i32) -> *mut c_void;
    pub type InitFn = unsafe extern "C" fn(*mut c_void, i32, *const c_char) -> i32;
    pub type CleanupFn = unsafe extern "C" fn(*mut c_void);
    pub type IsValidFn = unsafe extern "C" fn(*mut c_void, *const c_char) -> i32;
    pub type GetGenericFn =
        unsafe extern "C" fn(*mut c_void, *const c_char, *mut i32) -> *mut c_void;
    pub type CameraGetFn = unsafe extern "C" fn(*mut c_void, *mut u8) -> c_int;
    pub type CameraSetFn = unsafe extern "C" fn(*mut c_void, *const u8);
}

// ---- interface/slot layout: verified against the OpenVR SDK's loader
// (ivrclientcore.h's method order; openvr_api_public.cpp's
// VR_LoadHmdSystemInternal/VR_InitInternal2/VR_GetGenericInterface) and
// against the installed vrclient.so. Each slot number is only ever looked
// up through ffi::vtable_slot, so this is the one place naming them. ----
const SLOT_INIT: usize = 0; // IVRClientCore::Init
const SLOT_CLEANUP: usize = 1; // IVRClientCore::Cleanup
const SLOT_IS_VALID: usize = 2; // IVRClientCore::IsInterfaceVersionValid
const SLOT_GET_GENERIC: usize = 3; // IVRClientCore::GetGenericInterface
// Camera get/set slots and the 5-byte layout [enabled, stereo, rgbSource,
// disableDevignetting, sharpening], both from
// KominoVR/frame-passthrough-shortcuts (openvr_camera_source.cpp,
// camera_source.hpp), confirmed present at these names in vrclient.so.
const SLOT_CAMERA_GET: usize = 9; // IVRCameraPassthroughInternal_001::Get
const SLOT_CAMERA_SET: usize = 10; // IVRCameraPassthroughInternal_001::Set
const CONFIG_BYTES: usize = 5;
// EVRApplicationType_VRApplication_Background (openvr_capi.h); the least
// intrusive application type that still lets SteamVR hand out interfaces.
const APP_TYPE_BACKGROUND: i32 = 3;
const CLIENT_CORE_VERSION: &CStr = c"IVRClientCore_003";
const CAMERA_INTERFACE_VERSION: &CStr = c"IVRCameraPassthroughInternal_001";

/// A loaded vrclient.so plus its initialized IVRClientCore. `Drop` closes
/// both, so every exit path -- including ones added later -- cleans up
/// without a matching manual call.
struct ClientCore {
    module: *mut c_void,
    core: *mut c_void,
}

impl Drop for ClientCore {
    fn drop(&mut self) {
        // SAFETY: `core`/`module` are valid until this point (only ever
        // built by a successful load(), dropped at most once).
        unsafe {
            let cleanup: ffi::CleanupFn = ffi::vtable_slot(self.core, SLOT_CLEANUP);
            cleanup(self.core);
            ffi::dlclose(self.module);
        }
    }
}

struct CameraInterface {
    instance: *mut c_void,
}

// ---- error reporting (one JSON line; no library, so escape by hand) ----
// Operates on raw bytes throughout (not `str`) so a non-UTF-8 byte from, say,
// dlerror() is reproduced exactly rather than re-encoded.

fn escape_json_string(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 2);
    out.push(b'"');
    for &b in bytes {
        match b {
            b'"' | b'\\' => {
                out.push(b'\\');
                out.push(b);
            }
            b'\n' => out.extend_from_slice(b"\\n"),
            0x00..=0x1f => out.extend_from_slice(format!("\\u{:04x}", b).as_bytes()),
            _ => out.push(b),
        }
    }
    out.push(b'"');
    out
}

fn format_error(message: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(message.len() + 24);
    out.extend_from_slice(b"{\"ok\":false,\"error\":");
    out.extend_from_slice(&escape_json_string(message));
    out.extend_from_slice(b"}\n");
    out
}

fn print_error(message: &[u8]) {
    let _ = std::io::stdout().write_all(&format_error(message));
}

// ---- <runtime>/bin/linuxarm64/vrclient.so ----

/// Config path precedence matches the OpenVR SDK's own path registry
/// (CVRPathRegistry_Public): $VR_PATHREG_OVERRIDE as the whole file path,
/// else $XDG_CONFIG_HOME/openvr/openvrpaths.vrpath, else
/// $HOME/.config/openvr/openvrpaths.vrpath. None if none of these resolve.
fn registry_path() -> Option<PathBuf> {
    let nonempty = |name| std::env::var_os(name).filter(|v| !v.is_empty());
    if let Some(over) = nonempty("VR_PATHREG_OVERRIDE") {
        return Some(PathBuf::from(over));
    }
    let base = match nonempty("XDG_CONFIG_HOME") {
        Some(v) => PathBuf::from(v),
        None => PathBuf::from(nonempty("HOME")?).join(".config"),
    };
    Some(base.join("openvr/openvrpaths.vrpath"))
}

/// The first string of openvrpaths.vrpath's "runtime" array (SteamVR's own
/// install, the first entry if there is more than one). A small scan, not a
/// JSON parser: good enough for a file only SteamVR writes, and harmless if
/// it doesn't match what's expected (None; the caller falls back).
fn first_runtime_path(json: &[u8]) -> Option<Vec<u8>> {
    let find = |h: &[u8], n: &[u8]| h.windows(n.len()).position(|w| w == n);
    let find_byte = |h: &[u8], b: u8| h.iter().position(|&x| x == b);
    let rest = &json[find(json, b"\"runtime\"")?..];
    let after_bracket = &rest[find_byte(rest, b'[')?..];
    let after_quote1 = &after_bracket[find_byte(after_bracket, b'"')? + 1..];
    let end = find_byte(after_quote1, b'"')?;
    Some(after_quote1[..end].to_vec())
}

fn runtime_dir() -> PathBuf {
    registry_path()
        .and_then(|p| fs::read(p).ok())
        .and_then(|c| first_runtime_path(&c))
        .filter(|r| !r.is_empty())
        .map(|r| PathBuf::from(OsString::from_vec(r)))
        .unwrap_or_else(|| PathBuf::from("/opt/steamvr"))
}

fn valid_bytes(bytes: &[u8; CONFIG_BYTES]) -> bool {
    bytes.iter().all(|&b| b <= 1)
}

// ---- load: open vrclient.so, Init IVRClientCore, then fetch
// IVRCameraPassthroughInternal_001 from it -- the same two-step path
// OpenVR's own openvr_api.so takes internally. ----

fn load() -> HelperResult<(ClientCore, CameraInterface)> {
    let path = runtime_dir().join("bin/linuxarm64/vrclient.so");
    let path_c = CString::new(path.into_os_string().into_vec())
        .map_err(|_| (EXIT_NO_STEAMVR, b"could not build the vrclient.so path".to_vec()))?;

    // SAFETY: dlopen's standard contract; a null result means failure,
    // reported via dlerror() immediately after (same thread, no other
    // libdl call in between).
    let module = unsafe { ffi::dlopen(path_c.as_ptr(), ffi::RTLD_NOW | ffi::RTLD_LOCAL) };
    if module.is_null() {
        return Err((EXIT_NO_STEAMVR, unsafe { ffi::dlerror_message(ffi::dlerror()) }));
    }
    // Closes `module` on every failure path below; a successful Init instead
    // hands it to a `ClientCore`, whose own Drop closes it exactly once.
    let fail = |msg: &str| -> HelperResult<(ClientCore, CameraInterface)> {
        unsafe { ffi::dlclose(module) };
        Err((EXIT_NO_STEAMVR, msg.as_bytes().to_vec()))
    };

    // SAFETY: dlsym's standard contract against a module we just opened.
    let factory_sym = unsafe { ffi::dlsym(module, c"VRClientCoreFactory".as_ptr()) };
    if factory_sym.is_null() {
        return fail("vrclient.so has no VRClientCoreFactory");
    }
    // SAFETY: dlsym guarantees, when non-null, a pointer to the named
    // symbol, of VRClientCoreFactory's signature (openvr_api_public.cpp).
    let factory: ffi::FactoryFn = unsafe { std::mem::transmute(factory_sym) };

    let mut return_code: i32 = 0;
    // SAFETY: calling the vendor factory per its documented ABI.
    let core = unsafe { factory(CLIENT_CORE_VERSION.as_ptr(), &mut return_code) };
    if core.is_null() {
        return fail("vrclient.so did not provide IVRClientCore_003");
    }

    // SAFETY: `core` is the object the factory just returned; calling a
    // vtable slot with `core` as `this` is the Itanium ABI's convention for
    // a virtual call (true of every such call below too).
    let init: ffi::InitFn = unsafe { ffi::vtable_slot(core, SLOT_INIT) };
    let init_error = unsafe { init(core, APP_TYPE_BACKGROUND, std::ptr::null()) };
    if init_error != 0 {
        // Not calling Cleanup: a failed Init never fully set vrclient.so up.
        return fail(&format!(
            "SteamVR did not initialize (Init error {init_error}); is it running?"
        ));
    }
    let core = ClientCore { module, core };

    let is_valid: ffi::IsValidFn = unsafe { ffi::vtable_slot(core.core, SLOT_IS_VALID) };
    if unsafe { is_valid(core.core, CAMERA_INTERFACE_VERSION.as_ptr()) } != 0 {
        return Err((EXIT_INTERFACE, b"SteamVR no longer recognises IVRCameraPassthroughInternal_001; its private interface may have changed".to_vec()));
    }

    let get_generic: ffi::GetGenericFn = unsafe { ffi::vtable_slot(core.core, SLOT_GET_GENERIC) };
    let mut error: i32 = 0;
    let instance = unsafe { get_generic(core.core, CAMERA_INTERFACE_VERSION.as_ptr(), &mut error) };
    if instance.is_null() || error != 0 {
        return Err((EXIT_INTERFACE, b"SteamVR did not provide IVRCameraPassthroughInternal_001".to_vec()));
    }

    // SAFETY: reading two slots that must exist for any real camera
    // interface; only their *contents* (possibly null) are unverified yet.
    let get_slot: *const c_void = unsafe { ffi::vtable_slot(instance, SLOT_CAMERA_GET) };
    let set_slot: *const c_void = unsafe { ffi::vtable_slot(instance, SLOT_CAMERA_SET) };
    if get_slot.is_null() || set_slot.is_null() {
        return Err((EXIT_INTERFACE, b"the camera interface has no configuration accessors; it may have changed".to_vec()));
    }

    Ok((core, CameraInterface { instance }))
}

// ---- Arcturus RGB camera presence: /sys/class/video4linux/<node>/name
// starting with "arcimx616 " names a sensor node (v4l-subdevN on the Frame,
// not videoN); a read-only ioctl on the matching /dev/<node> reports
// whether it's physically connected (both from
// KominoVR/frame-passthrough-shortcuts, OpenVrCameraSource::rgb_available).
// One-shot per invocation, no debounce: this is a CLI, not a daemon.
// V4L_DIR/DEV_DIR are overridable at compile time for check.nix's fake
// sysfs/dev tree only. ----
const V4L_DIR: &str = match option_env!("V4L_DIR") { Some(v) => v, None => "/sys/class/video4linux" };
const DEV_DIR: &str = match option_env!("DEV_DIR") { Some(v) => v, None => "/dev" };

fn ioctl_connected(dev_name: &OsStr) -> bool {
    let Ok(dev_path) = CString::new(PathBuf::from(DEV_DIR).join(dev_name).into_os_string().into_vec()) else {
        return false;
    };
    // SAFETY: open(2)'s standard contract; a negative fd means failure.
    let fd = unsafe { ffi::open(dev_path.as_ptr(), ffi::O_RDWR | ffi::O_NONBLOCK | ffi::O_CLOEXEC) };
    if fd < 0 {
        return false;
    }
    // SAFETY: fd is just-opened and uniquely owned; wrapping it closes it
    // on every return below, including ones added later.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut value: u32 = 0;
    // SAFETY: fd is open (the guard above); `value` is a live local the
    // ioctl is documented to fill with a 0/1 result.
    let ok = unsafe { ffi::ioctl(fd.as_raw_fd(), 0x800456C1, (&mut value as *mut u32).cast()) } == 0;
    ok && value == 1
}

fn detect_arcturus() -> bool {
    use std::io::Read;
    let Ok(entries) = fs::read_dir(V4L_DIR) else {
        return false;
    };
    // First 10 bytes of <node>/name are exactly "arcimx616 ".
    entries.flatten().any(|entry| {
        let mut buf = [0u8; 10];
        fs::File::open(entry.path().join("name")).is_ok_and(|mut f| f.read_exact(&mut buf).is_ok())
            && buf == *b"arcimx616 "
            && ioctl_connected(&entry.file_name())
    })
}

fn print_status(bytes: &[u8; CONFIG_BYTES], arcturus: bool, changed: bool) {
    let source = if bytes[2] != 0 { "rgb" } else { "mono" };
    let line = format!(
        "{{\"ok\":true,\"enabled\":{},\"stereo\":{},\"rgbSource\":{},\"disableDevignetting\":{},\"sharpening\":{},\"source\":\"{source}\",\"arcturus\":{arcturus},\"changed\":{changed}}}\n",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4],
    );
    let _ = std::io::stdout().write_all(line.as_bytes());
}

#[derive(Clone, Copy)]
enum Action {
    Status,
    Set(u8),
}

fn parse_args(args: &[String]) -> Option<Action> {
    match args {
        [_, cmd] if cmd == "status" => Some(Action::Status),
        [_, cmd, src] if cmd == "set" && src == "rgb" => Some(Action::Set(1)),
        [_, cmd, src] if cmd == "set" && src == "mono" => Some(Action::Set(0)),
        _ => None,
    }
}

fn run(action: Action) -> i32 {
    let (_core, camera) = match load() {
        Ok(v) => v,
        Err((code, message)) => {
            print_error(&message);
            return code;
        }
    };

    // SAFETY: load() already checked both slots are non-null; get()/set()
    // read/write exactly CONFIG_BYTES bytes of the buffer passed to them,
    // per the interface's documented layout.
    let get: ffi::CameraGetFn = unsafe { ffi::vtable_slot(camera.instance, SLOT_CAMERA_GET) };
    let set: ffi::CameraSetFn = unsafe { ffi::vtable_slot(camera.instance, SLOT_CAMERA_SET) };

    let mut bytes = [0u8; CONFIG_BYTES];
    unsafe { get(camera.instance, bytes.as_mut_ptr()) };
    if !valid_bytes(&bytes) {
        print_error(
            b"SteamVR's camera configuration holds values outside 0/1; its private interface may have changed",
        );
        return EXIT_INTERFACE;
    }

    let mut changed = false;
    if let Action::Set(desired_source) = action {
        if bytes[0] == 1 && bytes[2] != desired_source {
            let mut next = bytes;
            next[2] = desired_source;
            unsafe { set(camera.instance, next.as_ptr()) };
            let mut verify = [0u8; CONFIG_BYTES];
            unsafe { get(camera.instance, verify.as_mut_ptr()) };
            if next != verify {
                print_error(b"SteamVR did not retain the requested camera source");
                return EXIT_OTHER;
            }
            bytes = verify;
            changed = true;
        }
    }

    print_status(&bytes, detect_arcturus(), changed);
    EXIT_OK
}

fn usage_exit() -> ! {
    eprintln!("usage: steam-frame-nix-passthrough status|set rgb|set mono");
    exit(EXIT_OTHER);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(action) = parse_args(&args) else {
        usage_exit();
    };
    exit(run(action));
}

// Unit tests of the two pure helpers check.nix's end-to-end run of the
// packaged binary (via a fake vrclient.so and sysfs tree) does not already
// cover: vrpath parsing and JSON escaping. Everything else -- byte
// validation, the JSON shape, argument parsing, exit codes -- is exercised
// there against real-looking input/output instead.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_json_string_escapes_quotes_backslashes_and_controls() {
        assert_eq!(escape_json_string(b"plain"), b"\"plain\"");
        assert_eq!(escape_json_string(b"a\"b"), b"\"a\\\"b\"");
        assert_eq!(escape_json_string(b"a\\b"), b"\"a\\\\b\"");
        assert_eq!(escape_json_string(b"a\nb"), b"\"a\\nb\"");
        assert_eq!(escape_json_string(b"\x01"), b"\"\\u0001\"");
        // Bytes above 0x7f pass through unescaped and unmodified (no UTF-8
        // re-encoding): the bytes go out as they are.
        assert_eq!(escape_json_string(&[0xff]), vec![b'"', 0xff, b'"']);
    }

    #[test]
    fn format_error_wraps_the_message() {
        assert_eq!(
            format_error(b"oops"),
            b"{\"ok\":false,\"error\":\"oops\"}\n"
        );
    }

    #[test]
    fn first_runtime_path_extracts_the_first_entry() {
        let json = br#"{"config":"x","runtime":["/opt/steamvr","/other"]}"#;
        assert_eq!(first_runtime_path(json), Some(b"/opt/steamvr".to_vec()));
    }

    #[test]
    fn first_runtime_path_none_when_absent_or_malformed() {
        assert_eq!(first_runtime_path(b"{}"), None);
        assert_eq!(first_runtime_path(br#"{"runtime":[]}"#), None);
        assert_eq!(first_runtime_path(br#"{"runtime":"nope"}"#), None);
    }
}
