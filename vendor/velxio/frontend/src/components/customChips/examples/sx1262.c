/*
 * sx1262.c — Semtech SX1262 LoRa transceiver model.
 *
 * Copyright (c) 2026 Martin Thuku. MIT licence (test/fixtures/chip-nets/LICENSE).
 *
 * Scope: enough of the SX1262 command set that a real SX1262 driver (the
 * RadioLib / Semtech reference sequence) believes a radio is present,
 * plus a synthetic ANT pin that behaves as the air: the chip serialises its
 * TX buffer onto ANT as a Manchester bit stream, and every other SX1262
 * instance wired to the same ANT net decodes it into its RX buffer.
 *
 * This models command sequencing, buffers, IRQ latching and a shared medium.
 * It does NOT model LoRa modulation, spreading factors, airtime, sensitivity
 * or the link budget. See docs/wiki/custom-chips-chip-nets.md for the limits.
 *
 * Portable C: velxio-chip.h plus stdint / stdlib / string only.
 *
 * Air frame on ANT (identical scheme in the KQ-130F model, slower period):
 *   preamble  16 bits of 1
 *   sync      1 byte 0x2D
 *   length    1 byte, payload length
 *   payload   length bytes
 *   crc       2 bytes, CRC16-CCITT poly 0x1021 init 0xFFFF over length+payload,
 *             big endian
 * Manchester: bit 1 is HIGH then LOW, bit 0 is LOW then HIGH, each half cell
 * lasting bit_period_us / 2. The line idles LOW (ANT released to input).
 */

#include "velxio-chip.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* ---- SX1262 opcodes (DS.SX1261-2, chapter 13) -------------------------- */

#define OP_SET_SLEEP 0x84
#define OP_SET_STANDBY 0x80
#define OP_SET_FS 0xC1
#define OP_SET_TX 0x83
#define OP_SET_RX 0x82
#define OP_SET_REGULATOR_MODE 0x96
#define OP_CALIBRATE 0x89
#define OP_CALIBRATE_IMAGE 0x98
#define OP_SET_PA_CONFIG 0x95
#define OP_SET_RXTX_FALLBACK 0x93
#define OP_WRITE_REGISTER 0x0D
#define OP_READ_REGISTER 0x1D
#define OP_WRITE_BUFFER 0x0E
#define OP_READ_BUFFER 0x1E
#define OP_SET_DIO_IRQ_PARAMS 0x08
#define OP_GET_IRQ_STATUS 0x12
#define OP_CLEAR_IRQ_STATUS 0x02
#define OP_SET_DIO2_AS_RF_SWITCH 0x9D
#define OP_SET_DIO3_AS_TCXO 0x97
#define OP_SET_RF_FREQUENCY 0x86
#define OP_SET_PACKET_TYPE 0x8A
#define OP_GET_PACKET_TYPE 0x11
#define OP_SET_TX_PARAMS 0x8E
#define OP_SET_MODULATION_PARAMS 0x8B
#define OP_SET_PACKET_PARAMS 0x8C
#define OP_SET_BUFFER_BASE 0x8F
#define OP_GET_STATUS 0xC0
#define OP_GET_RSSI_INST 0x15
#define OP_GET_RX_BUFFER_STATUS 0x13
#define OP_GET_PACKET_STATUS 0x14
#define OP_GET_DEVICE_ERRORS 0x17
#define OP_CLEAR_DEVICE_ERRORS 0x07

#define PACKET_TYPE_GFSK 0x00
#define PACKET_TYPE_LORA 0x01

/* Chip modes as reported in bits 6:4 of the status byte. */
#define MODE_STBY_RC 0x02
#define MODE_FS 0x04
#define MODE_RX 0x05
#define MODE_TX 0x06

/* IRQ bits. */
#define IRQ_TX_DONE 0x0001
#define IRQ_RX_DONE 0x0002
#define IRQ_PREAMBLE_DETECTED 0x0004
#define IRQ_SYNC_WORD_VALID 0x0008
#define IRQ_HEADER_VALID 0x0010
#define IRQ_HEADER_ERR 0x0020
#define IRQ_CRC_ERR 0x0040
#define IRQ_TIMEOUT 0x0200

