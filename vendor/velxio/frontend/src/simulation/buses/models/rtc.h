/*
 * rtc.h: what the DS1307 and the DS3231 have in common, as one model on the
 * velxio-chip.h ABI. Included once by ds1307.c and by ds3231.c, which each
 * say before the include what their chip adds:
 *
 *   RTC_LAST_REGISTER      where the address pointer wraps to 0x00
 *   RTC_POINTER_MASK       the address bits a pointer byte is cut to (the
 *                          DS1307 has six; the DS3231 is given the byte)
 *   RTC_HAS_CLOCK_HALT     bit 7 of the seconds is CH and stops the clock
 *
 * and define these, which the core calls:
 *
 *   uint8_t rtc_read_register(uint8_t reg)    a register behind the time, as
 *                                             the transfer in progress sees it
 *   void    rtc_write_register(uint8_t reg, uint8_t value)
 *   void    rtc_latch_inputs(void)            what else a START samples
 *   uint8_t rtc_register_now(uint8_t reg)     a register behind the time as it
 *                                             is now (the register dump)
 *   void    rtc_counted(int64_t from, int64_t to, uint8_t weekday_at_from)
 *                                             the seconds the clock counted
 *                                             through, (from, to], for alarms
 *
 * Project i2c-model-fidelity-2026-09, P5 (decision O4): this is the one copy
 * of RtcCounters and VirtualRtc (frontend/src/simulation/I2CBusManager.ts)
 * and of _RtcCounters and _RtcSlave (backend/app/services/esp32_i2c_slaves.py),
 * ported line for line, which the tab and the QEMU workers both run. The
 * vectors of test/fixtures/i2c-vectors/ds1307.json and ds3231.json hold the
 * copies equal until they are deleted.
 *
 * ── What the chip needs from a host, and how it gets it ─────────────────
 *
 * A clock chip keeps the host's time until the sketch sets one (decision D7),
 * which the ABI has no call for. Two inputs the chip needs at almost every
 * START, so the host PUSHES them into `rtc_inputs` (the export chip_inputs
 * returns its address) and the model never calls out for them:
 *
 *   host_ms      the host's wall clock as the calendar on the user's wall
 *                reads it, milliseconds since 00:00 of 1 January 1970 of that
 *                calendar (RtcOptions.clock, TabClock). A double holds it
 *                exactly until the year 287,396. The host writes it before
 *                every bus event and before chip_setup and the dump, which is
 *                every moment a hand-written copy calls its clock().
 *   temperature  the sensor panel, degrees Celsius (the DS3231), written when
 *                the panel moves.
 *
 * A call out through a host function is what a bus event cost most in the
 * Python worker (about 35 us per call, two per START); a store into linear
 * memory is a few microseconds there and nothing in the tab.
 *
 * The firmware's build times are still asked for, as the string attribute
 * build_times ("YYYYMMDDhhmmss" each, any other character between them),
 * because finding them scans the firmware image and the chip needs them only
 * when a sketch has written a time: the moments the copies call buildTimes().
 *
 * The guest clock (vx_sim_now_nanos) is not this chip's clock: a real-time
 * clock counts wall time, whatever the guest's speed, as both copies do.
 *
 * ── The register file a host mirrors ────────────────────────────────────
 *
 * A host that answers the guest from a copy of the registers (the Raspberry
 * Pi relay) takes them from chip_dump_registers(): 256 bytes, the time brought
 * to the present, the rest as rtc_register_now() has it. This is
 * VirtualRtc.dumpRegisters().
 */
#ifndef VELXIO_RTC_H
#define VELXIO_RTC_H

#include "velxio-chip.h"

#define MS_DAY     86400000LL
#define MAX_BUILDS 16

typedef struct {
  int64_t year, month, day, hour, minute, second;
} build_time;

/* What the host pushes. The layout is part of the contract with the hosts
 * (wasmI2cModels.ts, wasm_i2c_models.py): host_ms at offset 0, temperature at
 * offset 8, both little-endian doubles. */
typedef struct {
  double host_ms;
  double temperature;
} rtc_inputs;

static rtc_inputs inputs = {0.0, 25.0};

__attribute__((export_name("chip_inputs"))) rtc_inputs* chip_inputs(void) { return &inputs; }

/* The registers behind the time as the chip powers on (07 up), which each
 * chip fills in and chip_setup applies. Exported (chip_power_on) so a host
 * that keeps the chip's facts as a table can hand the same table over before
 * chip_setup: the tab starts the model from DS1307_RULES / DS3231_RULES in
 * I2CBusManager.ts, which hold the same values (rtc-vectors-wasm.test.ts). */
static uint8_t rtc_power_on[RTC_LAST_REGISTER + 1];

__attribute__((export_name("chip_power_on"))) uint8_t* chip_power_on(void) { return rtc_power_on; }

