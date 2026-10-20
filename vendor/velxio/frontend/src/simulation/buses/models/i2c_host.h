/*
 * i2c_host.h: the entries a host with a price per call reaches an I2C model
 * through. Included by a model of this folder after its bus callbacks, which
 * it names before the include:
 *
 *   I2C_HOST_CONNECT(addr, is_read)   what the model's on_connect does
 *   I2C_HOST_WRITE(byte)              on_write, true to ACK
 *   I2C_HOST_READ()                   on_read, the byte
 *   I2C_HOST_STOP()                   on_stop
 *
 * and, when it can promise it, I2C_HOST_DEFERRABLE (below).
 *
 * The browser runs a model through ChipRuntime's own I2C device, one call per
 * bus event, which costs about a microsecond there. The Python worker pays
 * for every call into the model in wasmtime-py's ctypes layer: through the
 * generic path (WasmChipI2CSlave, call_i2c_callback, the indirect table) a
 * clock read cost 14 us an event there against 1 us for the Python twin
 * (project i2c-model-fidelity-2026-09, P5). These entries are what the
 * worker calls instead (backend/app/services/wasm_i2c_models.py):
 *
 *   chip_i2c_event(event, addr)  one QEMU bus event, encoded as QEMU gives it
 *                                (op | data << 8), and its answer: the ACK
 *                                for a START or a byte written, the byte for
 *                                a read.
 *   chip_i2c_peek(n)             the next n bytes a read would answer, into
 *                                chip_i2c_buffer(), with the model left
 *                                exactly as it was. Returns how many.
 *   chip_i2c_commit(k)           the master read k of them: the model reads
 *                                them for real.
 *   chip_i2c_run(k, count, n)    with I2C_HOST_DEFERRABLE: chip_i2c_commit(k),
 *                                the `count` events the host held back
 *                                (chip_i2c_events(), event | addr << 16 each),
 *                                then chip_i2c_peek(n). One call a transaction.
 *
 * QEMU asks for a read byte by byte and says how many only with the STOP, so
 * a burst (the MPU-6050's fourteen, the BMP280's six) is served from a peek:
 * the bytes from the buffer, one commit before anything else reaches the
 * model. Committing replays the reads, which gives the bytes the peek gave
 * because nothing the model reads has moved in between: the host commits
 * before it pushes an input or delivers any other event. A peek puts the
 * model back by copying its static memory (data and bss, from __global_base
 * to __data_end) above __heap_base and back, so a model that keeps state
 * anywhere else (malloc) must not include this header. A model whose static
 * memory is mostly what no read changes (the MPU-6050's 8 KB of DMP memory)
 * names the one object that holds everything a read can change instead,
 * I2C_HOST_STATE, and only that is copied.
 *
 * While it peeks, the model says so in i2c_host_state[0] (chip_i2c_guard()),
 * and a host function it calls then does nothing, answers a neutral value and
 * sets i2c_host_state[1] (the worker's _PeekGuard). The peek is then thrown
 * away and returns 0, and the host asks for the bytes one by one: a model
 * whose read drives a pin or reads the guest clock is slower, never wrong.
 *
 * I2C_HOST_DEFERRABLE is the model's promise that its START, write and STOP
 * ACK every byte and call no host function whose answer or effect depends on
 * the moment (the firmware's build times are a fact of the firmware). Every
 * answer to those events is then known before the model runs, so the host
 * answers them itself, holds them back in order and delivers them with the
 * next read, or before it pushes an input that moved, or when asked for the
 * registers: the model sees the same events with the same inputs, later. *
 * I2C_HOST_TIMED is for a model that keeps the guest's time (the MPU-6050
 * samples on it): the host pushes the time into the model's memory before a
 * call, and the model names where it keeps it (I2C_HOST_TIME_GET() and
 * I2C_HOST_TIME_SET(t)). A time moves with every event, so the host cannot
 * hold events back as "an input that moved"; it hands each one its own time
 * instead, in chip_i2c_times(), doubles in the order the model hears them:
 * first the reads chip_i2c_commit replays, then the events chip_i2c_run
 * delivers. The model sees every event at its own instant, and the time
 * pushed before the call is back for the peek. A peek says in
 * chip_i2c_until() (a double) until when its bytes hold
 * (I2C_HOST_VALID_UNTIL(): the next moment a read would find something
 * else, a sample due), and the host serves a byte of it only before then.
 */
#ifndef VELXIO_I2C_HOST_H
#define VELXIO_I2C_HOST_H

#include "velxio-chip.h"

#define I2C_HOST_PEEK_MAX 64

/* The QEMU bus events (wasm_chip_slave.py, the picsimlab protocol). */
#define I2C_HOST_START_RECV 0x00
#define I2C_HOST_START_SEND 0x01
#define I2C_HOST_FINISH 0x03
#define I2C_HOST_NACK 0x04
#define I2C_HOST_WRITE_BYTE 0x05
#define I2C_HOST_READ_BYTE 0x06

extern unsigned char __global_base[];
extern unsigned char __data_end[];
extern unsigned char __heap_base[];

#define I2C_HOST_EVENTS_MAX 64

static uint8_t i2c_host_buffer[I2C_HOST_PEEK_MAX];

#ifdef I2C_HOST_TIMED
/* The time of each read committed and each event delivered, in that order. */
static double i2c_host_times[I2C_HOST_PEEK_MAX + I2C_HOST_EVENTS_MAX];
static double i2c_host_until;

__attribute__((export_name("chip_i2c_times"))) double* chip_i2c_times(void) {
  return i2c_host_times;
}