/* ---- Air medium -------------------------------------------------------- */

#define AIR_PREAMBLE_BITS 16
#define AIR_SYNC_BYTE 0x2D
#define AIR_MAX_PAYLOAD 255
#define AIR_FRAME_MAX (1 + AIR_MAX_PAYLOAD + 2)
#define AIR_HEADER_BITS (AIR_PREAMBLE_BITS + 8)

/* BUSY stays high this long after a command completes. Short enough that the
 * driver's 1 ms polling loop never spins more than once. */
#define BUSY_NS 60000ull

typedef struct {
    uint8_t frame[AIR_FRAME_MAX];
    uint32_t frame_len;   /* bytes in frame[] */
    uint32_t half_total;  /* total half cells to drive, excluding the trailer */
    uint32_t cursor;      /* next half cell index */
    uint8_t active;
    vx_timer timer;
} air_tx_t;

typedef struct {
    uint8_t enabled; /* chip is in Rx */
    uint8_t locked;  /* an edge sequence is being tracked */
    uint8_t expect;  /* 1: the last edge was a cell boundary, 0: it was mid cell */
    uint64_t t_last;
    uint64_t h_est; /* measured half cell, tracks a host whose timers run slow */
    uint32_t shift; /* preamble + sync hunt register */
    uint8_t phase;  /* 0 hunt, 1 length, 2 payload and crc */
    uint8_t acc;
    uint32_t bitcnt;
    uint32_t need;
    uint32_t got;
    uint8_t buf[AIR_FRAME_MAX];
} air_rx_t;

typedef struct {
    vx_pin sck, mosi, miso, nss, busy, dio1, rst, ant;
    vx_spi spi;
    vx_attr a_rssi, a_drop, a_bit;
    vx_attr a_label;
    char label[24];

    /* SPI transaction state */
    uint8_t spibuf[1];
    uint8_t in_xfer;
    uint32_t idx;
    uint8_t op;
    uint8_t args[10];
    uint32_t nargs;
    uint16_t addr;       /* register address or buffer offset under way */
    uint8_t wr_off;      /* offset of the WriteBuffer in flight */
    uint32_t wr_len;     /* bytes of the WriteBuffer in flight */
    uint32_t last_wr_len;/* bytes of the last completed WriteBuffer */

    /* radio state */
    uint8_t mode;
    uint8_t packet_type;
    uint8_t data[256];
    uint8_t regs[256];
    uint8_t tx_base, rx_base;
    uint8_t pp_payload_len;
    uint16_t irq, irq_mask, dio1_mask;
    uint8_t rx_len, rx_start;
    uint32_t seed;

    air_tx_t tx;
    air_rx_t rx;
    vx_timer busy_timer;
} chip_t;

/* ---- small helpers ----------------------------------------------------- */

static void put_dec(char **p, char *end, long v)
{
    char tmp[24];
    int n = 0;
    unsigned long u;
    if (v < 0) {
        if (*p < end) *(*p)++ = '-';
        u = (unsigned long)(-v);
    } else {
        u = (unsigned long)v;
    }
    if (u == 0) tmp[n++] = '0';
    while (u) {
        tmp[n++] = (char)('0' + (u % 10));
        u /= 10;
    }
    while (n--) {
        if (*p < end) *(*p)++ = tmp[n];
    }
}

/* Log "<label>: <text><a><sep><b>" without pulling in printf. Pass NULL for
 * sep to stop after a. */
static void chip_log(chip_t *s, const char *text, const long *a, const char *sep, const long *b)
{
    char line[160];
    char *p = line;
    char *end = line + sizeof line - 1;
    const char *q;
    for (q = s->label; *q && p < end; q++) *p++ = *q;
    if (p < end) *p++ = ':';
    if (p < end) *p++ = ' ';
    for (q = text; *q && p < end; q++) *p++ = *q;
    if (a) put_dec(&p, end, *a);
    if (sep) for (q = sep; *q && p < end; q++) *p++ = *q;
    if (b) put_dec(&p, end, *b);
    *p = 0;
    vx_log(line);
}

