// Arduino Uno + LCD 16x2 with a PCF8574 backpack at 0x27 on Wire (SDA = A4,
// SCL = A5), driven with LiquidCrystal_PCF8574: "Hello" on row 0, "World" on row 1,
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
// Libraries: LiquidCrystal_PCF8574 2.3.0
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --libs "LiquidCrystal_PCF8574" \
//   --out <this dir> <this dir>/avr-lcd-pcf8574.ino
#include <Wire.h>
#include <LiquidCrystal_PCF8574.h>

LiquidCrystal_PCF8574 lcd(0x27);

void setup() {
  Serial.begin(115200);
  Serial.println("BEGIN");
  lcd.begin(16, 2);
  lcd.setBacklight(255);
  lcd.setCursor(0, 0);
  lcd.print("Hello");
  lcd.setCursor(0, 1);
  lcd.print("World");
  Serial.println("DONE");
}

void loop() {}
