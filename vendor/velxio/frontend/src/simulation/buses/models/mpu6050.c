/*
 * mpu6050.c: the InvenSense MPU-6050 6-axis IMU (and the MPU-9250 die) as
 * one portable model, on the velxio-chip.h ABI.
 *
 * Project i2c-model-fidelity-2026-09, P5 (decision O4): the model the tab and
 * the QEMU workers run for the part, as bmp280.c is for the BMP280. It is a
 * line-for-line port of the two hand-written copies, kept equal until now
 * only by replaying the same bus vectors, test/fixtures/i2c-vectors/mpu6050.json:
 *
 *   frontend/src/simulation/parts/ProtocolParts.ts   VirtualMPU6050 (the tab)
 *   backend/app/services/esp32_i2c_slaves.py         MPU6050Slave (the worker)
 *
 * Both stay, as the fallback a host takes when it cannot run this
 * (simulation/parts/wasmI2cModels.ts, backend/app/services/wasm_i2c_models.py).
 * The facts are the rules table MPU6050_RULES of both copies, the `rules` of
 * mpu6050.json; sections are those of the register map RM-MPU-6000A-00
 * rev 4.2 unless named otherwise.
 *
 * What the model does:
 *
 *  - It powers on asleep (PWR_MGMT_1 = 0x40; the MPU-9250 awake at 0x01), so
 *    a sketch that reads without waking it reads zeros, as on the bench.
 *  - DEVICE_RESET puts every register back to its power-on value and is gone
 *    before the next read (Adafruit_MPU6050::reset() polls it with no timeout).
 *    SIGNAL_PATH_RESET and the resets of USER_CTRL clear themselves too.
 *  - The panel is the world around the chip, not a register: it survives a
 *    reset, and the sample block 0x3B-0x48 is encoded from it and from the
 *    full-scale ranges the sketch selected when a read begins (the whole
 *    burst is one sample, 4.17). Half a count rounds away from zero and the
 *    counts saturate. Offsets (XG_OFFS_USR, the accelerometer trims) act
 *    before the output registers, the FIFO and the DMP (AN-OFFS 4).
 *  - Asleep, the block holds what it held when the chip fell asleep; so does
 *    an axis in standby and the temperature with TEMP_DIS. In CYCLE mode the
 *    block moves only at each wake-up, at LP_WAKE_CTRL.
 *  - Awake, it takes a sample every sample period of the guest's time, whether
 *    the sketch talks to it or not: DATA_RDY_INT, the INT pad by INT_PIN_CFG
 *    (a 50 us pulse, or latched), the FIFO (1024 bytes, 512 on the MPU-9250)
 *    with FIFO_COUNT latched at its high byte and FIFO_R_W popping without
 *    moving the pointer. With no guest clock one period passes per register
 *    pointer written.
 *  - BANK_SEL, MEM_START_ADDR and MEM_R_W reach 32 banks of DMP memory, with
 *    the ROM byte i2cdevlib reads as the hardware revision.
 *  - With DMP_EN and FIFO_EN, a DMP image it knows (MotionApps 2.0, 4.1 and
 *    6.12, told apart by the 16 bytes at the program start address of
 *    DMP_CFG_1/2) writes its packets into the FIFO at the rate its divider
 *    sets, with the orientation of the panel.
 *
 * ── What the chip needs from a host, and how it gets it ─────────────────
 *
 * The host PUSHES into `mpu_io` (the export chip_inputs returns its address)
 * and the model never calls out: a read calls no host, so the worker serves a
 * burst from one peek (i2c_host.h). The guest's clock is pushed before every
 * call, and the worker hands the time of every event it held back with the
 * event (I2C_HOST_TIMED), so the model sees each event at its own instant:
 *
 *   now_ns        offset 0, double: the guest's time in ns; NaN on a host
 *                 that keeps none (then the periods are the pointer writes)
 *   inputs        offset 8, 7 doubles: accelX, accelY, accelZ (g), gyroX,
 *                 gyroY, gyroZ (deg/s), temp (deg C), the panel's names
 *   not_before    offset 64, double: chip_int_wake's argument (NaN for none)
 *   wake_ns       offset 72, double: chip_int_wake's answer
 *   address       offset 80, uint32: 0x68 or 0x69 (AD0), read by chip_setup
 *   variant       offset 84, uint32: 0 the MPU-6050, 1 the MPU-9250, read by
 *                 chip_setup
 *   asleep_reads  offset 88, uint32, written by the model: reads of the
 *                 sample block while the chip sleeps (the tab's monitor note)
 *   dmp_unknown   offset 92, uint32, written by the model: starts of the DMP
 *                 on an image it does not know (the tab's monitor note)
 *   int_hint      offset 96, uint32, written by the model: bumped where what
 *                 the INT pad does, or when it moves next, may have changed
 *   pulses        offset 100, uint32, written by the model: INT pulses
 *                 started, ever (the ESP32 worker's timer thread counts them)
 *   int_state     offset 104, uint32, written by chip_i2c_event_int: what
 *                 chip_int_state answers after the event
 */
#include "velxio-chip.h"

double cos(double);
double sin(double);

typedef struct {
  double now_ns;
  double inputs[7];
  double not_before;
  double wake_ns;
  uint32_t address;
  uint32_t variant;
  uint32_t asleep_reads;
  uint32_t dmp_unknown;
  uint32_t int_hint;
  uint32_t pulses;
  uint32_t int_state;
  uint32_t reserved;
} mpu_io;

_Static_assert(sizeof(mpu_io) == 112, "mpu_io is the layout the hosts write");


/* ── The rules table (MPU6050_RULES) ─────────────────────────────────────── */