static uint16_t crc16_ccitt(const uint8_t *d, uint32_t n)
{
    uint16_t c = 0xFFFF;
    uint32_t i;
    int b;
    for (i = 0; i < n; i++) {
        c ^= (uint16_t)((uint16_t)d[i] << 8);
        for (b = 0; b < 8; b++)
            c = (uint16_t)((c & 0x8000) ? ((uint16_t)(c << 1) ^ 0x1021) : (uint16_t)(c << 1));
    }
    return c;
}

static uint32_t rnd(chip_t *s)
{
    s->seed = s->seed * 1664525u + 1013904223u;
    return (s->seed >> 16) & 0x7FFF;
}

static uint64_t half_ns(chip_t *s)
{
    double us = vx_attr_read(s->a_bit);
    if (us < 2.0) us = 2.0;
    return (uint64_t)(us * 500.0); /* half of bit_period_us, in nanoseconds */
}

static uint8_t status_byte(chip_t *s)
{
    /* bits 6:4 chip mode, bits 3:1 command status (2 = data available). */
    return (uint8_t)(((s->mode & 0x07) << 4) | 0x02);
}

static void update_dio1(chip_t *s)
{
    vx_pin_write(s->dio1, (s->irq & s->dio1_mask) ? VX_HIGH : VX_LOW);
}

static void raise_irq(chip_t *s, uint16_t bits)
{
    s->irq |= (uint16_t)(bits & s->irq_mask);
    update_dio1(s);
}

/* ---- air transmit ------------------------------------------------------ */

static int tx_bit_at(air_tx_t *t, uint32_t i)
{
    uint32_t k;
    if (i < AIR_PREAMBLE_BITS) return 1;
    if (i < AIR_HEADER_BITS) return (AIR_SYNC_BYTE >> (AIR_HEADER_BITS - 1 - i)) & 1;
    k = i - AIR_HEADER_BITS;
    if ((k >> 3) >= t->frame_len) return 0;
    return (t->frame[k >> 3] >> (7 - (k & 7))) & 1;
}

static int tx_level_at(air_tx_t *t, uint32_t half)
{
    int bit = tx_bit_at(t, half >> 1);
    return (half & 1) ? !bit : bit;
}

static void air_tx_finish(chip_t *s)
{
    vx_timer_stop(s->tx.timer);
    s->tx.active = 0;
    vx_pin_write(s->ant, VX_LOW);
    vx_pin_set_mode(s->ant, VX_INPUT);
    s->mode = MODE_STBY_RC;
    raise_irq(s, IRQ_TX_DONE);
    {
        long n = (long)s->tx.frame_len - 3;
        chip_log(s, "tx done, payload ", &n, " bytes", 0);
    }
}

static void air_tx_tick(void *ud)
{
    chip_t *s = (chip_t *)ud;
    if (!s->tx.active) return;
    if (s->tx.cursor < s->tx.half_total) {
        vx_pin_write(s->ant, tx_level_at(&s->tx, s->tx.cursor) ? VX_HIGH : VX_LOW);
        s->tx.cursor++;
        return;
    }
    if (s->tx.cursor == s->tx.half_total) {
        vx_pin_write(s->ant, VX_LOW); /* trailer half cell, return the line to idle */
        s->tx.cursor++;
        return;
    }
    air_tx_finish(s);
}

static void air_tx_abort(chip_t *s)
{
    if (!s->tx.active) return;
    vx_timer_stop(s->tx.timer);
    s->tx.active = 0;
    vx_pin_write(s->ant, VX_LOW);
    vx_pin_set_mode(s->ant, VX_INPUT);
}

