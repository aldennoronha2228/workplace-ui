/*
 * conf-uart-console: the guest of the UART controller-port conformance suite
 * (project board-buses-2026-09, F6, TESTS.md layer 2; the tests that drive it
 * are port-conformance-avr-uart.test.ts, port-conformance-rp2040-uart.test.ts
 * and the RP2350's port-conformance-rp2350-uart.test.ts).
 *
 * One sketch, built for the Uno (USART0), the Mega (USART0..3), the Pico
 * (UART0, UART1) and the Pico 2 (both cores). Units are the SoC's controller
 * indexes, in the order the core binds them: 0 = Serial (UART0; on the RP
 * boards velxio prepends "#define Serial Serial1"), 1 = Serial1 on the Mega
 * and Serial2 on the Pico, and so on.
 *
 * UART0 is the console AND a controller under test, so its RX carries both:
 * every byte is DATA the guest captured, except a line that starts with ESC
 * (0x1b), which is a command. Answers never go out on any UART, because a
 * probe on UART0's TX would hear them: they are written to `answer`, a buffer
 * in SRAM the rig finds by its magic and polls by its sequence byte, which is
 * written last. Nothing is printed at boot for the same reason: `ready` in
 * the same buffer is the boot report.
 *
 *   ESC t U HH HH ..   transmit the bytes on unit U and wait until the last
 *                      one has left (flush). Answers OK.
 *   ESC r U N          wait up to 100 ms for N bytes on unit U and answer
 *                      the bytes it has, in hex. Unit 0's bytes are the data
 *                      the parser set aside; the others are read from the
 *                      port. Answers what it got, possibly nothing.
 *   ESC b U BAUD       end() and begin(BAUD) on unit U. Answers OK.
 *   ESC p U TX RX      RP only: move unit U to these pads (end, setTX, setRX,
 *                      begin at its rate). Answers OK.
 *
 * Every unit begins at 115200 8N1 in setup().
 *
 * Rebuild (production toolchain), from the repo root:
 *   H=project/board-buses-2026-09/harness/compile-fixture.mjs
 *   D=velxio/frontend/src/__tests__/board-buses/fixtures/conf-uart-console
 *   node $H --fqbn arduino:avr:uno --out $D/uno $D/conf-uart-console.ino
 *   node $H --fqbn arduino:avr:mega --out $D/mega $D/conf-uart-console.ino
 *   node $H --fqbn rp2040:rp2040:rpipico --out $D/pico $D/conf-uart-console.ino
 *   P=pro/frontend/src/pro/boards/rp2350/__tests__/fixtures
 *   node $H --fqbn rp2040:rp2040:rpipico2:arch=riscv --board-kind badger-2350 \
 *     --out $P/conf-rp2350-uart $D/conf-uart-console.ino
 *   node $H --fqbn rp2040:rp2040:rpipico2:arch=arm --board-kind badger-2350 \
 *     --out $P/conf-rp2350-uart-arm $D/conf-uart-console.ino
 * (a copy of this .ino sits in $P/conf-rp2350-uart so the pro fixtures rebuild
 * on their own). Keep the .bin / .hex and compile.log; drop the .uf2.
 */

#if defined(ARDUINO_ARCH_RP2040)
static SerialUART* const U[] = { &Serial1, &Serial2 };
#elif defined(__AVR_ATmega2560__)
static HardwareSerial* const U[] = { &Serial, &Serial1, &Serial2, &Serial3 };
#else
static HardwareSerial* const U[] = { &Serial };
#endif
static const uint8_t UNITS = sizeof(U) / sizeof(U[0]);
static const uint32_t DEFAULT_BAUD = 115200;
static uint32_t baud[UNITS];

/* The answer buffer: magic, then the commit byte, then what was answered. */
struct Answer {
  char magic[4];
  volatile uint8_t seq;
  volatile uint8_t ready;
  volatile uint8_t len;
  char text[200];
};
static Answer answer;