#define XG_OFFS_USR 0x13
#define SMPLRT_DIV 0x19
#define CONFIG 0x1A
#define GYRO_CONFIG 0x1B
#define ACCEL_CONFIG 0x1C
#define FIFO_EN 0x23
#define INT_PIN_CFG 0x37
#define INT_LEVEL 0x80 /* active low, against active high */
#define INT_OPEN 0x40  /* open drain, against push-pull */
#define LATCH_INT_EN 0x20
#define INT_RD_CLEAR 0x10
#define INT_ENABLE 0x38
#define INT_STATUS 0x3A
#define DATA_RDY_INT 0x01
#define DMP_INT 0x02 /* a DMP packet reached the FIFO (i2cdevlib) */
#define FIFO_OFLOW_INT 0x10
#define INT_SOURCES (DATA_RDY_INT | DMP_INT | FIFO_OFLOW_INT)
#define SAMPLE_INTS (DATA_RDY_INT | FIFO_OFLOW_INT)
#define DMP_INTS (DMP_INT | FIFO_OFLOW_INT)
#define SAMPLE_FIRST 0x3B
#define SAMPLE_SIZE 14
#define SIGNAL_PATH_RESET 0x68
#define USER_CTRL 0x6A
#define USER_DMP_EN 0x80
#define USER_FIFO_EN 0x40
#define DMP_RESET 0x08
#define FIFO_RESET 0x04
#define SIG_COND_RESET 0x01
#define PWR_MGMT_1 0x6B
#define DEVICE_RESET 0x80
#define SLEEP 0x40
#define CYCLE 0x20
#define TEMP_DIS 0x08
#define PWR_MGMT_2 0x6C
#define BANK_SEL 0x6D
#define MEM_START_ADDR 0x6E
#define MEM_R_W 0x6F
#define DMP_CFG_1 0x70
#define FIFO_COUNT_H 0x72
#define FIFO_COUNT_L 0x73
#define FIFO_R_W 0x74
#define WHO_AM_I 0x75
#define TEMP_FIELD 0x08
#define ALL_FIELDS 0x7F
#define INT_PULSE_NS 50000.0
#define FIFO_MAX 1024
#define DMP_BANKS 32
#define DMP_SIZE (DMP_BANKS * 256)
#define DMP_ROM_AT 0x1006
#define DMP_ROM_VALUE 0xA5
#define DMP_RATE_HZ 200.0
#define DMP_RATE_DIV_AT 0x216
#define ACCEL_OFFSET_LSB_PER_G 2048.0
#define GYRO_OFFSET_LSB_PER_DPS 32.8

static const double ACCEL_LSB_PER_G[4] = {16384, 8192, 4096, 2048};
static const double GYRO_LSB_PER_DPS[4] = {131, 65.5, 32.8, 16.4};
static const double CYCLE_RATE_HZ[4] = {1.25, 5, 20, 40};
/* The accelerometer's factory trims (OTP) of the MPU-6050, X, Y, Z, high byte
 * then low; bit 0 of each low byte is the product revision eMPL reads
 * (AN-OFFS 7.2). */
static const uint8_t FACTORY_TRIM[3][2] = {{0xFA, 0x38}, {0x04, 0xB3}, {0x05, 0xDC}};
static const uint8_t MPU6050_OFFS_REG[3] = {0x06, 0x08, 0x0A};

/* What a die changes of the MPU-6050's map (MPU6050_RULES.variants). */
typedef struct {
  uint8_t pwr_mgmt_1;
  uint8_t who_am_i;
  double temp_lsb_per_c;
  double temp_offset_c;
  uint8_t accel_offs_reg[3];
  uint32_t fifo_size;
} die_t;

static const die_t DIES[2] = {
    {0x40, 0x68, 340, 36.53, {0x06, 0x08, 0x0A}, 1024},
    /* MPU-9250 (RM-MPU-9250A-00 rev 1.6 4.22 and 4.39, PS-MPU-9250A-01 3.4.2). */
    {0x01, 0x71, 333.87, 21, {0x77, 0x7A, 0x7D}, 512},
};

/* The FIFO_EN bits in the order their data enters the FIFO (4.6, 4.31):
 * bit, offset in the sample block, bytes. */
static const uint8_t FIFO_SOURCES[5][3] = {
    {0x08, 0, 6}, {0x80, 6, 2}, {0x40, 8, 2}, {0x20, 10, 2}, {0x10, 12, 2}};
/* The PWR_MGMT_2 standby bits as fields of the sample block (ax = bit 0). */
static const uint8_t STBY_FIELDS[6][2] = {
    {0x20, 0x01}, {0x10, 0x02}, {0x08, 0x04}, {0x04, 0x10}, {0x02, 0x20}, {0x01, 0x40}};

/* The DMP images (MPU6050_RULES.dmp_images), in the order both copies try them. */
enum { F_QUAT32, F_GYRO32, F_ACCEL32, F_GYRO16, F_ACCEL16, F_MAG16, F_FOOTER, F_END };
static const uint8_t FIELD_BYTES[F_END] = {16, 12, 12, 6, 6, 6, 2};
typedef struct {
  uint16_t start;
  uint8_t signature[16];
  uint8_t layout[6];
  uint8_t size;
  double accel_lsb_per_g; /* 0: the counts ACCEL_CONFIG selects */
} dmp_image_t;

static const dmp_image_t DMP_IMAGES[3] = {
    /* MotionApps 2.0 */
    {0x300,
     {0xD8, 0xDC, 0xBA, 0xA2, 0xF1, 0xDE, 0xB2, 0xB8, 0xB4, 0xA8, 0x81, 0x91, 0xF7, 0x4A, 0x90, 0x7F},
     {F_QUAT32, F_GYRO32, F_ACCEL32, F_FOOTER, F_END},
     42,
     8192},
    /* MotionApps 4.1 (MPU-9150) */
    {0x300,
     {0xD8, 0xDC, 0xF4, 0xD8, 0xB9, 0xAB, 0xF3, 0xF8, 0xFA, 0xF1, 0xBA, 0xA2, 0xDE, 0xB2, 0xB8, 0xB4},
     {F_QUAT32, F_GYRO32, F_MAG16, F_ACCEL32, F_FOOTER, F_END},
     48,
     4096},
    /* MotionApps 6.12 */
    {0x400,
     {0xD8, 0xDC, 0xB4, 0xB8, 0xB0, 0xD8, 0xB9, 0xAB, 0xF3, 0xF8, 0xFA, 0xB3, 0xB7, 0xBB, 0x8E, 0x9E},
     {F_QUAT32, F_ACCEL16, F_GYRO16, F_END},
     28,
     0},
};
#define DMP_NONE (-1)
#define DMP_UNKNOWN (-2)

