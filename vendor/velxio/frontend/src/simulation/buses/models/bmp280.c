/*
 * bmp280.c: the Bosch BMP280 pressure and temperature sensor as one portable
 * model, on the velxio-chip.h ABI.
 *
 * Project i2c-model-fidelity-2026-09, P5 (decision O4): the model the tab and
 * the QEMU workers run for the part, as rtc.h is for the two clocks. It is a
 * line-for-line port of the two hand-written copies, kept equal until now only
 * by replaying the same bus vectors, test/fixtures/i2c-vectors/bmp280.json:
 *
 *   frontend/src/simulation/I2CBusManager.ts        VirtualBMP280 (the tab)
 *   backend/app/services/esp32_i2c_slaves.py        BMP280Slave (the worker)
 *
 * Both stay, for now, as the fallback a host takes when it cannot run this
 * (simulation/parts/wasmI2cModels.ts, backend/app/services/wasm_i2c_models.py).
 * The pro BME280 is still its own TypeScript model.
 *
 * What the model does (datasheet BST-BMP280-DS001 rev 1.26, sections named):
 *
 *  - It powers on in sleep mode and measures nothing there (3.6.1): until the
 *    sketch selects a mode, the data registers hold their reset value 0x80000.
 *  - Forced mode is one measurement, and the chip is back in sleep mode when
 *    it is done (3.6.2). A conversion takes no time here, so the mode bits
 *    read 00 at once and the measurement is what the panel said at the write.
 *  - In normal mode the chip measures by itself (3.6.3): a read finds what the
 *    panel says when it begins, and the whole burst is answered from that one
 *    measurement (3.10).
 *  - `measuring` reads 1 once after a mode write that starts a conversion.
 *  - A write is pairs of register address and register data, and the address
 *    does not count up (5.2.1, figure 7). A read counts up from the last
 *    address written (5.2.2), past 0xFF to 0x00.
 *  - What the panel sets is the world around the chip, not a register: it
 *    survives a soft reset.
 *
 * ── What the chip needs from a host, and how it gets it ─────────────────
 *
 * The host PUSHES into `bmp280_io` (the export chip_inputs returns its
 * address), and the model never calls out, so a read calls no host and the
 * worker serves a burst from one peek (i2c_host.h):
 *
 *   temperature  offset 0, double, degrees Celsius (the panel)
 *   pressure     offset 8, double, hPa (the panel)
 *   address      offset 16, uint32, 0x76 or 0x77 (SDO), read by chip_setup
 *   asleep_reads offset 20, uint32, written by the model: how many data
 *                registers were read before the chip ever measured, which
 *                the tab tells the board's monitor about once a run
 *
 * The raw values a measurement puts in the data registers are the ones the
 * compensation formulas turn back into the panel's values, found by searching
 * them, and worked out again when a measurement finds the panel moved. The
 * search aims at the temperature in hundredths of a degree rounded as
 * JavaScript's Math.round does (half up), which the vectors pin.
 */
#include "velxio-chip.h"

typedef struct {
  double temperature;
  double pressure;
  uint32_t address;
  uint32_t asleep_reads;
} bmp280_io;

static bmp280_io io = {24.0, 1013.25, 0x76, 0};

__attribute__((export_name("chip_inputs"))) bmp280_io* chip_inputs(void) { return &io; }

/* BMP280_RULES in I2CBusManager.ts, the `rules` of bmp280.json. */
#define REG_ID 0xD0
#define REG_RESET 0xE0
#define RESET_WORD 0xB6
#define REG_STATUS 0xF3
#define MEASURING 0x08
#define REG_CTRL_MEAS 0xF4
#define REG_CONFIG 0xF5
#define MODE_MASK 0x03
#define MODE_SLEEP 0x00
#define MODE_NORMAL 0x03
#define SAMPLE_FIRST 0xF7
#define SAMPLE_LAST 0xFC

/* The datasheet's example calibration (8.2), which makes a measurement of
 * its example raw values 25.08 C and 1006.5 hPa. */
#define DIG_T1 27504
#define DIG_T2 26435
#define DIG_T3 (-1000)
#define DIG_P1 36477
#define DIG_P2 (-10685)
#define DIG_P3 3024
#define DIG_P4 2855
#define DIG_P5 140
#define DIG_P6 (-7)
#define DIG_P7 15500
#define DIG_P8 (-14600)
#define DIG_P9 6000

static struct {
  uint8_t regs[256];
  /* What a measurement taken now puts in the data registers, and the panel
   * values it was worked out from. */
  uint8_t live[SAMPLE_LAST - SAMPLE_FIRST + 1];
  bool live_valid;
  double live_temperature;
  double live_pressure;
  uint8_t pointer;
  /* The next byte written is a register address. */
  bool first_byte;
  /* A conversion started and status has not been read since. */
  bool measuring;
  /* The data registers hold a measurement and not their reset value. */
  bool measured;
  /* No START was heard for the read that comes next: latch on its first byte. */
  bool latch_due;
  uint8_t dump[256];
} bmp;