static void air_tx_start(chip_t *s)
{
    uint32_t n = s->last_wr_len;
    uint32_t i;
    uint16_t crc;

    if (s->pp_payload_len && s->pp_payload_len <= n) n = s->pp_payload_len;
    if (n > AIR_MAX_PAYLOAD) n = AIR_MAX_PAYLOAD;

    s->tx.frame[0] = (uint8_t)n;
    for (i = 0; i < n; i++) s->tx.frame[1 + i] = s->data[(s->tx_base + i) & 0xFF];
    crc = crc16_ccitt(s->tx.frame, 1 + n);
    s->tx.frame[1 + n] = (uint8_t)(crc >> 8);
    s->tx.frame[2 + n] = (uint8_t)crc;
    s->tx.frame_len = n + 3;
    s->tx.half_total = (AIR_HEADER_BITS + s->tx.frame_len * 8) * 2;
    s->tx.cursor = 0;
    s->tx.active = 1;
    s->mode = MODE_TX;

    vx_pin_set_mode(s->ant, VX_OUTPUT_LOW);
    vx_pin_write(s->ant, tx_level_at(&s->tx, 0) ? VX_HIGH : VX_LOW);
    s->tx.cursor = 1;
    vx_timer_start(s->tx.timer, half_ns(s), true);
    {
        long ln = (long)n;
        chip_log(s, "tx start, payload ", &ln, " bytes", 0);
    }
}

/* ---- air receive ------------------------------------------------------- */

static void air_rx_reset(air_rx_t *r)
{
    r->locked = 0;
    r->expect = 0;
    r->h_est = 0;
    r->shift = 0;
    r->phase = 0;
    r->acc = 0;
    r->bitcnt = 0;
    r->need = 0;
    r->got = 0;
}

static void air_rx_frame(chip_t *s)
{
    air_rx_t *r = &s->rx;
    uint8_t len = r->buf[0];
    uint16_t got_crc = (uint16_t)(((uint16_t)r->buf[1 + len] << 8) | r->buf[2 + len]);
    uint16_t want_crc = crc16_ccitt(r->buf, 1u + len);
    uint32_t i;
    long l;

    if (got_crc != want_crc) {
        l = (long)len;
        chip_log(s, "rx crc error, len ", &l, 0, 0);
        raise_irq(s, (uint16_t)(IRQ_RX_DONE | IRQ_CRC_ERR));
        return;
    }
    if ((uint32_t)vx_attr_read(s->a_drop) > 0 &&
        rnd(s) % 100u < (uint32_t)vx_attr_read(s->a_drop)) {
        l = (long)len;
        chip_log(s, "rx dropped by drop_percent, len ", &l, 0, 0);
        return;
    }
    for (i = 0; i < len; i++) s->data[(s->rx_base + i) & 0xFF] = r->buf[1 + i];
    s->rx_len = len;
    s->rx_start = s->rx_base;
    l = (long)len;
    chip_log(s, "rx frame ok, len ", &l, 0, 0);
    raise_irq(s, IRQ_RX_DONE);
}

static void air_rx_bit(chip_t *s, int bit)
{
    air_rx_t *r = &s->rx;
    uint8_t byte;

    if (r->phase == 0) {
        r->shift = (r->shift << 1) | (uint32_t)(bit & 1);
        if ((r->shift & 0xFFFFu) == ((0xFFu << 8) | AIR_SYNC_BYTE)) {
            r->phase = 1;
            r->acc = 0;
            r->bitcnt = 0;
            r->got = 0;
            r->need = 0;
        }
        return;
    }

    r->acc = (uint8_t)((r->acc << 1) | (bit & 1));
    if (++r->bitcnt < 8) return;
    r->bitcnt = 0;
    byte = r->acc;
    r->acc = 0;

    if (r->phase == 1) { /* length byte */
        r->buf[0] = byte;
        r->got = 1;
        r->need = 1u + byte + 2u;
        r->phase = 2;
        return;
    }
    if (r->got < AIR_FRAME_MAX) r->buf[r->got] = byte;
    r->got++;
    if (r->got >= r->need) {
        air_rx_frame(s);
        air_rx_reset(r);
    }
}

/* Track the half cell actually observed. A host whose software timers run slow
 * stretches every cell by roughly the same factor, and following it costs one
 * average per edge. Clamped so a burst of jitter cannot drag the estimate away
 * from the configured bit period. */
static void air_rx_track(chip_t *s, air_rx_t *r, uint64_t measured)
{
    uint64_t nominal = half_ns(s);
    uint64_t est;
    if (measured == 0) return;
    est = (r->h_est * 3u + measured) / 4u;
    if (est < nominal / 8u) est = nominal / 8u;
    if (est > nominal * 8u) est = nominal * 8u;
    r->h_est = est;
}