static bool read_only(uint8_t reg) {
  return reg == 0x36 || reg == 0x3A || (reg >= 0x3B && reg <= 0x60) || reg == 0x72 ||
         reg == 0x73 || reg == 0x75;
}

static uint8_t self_clearing(uint8_t reg) {
  return reg == SIGNAL_PATH_RESET ? 0xFF : reg == USER_CTRL ? 0x0F : reg == PWR_MGMT_1 ? 0x80 : 0;
}

/* The pointer stays on MEM_R_W and FIFO_R_W (pointer_stays). */
static bool pointer_stays(uint8_t reg) { return reg == MEM_R_W || reg == FIFO_R_W; }

/* ── State ───────────────────────────────────────────────────────────────── */

/* Everything a read can change, in one object: the worker's read-ahead copies
 * this aside and back (I2C_HOST_STATE, i2c_host.h), not the DMP memory. */
static struct {
  mpu_io io;
  struct {
    const die_t* die;
    uint8_t regs[256];
    /* The sample the read in progress is answered from. */
    uint8_t sample[SAMPLE_SIZE];
    /* What the fields that do not sample hold (SLEEP, standby, TEMP_DIS,
     * the last CYCLE wake-up); zeros after power-on and reset. */
    uint8_t held[SAMPLE_SIZE];
    bool latch_due;
    bool first_byte;
    uint8_t reg_ptr;
    /* Guest ns the sample periods are counted from (NaN: from the next look),
     * the samples taken since, and the period they were counted with. */
    double epoch_ns;
    int64_t taken;
    double period_ns;
    /* Where the INT pulse of the last sample ends (NaN: none). */
    double pulse_end_ns;
    uint8_t fifo[FIFO_MAX];
    uint32_t fifo_head;
    uint32_t fifo_count;
    uint8_t fifo_last;
    /* The image the DMP runs (DMP_NONE while it writes nothing), its packet
     * period, the periods counted as the samples', and its heading. */
    int dmp_image;
    double dmp_period_ns;
    double dmp_epoch_ns;
    int64_t dmp_taken;
    double dmp_yaw;
  } m;
} st = {
    /* At rest on the bench, as the panel starts. */
    .io = {__builtin_nan(""), {0, 0, 1, 0, 0, 0, 24}, 0, 0, 0x68, 0, 0, 0, 0, 0},
};

/* The DMP's 32 banks of memory. Only a write changes it. */
static uint8_t dmp_mem[DMP_SIZE];
/* The register copy chip_dump_registers hands out. */
static uint8_t dump_out[256];

__attribute__((export_name("chip_inputs"))) mpu_io* chip_inputs(void) { return &st.io; }

/* ── Numbers ─────────────────────────────────────────────────────────────── */

static bool isnan_(double x) { return x != x; }

/* A physical value as the counts of a 16-bit output register: half a count
 * away from zero, held to the ends of the scale (Rounding, README). */
static int32_t counts(double value) {
  double size = value < 0 ? -value : value;
  int32_t c;
  if (size < 32768) {
    double f = __builtin_floor(size);
    c = (int32_t)f;
    if (size - f >= 0.5) c += 1;
  } else {
    c = 32768; /* infinity included */
  }
  if (value >= 0) return c > 32767 ? 32767 : c;
  return -c;
}

/* A q30 fraction (1.0 = 2^30) as a 32-bit word, half away from zero, held to the word. */
static int32_t q30(double value) {
  double a = value < 0 ? -value : value;
  double q = __builtin_floor(a * 1073741824.0 + 0.5);
  if (value < 0) q = -q;
  if (q > 2147483647.0) q = 2147483647.0;
  if (q < -2147483648.0) q = -2147483648.0;
  return (int32_t)q;
}

static int32_t word_at(const uint8_t* b, int at) {
  return (int16_t)(uint16_t)((b[at] << 8) | b[at + 1]);
}

/* ── The chip ────────────────────────────────────────────────────────────── */

static bool asleep(void) { return (st.m.regs[PWR_MGMT_1] & SLEEP) != 0; }
static bool sampling(void) { return !asleep(); }
static bool latched(void) { return (st.m.regs[INT_PIN_CFG] & LATCH_INT_EN) != 0; }

/* CYCLE with SLEEP clear: one sample per wake-up (4.28). */
static bool cycling(void) { return (st.m.regs[PWR_MGMT_1] & (CYCLE | SLEEP)) == CYCLE; }

static double now(void) { return st.io.now_ns; }

static double sample_period_ns(void) {
  if (cycling()) return 1e9 / CYCLE_RATE_HZ[st.m.regs[PWR_MGMT_2] >> 6];
  uint8_t dlpf = st.m.regs[CONFIG] & 0x07;
  double rate = dlpf == 0 || dlpf == 7 ? 8000.0 : 1000.0;
  return ((1 + st.m.regs[SMPLRT_DIV]) * 1e9) / rate;
}

static uint8_t standby_fields(void) {
  uint8_t fields = 0;
  uint8_t stby = st.m.regs[PWR_MGMT_2];
  for (int i = 0; i < 6; i++)
    if (stby & STBY_FIELDS[i][0]) fields |= STBY_FIELDS[i][1];
  if (st.m.regs[PWR_MGMT_1] & TEMP_DIS) fields |= TEMP_FIELD;
  return fields;
}

