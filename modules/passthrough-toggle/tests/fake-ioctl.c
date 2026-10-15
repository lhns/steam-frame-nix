// LD_PRELOAD shim for check.nix's Arcturus detection test: answers the
// helper's "connected" ioctl (0x800456C1) from the fake /dev node's contents
// ("1" or "0") instead of a real V4L2 sub-device. Any other request fails.
#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <unistd.h>

int ioctl(int fd, unsigned long request, ...) {
  va_list ap;
  va_start(ap, request);
  uint32_t *value = va_arg(ap, uint32_t *);
  va_end(ap);
  char c = 0;
  if (request != 0x800456C1 || pread(fd, &c, 1, 0) != 1) { errno = ENOTTY; return -1; }
  *value = c == '1';
  return 0;
}
