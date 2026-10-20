/*
 * kq130f.c — KQ-130F narrowband power-line carrier module model.
 *
 * Copyright (c) 2026 Martin Thuku. MIT licence (test/fixtures/chip-nets/LICENSE).
 *
 * Scope: the half duplex store and forward behaviour a KQ-130F host sketch
 * expects. The module takes
 * bytes on its UART RX at 9600 8N1, buffers them until the host stops
 * sending or the 128 byte payload limit is reached, then serialises the
 * buffer onto the synthetic LINE pin as one framed burst. Every other
 * KQ-130F on the same LINE net that is not transmitting decodes the burst
 * and replays the bytes on its own UART TX once the frame is complete.
 *
 * It does NOT model OFDM or FSK carriers, mains coupling, zero cross timing,
 * impedance or attenuation. See docs/wiki/custom-chips-chip-nets.md for the limits.
 *
 * Portable C: velxio-chip.h plus stdint / stdlib / string only.
 *
 * Line frame on LINE (identical scheme to the SX1262 ANT model):
 *   preamble  16 bits of 1
 *   sync      1 byte 0x2D
 *   length    1 byte, payload length, 1..128
 *   payload   length bytes
 *   crc       2 bytes, CRC16-CCITT poly 0x1021 init 0xFFFF over length+payload,
 *             big endian
 * Manchester: bit 1 is HIGH then LOW, bit 0 is LOW then HIGH, each half cell
 * lasting bit_period_us / 2. The line idles LOW (LINE released to input).
 */

#include "velxio-chip.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define KQ_MTU 128
#define KQ_BAUD 9600

#define AIR_PREAMBLE_BITS 16
#define AIR_SYNC_BYTE 0x2D
#define AIR_FRAME_MAX (1 + KQ_MTU + 2)
#define AIR_HEADER_BITS (AIR_PREAMBLE_BITS + 8)

/* Idle gap on the UART that ends a burst: three character times at 9600 8N1
 * is 3.125 ms, rounded to 4 ms so a host that pauses mid frame is tolerated. */
#define TX_GAP_NS 4000000ull

typedef struct {
    uint8_t frame[AIR_FRAME_MAX];
    uint32_t frame_len;
    uint32_t half_total;
    uint32_t cursor;
    uint8_t active;
    vx_timer timer;
} line_tx_t;

typedef struct {
    uint8_t locked;
    uint8_t expect;
    uint64_t t_last;
    uint64_t h_est; /* measured half cell, tracks a host whose timers run slow */
    uint32_t shift;
    uint8_t phase;
    uint8_t acc;
    uint32_t bitcnt;
    uint32_t need;
    uint32_t got;
    uint8_t buf[AIR_FRAME_MAX];
} line_rx_t;

typedef struct {
    vx_pin tx_pin, rx_pin, line;
    vx_uart uart;
    vx_attr a_noise, a_bit, a_label;
    char label[24];

    uint8_t pend[KQ_MTU]; /* bytes taken from the UART, waiting for the line */
    uint32_t pend_len;
    vx_timer gap_timer;
    uint32_t seed;

    line_tx_t tx;
    line_rx_t rx;
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

static void chip_log(chip_t *s, const char *text, const long *a)
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
    if (us < 4.0) us = 4.0;
    return (uint64_t)(us * 500.0);
}

/* ---- line transmit ----------------------------------------------------- */

static int tx_bit_at(line_tx_t *t, uint32_t i)
{
    uint32_t k;
    if (i < AIR_PREAMBLE_BITS) return 1;
    if (i < AIR_HEADER_BITS) return (AIR_SYNC_BYTE >> (AIR_HEADER_BITS - 1 - i)) & 1;
    k = i - AIR_HEADER_BITS;
    if ((k >> 3) >= t->frame_len) return 0;
    return (t->frame[k >> 3] >> (7 - (k & 7))) & 1;
}

static int tx_level_at(line_tx_t *t, uint32_t half)
{
    int bit = tx_bit_at(t, half >> 1);
    return (half & 1) ? !bit : bit;
}