static void encode(uint8_t out[SAMPLE_SIZE]) {
  const double* in = st.io.inputs;
  double accel = ACCEL_LSB_PER_G[(st.m.regs[ACCEL_CONFIG] >> 3) & 3];
  double gyro = GYRO_LSB_PER_DPS[(st.m.regs[GYRO_CONFIG] >> 3) & 3];
  double trim[3], drift[3];
  for (int axis = 0; axis < 3; axis++) {
    int32_t word = word_at(st.m.regs, st.m.die->accel_offs_reg[axis]);
    int32_t factory = word_at(FACTORY_TRIM[axis], 0);
    trim[axis] = ((double)((word & ~1) - (factory & ~1)) * accel) / ACCEL_OFFSET_LSB_PER_G;
    drift[axis] = ((double)word_at(st.m.regs, XG_OFFS_USR + 2 * axis) * gyro) / GYRO_OFFSET_LSB_PER_DPS;
  }
  double block[7] = {
      in[0] * accel + trim[0],
      in[1] * accel + trim[1],
      in[2] * accel + trim[2],
      (in[6] - st.m.die->temp_offset_c) * st.m.die->temp_lsb_per_c,
      in[3] * gyro + drift[0],
      in[4] * gyro + drift[1],
      in[5] * gyro + drift[2],
  };
  for (int i = 0; i < 7; i++) {
    int32_t c = counts(block[i]);
    out[2 * i] = (uint8_t)((c >> 8) & 0xFF);
    out[2 * i + 1] = (uint8_t)(c & 0xFF);
  }
}

/* The sample block as the chip's registers hold it now. */
static void output(uint8_t out[SAMPLE_SIZE]) {
  uint8_t frozen = asleep() || cycling() ? ALL_FIELDS : standby_fields();
  if (frozen == ALL_FIELDS) {
    __builtin_memcpy(out, st.m.held, SAMPLE_SIZE);
    return;
  }
  encode(out);
  for (int f = 0; f < 7; f++) {
    if (frozen & (1 << f)) {
      out[2 * f] = st.m.held[2 * f];
      out[2 * f + 1] = st.m.held[2 * f + 1];
    }
  }
}

/* ── The FIFO ────────────────────────────────────────────────────────────── */

/* One byte in; when it is full the oldest goes (4.31). */
static void fifo_push(uint8_t value) {
  uint32_t size = st.m.die->fifo_size;
  if (st.m.fifo_count == size) {
    st.m.fifo_head = (st.m.fifo_head + 1) % size;
    st.m.fifo_count--;
  }
  st.m.fifo[(st.m.fifo_head + st.m.fifo_count) % size] = value;
  st.m.fifo_count++;
}

static uint8_t fifo_pop(void) {
  if (st.m.fifo_count == 0) return st.m.fifo_last;
  st.m.fifo_last = st.m.fifo[st.m.fifo_head];
  st.m.fifo_head = (st.m.fifo_head + 1) % st.m.die->fifo_size;
  st.m.fifo_count--;
  return st.m.fifo_last;
}

static void fifo_empty(void) {
  st.m.fifo_head = 0;
  st.m.fifo_count = 0;
}

static int64_t min64(int64_t a, int64_t b) { return a < b ? a : b; }

/* `n` samples of the sources FIFO_EN selects, of one instant, while USER_CTRL
 * lets the FIFO take them; only as many as can still be in it afterwards are
 * pushed. Returns whether bytes were lost to a full FIFO. */
static bool fifo_samples(int64_t n) {
  if (!(st.m.regs[USER_CTRL] & USER_FIFO_EN)) return false;
  uint8_t sources = st.m.regs[FIFO_EN];
  if (!sources) return false;
  uint8_t block[SAMPLE_SIZE], packet[SAMPLE_SIZE];
  output(block);
  int len = 0;
  for (int i = 0; i < 5; i++) {
    if (sources & FIFO_SOURCES[i][0])
      for (int k = 0; k < FIFO_SOURCES[i][2]; k++) packet[len++] = block[FIFO_SOURCES[i][1] + k];
  }
  if (len == 0) return false;
  int64_t size = st.m.die->fifo_size;
  bool lost = (int64_t)st.m.fifo_count + n * len > size;
  int64_t pushes = min64(n, (size + len - 1) / len + 1);
  for (int64_t k = 0; k < pushes; k++)
    for (int i = 0; i < len; i++) fifo_push(packet[i]);
  return lost;
}

/* ── Interrupts ──────────────────────────────────────────────────────────── */

/* Interrupts happened at `at_ns` of the guest's time (NaN where no clock
 * measures it): only an enabled source raises its status bit (4.15, 4.16),
 * and a pulse has a length only where there is a clock; the later of two
 * events ends it. */
static void raise_int(uint8_t events, double at_ns) {
  uint8_t raised = st.m.regs[INT_ENABLE] & INT_SOURCES & events;
  if (!raised) return;
  st.m.regs[INT_STATUS] |= raised;
  if (!isnan_(at_ns) && !latched()) {
    double end = at_ns + INT_PULSE_NS;
    double from = isnan_(st.m.pulse_end_ns) ? 0 : st.m.pulse_end_ns;
    st.m.pulse_end_ns = from > end ? from : end;
    st.io.pulses++;
  }
}

static bool int_active(void) {
  if (latched()) return (st.m.regs[INT_STATUS] & st.m.regs[INT_ENABLE] & INT_SOURCES) != 0;
  double t = now();
  return !isnan_(st.m.pulse_end_ns) && !isnan_(t) && t < st.m.pulse_end_ns;
}

/* What the pad does when active or not: 0 low, 1 high, 2 let go (open drain). */
static int pad_of(bool active) {
  uint8_t cfg = st.m.regs[INT_PIN_CFG];
  bool high = active != ((cfg & INT_LEVEL) != 0);
  if (!high) return 0;
  return (cfg & INT_OPEN) ? 2 : 1;
}

