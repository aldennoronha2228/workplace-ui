// Arduino Uno + LCD 16x2 with a PCF8574 backpack at 0x27 on Wire (SDA = A4,
// SCL = A5), driven with LCD_I2C: "Hello" on row 0, "World" on row 1,
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
// Libraries: LCD_I2C 2.4.0 (blackhack, github.com/blackhack/LCD_I2C)
// Rebuild: the compile service resolves "LCD_I2C" to the LCD-I2C library of
// another author (their names differ by one character), so this one is built
// with arduino-cli in the app container, from the 2.4.0 release:
//   arduino-cli compile --fqbn arduino:avr:uno --library <LCD_I2C-2.4.0> \
//     --output-dir out <sketch dir holding this file as sketch.ino>
#include <Wire.h>
#include <LCD_I2C.h>

LCD_I2C lcd(0x27, 16, 2);

void setup() {
  Serial.begin(115200);
  Serial.println("BEGIN");
  lcd.begin();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Hello");
  lcd.setCursor(0, 1);
  lcd.print("World");
  Serial.println("DONE");
}

void loop() {}