static uint8_t rtc_read_register(uint8_t reg);
static void rtc_write_register(uint8_t reg, uint8_t value);
static void rtc_latch_inputs(void);
static uint8_t rtc_register_now(uint8_t reg);
static void rtc_counted(int64_t from, int64_t to, uint8_t weekday_at_from);

static struct {
  vx_attr a_build_times;

  /* RtcCounters: seconds, minutes, hours, day of week, date, month, year. */
  uint8_t time[7];
  /* Host time at which the second the registers show began. */
  int64_t tick_at;
  /* The counters are the host's clock. */
  bool following;
  /* A time register was written in the write phase that is open. */
  bool written;

  /* VirtualRtc: the time as the START of this transfer found it, and where
   * the transfer is. */
  uint8_t latched[7];
  bool latch_due;
  bool first_byte;
  uint8_t pointer;

  uint8_t dump[256];
  char builds_text[MAX_BUILDS * 16];
} rtc;

/* ── Arithmetic the two copies do in doubles and Python ints ─────────────── */

static int64_t fdiv(int64_t a, int64_t b) {
  int64_t q = a / b;
  if ((a % b != 0) && ((a < 0) != (b < 0))) q--;
  return q;
}

static int64_t fmod_(int64_t a, int64_t b) { return a - fdiv(a, b) * b; }

static uint8_t bcd(int64_t n) { return (uint8_t)((((n / 10) % 10) << 4) | (n % 10)); }

static int64_t bin(uint8_t v) { return ((v >> 4) & 0xF) * 10 + (v & 0xF); }

/* Days since 1 January 1970 of a date, and back: the same civil-calendar
 * arithmetic as rtcDaysOf and _rtc_days_of, a month 0 or a 31 June a sketch
 * wrote included, so the hosts count to the same day. */
static int64_t days_of(int64_t year, int64_t month, int64_t day) {
  int64_t m0 = month - 1;
  int64_t m = fmod_(m0, 12);
  int64_t y = year + fdiv(m0, 12) - (m < 2 ? 1 : 0);
  int64_t era = fdiv(y, 400);
  int64_t yoe = y - era * 400;
  int64_t doy = fdiv(153 * (m + (m > 1 ? -2 : 10)) + 2, 5);
  int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468 + (day - 1);
}

static void date_of(int64_t days, int64_t* year, int64_t* month, int64_t* day) {
  int64_t z = days + 719468;
  int64_t era = fdiv(z, 146097);
  int64_t doe = z - era * 146097;
  int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  int64_t mp = (5 * doy + 2) / 153;
  *month = mp < 10 ? mp + 3 : mp - 9;
  *year = yoe + era * 400 + (*month <= 2 ? 1 : 0);
  *day = doy - (153 * mp + 2) / 5 + 1;
}

/* The day-of-week register after `days` midnights. It counts 1 to 7 and back
 * to 1 from whatever it holds; a 0 (what RTClib writes to a DS1307) becomes 1
 * at the first midnight. */
static uint8_t weekday_after(uint8_t weekday, int64_t days) {
  if (days == 0) return weekday;
  if (weekday == 0) return days < 0 ? 0 : (uint8_t)(((days - 1) % 7) + 1);
  return (uint8_t)(fmod_((int64_t)weekday - 1 + days, 7) + 1);
}

/* Hours as the register holds them: bit 6 selects 12-hour mode, bit 5 is PM. */
static int64_t hour_of(uint8_t reg) {
  if (reg & 0x40) return (bin(reg & 0x1F) % 12) + ((reg & 0x20) ? 12 : 0);
  return bin(reg & 0x3F);
}

static uint8_t hour_register(int64_t hour, bool twelve_hour) {
  if (!twelve_hour) return bcd(hour);
  return (uint8_t)(0x40 | (hour >= 12 ? 0x20 : 0) | bcd(hour % 12 ? hour % 12 : 12));
}

/* ── The host's clock ────────────────────────────────────────────────────── */

static int64_t clock_ms(void) { return (int64_t)__builtin_floor(inputs.host_ms); }

/* ── RtcCounters ─────────────────────────────────────────────────────────── */

static bool halted(void) { return RTC_HAS_CLOCK_HALT && (rtc.time[0] & 0x80) != 0; }

static int64_t shown_time(void) {
  const uint8_t* r = rtc.time;
  int64_t days = days_of(2000 + bin(r[6]), bin(r[5] & 0x1F), bin(r[4] & 0x3F));
  return days * MS_DAY + hour_of(r[2]) * 3600000LL + bin(r[1] & 0x7F) * 60000LL +
         bin(r[0] & 0x7F) * 1000LL;
}

