// Arduino Uno + SSD1306 128x64 at 0x3C on Wire (SDA = A4, SCL = A5), driven
// with Adafruit_SSD1306: one known picture (the top-left quarter lit), then
// each command that changes what the glass shows without a new frame, and
// the command that undoes it.
//
// Serial protocol (115200): after each step the sketch prints its name and
// waits 50 ms, so a test can look at the panel before the next step.
//   SHOWN      the quarter, as begin() and display() left it
//   INVERTED   invertDisplay(true)            (0xA7)
//   DIM        invertDisplay(false), dim(true) (0xA6, 0x81 0x00)
//   OFF        dim(false), display off         (0x81 0xCF, 0xAE)
//   ALLON      display on, entire display on   (0xAF, 0xA5)
//   COMUP      resume RAM, COM scan up         (0xA4, 0xC0)
//   STARTLINE  COM scan down, start line 8     (0xC8, 0x48)
//   OFFSET     start line 0, display offset 16 (0x40, 0xD3 0x10)
//   SEGSAME    offset 0, segment re-map off    (0xD3 0x00, 0xA0)
//   MIRRORED   display() again under 0xA0
//   RESTORED   re-map on (0xA1) and display() again
//   DONE
//
// Libraries: Adafruit SSD1306 2.5.17, Adafruit GFX Library 1.12.6,
//            Adafruit BusIO 1.17.4
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno \
//   --libs "Adafruit SSD1306,Adafruit GFX Library,Adafruit BusIO" \
//   --out <this dir> <this dir>/avr-ssd1306-adafruit-commands.ino
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);

static void step(const char *name) {
  Serial.println(name);
  Serial.flush();
  delay(50);
}

void setup() {
  Serial.begin(115200);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("NOT FOUND");
    for (;;) {}
  }
  display.clearDisplay();
  display.fillRect(0, 0, 64, 32, SSD1306_WHITE);
  display.display();
  step("SHOWN");

  display.invertDisplay(true);
  step("INVERTED");

  display.invertDisplay(false);
  display.dim(true);
  step("DIM");

  display.dim(false);
  display.ssd1306_command(SSD1306_DISPLAYOFF);
  step("OFF");

  display.ssd1306_command(SSD1306_DISPLAYON);
  display.ssd1306_command(SSD1306_DISPLAYALLON);
  step("ALLON");

  display.ssd1306_command(SSD1306_DISPLAYALLON_RESUME);
  display.ssd1306_command(SSD1306_COMSCANINC);
  step("COMUP");

  display.ssd1306_command(SSD1306_COMSCANDEC);
  display.ssd1306_command(SSD1306_SETSTARTLINE | 8);
  step("STARTLINE");

  display.ssd1306_command(SSD1306_SETSTARTLINE | 0);
  display.ssd1306_command(SSD1306_SETDISPLAYOFFSET);
  display.ssd1306_command(16);
  step("OFFSET");

  display.ssd1306_command(SSD1306_SETDISPLAYOFFSET);
  display.ssd1306_command(0);
  display.ssd1306_command(SSD1306_SEGREMAP);
  step("SEGSAME");

  display.display();
  step("MIRRORED");

  display.ssd1306_command(SSD1306_SEGREMAP | 1);
  display.display();
  step("RESTORED");
  Serial.println("DONE");
}

void loop() {}
