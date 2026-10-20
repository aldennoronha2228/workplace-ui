/*
 * ds3231.c: the DS3231 real-time clock as one portable model, on the
 * velxio-chip.h ABI.
 *
 * Project i2c-model-fidelity-2026-09, P5 (decision O4): the model the tab and
 * the QEMU workers run for the part, as buses/models/microsd.c is for the
 * microSD card. It replaced two hand-written copies that were kept equal only
 * by replaying the same bus vectors, test/fixtures/i2c-vectors/ds3231.json:
 *
 *   frontend/src/simulation/I2CBusManager.ts        VirtualDS3231 (the tab)
 *   backend/app/services/esp32_i2c_slaves.py        DS3231Slave (the worker)
 *
 * Both stay, for now, as the fallback a host takes when it cannot run this
 * (simulation/parts/wasmI2cModels.ts, backend/app/services/wasm_i2c_models.py).
 *
 * The clock, the pointer, the latch and the register dump are rtc.h, shared
 * with the DS1307; what the host pushes and why is written there. This file is
 * what the DS3231 adds: no CH bit, the century bit, two alarms, CONTROL,
 * STATUS, the aging offset and the temperature, and the pointer wrapping at
 * 0x12 (datasheet 19-5170 rev 10).
 */
#define RTC_LAST_REGISTER  0x12u
#define RTC_POINTER_MASK   0xFFu
#define RTC_HAS_CLOCK_HALT 0
#include "rtc.h"

#define LAST_REGISTER RTC_LAST_REGISTER
/* "No constraint" for an alarm field whose mask bit is set. An hour of -1 is
 * an alarm in the other hour mode than the clock, which never matches. */
#define ANY (-100)

/* The write rules, DS3231_RULES in I2CBusManager.ts (datasheet 19-5170 rev 10,
 * Figure 1 and the Control and Status registers). 0 = not writable. */
static const uint8_t WRITE_MASK[LAST_REGISTER + 1] = {
  0x7F, 0x7F, 0x7F, 0x07, 0x3F, 0x9F, 0xFF,   /* 00-06: the time; no CH bit */
  0xFF, 0xFF, 0xFF, 0xFF,                     /* 07-0A: alarm 1 */
  0xFF, 0xFF, 0xFF,                           /* 0B-0D: alarm 2 */
  0xDF,                                       /* 0E: CONTROL, CONV never stored */
  0x08,                                       /* 0F: STATUS, only EN32kHz */
  0xFF,                                       /* 10: aging offset */
  0x00, 0x00,                                 /* 11-12: temperature, read only */
};
/* OSF, A2F and A1F can only be written to 0. */
#define STATUS_WRITE_ZERO_TO_CLEAR 0x83u

/* Alarm 1 (07-0A), alarm 2 (0B-0D), CONTROL, STATUS and the aging offset. */
static uint8_t regs[LAST_REGISTER + 1];
/* The temperature as the START of this transfer found it. */
static uint8_t temperature[2];

/* ── Alarms ──────────────────────────────────────────────────────────────── */

static bool day_matches(int64_t days, int64_t first_day, uint8_t weekday_at_from,
                        uint8_t day_register) {
  if (day_register & 0x80) return true;
  if (day_register & 0x40)
    return weekday_after(weekday_at_from, days - first_day) == (day_register & 0x0F);
  int64_t y, m, d;
  date_of(days, &y, &m, &d);
  return d == bin(day_register & 0x3F);
}

/* Whether an alarm's registers matched the clock at one of the seconds it
 * counted through, (from, to]: rtcAlarmMatched, field by field and not second
 * by second. */
static bool alarm_matched(int64_t from, int64_t to, uint8_t weekday_at_from, int64_t second,
                          int64_t minute, int64_t hour, uint8_t day_register) {
  int64_t first_day = fdiv(from, MS_DAY);
  /* Longer ago than a year the chip would have matched as well; nobody waits. */
  int64_t t = (from > to - 400 * MS_DAY ? from : to - 400 * MS_DAY) + 1000;
  while (t <= to) {
    int64_t days = fdiv(t, MS_DAY);
    int64_t day = days * MS_DAY;
    if (!day_matches(days, first_day, weekday_at_from, day_register)) {
      t = day + MS_DAY;
      continue;
    }
    int64_t h = (t - day) / 3600000;
    if (hour != ANY && h != hour) {
      t = h < hour ? day + hour * 3600000 : day + MS_DAY;
      continue;
    }
    int64_t m = ((t - day) / 60000) % 60;
    if (minute != ANY && m != minute) {
      int64_t hour_start = day + h * 3600000;
      t = m < minute ? hour_start + minute * 60000 : hour_start + 3600000;
      continue;
    }
    int64_t s = ((t - day) / 1000) % 60;
    if (second != ANY && s != second) {
      int64_t minute_start = day + h * 3600000 + m * 60000;
      t = s < second ? minute_start + second * 1000 : minute_start + 60000;
      continue;
    }
    return true;
  }
  return false;
}