/* Put a time in the registers. CH, the 12-hour mode and the day of week stay. */
static void show(int64_t t) {
  uint8_t* r = rtc.time;
  int64_t days = fdiv(t, MS_DAY);
  int64_t ms = t - days * MS_DAY;
  int64_t year, month, day;
  date_of(days, &year, &month, &day);
  /* The year register counts 00 to 99, and the century bit of the DS3231
   * turns over with it. */
  int64_t centuries = fdiv(year - 2000, 100);
  r[0] = (uint8_t)((r[0] & 0x80) | bcd((ms / 1000) % 60));
  r[1] = bcd((ms / 60000) % 60);
  r[2] = hour_register(ms / 3600000, (r[2] & 0x40) != 0);
  r[4] = bcd(day);
  r[5] = (uint8_t)(((r[5] & 0x80) ^ ((centuries & 1) ? 0x80 : 0)) | bcd(month));
  r[6] = bcd(fmod_(year - 2000, 100));
}

static void count(int64_t from, int64_t to, bool alarms) {
  if (to == from) return;
  uint8_t weekday = rtc.time[3];
  rtc.time[3] = weekday_after(weekday, fdiv(to, MS_DAY) - fdiv(from, MS_DAY));
  show(to);
  if (alarms && to > from) rtc_counted(from, to, weekday);
}

/* Bring the counters to the present. */
static void sync(void) {
  int64_t now = clock_ms();
  if (rtc.following) {
    int64_t to = fdiv(now, 1000) * 1000;
    count(shown_time(), to, true);
    rtc.tick_at = to;
    return;
  }
  if (halted()) return;
  int64_t seconds = fdiv(now - rtc.tick_at, 1000);
  if (seconds <= 0) {
    /* The host's clock was set back: the chip does not count backwards. */
    if (now < rtc.tick_at) rtc.tick_at = now;
    return;
  }
  int64_t from = shown_time();
  count(from, from + seconds * 1000, true);
  rtc.tick_at += seconds * 1000;
}

/* A byte written to one of the seven registers, already cut to its bits. */
static void counters_write(uint8_t reg, uint8_t value) {
  rtc.time[reg] = value;
  /* The day of week is a counter of its own: writing it sets no time. */
  if (reg == 3) return;
  rtc.following = false;
  rtc.written = true;
  /* "The countdown chain is reset whenever the seconds register is written." */
  if (reg == 0) rtc.tick_at = clock_ms();
}

/* "YYYYMMDDhhmmss", any non-digit between two of them. */
static int read_build_times(build_time* out) {
  uint32_t len = vx_attr_string_read(rtc.a_build_times, rtc.builds_text, sizeof rtc.builds_text);
  if (len >= sizeof rtc.builds_text) len = sizeof rtc.builds_text - 1;
  rtc.builds_text[len] = 0;
  int n = 0;
  const char* p = rtc.builds_text;
  while (*p && n < MAX_BUILDS) {
    int digits = 0;
    int64_t f[14];
    while (digits < 14 && p[digits] >= '0' && p[digits] <= '9') {
      f[digits] = p[digits] - '0';
      digits++;
    }
    if (digits == 14) {
      out[n].year = f[0] * 1000 + f[1] * 100 + f[2] * 10 + f[3];
      out[n].month = f[4] * 10 + f[5];
      out[n].day = f[6] * 10 + f[7];
      out[n].hour = f[8] * 10 + f[9];
      out[n].minute = f[10] * 10 + f[11];
      out[n].second = f[12] * 10 + f[13];
      n++;
      p += 14;
    } else {
      p += digits ? digits : 1;
    }
  }
  return n;
}

/* The write phase ended: what was written is a time now. A time that is the
 * compile time of the firmware means "now" (decision D7), and the counters go
 * back to the host's clock; anything else is kept. A halted clock keeps what
 * it was given until CH is cleared. */
static void commit(void) {
  if (!rtc.written) return;
  rtc.written = false;
  if (halted()) return;
  int64_t set = shown_time();
  int64_t days = fdiv(set, MS_DAY);
  int64_t ms = set - days * MS_DAY;
  int64_t year, month, day;
  date_of(days, &year, &month, &day);
  int64_t hour = ms / 3600000, minute = (ms / 60000) % 60, second = (ms / 1000) % 60;
  build_time builds[MAX_BUILDS];
  int n = read_build_times(builds);
  bool built = false;
  for (int i = 0; i < n && !built; i++) {
    const build_time* b = &builds[i];
    built = b->year == year && b->month == month && b->day == day && b->hour == hour &&
            b->minute == minute && b->second == second;
  }
  if (!built) return;
  rtc.following = true;
  int64_t to = fdiv(clock_ms(), 1000) * 1000;
  /* Set back then, running since: no alarm is owed for the time in between. */
  count(set, to, false);
  rtc.tick_at = to;
}