/* ── Compensation (Bosch, 32-bit integer temperature, double pressure) ───── */

static int32_t t_fine(int32_t adc_t) {
  int32_t var1 = (int32_t)((((int64_t)(adc_t >> 3) - (DIG_T1 << 1)) * DIG_T2) >> 11);
  int32_t sub = (adc_t >> 4) - DIG_T1;
  int32_t var2 = (int32_t)(((((int64_t)sub * sub) >> 12) * DIG_T3) >> 14);
  return var1 + var2;
}

/* Hundredths of a degree. */
static int32_t compensate_t(int32_t adc_t) { return (t_fine(adc_t) * 5 + 128) >> 8; }

/* Pa, in the order of operations of the two copies, so the doubles agree. */
static double compensate_p(int32_t adc_p, int32_t adc_t) {
  double tf = (double)t_fine(adc_t);
  double var1 = tf / 2.0 - 64000.0;
  double var2 = (var1 * var1 * DIG_P6) / 32768.0;
  var2 = var2 + var1 * DIG_P5 * 2.0;
  var2 = var2 / 4.0 + DIG_P4 * 65536.0;
  var1 = ((DIG_P3 * var1 * var1) / 524288.0 + DIG_P2 * var1) / 524288.0;
  var1 = (1.0 + var1 / 32768.0) * DIG_P1;
  if (var1 == 0) return 0;
  double p = 1048576.0 - adc_p;
  p = ((p - var2 / 4096.0) * 6250.0) / var1;
  double v1b = (DIG_P9 * p * p) / 2147483648.0;
  double v2b = (p * DIG_P8) / 32768.0;
  return p + (v1b + v2b + DIG_P7) / 16.0;
}

/* The 20-bit raw temperature whose compensation first reaches the target. */
static int32_t find_adc_t(double target) {
  int32_t lo = 0, hi = (1 << 20) - 1;
  while (lo < hi) {
    int32_t mid = (lo + hi) >> 1;
    if (compensate_t(mid) < target)
      lo = mid + 1;
    else
      hi = mid;
  }
  return lo;
}

/* Pressure falls as the raw value rises. */
static int32_t find_adc_p(double target, int32_t adc_t) {
  int32_t lo = 0, hi = (1 << 20) - 1;
  while (lo < hi) {
    int32_t mid = (lo + hi) >> 1;
    if (compensate_p(mid, adc_t) > target)
      lo = mid + 1;
    else
      hi = mid;
  }
  return lo;
}

/* JavaScript's Math.round: the nearest integer, half toward +infinity. */
static double js_round(double x) {
  double r = __builtin_floor(x);
  return x - r >= 0.5 ? r + 1.0 : r;
}

static void encode20(uint8_t* out, int32_t v) {
  out[0] = (uint8_t)((v >> 12) & 0xFF);
  out[1] = (uint8_t)((v >> 4) & 0xFF);
  out[2] = (uint8_t)((v & 0xF) << 4);
}

static bool same(double a, double b) { return __builtin_memcmp(&a, &b, sizeof a) == 0; }

/* The raw values of the panel's values, worked out again only when it moved. */
static const uint8_t* live(void) {
  if (!bmp.live_valid || !same(bmp.live_temperature, io.temperature) ||
      !same(bmp.live_pressure, io.pressure)) {
    int32_t adc_t = find_adc_t(js_round(io.temperature * 100));
    int32_t adc_p = find_adc_p(io.pressure * 100, adc_t);
    encode20(bmp.live, adc_p);
    encode20(bmp.live + 3, adc_t);
    bmp.live_temperature = io.temperature;
    bmp.live_pressure = io.pressure;
    bmp.live_valid = true;
  }
  return bmp.live;
}

/* ── The chip ────────────────────────────────────────────────────────────── */

static uint8_t mode(void) { return bmp.regs[REG_CTRL_MEAS] & MODE_MASK; }

static void wu16(int at, int v) {
  bmp.regs[at] = (uint8_t)(v & 0xFF);
  bmp.regs[at + 1] = (uint8_t)((v >> 8) & 0xFF);
}

static void calibration(void) {
  wu16(0x88, DIG_T1);
  wu16(0x8A, DIG_T2);
  wu16(0x8C, DIG_T3);
  wu16(0x8E, DIG_P1);
  wu16(0x90, DIG_P2);
  wu16(0x92, DIG_P3);
  wu16(0x94, DIG_P4);
  wu16(0x96, DIG_P5);
  wu16(0x98, DIG_P6);
  wu16(0x9A, DIG_P7);
  wu16(0x9C, DIG_P8);
  wu16(0x9E, DIG_P9);
}

/* The power-on reset, which the reset word runs too (4.3.2). The calibration
 * is NVM and the panel is not the chip's. */