/* ── The DMP ─────────────────────────────────────────────────────────────── */

/* The orientation the DMP reports, the unit quaternion (w, x, y, z): the
 * shortest turn that takes the accelerometer's direction to the vertical,
 * then `yaw` about the vertical (mpuDmpQuaternion, mpu_dmp_quaternion). */
static void dmp_quaternion(double ax, double ay, double az, double yaw, double q[4]) {
  double n = __builtin_sqrt(ax * ax + ay * ay + az * az);
  double tw = 1, tx = 0, ty = 0;
  if (n > 0) {
    tw = 1 + az / n;
    tx = ay / n;
    ty = -ax / n;
    double mm = __builtin_sqrt(tw * tw + tx * tx + ty * ty);
    if (mm < 1e-9) {
      tw = 0;
      tx = 1;
      ty = 0;
    } else {
      tw /= mm;
      tx /= mm;
      ty /= mm;
    }
  }
  double c = cos(yaw / 2);
  double s = sin(yaw / 2);
  q[0] = c * tw;
  q[1] = c * tx - s * ty;
  q[2] = c * ty + s * tx;
  q[3] = s * tw;
}

/* How far the heading turns in one DMP period, in radians: the gyroscope
 * along the accelerometer's direction. */
static double dmp_heading_step(const uint8_t* block, double gyro_lsb, double period_ns) {
  double ax = word_at(block, 0), ay = word_at(block, 2), az = word_at(block, 4);
  double gx = word_at(block, 8), gy = word_at(block, 10), gz = word_at(block, 12);
  double n = __builtin_sqrt(ax * ax + ay * ay + az * az);
  if (n == 0) return 0;
  double rate = (gx * ax + gy * ay + gz * az) / n / gyro_lsb;
  return ((rate * period_ns) / 1e9) * (3.141592653589793 / 180);
}

static void push32(int32_t v) {
  fifo_push((uint8_t)((uint32_t)v >> 24));
  fifo_push((uint8_t)((uint32_t)v >> 16));
  fifo_push((uint8_t)((uint32_t)v >> 8));
  fifo_push((uint8_t)v);
}

static void push16(int32_t v) {
  fifo_push((uint8_t)((uint32_t)v >> 8));
  fifo_push((uint8_t)v);
}

/* One packet of `image` into the FIFO, from the sample block and the heading
 * (mpuDmpPacket, mpu_dmp_packet). */
static void dmp_packet(const dmp_image_t* image, const uint8_t* block, double accel_lsb, double yaw) {
  int32_t accel[3] = {word_at(block, 0), word_at(block, 2), word_at(block, 4)};
  int32_t gyro[3] = {word_at(block, 8), word_at(block, 10), word_at(block, 12)};
  int32_t dmp_accel[3];
  for (int i = 0; i < 3; i++)
    dmp_accel[i] = image->accel_lsb_per_g == 0
                       ? accel[i]
                       : counts((accel[i] * image->accel_lsb_per_g) / accel_lsb);
  for (int f = 0; image->layout[f] != F_END; f++) {
    switch (image->layout[f]) {
      case F_QUAT32: {
        double q[4];
        dmp_quaternion(accel[0], accel[1], accel[2], yaw, q);
        for (int i = 0; i < 4; i++) push32(q30(q[i]));
        break;
      }
      case F_GYRO32:
        for (int i = 0; i < 3; i++) push32((int32_t)((uint32_t)gyro[i] << 16));
        break;
      case F_ACCEL32:
        for (int i = 0; i < 3; i++) push32((int32_t)((uint32_t)dmp_accel[i] << 16));
        break;
      case F_GYRO16:
        for (int i = 0; i < 3; i++) push16(gyro[i]);
        break;
      case F_ACCEL16:
        for (int i = 0; i < 3; i++) push16(dmp_accel[i]);
        break;
      default:
        for (int i = 0; i < FIELD_BYTES[image->layout[f]]; i++) fifo_push(0);
    }
  }
}

/* The DMP wrote `n` packets, the last at `at_ns`: of one instant, the heading
 * turning by one period's worth per packet whether or not the FIFO keeps it. */
static void dmp_packets(int64_t n, double at_ns) {
  const dmp_image_t* image = &DMP_IMAGES[st.m.dmp_image];
  uint8_t block[SAMPLE_SIZE];
  output(block);
  double accel_lsb = ACCEL_LSB_PER_G[(st.m.regs[ACCEL_CONFIG] >> 3) & 3];
  double gyro_lsb = GYRO_LSB_PER_DPS[(st.m.regs[GYRO_CONFIG] >> 3) & 3];
  double step = dmp_heading_step(block, gyro_lsb, st.m.dmp_period_ns);
  int64_t size = st.m.die->fifo_size;
  bool lost = (int64_t)st.m.fifo_count + n * image->size > size;
  int64_t pushes = min64(n, (size + image->size - 1) / image->size + 1);
  for (int64_t k = 0; k < n - pushes; k++) st.m.dmp_yaw += step;
  for (int64_t k = 0; k < pushes; k++) {
    st.m.dmp_yaw += step;
    dmp_packet(image, block, accel_lsb, st.m.dmp_yaw);
  }
  raise_int(DMP_INT | (lost ? FIFO_OFLOW_INT : 0), at_ns);
}

/* The image the DMP runs now: while the chip is awake and USER_CTRL has
 * DMP_EN and FIFO_EN, from the program start address of DMP_CFG_1/2. */
static int dmp_runnable(void) {
  uint8_t both = USER_DMP_EN | USER_FIFO_EN;
  if (!sampling() || (st.m.regs[USER_CTRL] & both) != both) return DMP_NONE;
  uint32_t start = (uint32_t)((st.m.regs[DMP_CFG_1] << 8) | st.m.regs[DMP_CFG_1 + 1]) % DMP_SIZE;
  for (int i = 0; i < 3; i++) {
    if (DMP_IMAGES[i].start == start &&
        __builtin_memcmp(dmp_mem + start, DMP_IMAGES[i].signature, 16) == 0)
      return i;
  }
  return DMP_UNKNOWN;
}