static void commit(const char* text) {
  uint8_t n = 0;
  while (text[n] && n < sizeof(answer.text) - 1) {
    answer.text[n] = text[n];
    n++;
  }
  answer.text[n] = 0;
  answer.len = n;
  answer.seq = (uint8_t)(answer.seq + 1);
}

/* Unit 0's RX: data set aside by the parser, and the command line it builds. */
static uint8_t cap[256];
static uint16_t capLen = 0;
static char line[400];
static uint16_t lineLen = 0;
static bool inCmd = false;
static bool pending = false;

static void poll0() {
  while (!pending && U[0]->available()) {
    int c = U[0]->read();
    if (inCmd) {
      if (c == '\n') {
        line[lineLen] = 0;
        inCmd = false;
        pending = true;
      } else if (lineLen < sizeof(line) - 1) {
        line[lineLen++] = (char)c;
      }
    } else if (c == 0x1b) {
      inCmd = true;
      lineLen = 0;
    } else if (capLen < sizeof(cap)) {
      cap[capLen++] = (uint8_t)c;
    }
  }
}

static long num(char** p, int base) { return strtol(*p, p, base); }

static char hexOut[3 * 128 + 1];

static void hex2(char* d, uint8_t v) {
  static const char* H = "0123456789abcdef";
  d[0] = H[v >> 4];
  d[1] = H[v & 15];
}

/* Up to n bytes from unit u, waiting at most 100 ms for them. */
static void readUnit(int u, int n) {
  if (n > 128) n = 128;
  int got = 0;
  unsigned long t0 = millis();
  uint8_t buf[128];
  while (got < n && millis() - t0 < 100) {
    if (u == 0) {
      poll0();
      while (got < n && capLen > 0) {
        buf[got++] = cap[0];
        for (uint16_t i = 1; i < capLen; i++) cap[i - 1] = cap[i];
        capLen--;
      }
    } else {
      while (got < n && U[u]->available()) buf[got++] = (uint8_t)U[u]->read();
    }
  }
  char* d = hexOut;
  for (int i = 0; i < got; i++) {
    if (i) *d++ = ' ';
    hex2(d, buf[i]);
    d += 2;
  }
  *d = 0;
  commit(hexOut);
}

static void exec(char* s) {
  char cmd = s[0];
  char* p = s + 1;
  int u = (int)num(&p, 10);
  if (u < 0 || u >= UNITS) {
    commit("ERR unit");
    return;
  }
  switch (cmd) {
    case 't': {
      for (;;) {
        char* e;
        long b = strtol(p, &e, 16);
        if (e == p) break;
        p = e;
        U[u]->write((uint8_t)b);
      }
      U[u]->flush();
      commit("OK");
      break;
    }
    case 'r':
      readUnit(u, (int)num(&p, 10));
      break;
    case 'b': {
      uint32_t rate = (uint32_t)num(&p, 10);
      U[u]->end();
      baud[u] = rate;
      U[u]->begin(rate);
      commit("OK");
      break;
    }
#if defined(ARDUINO_ARCH_RP2040)
    case 'p': {
      int tx = (int)num(&p, 10), rx = (int)num(&p, 10);
      U[u]->end();
      U[u]->setTX(tx);
      U[u]->setRX(rx);
      U[u]->begin(baud[u]);
      commit("OK");
      break;
    }
#endif
    default:
      commit("ERR cmd");
  }
}

void setup() {
  for (uint8_t i = 0; i < UNITS; i++) {
    baud[i] = DEFAULT_BAUD;
    U[i]->begin(DEFAULT_BAUD);
  }
  answer.magic[0] = 'V';
  answer.magic[1] = 'X';
  answer.magic[2] = 'A';
  answer.magic[3] = 'N';
  answer.seq = 0;
  answer.len = 0;
  answer.text[0] = 0;
  answer.ready = 1;
}

void loop() {
  poll0();
  if (pending) {
    pending = false;
    exec(line);
  }
}