static void air_on_ant(void *ud, vx_pin pin, int value)
{
    chip_t *s = (chip_t *)ud;
    air_rx_t *r = &s->rx;
    uint64_t now, dt, h;

    (void)pin;
    if (s->tx.active) return; /* half duplex: our own edges, or a collision */
    if (!r->enabled) return;

    now = vx_sim_now_nanos();
    h = half_ns(s);

    if (!r->locked) {
        if (value != VX_HIGH) return; /* a frame always opens with a rising edge */
        air_rx_reset(r);
        r->locked = 1;
        r->expect = 1; /* that edge was a cell boundary; the next one is mid cell */
        r->t_last = now;
        r->h_est = h;
        return;
    }

    if (r->h_est) h = r->h_est;
    dt = now - r->t_last;
    if (dt > h * 4u) { /* the line went quiet: treat this as a new frame */
        air_rx_reset(r);
        if (value == VX_HIGH) {
            r->locked = 1;
            r->expect = 1;
            r->t_last = now;
            r->h_est = half_ns(s);
        }
        return;
    }
    r->t_last = now;

    if (r->expect) {
        /* the previous edge was a cell boundary, so this one carries a bit and
         * the interval just measured was exactly one half cell */
        air_rx_track(s, r, dt);
        air_rx_bit(s, value ? 0 : 1);
        r->expect = 0;
        return;
    }
    if (dt * 2u < h * 3u) {
        air_rx_track(s, r, dt);
        r->expect = 1; /* short interval: this is a cell boundary, no bit */
        return;
    }
    air_rx_track(s, r, dt / 2u); /* full bit interval: another mid cell edge */
    air_rx_bit(s, value ? 0 : 1);
    r->expect = 0;
}

/* ---- SPI command machine ----------------------------------------------- */

static uint8_t rssi_pkt_byte(chip_t *s)
{
    double r = vx_attr_read(s->a_rssi);
    long v;
    if (r > 0.0) r = -r;
    v = (long)(-2.0 * r); /* the register holds -2 x RSSI in dBm */
    if (v < 0) v = 0;
    if (v > 255) v = 255;
    return (uint8_t)v;
}

static uint8_t miso_for(chip_t *s, uint32_t i)
{
    uint8_t st;
    if (i == 0) return 0x00;
    st = status_byte(s);
    switch (s->op) {
    case OP_GET_STATUS:
        return (i == 1) ? st : 0x00;
    case OP_GET_IRQ_STATUS:
        if (i == 1) return st;
        if (i == 2) return (uint8_t)(s->irq >> 8);
        if (i == 3) return (uint8_t)s->irq;
        return 0x00;
    case OP_GET_RX_BUFFER_STATUS:
        if (i == 1) return st;
        if (i == 2) return s->rx_len;
        if (i == 3) return s->rx_start;
        return 0x00;
    case OP_GET_PACKET_STATUS:
        if (i == 1) return st;
        if (i == 2) return rssi_pkt_byte(s);
        if (i == 3) return 40; /* SNR: +10 dB, coded as snr x 4 */
        if (i == 4) return rssi_pkt_byte(s);
        return 0x00;
    case OP_GET_PACKET_TYPE:
        if (i == 1) return st;
        if (i == 2) return s->packet_type;
        return 0x00;
    case OP_GET_RSSI_INST:
        if (i == 1) return st;
        if (i == 2) return rssi_pkt_byte(s);
        return 0x00;
    case OP_READ_REGISTER:
        /* opcode, addr hi, addr lo, NOP carrying status, then data */
        if (i <= 3) return st;
        return s->regs[(s->addr + (i - 4)) & 0xFF];
    case OP_READ_BUFFER:
        /* opcode, offset, NOP carrying status, then data */
        if (i <= 2) return st;
        return s->data[((s->addr & 0xFF) + (i - 3)) & 0xFF];
    case OP_GET_DEVICE_ERRORS:
        return (i == 1) ? st : 0x00;
    default:
        return (i == 1) ? st : 0x00;
    }
}

