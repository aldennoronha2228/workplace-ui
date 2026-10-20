/*
 * abi-probe.c: the cross-host conformance fixture for the whole chip ABI
 * (board-buses F7).
 *
 * ONE artifact, one table, every host. The same abi-probe.wasm is run by
 * ChipRuntime.ts in the browser and by WasmChipRuntime in the QEMU workers
 * (and, for the calls the Linux boards forward, by their adapter), each
 * driven the way that host drives a chip in production and asserted against
 * the same list of expected answers (expectations.json). A chip that models
 * an MCP3008 or a display has to see the same callbacks in the same order
 * wherever it lands; a call that differs by host is the per-engine divergence
 * this project exists to remove, and where a host legitimately cannot do
 * something (the worker has no pad model) the table says so on that row.
 *
 * The chip does nothing on its own. It registers one of everything the
 * header offers and RECORDS every callback it receives into a trace the test
 * reads back through exported probe functions:
 *
 *   SPI     two handles: 0 on CS answers from its armed buffer (on_done),
 *           1 on CS2 answers each byte as it comes (on_exchange) and keeps
 *           a buffer armed for the look-ahead a bit-banged master reads.
 *   I2C     two addresses (0x42, 0x43) on the same SDA/SCL: one chip, two
 *           targets, each with its own register pointer.
 *   UART    one handle on RX/TX at 9600.
 *   pins    IN (watched, both edges), OUT (output, low at reset), DIR
 *           (an input the test flips to output and back: the tri-state idiom).
 *   timer   one, whose callback records vx_sim_now_nanos at the fire.
 *   attrs   a number (gain, default 3) and a string (label, default "abc").
 *   blob    "card", reached through the same three calls as blob-probe.c.
 *
 * The probe surface is what the tests call: arm or stop a transfer, write or
 * read a pin, start the timer, read the trace. The chip never re-arms from
 * inside on_done, on purpose: a host that reports one completion twice shows
 * it here as two records.
 */
#include "velxio-chip.h"
#include <string.h>

/* ── The trace ──────────────────────────────────────────────────────────── */

enum {
  T_SPI_DONE    = 1,   /* a: handle, b: count, c: which buffer (0/1, 2 = neither) */
  T_SPI_RXB     = 2,   /* a: index,  b: the MOSI byte the buffer holds */
  T_SPI_XCHG    = 3,   /* a: mosi,   b: the miso it answered */
  T_I2C_CONNECT = 4,   /* a: slot,   b: addr, c: is_read */
  T_I2C_WRITE   = 5,   /* a: slot,   b: byte */
  T_I2C_READ    = 6,   /* a: slot,   b: the byte it served */
  T_I2C_STOP    = 7,   /* a: slot */
  T_UART_RX     = 8,   /* a: byte */
  T_UART_TXDONE = 9,
  T_PIN         = 10,  /* a: which (see pick_pin), b: level */
  T_TIMER       = 11,  /* a: now low 32, b: now high 32 */
};

typedef struct { uint32_t kind, a, b, c; } rec_t;

#define TRACE_LEN 256u
static rec_t    trace[TRACE_LEN];
static uint32_t trace_n;

static void rec(uint32_t kind, uint32_t a, uint32_t b, uint32_t c) {
  if (trace_n < TRACE_LEN) {
    trace[trace_n].kind = kind;
    trace[trace_n].a = a;
    trace[trace_n].b = b;
    trace[trace_n].c = c;
    trace_n++;
  }
}

/* ── State ──────────────────────────────────────────────────────────────── */

/* Pins, by the index the probe surface uses (pick_pin). AIN and AIN2 are the
 * analog pads: AIN is the one a scenario wires to a solved net, AIN2 stays in
 * the air, and neither is on the board's pin table. */
enum { P_IN = 0, P_OUT = 1, P_DIR = 2, P_CS = 3, P_CS2 = 4, P_AIN = 5, P_AIN2 = 6 };
#define P_COUNT 7
static vx_pin pins[P_COUNT];
static vx_pin p_sck, p_mosi, p_miso, p_sda, p_scl, p_rx, p_tx;

