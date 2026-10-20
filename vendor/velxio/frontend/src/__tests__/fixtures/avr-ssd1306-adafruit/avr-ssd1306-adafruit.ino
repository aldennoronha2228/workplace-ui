// Arduino Uno + SSD1306 128x64 at 0x3C on Wire (SDA = A4, SCL = A5), drawn
// with Adafruit_SSD1306: two frames whose pictures are known pixel by pixel.
//
// On AVR the library sends one display() as about 37 I2C transactions (the
// 1 KiB buffer in 31-byte chunks behind a 0x40 control byte, plus the
// address window), so the fixture is the yardstick for how often the part
// repaints per frame, and for which picture it shows after the last one.
//
// Serial protocol (115200): BEGIN, then READY (or NOT FOUND), then "FRAME 0"
// after the first display() (the top-left quarter lit) and "FRAME 1" after
// the second (only the bottom-right quarter lit), then DONE.
//
// Libraries: Adafruit SSD1306 2.5.17, Adafruit GFX Library 1.12.6,
//            Adafruit BusIO 1.17.4
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno \
//   --libs "Adafruit SSD1306,Adafruit GFX Library,Adafruit BusIO" \
//   --out <this dir> <this dir>/avr-ssd1306-adafruit.ino
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);

void setup() {
  Serial.begin(115200);
  Serial.println("BEGIN");
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("NOT FOUND");
    for (;;) {}
  }
  Serial.println("READY");

  display.clearDisplay();
  display.fillRect(0, 0, 64, 32, SSD1306_WHITE);
  display.display();
  Serial.println("FRAME 0");

  display.clearDisplay();
  display.fillRect(64, 32, 64, 32, SSD1306_WHITE);
  display.display();
  Serial.println("FRAME 1");
  Serial.println("DONE");
}

void loop() {}