static void consume(chip_t *s, uint32_t i, uint8_t b)
{
    if (i == 0) {
        s->op = b;
        s->nargs = 0;
        s->wr_len = 0;
        s->addr = 0;
        return;
    }
    switch (s->op) {
    case OP_WRITE_BUFFER:
        if (i == 1) {
            s->wr_off = b;
        } else {
            s->data[(s->wr_off + (i - 2)) & 0xFF] = b;
            s->wr_len++;
        }
        return;
    case OP_WRITE_REGISTER:
        if (i == 1) s->addr = (uint16_t)((uint16_t)b << 8);
        else if (i == 2) s->addr = (uint16_t)(s->addr | b);
        else s->regs[(s->addr + (i - 3)) & 0xFF] = b;
        return;
    case OP_READ_REGISTER:
        if (i == 1) s->addr = (uint16_t)((uint16_t)b << 8);
        else if (i == 2) s->addr = (uint16_t)(s->addr | b);
        return;
    case OP_READ_BUFFER:
        if (i == 1) s->addr = b;
        return;
    default:
        if (s->nargs < sizeof s->args) s->args[s->nargs++] = b;
        return;
    }
}

static void command_done(chip_t *s)
{
    switch (s->op) {
    case OP_SET_STANDBY:
    case OP_SET_SLEEP:
        air_tx_abort(s);
        s->rx.enabled = 0;
        s->mode = MODE_STBY_RC;
        break;
    case OP_SET_FS:
        s->mode = MODE_FS;
        break;
    case OP_SET_PACKET_TYPE:
        s->packet_type = s->args[0];
        break;
    case OP_SET_BUFFER_BASE:
        s->tx_base = s->args[0];
        s->rx_base = s->args[1];
        break;
    case OP_SET_PACKET_PARAMS:
        if (s->packet_type == PACKET_TYPE_LORA) {
            if (s->nargs > 3) s->pp_payload_len = s->args[3];
        } else {
            if (s->nargs > 6) s->pp_payload_len = s->args[6];
        }
        break;
    case OP_SET_DIO_IRQ_PARAMS:
        if (s->nargs >= 4) {
            s->irq_mask = (uint16_t)(((uint16_t)s->args[0] << 8) | s->args[1]);
            s->dio1_mask = (uint16_t)(((uint16_t)s->args[2] << 8) | s->args[3]);
        }
        break;
    case OP_CLEAR_IRQ_STATUS:
        if (s->nargs >= 2)
            s->irq &= (uint16_t)~(((uint16_t)s->args[0] << 8) | s->args[1]);
        else
            s->irq = 0;
        update_dio1(s);
        break;
    case OP_WRITE_BUFFER:
        s->last_wr_len = s->wr_len;
        break;
    case OP_SET_TX:
        air_tx_start(s);
        break;
    case OP_SET_RX:
        s->mode = MODE_RX;
        s->rx.enabled = 1;
        air_rx_reset(&s->rx);
        chip_log(s, "rx armed", 0, 0, 0);
        break;
    /* Accepted and recorded only: they change nothing an observer can see. */
    case OP_SET_RF_FREQUENCY:
    case OP_SET_PA_CONFIG:
    case OP_SET_TX_PARAMS:
    case OP_SET_MODULATION_PARAMS:
    case OP_SET_REGULATOR_MODE:
    case OP_SET_DIO2_AS_RF_SWITCH:
    case OP_SET_DIO3_AS_TCXO:
    case OP_CALIBRATE:
    case OP_CALIBRATE_IMAGE:
    case OP_SET_RXTX_FALLBACK:
    case OP_CLEAR_DEVICE_ERRORS:
    default:
        break;
    }
}

static void busy_release(void *ud)
{
    chip_t *s = (chip_t *)ud;
    vx_pin_write(s->busy, VX_LOW);
}

static void on_spi_done(void *ud, uint8_t *buffer, uint32_t count)
{
    chip_t *s = (chip_t *)ud;
    uint8_t mosi;
    if (!s->in_xfer || count == 0) return;
    mosi = buffer[0];
    consume(s, s->idx, mosi);
    s->idx++;
    s->spibuf[0] = miso_for(s, s->idx);
    vx_spi_start(s->spi, s->spibuf, 1);
}

