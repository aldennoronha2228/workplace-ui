// Arduino Uno + SSD1306 128x64 at 0x3C on Wire (SDA = A4, SCL = A5), driven
// with U8g2 in page-buffer mode (the _1_ constructor: firstPage / nextPage,
// eight page transfers per picture), one known picture (the top-left quarter
// lit), then the panel calls U8g2 offers.
//
// Serial protocol (115200): after each step the sketch prints its name and
// waits 50 ms, so a test can look at the panel before the next step.
//   SHOWN    the quarter, as begin() and the page loop left it
//   DIM      setContrast(0)                       (0x81 0x00)
//   ASLEEP   setContrast(255), setPowerSave(1)    (0x81 0xFF, 0xAE)
//   AWAKE    setPowerSave(0)                      (0xAF)
//   FLIPPED  setFlipMode(1) and the page loop again (0xA0 0xC0)
//   DONE
//
// Libraries: U8g2 2.36.19
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --libs "U8g2" \
//   --out <this dir> <this dir>/avr-ssd1306-u8g2-commands.ino
#include <Wire.h>
#include <U8g2lib.h>

U8G2_SSD1306_128X64_NONAME_1_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

static void step(const char *name) {
  Serial.println(name);
  Serial.flush();
  delay(50);
}

static void draw() {
  u8g2.firstPage();
  do {
    u8g2.drawBox(0, 0, 64, 32);
  } while (u8g2.nextPage());
}

void setup() {
  Serial.begin(115200);
  u8g2.begin();
  draw();
  step("SHOWN");

  u8g2.setContrast(0);
  step("DIM");

  u8g2.setContrast(255);
  u8g2.setPowerSave(1);
  step("ASLEEP");

  u8g2.setPowerSave(0);
  step("AWAKE");

  u8g2.setFlipMode(1);
  draw();
  step("FLIPPED");
  Serial.println("DONE");
}

void loop() {}