/* The DMP period its divider sets (D_0_22, bank 2 byte 0x16), in ns. */
static double dmp_period_of(void) {
  uint32_t divider = (dmp_mem[DMP_RATE_DIV_AT] << 8) | dmp_mem[DMP_RATE_DIV_AT + 1];
  return ((1 + divider) * 1e9) / DMP_RATE_HZ;
}

/* After a write: the DMP starts, stops, or runs at another rate. A start (and
 * DMP_RESET) puts the heading back to zero, the first packet one period on. */
static void dmp_follow(bool reset) {
  int runnable = dmp_runnable();
  int image = runnable == DMP_UNKNOWN ? DMP_NONE : runnable;
  if (runnable == DMP_UNKNOWN) st.io.dmp_unknown++;
  double period = image != DMP_NONE ? dmp_period_of() : 0;
  if (image == st.m.dmp_image && period == st.m.dmp_period_ns && !reset) return;
  if (image != st.m.dmp_image || reset) st.m.dmp_yaw = 0;
  st.m.dmp_image = image;
  st.m.dmp_period_ns = period;
  st.m.dmp_epoch_ns = image != DMP_NONE ? now() : __builtin_nan("");
  st.m.dmp_taken = 0;
}

/* ── Sampling ────────────────────────────────────────────────────────────── */

/* The periods are counted from this instant: the chip woke, its rate
 * changed, or the clock it measures on did. */
static void restart_sampling(void) {
  st.m.epoch_ns = sampling() ? now() : __builtin_nan("");
  st.m.taken = 0;
  st.m.period_ns = sample_period_ns();
  st.m.pulse_end_ns = __builtin_nan("");
  st.m.dmp_epoch_ns = st.m.dmp_image != DMP_NONE ? now() : __builtin_nan("");
  st.m.dmp_taken = 0;
}

/* `n` samples were taken, the last at `at_ns`. */
static void sampled(int64_t n, double at_ns) {
  /* A CYCLE wake-up samples what is not in standby, and holds it. */
  if (cycling()) {
    uint8_t live[SAMPLE_SIZE];
    encode(live);
    uint8_t stby = standby_fields();
    for (int f = 0; f < 7; f++) {
      if (!(stby & (1 << f))) {
        st.m.held[2 * f] = live[2 * f];
        st.m.held[2 * f + 1] = live[2 * f + 1];
      }
    }
  }
  uint8_t events = DATA_RDY_INT;
  if (fifo_samples(n)) events |= FIFO_OFLOW_INT;
  raise_int(events, at_ns);
}

static void sync_samples(double t) {
  if (isnan_(st.m.epoch_ns) || t < st.m.epoch_ns) {
    /* A clock that was not there when the chip woke, or one that started
     * again: the first sample is one period from here. */
    st.m.epoch_ns = t;
    st.m.taken = 0;
    return;
  }
  int64_t due = (int64_t)__builtin_floor((t - st.m.epoch_ns) / st.m.period_ns);
  if (due <= st.m.taken) return;
  int64_t n = due - st.m.taken;
  st.m.taken = due;
  sampled(n, st.m.epoch_ns + (double)due * st.m.period_ns);
}

static void sync_dmp(double t) {
  if (st.m.dmp_image == DMP_NONE) return;
  if (isnan_(st.m.dmp_epoch_ns) || t < st.m.dmp_epoch_ns) {
    st.m.dmp_epoch_ns = t;
    st.m.dmp_taken = 0;
    return;
  }
  int64_t due = (int64_t)__builtin_floor((t - st.m.dmp_epoch_ns) / st.m.dmp_period_ns);
  if (due <= st.m.dmp_taken) return;
  int64_t n = due - st.m.dmp_taken;
  st.m.dmp_taken = due;
  dmp_packets(n, st.m.dmp_epoch_ns + (double)due * st.m.dmp_period_ns);
}

/* Take the samples that came due since the chip was last looked at, before
 * anything reads or changes what a sample depends on. */
static void sync(void) {
  if (!sampling()) return;
  double t = now();
  if (isnan_(t)) {
    /* No time to measure on: the periods are the ticks of on_write. */
    st.m.epoch_ns = __builtin_nan("");
    st.m.dmp_epoch_ns = __builtin_nan("");
    return;
  }
  sync_samples(t);
  sync_dmp(t);
}

/* One sample period passed on a host where nothing measures it; a DMP that
 * runs writes one packet in it. */
static void tick(void) {
  if (!sampling()) return;
  sampled(1, __builtin_nan(""));
  if (st.m.dmp_image != DMP_NONE) dmp_packets(1, __builtin_nan(""));
}

/* The guest time before which a read gives what it gives now: the next
 * sample or DMP packet due (i2c_host.h, I2C_HOST_TIMED). A nanosecond early,
 * so the division that counts the periods cannot round across it. */
static double valid_until(void) {
  double t = now();
  if (!sampling() || isnan_(t)) return __builtin_inf();
  double next = __builtin_inf();
  if (!isnan_(st.m.epoch_ns)) next = st.m.epoch_ns + (double)(st.m.taken + 1) * st.m.period_ns;
  if (st.m.dmp_image != DMP_NONE && !isnan_(st.m.dmp_epoch_ns)) {
    double packet = st.m.dmp_epoch_ns + (double)(st.m.dmp_taken + 1) * st.m.dmp_period_ns;
    if (packet < next) next = packet;
  }
  return next - 1.0;
}

/* ── Registers ───────────────────────────────────────────────────────────── */