static void on_nss(void *ud, vx_pin pin, int value)
{
    chip_t *s = (chip_t *)ud;
    (void)pin;
    if (value == VX_LOW) {
        vx_pin_write(s->busy, VX_LOW); /* a stuck BUSY self heals on the next command */
        s->in_xfer = 1;
        s->idx = 0;
        s->op = 0;
        s->nargs = 0;
        s->spibuf[0] = miso_for(s, 0);
        vx_spi_start(s->spi, s->spibuf, 1);
        return;
    }
    if (!s->in_xfer) return;
    s->in_xfer = 0;
    vx_spi_stop(s->spi);
    command_done(s);
    vx_pin_write(s->busy, VX_HIGH);
    vx_timer_start(s->busy_timer, BUSY_NS, false);
}

static void on_reset(void *ud, vx_pin pin, int value)
{
    chip_t *s = (chip_t *)ud;
    (void)pin;
    (void)value;
    air_tx_abort(s);
    air_rx_reset(&s->rx);
    s->rx.enabled = 0;
    s->mode = MODE_STBY_RC;
    s->irq = 0;
    s->irq_mask = 0xFFFF;
    s->dio1_mask = 0;
    s->rx_len = 0;
    s->last_wr_len = 0;
    s->pp_payload_len = 0;
    vx_pin_write(s->dio1, VX_LOW);
    vx_pin_write(s->busy, VX_LOW);
    chip_log(s, "reset", 0, 0, 0);
}

/* ---- setup ------------------------------------------------------------- */

void chip_setup(void)
{
    chip_t *s = (chip_t *)calloc(1, sizeof(chip_t));
    if (!s) return;

    s->sck = vx_pin_register("SCK", VX_INPUT);
    s->mosi = vx_pin_register("MOSI", VX_INPUT);
    s->miso = vx_pin_register("MISO", VX_OUTPUT_LOW);
    s->nss = vx_pin_register("NSS", VX_INPUT_PULLUP);
    s->busy = vx_pin_register("BUSY", VX_OUTPUT_LOW);
    s->dio1 = vx_pin_register("DIO1", VX_OUTPUT_LOW);
    s->rst = vx_pin_register("RESET", VX_INPUT_PULLUP);
    s->ant = vx_pin_register("ANT", VX_INPUT);

    s->a_rssi = vx_attr_register("rssi_dbm", -80.0);
    s->a_drop = vx_attr_register("drop_percent", 0.0);
    s->a_bit = vx_attr_register("bit_period_us", 20.0);
    s->a_label = vx_attr_register_string("label", "sx1262");
    s->label[0] = 0;
    vx_attr_string_read(s->a_label, s->label, (uint32_t)sizeof s->label - 1);
    if (!s->label[0]) {
        s->label[0] = 's'; s->label[1] = 'x'; s->label[2] = '1';
        s->label[3] = '2'; s->label[4] = '6'; s->label[5] = '2'; s->label[6] = 0;
    }

    s->mode = MODE_STBY_RC;
    s->irq_mask = 0xFFFF;
    s->dio1_mask = 0;
    s->tx_base = 0x00;
    s->rx_base = 0x00;
    s->seed = (uint32_t)(vx_sim_now_nanos() & 0xFFFFFFFFu) ^
              (uint32_t)((unsigned char)s->label[0] * 2654435761u);

    {
        vx_spi_config cfg = {
            .sck = s->sck,
            .mosi = s->mosi,
            .miso = s->miso,
            .cs = s->nss,
            .mode = 0,
            .on_done = on_spi_done,
            .user_data = s,
        };
        s->spi = vx_spi_attach(&cfg);
    }

    s->tx.timer = vx_timer_create(air_tx_tick, s);
    s->busy_timer = vx_timer_create(busy_release, s);

    vx_pin_watch(s->nss, VX_EDGE_BOTH, on_nss, s);
    vx_pin_watch(s->rst, VX_EDGE_FALLING, on_reset, s);
    vx_pin_watch(s->ant, VX_EDGE_BOTH, air_on_ant, s);

    chip_log(s, "ready", 0, 0, 0);
}