static int64_t alarm_field(uint8_t reg) { return (reg & 0x80) ? ANY : bin(reg & 0x7F); }

static int64_t alarm_hour(uint8_t reg, bool twelve_hour) {
  if (reg & 0x80) return ANY;
  return (((reg & 0x40) != 0) == twelve_hour) ? hour_of(reg & 0x7F) : -1;
}

/* The clock counted through (from, to]: A1F and A2F are set when the clock counts through a matching second,
 * whether or not the interrupt is enabled. The INT/SQW pin is not driven. */
static void rtc_counted(int64_t from, int64_t to, uint8_t weekday) {
  uint8_t* r = regs;
  bool twelve = (rtc.time[2] & 0x40) != 0;
  if (alarm_matched(from, to, weekday, alarm_field(r[0x07]), alarm_field(r[0x08]),
                    alarm_hour(r[0x09], twelve), r[0x0A]))
    r[0x0F] |= 0x01;
  /* Alarm 2 has no seconds register: it matches at second 00. */
  if (alarm_matched(from, to, weekday, 0, alarm_field(r[0x0B]), alarm_hour(r[0x0C], twelve),
                    r[0x0D]))
    r[0x0F] |= 0x02;
}

/* ── Temperature ─────────────────────────────────────────────────────────── */

/* Quarter degrees, two's complement: q = round(T x 4), half away from zero,
 * saturated at -128.00 and +127.75. 0x11 = q >> 2, 0x12 = (q & 3) << 6. */
static void temperature_registers(uint8_t out[2]) {
  double quarters = inputs.temperature * 4.0;
  int32_t q = 0;
  if (quarters == quarters && quarters - quarters == 0.0) {
    double size = __builtin_floor(__builtin_fabs(quarters) + 0.5);
    if (size > 512.0) size = 512.0;
    q = quarters < 0 ? -(int32_t)size : (int32_t)size;
    if (q > 511) q = 511;
  }
  out[0] = (uint8_t)((q >> 2) & 0xFF);
  out[1] = (uint8_t)((q & 3) << 6);
}

/* ── What the DS3231 adds to the bus ─────────────────────────────────────── */

static uint8_t rtc_read_register(uint8_t reg) {
  if (reg == 0x11 || reg == 0x12) return temperature[reg - 0x11];
  return reg <= 0x10 ? regs[reg] : 0x00;
}

static void rtc_write_register(uint8_t reg, uint8_t value) {
  if (reg > LAST_REGISTER || WRITE_MASK[reg] == 0) return;
  uint8_t mask = WRITE_MASK[reg];
  if (reg < 7) {
    counters_write(reg, value & mask);
    return;
  }
  uint8_t flags = reg == 0x0F ? STATUS_WRITE_ZERO_TO_CLEAR : 0;
  regs[reg] = (uint8_t)((regs[reg] & flags & value) | (value & mask));
}

static void rtc_latch_inputs(void) { temperature_registers(temperature); }

/* The temperature as it is now rather than as the transfer in progress
 * latched it. */
static uint8_t rtc_register_now(uint8_t reg) {
  if (reg == 0x11 || reg == 0x12) {
    uint8_t now[2];
    temperature_registers(now);
    return now[reg - 0x11];
  }
  return rtc_read_register(reg);
}

/* CONTROL 0x1C and STATUS 0x08 with OSF clear: a module somebody set and
 * whose battery kept it running (DS3231_RULES.power_on says why). */
static uint8_t rtc_power_on[LAST_REGISTER + 1] = {[0x0E] = 0x1C, [0x0F] = 0x08};

void chip_setup(void) {
  /* The temperature registers are the panel's, not a power-on value. */
  for (int reg = 7; reg <= 0x10; reg++) regs[reg] = rtc_power_on[reg];
  rtc_setup();
}
