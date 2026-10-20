/*
 * mcp3008.c: Microchip MCP3008, 8-channel 10-bit SPI ADC.
 *
 * Pins: CS, SCK, MOSI (DIN), MISO (DOUT), CH0..CH7 (analog inputs).
 *
 * The chip has no byte framing of its own (datasheet DS21295, figure 6-1).
 * After CS falls it waits for a start bit (a 1 on DIN), takes four
 * configuration bits (SGL/DIFF, D2, D1, D0), samples the input on the next
 * clock, drives one null bit, then the 10-bit result MSB first. If the master
 * keeps clocking it repeats the result LSB first and then drives zeros until
 * CS rises. Every driver in the field groups those bits into bytes its own
 * way, and the two common framings both put result bits in the SAME byte as
 * the configuration bits that decide them:
 *
 *   spidev / gpiozero   [0x01, 0x80 | ch << 4, 0x00]  B9 B8 in byte 1
 *   Adafruit_MCP3008    [0xC0 | ch << 3, 0x00, 0x00]  B9 in byte 0
 *
 * That is why this chip answers through `on_exchange` (velxio-chip.h). The
 * buffer of vx_spi_start has to be filled BEFORE the chip has seen the byte
 * it answers, so through the buffer alone a reading loses its top bits (the
 * first version of this example queued the result for a second transaction,
 * which CS rising cancelled, and read 1023 whatever the input). With
 * `on_exchange` the host hands the chip each byte a hardware controller
 * clocks and takes the return value as the MISO for that byte, so the bits go
 * through in order, as they do on silicon.
 *
 * The buffer still matters: a bit-banged master (shiftIn, the Pi's readadc
 * loop) reads MISO bit by bit before its byte is complete, and it reads the
 * armed buffer. So the chip keeps one byte armed at all times, computed as
 * what DOUT would carry over the next eight clocks if DIN stayed low; once
 * the sample clock has passed nothing the master sends changes the answer,
 * so every byte that carries result bits is exact either way.
 */

#include "velxio-chip.h"
#include <stdlib.h>

static const char* CH_NAMES[8] = {"CH0","CH1","CH2","CH3","CH4","CH5","CH6","CH7"};

/* Where the chip is in one conversion (figure 6-1). */
typedef enum { IDLE, CONFIG, SAMPLE, NULL_BIT, MSB, LSB, DONE } phase_t;

typedef struct {
  phase_t phase;
  int cfg;        /* the four configuration bits, MSB first */
  int cfg_bits;   /* how many of them have arrived */
  int result;     /* 10-bit code latched at the sample clock */
  int bit;        /* index of the result bit being shifted out */
} frame_t;

typedef struct {
  vx_pin CS, SCK, MOSI, MISO;
  vx_pin CH[8];
  vx_spi spi;
  frame_t f;
  uint8_t buf[1];   /* the look-ahead byte a bit-banged master reads */
} chip_state_t;

/* Volts on a channel, converted at 5 V full scale: 0..1023. */
static int convert(const chip_state_t* s, int cfg) {
  int single = (cfg >> 3) & 1;
  int ch = cfg & 7;
  double v;
  if (single) {
    v = vx_pin_read_analog(s->CH[ch]);
  } else {
    /* Differential pairs (datasheet table 5-2): 000 = CH0+ CH1-, 001 = CH0- CH1+, ... */
    int even = ch & ~1;
    int plus = (ch & 1) ? even + 1 : even;
    int minus = (ch & 1) ? even : even + 1;
    v = vx_pin_read_analog(s->CH[plus]) - vx_pin_read_analog(s->CH[minus]);
  }
  if (v < 0) v = 0;
  if (v > 5.0) v = 5.0;
  return (int)((v / 5.0) * 1023.0 + 0.5);
}

