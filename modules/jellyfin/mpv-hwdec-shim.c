// LD_PRELOAD shim for libmpv apps that set hwdec to an "auto*" value, such as
// Jellyfin Desktop (hwdec=auto-copy). mpv's auto probe list leaves out V4L2
// M2M decoders, so the Steam Frame's hardware decoder (qcom-iris) is never
// tried. An "auto*" hwdec is rewritten to $SFN_MPV_HWDEC (default below); an
// explicit value such as "no" is left alone. mpv falls back to software
// decoding per stream if the decoder can't handle it.
//
// The preload applies to every process in the Flatpak sandbox; the wrappers
// only run when a process calls libmpv, and need nothing but libc.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DEFAULT_HWDEC "v4l2m2m-copy,auto-copy"

// From mpv/client.h (stable ABI).
typedef struct mpv_handle mpv_handle;
enum { MPV_FORMAT_STRING = 1, MPV_FORMAT_NODE = 6 };
enum { MPV_ERROR_GENERIC = -20 };
typedef struct mpv_node {
  union { char *string; int flag; int64_t int64; double double_; void *list; void *ba; } u;
  int format;
} mpv_node;

// The replacement for an automatic hwdec value, or NULL to keep `value`.
static const char *hwdec_for(const char *name, const char *value) {
  if (!name || !value || strcmp(name, "hwdec") != 0 || strncmp(value, "auto", 4) != 0) return NULL;
  const char *v = getenv("SFN_MPV_HWDEC");
  if (!v || !*v) v = DEFAULT_HWDEC;
  static int logged;
  if (!__atomic_exchange_n(&logged, 1, __ATOMIC_RELAXED))
    fprintf(stderr, "mpv-hwdec-shim: hwdec \"%s\" -> \"%s\"\n", value, v);
  return v;
}

// `data` of an mpv_set_* call in `format`, with a rewritten hwdec in *node or
// *str if applicable.
static void *rewrite(const char *name, int format, void *data, mpv_node *node, const char **str) {
  const char *v;
  if (!data) return data;
  if (format == MPV_FORMAT_STRING && (v = hwdec_for(name, *(char **)data))) {
    *str = v;
    return str;
  }
  if (format == MPV_FORMAT_NODE && ((mpv_node *)data)->format == MPV_FORMAT_STRING &&
      (v = hwdec_for(name, ((mpv_node *)data)->u.string))) {
    node->format = MPV_FORMAT_STRING;
    node->u.string = (char *)v;
    return node;
  }
  return data;
}

// The real function (libmpv's), looked up once; returns MPV_ERROR_GENERIC if
// it can't be found (no libmpv in the process: then nothing calls us anyway).
#define NEXT(fn)                                                     \
  static __typeof__(fn) *next;                                       \
  __typeof__(fn) *real = __atomic_load_n(&next, __ATOMIC_RELAXED);   \
  if (!real) {                                                       \
    real = (__typeof__(fn) *)dlsym(RTLD_NEXT, #fn);                  \
    if (!real) return MPV_ERROR_GENERIC;                             \
    __atomic_store_n(&next, real, __ATOMIC_RELAXED);                 \
  }

int mpv_set_property(mpv_handle *ctx, const char *name, int format, void *data) {
  NEXT(mpv_set_property);
  mpv_node n; const char *s;
  return real(ctx, name, format, rewrite(name, format, data, &n, &s));
}

int mpv_set_option(mpv_handle *ctx, const char *name, int format, void *data) {
  NEXT(mpv_set_option);
  mpv_node n; const char *s;
  return real(ctx, name, format, rewrite(name, format, data, &n, &s));
}

int mpv_set_property_async(mpv_handle *ctx, uint64_t ud, const char *name, int format, void *data) {
  NEXT(mpv_set_property_async);
  mpv_node n; const char *s;
  return real(ctx, ud, name, format, rewrite(name, format, data, &n, &s));
}

int mpv_set_property_string(mpv_handle *ctx, const char *name, const char *data) {
  NEXT(mpv_set_property_string);
  const char *v = hwdec_for(name, data);
  return real(ctx, name, v ? v : data);
}

int mpv_set_option_string(mpv_handle *ctx, const char *name, const char *data) {
  NEXT(mpv_set_option_string);
  const char *v = hwdec_for(name, data);
  return real(ctx, name, v ? v : data);
}