static void power_on(void) {
  bmp.regs[REG_CTRL_MEAS] = 0;
  bmp.regs[REG_CONFIG] = 0;
  for (int reg = SAMPLE_FIRST; reg <= SAMPLE_LAST; reg++) bmp.regs[reg] = 0;
  /* The id, and the msb of the two data words: 0x80000 until a measurement
   * replaces it (4.2, table 18). */
  bmp.regs[REG_ID] = 0x58;
  bmp.regs[0xF7] = 0x80;
  bmp.regs[0xFA] = 0x80;
  bmp.measuring = false;
  bmp.measured = false;
}

static void measure(void) {
  const uint8_t* l = live();
  for (int i = 0; i <= SAMPLE_LAST - SAMPLE_FIRST; i++) bmp.regs[SAMPLE_FIRST + i] = l[i];
  bmp.measured = true;
}

static void latch(void) {
  if (mode() == MODE_NORMAL) measure();
  bmp.latch_due = false;
}

static void write_register(uint8_t reg, uint8_t value) {
  if (reg == REG_RESET) {
    if (value == RESET_WORD) power_on();
    return;
  }
  /* ctrl_meas and config; the rest is read-only or reserved (table 18). */
  if (reg != REG_CTRL_MEAS && reg != REG_CONFIG) return;
  if (reg != REG_CTRL_MEAS) {
    bmp.regs[reg] = value;
    return;
  }
  uint8_t m = value & MODE_MASK;
  if (m == MODE_SLEEP) {
    /* The chip measured until now, so what it holds asleep is this instant. */
    if (mode() == MODE_NORMAL) measure();
    bmp.measuring = false;
    bmp.regs[reg] = value;
    return;
  }
  bmp.measuring = true;
  if (m == MODE_NORMAL) {
    bmp.regs[reg] = value;
    return;
  }
  /* Forced: one measurement, and back to sleep. */
  measure();
  bmp.regs[reg] = value & (uint8_t)~MODE_MASK;
}

/* ── The bus ─────────────────────────────────────────────────────────────── */

static bool on_connect(void* ud, uint8_t addr, bool is_read) {
  (void)ud;
  (void)addr;
  /* The pointer is not reset: a write-then-read relies on it. */
  bmp.first_byte = true;
  if (is_read) latch();
  return true;
}

static bool on_write(void* ud, uint8_t byte) {
  (void)ud;
  /* For a host that does not say where a read begins: after a write, the
   * next byte read is the first of a new read. */
  bmp.latch_due = true;
  if (bmp.first_byte) {
    bmp.pointer = byte;
    bmp.first_byte = false;
    return true;
  }
  /* The byte after a register's data is the next register's address. The
   * pointer stays where the pair put it: esp-idf-lib's bmp280_is_measuring
   * sends 0xF3 0xF4 and reads status and ctrl_meas back. */
  bmp.first_byte = true;
  write_register(bmp.pointer, byte);
  return true;
}

static uint8_t on_read(void* ud) {
  (void)ud;
  if (bmp.latch_due) latch();
  uint8_t reg = bmp.pointer;
  bmp.pointer = (uint8_t)(reg + 1);
  if (reg == REG_STATUS) {
    uint8_t status = bmp.measuring ? MEASURING : 0;
    bmp.measuring = false;
    return status;
  }
  if (reg >= SAMPLE_FIRST && reg <= SAMPLE_LAST && !bmp.measured) io.asleep_reads++;
  return bmp.regs[reg];
}

/* The pointer survives the STOP: Seeed_BMP280 writes it in one transaction and
 * reads in the next, and QEMU ends every write phase this way. */
static void on_stop(void* ud) {
  (void)ud;
  bmp.first_byte = true;
  bmp.latch_due = true;
}

/* The registers as a read would find them now, for a host that answers the
 * guest from a copy: in normal mode the data registers encoded from the
 * panel's values, and no `measuring`. */
__attribute__((export_name("chip_dump_registers"))) uint8_t* chip_dump_registers(void) {
  for (int i = 0; i < 256; i++) bmp.dump[i] = bmp.regs[i];
  if (mode() == MODE_NORMAL) {
    const uint8_t* l = live();
    for (int i = 0; i <= SAMPLE_LAST - SAMPLE_FIRST; i++) bmp.dump[SAMPLE_FIRST + i] = l[i];
  }
  return bmp.dump;
}

/* The entries the worker calls (i2c_host.h). Nothing here calls the host, and
 * every byte is ACKed: the worker may hold the events back and serve reads
 * from a peek. */
#define I2C_HOST_CONNECT(addr, is_read) on_connect(0, (addr), (is_read))
#define I2C_HOST_WRITE(byte) on_write(0, (byte))
#define I2C_HOST_READ() on_read(0)
#define I2C_HOST_STOP() on_stop(0)
#define I2C_HOST_DEFERRABLE 1
#include "i2c_host.h"

/* Power-on at the address the host pushed (SDO). */
void chip_setup(void) {
  calibration();
  power_on();
  bmp.first_byte = true;
  bmp.latch_due = true;
  vx_i2c_config cfg = {
      .address = io.address == 0x77 ? 0x77 : 0x76,
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
