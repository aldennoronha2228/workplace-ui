// Arduino Uno + LCD 16x2 with a PCF8574 backpack at 0x27 on Wire (SDA = A4,
// SCL = A5), driven with LiquidCrystal_I2C: "Hello" on row 0, "World" on row 1,
// backlight on.
//
// The backpack's expander is quasi-bidirectional and its P3 drives the base
// of the backlight transistor, so a read of the port sees P3 low. This
// fixture is one of the four drivers the corpus uses for the part; what the
// panel shows under it must not depend on how the model answers reads
// unless the driver reads.
//
// Serial protocol (115200): BEGIN, then DONE once both rows are printed.
//
// Libraries: LiquidCrystal_I2C 2.0.0
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --libs "LiquidCrystal I2C" \
//   --out <this dir> <this dir>/avr-lcd-liquidcrystal-i2c.ino
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);

void setup() {
  Serial.begin(115200);
  Serial.println("BEGIN");
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Hello");
  lcd.setCursor(0, 1);
  lcd.print("World");
  Serial.println("DONE");
}

void loop() {}