static vx_spi  spi[2];
static uint8_t spi_buf[2][8];
static int     auto_arm;   /* the CS idiom of the API reference, on demand */

static vx_i2c  i2c[2];
static uint8_t i2c_reg[2];

static vx_uart  uart;
static vx_timer tmr;
static vx_attr  a_gain, a_label;

#define SCRATCH_LEN 64u
static uint8_t scratch[SCRATCH_LEN];

/* ── SPI ────────────────────────────────────────────────────────────────── */

static uint32_t which_buf(const uint8_t* p) {
  if (p == spi_buf[0]) return 0;
  if (p == spi_buf[1]) return 1;
  return 2;
}

static void spi_done(void* ud, uint8_t* buffer, uint32_t count) {
  uint32_t h = (uint32_t)(uintptr_t)ud;
  rec(T_SPI_DONE, h, count, which_buf(buffer));
  for (uint32_t i = 0; i < count && i < 8; i++) rec(T_SPI_RXB, i, buffer[i], 0);
}

static uint8_t spi_exchange(void* ud, uint8_t mosi) {
  (void)ud;
  uint8_t miso = (uint8_t)(mosi ^ 0xFF);
  rec(T_SPI_XCHG, mosi, miso, 0);
  return miso;
}

static void arm(uint32_t h, uint32_t n, uint32_t seed) {
  if (n > 8) n = 8;
  for (uint32_t i = 0; i < n; i++) spi_buf[h][i] = (uint8_t)(seed + i);
  vx_spi_start(spi[h], spi_buf[h], n);
}

/* ── I2C ────────────────────────────────────────────────────────────────── */

static bool i2c_connect(void* ud, uint8_t addr, bool is_read) {
  rec(T_I2C_CONNECT, (uint32_t)(uintptr_t)ud, addr, is_read ? 1 : 0);
  return true;
}

static bool i2c_write(void* ud, uint8_t byte) {
  uint32_t slot = (uint32_t)(uintptr_t)ud;
  rec(T_I2C_WRITE, slot, byte, 0);
  /* One byte the chip refuses, so a NAK's path is on the table too. */
  if (byte == 0xEE) return false;
  i2c_reg[slot] = byte;
  return true;
}

static uint8_t i2c_read(void* ud) {
  uint32_t slot = (uint32_t)(uintptr_t)ud;
  uint8_t v = (uint8_t)((slot == 0 ? 0x30 : 0x40) + i2c_reg[slot]);
  i2c_reg[slot]++;
  rec(T_I2C_READ, slot, v, 0);
  return v;
}

static void i2c_stop(void* ud) {
  rec(T_I2C_STOP, (uint32_t)(uintptr_t)ud, 0, 0);
}

/* ── UART ───────────────────────────────────────────────────────────────── */

static void uart_rx(void* ud, uint8_t byte) {
  (void)ud;
  rec(T_UART_RX, byte, 0, 0);
}

static void uart_tx_done(void* ud) {
  (void)ud;
  rec(T_UART_TXDONE, 0, 0, 0);
}

/* ── Pins and timer ─────────────────────────────────────────────────────── */

static void on_pin(void* ud, vx_pin pin, int value) {
  uint32_t which = (uint32_t)(uintptr_t)ud;
  (void)pin;
  rec(T_PIN, which, (uint32_t)value, 0);
  if (which == P_CS && auto_arm) {
    if (value == VX_LOW) arm(0, 3, 0xA0);
    else vx_spi_stop(spi[0]);
  }
}

static void on_tick(void* ud) {
  (void)ud;
  uint64_t now = vx_sim_now_nanos();
  rec(T_TIMER, (uint32_t)(now & 0xFFFFFFFFu), (uint32_t)(now >> 32), 0);
}

/* ── Setup ──────────────────────────────────────────────────────────────── */