/* One clock edge: DIN in, DOUT out. */
static int clock_bit(const chip_state_t* s, frame_t* f, int din) {
  switch (f->phase) {
    case IDLE:
      if (din) { f->phase = CONFIG; f->cfg = 0; f->cfg_bits = 0; }
      return 0;
    case CONFIG:
      f->cfg = (f->cfg << 1) | din;
      if (++f->cfg_bits == 4) f->phase = SAMPLE;
      return 0;
    case SAMPLE:
      f->result = convert(s, f->cfg);
      f->phase = NULL_BIT;
      return 0;
    case NULL_BIT:
      f->phase = MSB;
      f->bit = 9;
      return 0;
    case MSB: {
      int out = (f->result >> f->bit) & 1;
      if (f->bit-- == 0) { f->phase = LSB; f->bit = 1; }
      return out;
    }
    case LSB: {
      int out = (f->result >> f->bit) & 1;
      if (++f->bit > 9) f->phase = DONE;
      return out;
    }
    default:
      return 0;   /* DOUT stays low until CS rises */
  }
}

/* Eight clocks, MSB first on both lines: one byte of the exchange. */
static uint8_t clock_byte(const chip_state_t* s, frame_t* f, uint8_t mosi) {
  uint8_t miso = 0;
  for (int i = 7; i >= 0; i--) {
    miso = (uint8_t)((miso << 1) | clock_bit(s, f, (mosi >> i) & 1));
  }
  return miso;
}

/* Arm the look-ahead: the next byte DOUT would carry, without consuming the
 * frame (a copy is clocked, the real one waits for the master's bits). */
static void arm(chip_state_t* s) {
  frame_t look = s->f;
  s->buf[0] = clock_byte(s, &look, 0x00);
  vx_spi_start(s->spi, s->buf, 1);
}

/* CS moved either way: the conversion in flight is abandoned and the chip
 * waits for a start bit again. It stays armed across the edge so the first
 * bit is on the wire when the next transaction begins. */
static void on_cs_change(void* ud, vx_pin pin, int value) {
  chip_state_t* s = (chip_state_t*)ud;
  (void)pin;
  (void)value;
  s->f.phase = IDLE;
  arm(s);
}

/* A hardware controller clocked one whole byte: shift it through the frame
 * and answer with what DOUT carried meanwhile, then re-arm the look-ahead. */
static uint8_t on_spi_exchange(void* ud, uint8_t mosi) {
  chip_state_t* s = (chip_state_t*)ud;
  uint8_t miso = clock_byte(s, &s->f, mosi);
  arm(s);
  return miso;
}

/* A host without `on_exchange` (or a bit-banged master) consumed the
 * look-ahead byte: only now does the chip learn what the master sent, so the
 * real frame catches up here and the next look-ahead follows from it. */
static void on_spi_done(void* ud, uint8_t* buffer, uint32_t count) {
  chip_state_t* s = (chip_state_t*)ud;
  if (count == 0) return;
  clock_byte(s, &s->f, buffer[0]);
  arm(s);
}

void chip_setup(void) {
  chip_state_t* s = (chip_state_t*)calloc(1, sizeof(chip_state_t));
  s->CS   = vx_pin_register("CS",   VX_INPUT_PULLUP);
  s->SCK  = vx_pin_register("SCK",  VX_INPUT);
  s->MOSI = vx_pin_register("MOSI", VX_INPUT);
  /* MISO is answered through the bus, which drives the pad itself for a
   * bit-banged master; a chip that also stamped a level there would be a
   * second driver on the same net. So the leg is registered, not driven. */
  s->MISO = vx_pin_register("MISO", VX_INPUT);
  for (int i = 0; i < 8; i++) {
    s->CH[i] = vx_pin_register(CH_NAMES[i], VX_ANALOG);
  }

  vx_spi_config cfg = {
    .sck         = s->SCK,
    .mosi        = s->MOSI,
    .miso        = s->MISO,
    .cs          = s->CS,
    .mode        = 0,             /* SPI mode 0,0 (or 1,1), MSB first */
    .on_done     = on_spi_done,
    .user_data   = s,
    .on_exchange = on_spi_exchange,
  };
  s->spi = vx_spi_attach(&cfg);
  vx_pin_watch(s->CS, VX_EDGE_BOTH, on_cs_change, s);
  arm(s);

  vx_log("MCP3008 ADC ready");
}
