// Arduino Uno + SSD1306 128x64 at 0x3C on Wire (SDA = A4, SCL = A5), drawn
// with U8g2 in full-buffer mode: two frames whose pictures are known pixel
// by pixel.
//
// sendBuffer() goes through u8x8_cad_ssd13xx_fast_i2c, which splits every
// 128-byte page into short data transactions, so one frame is several dozen
// I2C transactions.
//
// Serial protocol (115200): BEGIN, then "FRAME 0" after the first
// sendBuffer() (the top-left quarter lit) and "FRAME 1" after the second
// (only the bottom-right quarter lit), then DONE.
//
// Libraries: U8g2 2.36.19
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --libs "U8g2" \
//   --out <this dir> <this dir>/avr-ssd1306-u8g2.ino
#include <Wire.h>
#include <U8g2lib.h>

U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

void setup() {
  Serial.begin(115200);
  Serial.println("BEGIN");
  u8g2.begin();

  u8g2.clearBuffer();
  u8g2.drawBox(0, 0, 64, 32);
  u8g2.sendBuffer();
  Serial.println("FRAME 0");

  u8g2.clearBuffer();
  u8g2.drawBox(64, 32, 64, 32);
  u8g2.sendBuffer();
  Serial.println("FRAME 1");
  Serial.println("DONE");
}

void loop() {}
