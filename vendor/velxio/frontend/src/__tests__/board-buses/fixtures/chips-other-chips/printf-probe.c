/*
 * printf-probe: prints one line from chip_setup and one from each of three
 * timer callbacks, the way a chip author debugs with printf.
 */
#include "velxio-chip.h"
#include <stdio.h>

static vx_timer t;
static int n;

static void tick(void* ud) {
  (void)ud;
  printf("tick %d\n", ++n);
  if (n == 3) vx_timer_stop(t);
}

void chip_setup(void) {
  printf("setup\n");
  t = vx_timer_create(tick, 0);
  vx_timer_start(t, 1000000ULL, true);
}