/* ── VirtualRtc: the bus ─────────────────────────────────────────────────── */

static void latch(void) {
  sync();
  for (int i = 0; i < 7; i++) rtc.latched[i] = rtc.time[i];
  rtc_latch_inputs();
}

/* "The user buffers are synchronized to the internal registers on any START
 * and when the register pointer rolls over to zero." A repeated START ends a
 * write phase as a STOP does. */
static void begin(void) {
  commit();
  latch();
  rtc.latch_due = false;
}

static uint8_t after(uint8_t reg) {
  return reg == RTC_LAST_REGISTER ? 0 : (uint8_t)(reg + 1);
}

static bool on_connect(void* ud, uint8_t addr, bool is_read) {
  (void)ud;
  (void)addr;
  (void)is_read;
  /* The pointer is not reset: a write-then-read relies on it. */
  rtc.first_byte = true;
  begin();
  return true;
}

static bool on_write(void* ud, uint8_t byte) {
  (void)ud;
  /* For a host that does not say where a transfer begins: the first byte
   * after a STOP begins one, and after a write the next byte read does. */
  if (rtc.first_byte && rtc.latch_due) begin();
  rtc.latch_due = true;
  if (rtc.first_byte) {
    /* Past the last register the datasheets say nothing: the DS1307 has six
     * address bits to count with, the DS3231 is given the byte. */
    rtc.pointer = byte & RTC_POINTER_MASK;
    rtc.first_byte = false;
    return true;
  }
  uint8_t reg = rtc.pointer;
  rtc.pointer = after(reg);
  rtc_write_register(reg, byte);
  return true;
}

static uint8_t on_read(void* ud) {
  (void)ud;
  if (rtc.latch_due) begin();
  uint8_t reg = rtc.pointer;
  uint8_t value = reg < 7 ? rtc.latched[reg] : rtc_read_register(reg);
  rtc.pointer = after(reg);
  if (rtc.pointer == 0) latch();
  return value;
}

/* The pointer survives the STOP: the Seeed library writes it in one
 * transaction and reads in the next, and QEMU ends every write phase this
 * way, the one before a repeated START included. What a write phase wrote to
 * the time registers is a time from here. */
static void on_stop(void* ud) {
  (void)ud;
  commit();
  rtc.first_byte = true;
  rtc.latch_due = true;
}

/* The registers as a read would find them now, for a host that answers the
 * guest from a copy. Returns the address of 256 bytes in linear memory. */
__attribute__((export_name("chip_dump_registers"))) uint8_t* chip_dump_registers(void) {
  sync();
  for (int i = 0; i < 256; i++) rtc.dump[i] = 0;
  for (int reg = 7; reg <= RTC_LAST_REGISTER; reg++) rtc.dump[reg] = rtc_register_now((uint8_t)reg);
  for (int i = 0; i < 7; i++) rtc.dump[i] = rtc.time[i];
  return rtc.dump;
}

/* Power-on: the host's time, and the chip on the bus at 0x68. The host has
 * pushed its clock before chip_setup runs. */
static void rtc_setup(void) {
  rtc.a_build_times = vx_attr_register_string("build_times", "");

  int64_t now = clock_ms();
  rtc.following = true;
  show(fdiv(now, 1000) * 1000);
  /* No sketch has said what the numbers mean yet. Monday = 1 is what RTClib
   * writes to a DS3231 and compares an alarm on a weekday with
   * (dowToDS3231), and what the Seeed DS1307 library calls MON. */
  rtc.time[3] = (uint8_t)(fmod_(fdiv(now, MS_DAY) + 3, 7) + 1);
  rtc.tick_at = fdiv(now, 1000) * 1000;
  rtc.latch_due = true;
  rtc.first_byte = true;

  vx_i2c_config cfg = {
      .address = 0x68,
      .scl = vx_pin_register("SCL", VX_INPUT),
      .sda = vx_pin_register("SDA", VX_INPUT),
      .on_connect = on_connect,
      .on_read = on_read,
      .on_write = on_write,
      .on_stop = on_stop,
      .user_data = 0,
  };
  vx_i2c_attach(&cfg);
}

/* The entries the worker calls (i2c_host.h). A read after a START calls no
 * host, the time was latched there, so a burst is served from a peek. The
 * START, write and STOP ACK everything and call the host only for the build
 * times, a fact of the firmware: the worker may hold them back. */
#define I2C_HOST_CONNECT(addr, is_read) on_connect(0, (addr), (is_read))
#define I2C_HOST_WRITE(byte) on_write(0, (byte))
#define I2C_HOST_READ() on_read(0)
#define I2C_HOST_STOP() on_stop(0)
#define I2C_HOST_DEFERRABLE 1
#include "i2c_host.h"

#endif /* VELXIO_RTC_H */
