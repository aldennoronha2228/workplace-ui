// Arduino Uno + one BMP280 at 0x76 on Wire (SDA = A4, SCL = A5), read with
// Adafruit_BMP280: the library most projects read the part with.
//
// First the way the gallery examples do it (begin(0x76), then setSampling()
// for normal mode), then in forced mode, where every reading is one
// takeForcedMeasurement(). A test can tell from the lines whether begin()
// found the chip, whether takeForcedMeasurement() came back, and which values
// the driver's own compensation makes of what it read.
//
// Serial protocol (115200): BOOT, then BEGIN=OK or BEGIN=FAIL, then a line
// per pass, "NORMAL T=<c> P=<pa>" for the first passes and
// "FORCED T=<c> P=<pa>" from then on, T with two decimals and P with none.
//
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno \
//   --libs "Adafruit BMP280 Library,Adafruit Unified Sensor,Adafruit BusIO" \
//   --out <this dir> <this dir>/avr-adafruit-bmp280.ino
#include <Wire.h>
#include <Adafruit_BMP280.h>

#define NORMAL_PASSES 6

Adafruit_BMP280 bmp;

static void report(const __FlashStringHelper *mode) {
  Serial.print(mode);
  Serial.print(F(" T="));
  Serial.print(bmp.readTemperature(), 2);
  Serial.print(F(" P="));
  Serial.println(bmp.readPressure(), 0);
}

void setup() {
  Serial.begin(115200);
  Serial.println(F("BOOT"));
  if (!bmp.begin(0x76)) {
    Serial.println(F("BEGIN=FAIL"));
    while (1) delay(10);
  }
  Serial.println(F("BEGIN=OK"));
  bmp.setSampling(Adafruit_BMP280::MODE_NORMAL,
                  Adafruit_BMP280::SAMPLING_X2,
                  Adafruit_BMP280::SAMPLING_X16,
                  Adafruit_BMP280::FILTER_X16,
                  Adafruit_BMP280::STANDBY_MS_500);
}

void loop() {
  static uint8_t pass = 0;
  if (pass < NORMAL_PASSES) {
    report(F("NORMAL"));
    pass++;
    if (pass == NORMAL_PASSES) {
      bmp.setSampling(Adafruit_BMP280::MODE_FORCED,
                      Adafruit_BMP280::SAMPLING_X1,
                      Adafruit_BMP280::SAMPLING_X1,
                      Adafruit_BMP280::FILTER_OFF,
                      Adafruit_BMP280::STANDBY_MS_1);
    }
  } else if (bmp.takeForcedMeasurement()) {
    report(F("FORCED"));
  } else {
    Serial.println(F("FORCED=FAIL"));
  }
  delay(20);
}