static void power_on(void) {
  __builtin_memset(st.m.regs, 0, sizeof st.m.regs);
  /* The factory trims go to the offset registers of the die; a die whose map
   * has none at the MPU-6050's reads 0x00 there. */
  for (int axis = 0; axis < 3; axis++) {
    st.m.regs[st.m.die->accel_offs_reg[axis]] = FACTORY_TRIM[axis][0];
    st.m.regs[st.m.die->accel_offs_reg[axis] + 1] = FACTORY_TRIM[axis][1];
  }
  st.m.regs[PWR_MGMT_1] = st.m.die->pwr_mgmt_1;
  st.m.regs[WHO_AM_I] = st.m.die->who_am_i;
  __builtin_memset(st.m.held, 0, sizeof st.m.held);
  fifo_empty();
  st.m.fifo_last = 0;
  __builtin_memset(dmp_mem, 0, sizeof dmp_mem);
  dmp_mem[DMP_ROM_AT] = DMP_ROM_VALUE;
  st.m.dmp_image = DMP_NONE;
  st.m.dmp_period_ns = 0;
  st.m.dmp_yaw = 0;
  restart_sampling();
}

/* Where MEM_R_W reads or writes, the address moving on within its bank. */
static uint32_t dmp_cell(void) {
  uint32_t at = ((uint32_t)(st.m.regs[BANK_SEL] & 0x1F) << 8) | st.m.regs[MEM_START_ADDR];
  st.m.regs[MEM_START_ADDR] = (uint8_t)(st.m.regs[MEM_START_ADDR] + 1);
  return at % DMP_SIZE;
}

static uint8_t read_register(uint8_t reg) {
  if (reg == FIFO_COUNT_H) {
    /* Both bytes are latched when the high one is read (4.30). */
    st.m.regs[FIFO_COUNT_H] = (uint8_t)(st.m.fifo_count >> 8);
    st.m.regs[FIFO_COUNT_L] = (uint8_t)(st.m.fifo_count & 0xFF);
  }
  if (reg == FIFO_R_W) return fifo_pop();
  if (reg == MEM_R_W) return dmp_mem[dmp_cell()];
  if (reg < SAMPLE_FIRST || reg >= SAMPLE_FIRST + SAMPLE_SIZE) return st.m.regs[reg];
  if (asleep()) st.io.asleep_reads++;
  return st.m.sample[reg - SAMPLE_FIRST];
}

static void write_register(uint8_t reg, uint8_t value) {
  if (read_only(reg)) return;
  if (reg == PWR_MGMT_1 && (value & DEVICE_RESET)) {
    /* Nothing of the byte is kept: Adafruit's read-modify-write sends 0xC0
     * and then has to read 0x40. */
    power_on();
    return;
  }
  /* SIG_COND_RESET clears the sensor registers too (4.27). */
  if (reg == USER_CTRL && (value & SIG_COND_RESET)) __builtin_memset(st.m.held, 0, sizeof st.m.held);
  /* FIFO_RESET empties it enabled or not (i2cdevlib resetFIFO counts on it). */
  if (reg == USER_CTRL && (value & FIFO_RESET)) fifo_empty();
  if (reg == FIFO_R_W) {
    fifo_push(value);
    return;
  }
  if (reg == MEM_R_W) {
    dmp_mem[dmp_cell()] = value;
    /* A divider written while the DMP runs changes its rate. */
    if (st.m.dmp_image != DMP_NONE) dmp_follow(false);
    return;
  }
  uint8_t stored = value & (uint8_t)~self_clearing(reg);
  /* What sampled until now holds this instant from here on if the write stops it. */
  if (reg == PWR_MGMT_1 || reg == PWR_MGMT_2) {
    uint8_t now_held[SAMPLE_SIZE];
    output(now_held);
    __builtin_memcpy(st.m.held, now_held, SAMPLE_SIZE);
  }
  bool was_sampling = sampling();
  st.m.regs[reg] = stored;
  /* Waking up, or another rate: the first sample is one period from here. */
  if (sampling() != was_sampling || sample_period_ns() != st.m.period_ns) restart_sampling();
  dmp_follow(reg == USER_CTRL && (value & DMP_RESET));
}

static void latch(void) {
  output(st.m.sample);
  st.m.latch_due = false;
}

/* ── The bus ─────────────────────────────────────────────────────────────── */

static bool on_connect(void* ud, uint8_t addr, bool is_read) {
  (void)ud;
  (void)addr;
  /* The pointer is not reset: a write-then-read relies on it. */
  st.m.first_byte = true;
  sync();
  if (is_read) latch();
  st.io.int_hint++;
  return true;
}

static bool on_write(void* ud, uint8_t byte) {
  (void)ud;
  /* For a host that does not say where a read begins: after a write, the
   * next byte read is the first of a new read. */
  st.m.latch_due = true;
  if (st.m.first_byte) {
    st.m.reg_ptr = byte;
    st.m.first_byte = false;
    /* Every register access starts with a pointer: where there is no time
     * to read, this is the chip's tick. */
    if (isnan_(now()))
      tick();
    else
      sync();
    return true;
  }
  sync();
  uint8_t reg = st.m.reg_ptr;
  st.m.reg_ptr = pointer_stays(reg) ? reg : (uint8_t)(reg + 1);
  write_register(reg, byte);
  st.io.int_hint++;
  return true;
}

static uint8_t on_read(void* ud) {
  (void)ud;
  sync();
  if (st.m.latch_due) latch();
  uint8_t reg = st.m.reg_ptr;
  st.m.reg_ptr = pointer_stays(reg) ? reg : (uint8_t)(reg + 1);
  uint8_t value = read_register(reg);
  /* What the read takes with it goes at the read, not at the STOP (4.16;
   * with INT_RD_CLEAR any read clears it, 4.14). */
  uint8_t cleared = (st.m.regs[INT_PIN_CFG] & INT_RD_CLEAR) ? 0xFF : reg == INT_STATUS ? 0xFF : 0;
  if (cleared && (st.m.regs[INT_STATUS] & cleared)) {
    st.m.regs[INT_STATUS] &= (uint8_t)~cleared;
    st.io.int_hint++;
  }
  return value;
}