static void line_tx_tick(void *ud)
{
    chip_t *s = (chip_t *)ud;
    if (!s->tx.active) return;
    if (s->tx.cursor < s->tx.half_total) {
        vx_pin_write(s->line, tx_level_at(&s->tx, s->tx.cursor) ? VX_HIGH : VX_LOW);
        s->tx.cursor++;
        return;
    }
    if (s->tx.cursor == s->tx.half_total) {
        vx_pin_write(s->line, VX_LOW);
        s->tx.cursor++;
        return;
    }
    vx_timer_stop(s->tx.timer);
    s->tx.active = 0;
    vx_pin_write(s->line, VX_LOW);
    vx_pin_set_mode(s->line, VX_INPUT);
    {
        long n = (long)s->tx.frame_len - 3;
        chip_log(s, "line tx done, bytes ", &n);
    }
}

static void line_tx_start(chip_t *s)
{
    uint32_t n = s->pend_len;
    uint32_t i;
    uint16_t crc;
    long ln;

    if (n == 0) return;
    if (n > KQ_MTU) n = KQ_MTU;
    if (s->tx.active) return; /* half duplex: the burst in flight wins */

    s->tx.frame[0] = (uint8_t)n;
    for (i = 0; i < n; i++) s->tx.frame[1 + i] = s->pend[i];
    crc = crc16_ccitt(s->tx.frame, 1 + n);
    s->tx.frame[1 + n] = (uint8_t)(crc >> 8);
    s->tx.frame[2 + n] = (uint8_t)crc;
    s->tx.frame_len = n + 3;
    s->tx.half_total = (AIR_HEADER_BITS + s->tx.frame_len * 8) * 2;
    s->tx.active = 1;
    s->pend_len = 0;

    vx_pin_set_mode(s->line, VX_OUTPUT_LOW);
    vx_pin_write(s->line, tx_level_at(&s->tx, 0) ? VX_HIGH : VX_LOW);
    s->tx.cursor = 1;
    vx_timer_start(s->tx.timer, half_ns(s), true);
    ln = (long)n;
    chip_log(s, "line tx start, bytes ", &ln);
}

static void on_gap(void *ud)
{
    chip_t *s = (chip_t *)ud;
    vx_timer_stop(s->gap_timer);
    line_tx_start(s);
}

/* ---- line receive ------------------------------------------------------ */

static void line_rx_reset(line_rx_t *r)
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

static void line_rx_frame(chip_t *s)
{
    line_rx_t *r = &s->rx;
    uint8_t len = r->buf[0];
    uint16_t got_crc;
    uint16_t want_crc;
    uint32_t noise = (uint32_t)vx_attr_read(s->a_noise);
    long l;

    if (noise > 0 && rnd(s) % 100u < noise) {
        /* Mains noise: flip one bit of the payload before the CRC is checked,
         * so the frame fails exactly the way a real corrupted burst does. */
        uint32_t pos = len ? (rnd(s) % len) : 0u;
        r->buf[1 + pos] ^= (uint8_t)(1u << (rnd(s) & 7u));
    }

    got_crc = (uint16_t)(((uint16_t)r->buf[1 + len] << 8) | r->buf[2 + len]);
    want_crc = crc16_ccitt(r->buf, 1u + len);
    if (got_crc != want_crc) {
        l = (long)len;
        chip_log(s, "line crc error, bytes ", &l);
        return;
    }
    vx_uart_write(s->uart, r->buf + 1, len);
    l = (long)len;
    chip_log(s, "line rx ok, forwarded bytes ", &l);
}

static void line_rx_bit(chip_t *s, int bit)
{
    line_rx_t *r = &s->rx;
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

    if (r->phase == 1) {
        if (byte == 0 || byte > KQ_MTU) { /* not a frame this module would send */
            line_rx_reset(r);
            return;
        }
        r->buf[0] = byte;
        r->got = 1;
        r->need = 1u + byte + 2u;
        r->phase = 2;
        return;
    }
    if (r->got < AIR_FRAME_MAX) r->buf[r->got] = byte;
    r->got++;
    if (r->got >= r->need) {
        line_rx_frame(s);
        line_rx_reset(r);
    }
}