void chip_setup(void) {
  pins[P_IN]  = vx_pin_register("IN",  VX_INPUT);
  pins[P_OUT] = vx_pin_register("OUT", VX_OUTPUT_LOW);
  pins[P_DIR] = vx_pin_register("DIR", VX_INPUT);
  pins[P_CS]  = vx_pin_register("CS",  VX_INPUT_PULLUP);
  pins[P_CS2] = vx_pin_register("CS2", VX_INPUT_PULLUP);
  pins[P_AIN]  = vx_pin_register("AIN",  VX_INPUT);
  pins[P_AIN2] = vx_pin_register("AIN2", VX_INPUT);
  p_sck  = vx_pin_register("SCK",  VX_INPUT);
  p_mosi = vx_pin_register("MOSI", VX_INPUT);
  p_miso = vx_pin_register("MISO", VX_INPUT);
  p_sda  = vx_pin_register("SDA",  VX_INPUT);
  p_scl  = vx_pin_register("SCL",  VX_INPUT);
  p_rx   = vx_pin_register("RX",   VX_INPUT);
  p_tx   = vx_pin_register("TX",   VX_OUTPUT_HIGH);

  a_gain  = vx_attr_register("gain", 3.0);
  a_label = vx_attr_register_string("label", "abc");

  vx_spi_config s0 = {0};
  s0.sck = p_sck; s0.mosi = p_mosi; s0.miso = p_miso; s0.cs = pins[P_CS];
  s0.mode = 0;
  s0.on_done = spi_done;
  s0.user_data = (void*)(uintptr_t)0;
  spi[0] = vx_spi_attach(&s0);

  vx_spi_config s1 = {0};
  s1.sck = p_sck; s1.mosi = p_mosi; s1.miso = p_miso; s1.cs = pins[P_CS2];
  s1.mode = 0;
  s1.on_done = spi_done;
  s1.on_exchange = spi_exchange;
  s1.user_data = (void*)(uintptr_t)1;
  spi[1] = vx_spi_attach(&s1);

  for (uint32_t k = 0; k < 2; k++) {
    vx_i2c_config c = {0};
    c.address = (uint8_t)(0x42 + k);
    c.scl = p_scl;
    c.sda = p_sda;
    c.on_connect = i2c_connect;
    c.on_read = i2c_read;
    c.on_write = i2c_write;
    c.on_stop = i2c_stop;
    c.user_data = (void*)(uintptr_t)k;
    i2c[k] = vx_i2c_attach(&c);
  }

  vx_uart_config u = {0};
  u.rx = p_rx; u.tx = p_tx; u.baud_rate = 9600;
  u.on_rx_byte = uart_rx;
  u.on_tx_done = uart_tx_done;
  uart = vx_uart_attach(&u);

  vx_pin_watch(pins[P_IN],  VX_EDGE_BOTH, on_pin, (void*)(uintptr_t)P_IN);
  vx_pin_watch(pins[P_CS],  VX_EDGE_BOTH, on_pin, (void*)(uintptr_t)P_CS);
  vx_pin_watch(pins[P_CS2], VX_EDGE_BOTH, on_pin, (void*)(uintptr_t)P_CS2);

  tmr = vx_timer_create(on_tick, 0);
  vx_log("abi probe ready");
}

/* ── Probe surface ──────────────────────────────────────────────────────── */

__attribute__((export_name("trace_ptr")))
uint32_t probe_trace_ptr(void) { return (uint32_t)(uintptr_t)trace; }

__attribute__((export_name("trace_count")))
uint32_t probe_trace_count(void) { return trace_n; }

__attribute__((export_name("trace_clear")))
void probe_trace_clear(void) { trace_n = 0; }

__attribute__((export_name("scratch_ptr")))
uint32_t probe_scratch_ptr(void) { return (uint32_t)(uintptr_t)scratch; }

/* SPI */
__attribute__((export_name("spi_arm")))
void probe_spi_arm(uint32_t h, uint32_t n, uint32_t seed) { arm(h & 1, n, seed); }

__attribute__((export_name("spi_stop")))
void probe_spi_stop(uint32_t h) { vx_spi_stop(spi[h & 1]); }

__attribute__((export_name("spi_buf")))
uint32_t probe_spi_buf(uint32_t h) { return (uint32_t)(uintptr_t)spi_buf[h & 1]; }

__attribute__((export_name("spi_handle")))
uint32_t probe_spi_handle(uint32_t h) { return (uint32_t)spi[h & 1]; }

