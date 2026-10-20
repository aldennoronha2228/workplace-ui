/*
 * plain-output: the three ways a chip puts an output on a board pin.
 *
 *  - A is a plain VX_OUTPUT: it drives nothing until the chip writes it.
 *  - B is VX_OUTPUT_LOW: it drives low from registration.
 *  - T is an input. A rising edge writes A high; a falling edge releases A
 *    with VX_INPUT. So a pulse on T is "write, then let go" on A.
 */
#include "velxio-chip.h"

static vx_pin a, b, t;

static void on_t(void* ud, vx_pin p, int v) {
  (void)ud;
  (void)p;
  if (v) vx_pin_write(a, 1);
  else vx_pin_set_mode(a, VX_INPUT);
}

void chip_setup(void) {
  a = vx_pin_register("A", VX_OUTPUT);
  b = vx_pin_register("B", VX_OUTPUT_LOW);
  t = vx_pin_register("T", VX_INPUT);
  vx_pin_watch(t, VX_EDGE_BOTH, on_t, 0);
  vx_log("plain-output ready");
}