/* Track the half cell actually observed, so a host whose software timers run
 * slow still decodes. Clamped against the configured bit period. */
static void line_rx_track(chip_t *s, line_rx_t *r, uint64_t measured)
{
    uint64_t nominal = half_ns(s);
    uint64_t est;
    if (measured == 0) return;
    est = (r->h_est * 3u + measured) / 4u;
    if (est < nominal / 8u) est = nominal / 8u;
    if (est > nominal * 8u) est = nominal * 8u;
    r->h_est = est;
}

static void on_line_edge(void *ud, vx_pin pin, int value)
{
    chip_t *s = (chip_t *)ud;
    line_rx_t *r = &s->rx;
    uint64_t now, dt, h;

    (void)pin;
    if (s->tx.active) return; /* half duplex: a module never hears itself */

    now = vx_sim_now_nanos();
    h = half_ns(s);

    if (!r->locked) {
        if (value != VX_HIGH) return;
        line_rx_reset(r);
        r->locked = 1;
        r->expect = 1;
        r->t_last = now;
        r->h_est = h;
        return;
    }

    if (r->h_est) h = r->h_est;
    dt = now - r->t_last;
    if (dt > h * 4u) {
        line_rx_reset(r);
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
        line_rx_track(s, r, dt);
        line_rx_bit(s, value ? 0 : 1);
        r->expect = 0;
        return;
    }
    if (dt * 2u < h * 3u) {
        line_rx_track(s, r, dt);
        r->expect = 1;
        return;
    }
    line_rx_track(s, r, dt / 2u);
    line_rx_bit(s, value ? 0 : 1);
    r->expect = 0;
}

/* ---- UART -------------------------------------------------------------- */

static void on_uart_rx(void *ud, uint8_t byte)
{
    chip_t *s = (chip_t *)ud;

    if (s->pend_len < KQ_MTU) s->pend[s->pend_len++] = byte;

    if (s->pend_len >= KQ_MTU) {
        vx_timer_stop(s->gap_timer);
        line_tx_start(s); /* the 128 byte payload limit forces the burst out */
        return;
    }
    /* Restart the idle gap: the burst goes out once the host stops talking. */
    vx_timer_stop(s->gap_timer);
    vx_timer_start(s->gap_timer, TX_GAP_NS, false);
}

/* ---- setup ------------------------------------------------------------- */

void chip_setup(void)
{
    chip_t *s = (chip_t *)calloc(1, sizeof(chip_t));
    if (!s) return;

    s->tx_pin = vx_pin_register("TX", VX_OUTPUT_HIGH); /* UART idle is high */
    s->rx_pin = vx_pin_register("RX", VX_INPUT_PULLUP);
    s->line = vx_pin_register("LINE", VX_INPUT);

    s->a_noise = vx_attr_register("line_noise_percent", 0.0);
    s->a_bit = vx_attr_register("bit_period_us", 200.0);
    s->a_label = vx_attr_register_string("label", "kq130f");
    s->label[0] = 0;
    vx_attr_string_read(s->a_label, s->label, (uint32_t)sizeof s->label - 1);
    if (!s->label[0]) {
        s->label[0] = 'k'; s->label[1] = 'q'; s->label[2] = '1';
        s->label[3] = '3'; s->label[4] = '0'; s->label[5] = 'f'; s->label[6] = 0;
    }

    s->seed = (uint32_t)(vx_sim_now_nanos() & 0xFFFFFFFFu) ^
              (uint32_t)((unsigned char)s->label[0] * 2654435761u);

    {
        vx_uart_config cfg = {
            .rx = s->rx_pin,
            .tx = s->tx_pin,
            .baud_rate = KQ_BAUD,
            .on_rx_byte = on_uart_rx,
            .on_tx_done = 0,
            .user_data = s,
        };
        s->uart = vx_uart_attach(&cfg);
    }

    s->tx.timer = vx_timer_create(line_tx_tick, s);
    s->gap_timer = vx_timer_create(on_gap, s);
    vx_pin_watch(s->line, VX_EDGE_BOTH, on_line_edge, s);

    chip_log(s, "ready at 9600 8N1", 0);
}