__attribute__((export_name("chip_i2c_until"))) double* chip_i2c_until(void) {
  return &i2c_host_until;
}
#endif
/* [0] the model is peeking, [1] a host function was called while it was. */
static volatile uint8_t i2c_host_state[2];

__attribute__((export_name("chip_i2c_guard"))) volatile uint8_t* chip_i2c_guard(void) {
  return i2c_host_state;
}

__attribute__((export_name("chip_i2c_buffer"))) uint8_t* chip_i2c_buffer(void) {
  return i2c_host_buffer;
}

/* WasmChipI2CSlave.handle_event, in the model: every START names the address
 * to on_connect, a repeated START included, and its return is not the ACK
 * (the chip being there is). Unknown events are ACKed to keep the bus alive. */
__attribute__((export_name("chip_i2c_event"))) int chip_i2c_event(int event, int addr) {
  uint8_t data = (uint8_t)(event >> 8);
  switch (event & 0xFF) {
    case I2C_HOST_START_SEND:
      I2C_HOST_CONNECT((uint8_t)addr, false);
      return 0;
    case I2C_HOST_START_RECV:
      I2C_HOST_CONNECT((uint8_t)addr, true);
      return 0;
    case I2C_HOST_WRITE_BYTE:
      return I2C_HOST_WRITE(data) ? 0 : 1;
    case I2C_HOST_READ_BYTE:
      return I2C_HOST_READ();
    case I2C_HOST_FINISH:
      I2C_HOST_STOP();
      return 0;
    default:
      return 0;
  }
}

__attribute__((export_name("chip_i2c_peek"))) int chip_i2c_peek(int n) {
  if (n <= 0) return 0;
  if (n > I2C_HOST_PEEK_MAX) n = I2C_HOST_PEEK_MAX;
#ifdef I2C_HOST_STATE
  unsigned char* state = (unsigned char*)&(I2C_HOST_STATE);
  unsigned long size = (unsigned long)sizeof(I2C_HOST_STATE);
#else
  unsigned char* state = __global_base;
  unsigned long size = (unsigned long)(__data_end - __global_base);
#endif
  unsigned long end = (unsigned long)__heap_base + size;
  if (end > (unsigned long)__builtin_wasm_memory_size(0) * 65536UL) return 0;
  __builtin_memcpy(__heap_base, state, size);
  i2c_host_state[1] = 0;
  i2c_host_state[0] = 1;
  /* On the stack, which is not the static memory the copy puts back. */
  uint8_t bytes[I2C_HOST_PEEK_MAX];
  for (int i = 0; i < n; i++) bytes[i] = (uint8_t)I2C_HOST_READ();
  bool touched = i2c_host_state[1] != 0;
#ifdef I2C_HOST_TIMED
  double until = I2C_HOST_VALID_UNTIL();
#endif
  __builtin_memcpy(state, __heap_base, size);
  /* Not peeking, nothing called: the whole static memory put this back
   * too, a named state (I2C_HOST_STATE) does not hold it. */
  i2c_host_state[0] = 0;
  i2c_host_state[1] = 0;
  if (touched) return 0;
  __builtin_memcpy(i2c_host_buffer, bytes, (unsigned long)n);
#ifdef I2C_HOST_TIMED
  /* After the copy back, which would undo it. */
  i2c_host_until = until;
#endif
  return n;
}

__attribute__((export_name("chip_i2c_commit"))) void chip_i2c_commit(int k) {
#ifdef I2C_HOST_TIMED
  double now = I2C_HOST_TIME_GET();
  if (k > I2C_HOST_PEEK_MAX) k = I2C_HOST_PEEK_MAX;
  for (int i = 0; i < k; i++) {
    I2C_HOST_TIME_SET(i2c_host_times[i]);
    (void)I2C_HOST_READ();
  }
  I2C_HOST_TIME_SET(now);
#else
  for (int i = 0; i < k; i++) (void)I2C_HOST_READ();
#endif
}

#ifdef I2C_HOST_DEFERRABLE
static uint32_t i2c_host_events[I2C_HOST_EVENTS_MAX];

__attribute__((export_name("chip_i2c_events"))) uint32_t* chip_i2c_events(void) {
  return i2c_host_events;
}

/* Returns what the peek returned, with bit 16 set if a byte written was not
 * ACKed after all (the host had ACKed it: a model that breaks the promise). */
__attribute__((export_name("chip_i2c_run"))) int chip_i2c_run(int taken, int count, int peek) {
  chip_i2c_commit(taken);
  if (count > I2C_HOST_EVENTS_MAX) count = I2C_HOST_EVENTS_MAX;
#ifdef I2C_HOST_TIMED
  if (taken > I2C_HOST_PEEK_MAX) taken = I2C_HOST_PEEK_MAX;
  if (taken < 0) taken = 0;
  double now = I2C_HOST_TIME_GET();
#endif
  int nack = 0;
  for (int i = 0; i < count; i++) {
    uint32_t e = i2c_host_events[i];
#ifdef I2C_HOST_TIMED
    I2C_HOST_TIME_SET(i2c_host_times[taken + i]);
#endif
    int answer = chip_i2c_event((int)(e & 0xFFFF), (int)(e >> 16));
    if ((e & 0xFF) == I2C_HOST_WRITE_BYTE && answer) nack = 0x10000;
  }
#ifdef I2C_HOST_TIMED
  I2C_HOST_TIME_SET(now);
#endif
  return (peek > 0 ? chip_i2c_peek(peek) : 0) | nack;
}
#endif

#endif /* VELXIO_I2C_HOST_H */
