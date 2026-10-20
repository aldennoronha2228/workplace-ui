// Arduino Uno + LCD 16x2 with a PCF8574 backpack at 0x27 on Wire (SDA = A4,
// SCL = A5), driven with hd44780: "Hello" on row 0, "World" on row 1,
// backlight on.
//
// This driver reads the port. hd44780_I2Cexp tells a PCF8574 from an
// MCP23008 by what a read returns after it wrote 0x00, then works out the
// pin map and the backlight polarity from reads after writing 0xFF and 0xFB
// (hd44780_I2Cexp.h, IdentifyIOexp() and autocfg8574()). On the bench P3
// reads low, because the backlight transistor's base pulls the released pin
// down, and the library picks an active-high backlight. Against a port that
// reads 0xFF it picks active low, and lcd.backlight() turns the panel dark.
//
// Serial protocol (115200): BEGIN, then DONE once both rows are printed, or
// "BEGIN FAILED <status>" when the library cannot configure the backpack.
//
// Libraries: hd44780 1.3.2 (hd44780_I2Cexp)
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --libs "hd44780" \
//   --out <this dir> <this dir>/avr-lcd-hd44780.ino
#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>

// No address and no pin map: the library finds the expander and works out
// the wiring and the backlight polarity by reading the port.
hd44780_I2Cexp lcd;

void setup() {
  Serial.begin(115200);
  Serial.println("BEGIN");
  int status = lcd.begin(16, 2);
  if (status) {
    Serial.print("BEGIN FAILED ");
    Serial.println(status);
    for (;;) {}
  }
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Hello");
  lcd.setCursor(0, 1);
  lcd.print("World");
  Serial.println("DONE");
}

void loop() {}
