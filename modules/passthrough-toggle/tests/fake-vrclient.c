// fake-vrclient.c: a minimal stand-in for SteamVR's vrclient.so, loaded by
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
#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { void **vtable; } object_t;

static int32_t env_int(const char *name, int32_t fallback) {
  const char *v = getenv(name);
  return (v && *v) ? (int32_t)atoi(v) : fallback;
}

// ---- IVRCameraPassthroughInternal_001 (slots 9 get / 10 set) ----
static uint8_t g_bytes[5] = { 1, 0, 0, 0, 0 };
static int g_reject_write;

static int camera_get(void *self, uint8_t out[5]) {
  (void)self;
  memcpy(out, g_bytes, 5);
  return 1;
}
static void camera_set(void *self, const uint8_t in[5]) {
  (void)self;
  if (g_reject_write) return;
  memcpy(g_bytes, in, 5);
}

static void *camera_vtable[11];
static object_t g_camera = { camera_vtable };

// ---- IVRClientCore (slots 0 Init, 1 Cleanup, 2 IsInterfaceVersionValid,
// 3 GetGenericInterface) ----
static int32_t g_init_error;
static int g_interface_missing;
static int g_no_camera_slots;

static int32_t core_init(void *self, int32_t app_type, const char *startup_info) {
  (void)self; (void)app_type; (void)startup_info;
  return g_init_error;
}
static void core_cleanup(void *self) { (void)self; }

static int32_t core_is_valid(void *self, const char *version) {
  (void)self;
  if (g_interface_missing) return 1;
  if (strcmp(version, "IVRCameraPassthroughInternal_001") != 0) return 1;
  return 0;
}
static void *core_get_generic(void *self, const char *version, int32_t *error) {
  (void)self;
  if (g_interface_missing || strcmp(version, "IVRCameraPassthroughInternal_001") != 0) {
    *error = 1;
    return NULL;
  }
  *error = 0;
  return &g_camera;
}

static void *core_vtable[4];
static object_t g_core = { core_vtable };

static int g_initialized;

static void init_once(void) {
  if (g_initialized) return;
  g_initialized = 1;
  g_init_error = env_int("FAKE_INIT_ERROR", 0);
  g_interface_missing = env_int("FAKE_INTERFACE_MISSING", 0);
  g_no_camera_slots = env_int("FAKE_NO_CAMERA_SLOTS", 0);
  g_reject_write = env_int("FAKE_REJECT_WRITE", 0);

  const char *bytes_env = getenv("FAKE_BYTES");
  if (bytes_env && *bytes_env) {
    int values[5] = { 0, 0, 0, 0, 0 };
    if (sscanf(bytes_env, "%d,%d,%d,%d,%d", &values[0], &values[1], &values[2], &values[3], &values[4]) == 5)
      for (int i = 0; i < 5; i++) g_bytes[i] = (uint8_t)values[i];
  }

  core_vtable[0] = (void *)core_init;
  core_vtable[1] = (void *)core_cleanup;
  core_vtable[2] = (void *)core_is_valid;
  core_vtable[3] = (void *)core_get_generic;
  if (!g_no_camera_slots) {
    camera_vtable[9] = (void *)camera_get;
    camera_vtable[10] = (void *)camera_set;
  }
}

void *VRClientCoreFactory(const char *interface_name, int *return_code) {
  init_once();
  if (strcmp(interface_name, "IVRClientCore_003") != 0) {
    if (return_code) *return_code = 1;
    return NULL;
  }
  if (return_code) *return_code = 0;
  return &g_core;
}