/* The pointer survives the STOP: i2cdevlib writes it in one transaction and
 * reads in the next, and QEMU ends every write phase this way. */
static void on_stop(void* ud) {
  (void)ud;
  st.m.first_byte = true;
  st.m.latch_due = true;
}

/* ── What a host asks besides the bus ────────────────────────────────────── */

/* The samples due now, before the panel moves (setInputs, update). */
__attribute__((export_name("chip_sync"))) void chip_sync(void) { sync(); }

/* The clock the chip measures on changed (setClock), or the MCU was reset
 * (boardReset): the periods are counted from where the guest stands now. */
__attribute__((export_name("chip_restart_sampling"))) void chip_restart_sampling(void) {
  restart_sampling();
  st.io.int_hint++;
}

/* What the INT pad does at this instant: 0 low, 1 high, 2 let go. */
__attribute__((export_name("chip_int_pad"))) int chip_int_pad(void) {
  sync();
  return pad_of(int_active());
}

/* All the ESP32 worker's pad driver asks after an event, in one call: what
 * the pad does now, and when active and when idle (pad | active << 4 |
 * idle << 8), with the samples due taken, so io.pulses is current too. */
__attribute__((export_name("chip_int_state"))) int chip_int_state(void) {
  sync();
  return pad_of(int_active()) | (pad_of(true) << 4) | (pad_of(false) << 8);
}

/* The guest time at which the pad moves next with nobody touching the chip,
 * into io.wake_ns; 0 when nothing is due. With io.not_before (not NaN), the
 * first sample at or past it instead of the next one; a pulse under way
 * still ends when it ends. */
__attribute__((export_name("chip_int_wake"))) int chip_int_wake(void) {
  if (!sampling()) return 0;
  sync();
  double t = now();
  if (isnan_(t)) return 0;
  if (latched()) {
    if (int_active()) return 0;
  } else if (!isnan_(st.m.pulse_end_ns) && t < st.m.pulse_end_ns) {
    st.io.wake_ns = st.m.pulse_end_ns;
    return 1;
  }
  uint8_t enabled = st.m.regs[INT_ENABLE];
  double nb = st.io.not_before;
  double next = __builtin_nan("");
  if (!isnan_(st.m.epoch_ns) && (enabled & SAMPLE_INTS)) {
    double k = (double)(st.m.taken + 1);
    if (!isnan_(nb)) {
      double first = __builtin_ceil((nb - st.m.epoch_ns) / st.m.period_ns);
      if (first > k) k = first;
    }
    next = st.m.epoch_ns + k * st.m.period_ns;
  }
  if (st.m.dmp_image != DMP_NONE && !isnan_(st.m.dmp_epoch_ns) && (enabled & DMP_INTS)) {
    double k = (double)(st.m.dmp_taken + 1);
    if (!isnan_(nb)) {
      double first = __builtin_ceil((nb - st.m.dmp_epoch_ns) / st.m.dmp_period_ns);
      if (first > k) k = first;
    }
    double packet = st.m.dmp_epoch_ns + k * st.m.dmp_period_ns;
    if (isnan_(next) || packet < next) next = packet;
  }
  if (isnan_(next)) return 0;
  st.io.wake_ns = next;
  return 1;
}

/* Where the register pointer is (the worker's I2C trace). */
__attribute__((export_name("chip_pointer"))) int chip_pointer(void) { return st.m.reg_ptr; }

/* The registers as a read would find them now, for a host that answers the
 * guest from a copy: the sample block encoded from the panel's values (or
 * what a sleeping chip holds), the FIFO count as it stands, no trigger bit.
 * Nothing is cleared: it is not a read on the bus. */
__attribute__((export_name("chip_dump_registers"))) uint8_t* chip_dump_registers(void) {
  sync();
  __builtin_memcpy(dump_out, st.m.regs, 256);
  output(dump_out + SAMPLE_FIRST);
  dump_out[FIFO_COUNT_H] = (uint8_t)(st.m.fifo_count >> 8);
  dump_out[FIFO_COUNT_L] = (uint8_t)(st.m.fifo_count & 0xFF);
  return dump_out;
}

/* The entries the worker calls (i2c_host.h). Nothing here calls the host,
 * every byte is ACKed, and the time of each event is data: the worker may
 * hold the events back with their times and serve reads from a peek until
 * the next sample is due. */
#define I2C_HOST_CONNECT(addr, is_read) on_connect(0, (addr), (is_read))
#define I2C_HOST_WRITE(byte) on_write(0, (byte))
#define I2C_HOST_READ() on_read(0)
#define I2C_HOST_STOP() on_stop(0)
#define I2C_HOST_DEFERRABLE 1
#define I2C_HOST_TIMED 1
#define I2C_HOST_TIME_GET() (st.io.now_ns)
#define I2C_HOST_TIME_SET(t) (st.io.now_ns = (t))
#define I2C_HOST_VALID_UNTIL() valid_until()
#define I2C_HOST_STATE st
#include "i2c_host.h"

/* One bus event and then the pad, for a worker that drives the INT pin and
 * looks at it after every event: chip_i2c_event, then chip_int_state into
 * io.int_state, so the look costs the host no second call. */
__attribute__((export_name("chip_i2c_event_int"))) int chip_i2c_event_int(int event, int addr) {
  int answer = chip_i2c_event(event, addr);
  st.io.int_state = (uint32_t)chip_int_state();
  return answer;
}

/* Power-on as the die the host pushed, at the address it pushed (AD0, or the
 * worker record's `addr`). */
void chip_setup(void) {
  st.m.die = &DIES[st.io.variant == 1 ? 1 : 0];
  power_on();
  st.m.first_byte = true;
  st.m.latch_due = true;
  vx_i2c_config cfg = {
      .address = st.io.address ? st.io.address & 0x7F : 0x68,
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
