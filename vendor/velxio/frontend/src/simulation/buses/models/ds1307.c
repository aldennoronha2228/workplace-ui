/*
 * ds1307.c: the DS1307 real-time clock as one portable model, on the
 * velxio-chip.h ABI.
 *
 * Project i2c-model-fidelity-2026-09, P5 (decision O4): the model the tab and
 * the QEMU workers run for the part (and for the Grove RTC, which is this
 * chip), as buses/models/microsd.c is for the microSD card. It replaced two
 * hand-written copies that were kept equal only by replaying the same bus
 * vectors, test/fixtures/i2c-vectors/ds1307.json:
 *
 *   frontend/src/simulation/I2CBusManager.ts        VirtualDS1307 (the tab)
 *   backend/app/services/esp32_i2c_slaves.py        DS1307Slave (the worker)
 *
 * Both stay, for now, as the fallback a host takes when it cannot run this
 * (simulation/parts/wasmI2cModels.ts, backend/app/services/wasm_i2c_models.py).
 *
 * The clock, the pointer, the latch and the register dump are rtc.h, shared
 * with the DS3231; what the host pushes and why is written there. This file is
 * what the DS1307 adds (datasheet REV 3/15):
 *
 *  - CH, bit 7 of the seconds, stops the clock where it is, and RTClib's
 *    isrunning() reads it. Clearing it starts the clock from there.
 *  - CONTROL at 0x07 and the 56 bytes of RAM at 0x08 to 0x3F keep what is
 *    written to them (RTClib readnvram and writenvram).
 *  - Six address bits: the pointer wraps from 0x3F to 0x00, and a pointer
 *    byte is cut to them.
 */
#define RTC_LAST_REGISTER  0x3Fu
#define RTC_POINTER_MASK   0x3Fu
#define RTC_HAS_CLOCK_HALT 1
#include "rtc.h"

/* The bits of each time register and of CONTROL that exist; the others always
 * read 0 (Table 2). DS1307_RULES.write_mask in I2CBusManager.ts. The RAM keeps
 * every bit. */
static const uint8_t WRITE_MASK[8] = {0xFF, 0x7F, 0x7F, 0x07, 0x3F, 0x1F, 0xFF, 0x93};

/* CONTROL at 0x07 and the RAM behind it, under their own addresses. */
static uint8_t ram[RTC_LAST_REGISTER + 1];

static uint8_t rtc_read_register(uint8_t reg) { return ram[reg]; }

static void rtc_write_register(uint8_t reg, uint8_t value) {
  uint8_t mask = reg < 8 ? WRITE_MASK[reg] : 0xFF;
  if (reg < 7)
    counters_write(reg, value & mask);
  else
    ram[reg] = value & mask;
}

/* A START samples nothing else, the RAM has no present to be brought to, and
 * the DS1307 has no alarms. */
static void rtc_latch_inputs(void) {}

static uint8_t rtc_register_now(uint8_t reg) { return rtc_read_register(reg); }

static void rtc_counted(int64_t from, int64_t to, uint8_t weekday_at_from) {
  (void)from;
  (void)to;
  (void)weekday_at_from;
}

/* CONTROL powers on with RS1 and RS0 set, and CH at 0: a module somebody
 * set, running and on the host's time (DS1307_RULES.power_on says why). The
 * RAM is modelled as zeros; the datasheet leaves it open. */
static uint8_t rtc_power_on[RTC_LAST_REGISTER + 1] = {[0x07] = 0x03};

void chip_setup(void) {
  for (int reg = 7; reg <= RTC_LAST_REGISTER; reg++) ram[reg] = rtc_power_on[reg];
  rtc_setup();
}