__attribute__((export_name("set_auto_arm")))
void probe_set_auto_arm(uint32_t on) { auto_arm = on ? 1 : 0; }

/* I2C: the handle vx_i2c_attach returned for slot k. */
__attribute__((export_name("i2c_handle")))
uint32_t probe_i2c_handle(uint32_t k) { return (uint32_t)i2c[k & 1]; }

/* UART: send n bytes 'A', 'B', ...; returns what vx_uart_write returned. */
__attribute__((export_name("uart_send")))
uint32_t probe_uart_send(uint32_t n) {
  if (n > SCRATCH_LEN) n = SCRATCH_LEN;
  for (uint32_t i = 0; i < n; i++) scratch[i] = (uint8_t)('A' + i);
  return vx_uart_write(uart, scratch, n) ? 1 : 0;
}

__attribute__((export_name("uart_handle")))
uint32_t probe_uart_handle(void) { return (uint32_t)uart; }

/* Pins */
__attribute__((export_name("pin_read")))
uint32_t probe_pin_read(uint32_t which) { return (uint32_t)vx_pin_read(pins[which % P_COUNT]); }

__attribute__((export_name("pin_write")))
void probe_pin_write(uint32_t which, uint32_t v) { vx_pin_write(pins[which % P_COUNT], (int)v); }

__attribute__((export_name("pin_set_mode")))
void probe_pin_set_mode(uint32_t which, uint32_t mode) {
  vx_pin_set_mode(pins[which % P_COUNT], (vx_pin_mode)mode);
}

__attribute__((export_name("pin_handle")))
uint32_t probe_pin_handle(uint32_t which) { return (uint32_t)pins[which % P_COUNT]; }

/* The analog side: the solved voltage in millivolts (rounded), and whether a
 * wire reaches the pad. */
__attribute__((export_name("pin_read_analog_mv")))
uint32_t probe_pin_read_analog_mv(uint32_t which) {
  double v = vx_pin_read_analog(pins[which % P_COUNT]);
  if (v < 0) v = 0;
  return (uint32_t)(v * 1000.0 + 0.5);
}

__attribute__((export_name("pin_wired")))
uint32_t probe_pin_wired(uint32_t which) { return (uint32_t)vx_pin_wired(pins[which % P_COUNT]); }

/* Attributes */
__attribute__((export_name("attr_gain_x100")))
uint32_t probe_attr_gain(void) { return (uint32_t)(vx_attr_read(a_gain) * 100.0 + 0.5); }

__attribute__((export_name("attr_label_len")))
uint32_t probe_attr_label_len(void) { return vx_attr_string_len(a_label); }

/* Copies the label into scratch (NUL included when it fits), returns the count. */
__attribute__((export_name("attr_label_read")))
uint32_t probe_attr_label_read(uint32_t cap) {
  memset(scratch, 0xEE, SCRATCH_LEN);
  return vx_attr_string_read(a_label, (char*)scratch, cap);
}

/* Blob "card" */
__attribute__((export_name("blob_size")))
uint32_t probe_blob_size(void) { return vx_blob_size("card"); }

__attribute__((export_name("blob_read")))
uint32_t probe_blob_read(uint32_t offset, uint32_t len) {
  memset(scratch, 0xEE, SCRATCH_LEN);
  return vx_blob_read("card", offset, scratch, len);
}

__attribute__((export_name("blob_write")))
uint32_t probe_blob_write(uint32_t offset, uint32_t len) {
  return vx_blob_write("card", offset, scratch, len);
}

/* Time */
__attribute__((export_name("timer_start")))
void probe_timer_start(uint32_t period_us, uint32_t repeat) {
  vx_timer_start(tmr, (uint64_t)period_us * 1000ull, repeat ? true : false);
}

__attribute__((export_name("timer_stop")))
void probe_timer_stop(void) { vx_timer_stop(tmr); }

__attribute__((export_name("now_lo")))
uint32_t probe_now_lo(void) { return (uint32_t)(vx_sim_now_nanos() & 0xFFFFFFFFu); }

__attribute__((export_name("now_hi")))
uint32_t probe_now_hi(void) { return (uint32_t)(vx_sim_now_nanos() >> 32); }
