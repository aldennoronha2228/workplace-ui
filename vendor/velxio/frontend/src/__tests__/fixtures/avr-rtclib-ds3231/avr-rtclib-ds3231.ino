// Arduino Uno + one DS3231 at 0x68 on Wire (SDA = A4, SCL = A5), read with
// RTClib: the setup of the library's own example (examples/ds3231), which is
// what most sketches that use a clock start from.
//
//   if (rtc.lostPower()) rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
//
// sets the clock to the moment this file was compiled. The two strings are
// parsed when the sketch runs, so they are in the image, and the model reads
// them there: set to its own build time, the clock stays on the host's time
// (project i2c-model-fidelity-2026-09, decision D7). After five readings the
// sketch sets a date of its own, which is kept.
//
// Serial protocol (115200): BEGIN, then READY (or NOT FOUND), LOST=<0|1>
// before and after the first adjust(), then "NOW=<yyyy-mm-dd hh:mm:ss>
// DOW=<0-6, Sunday is 0> T=<deg C>" every 200 ms, with OWN DATE between the
// fifth reading and the sixth.
//
// Libraries: RTClib 2.1.4, Adafruit BusIO 1.17.4
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --libs "RTClib,Adafruit BusIO" \
//   --out <this dir> <this dir>/avr-rtclib-ds3231.ino
#include <Wire.h>
#include <RTClib.h>

RTC_DS3231 rtc;
int readings = 0;

void print2(int v) {
  if (v < 10) Serial.print('0');
  Serial.print(v);
}

void setup() {
  Serial.begin(115200);
  Serial.println("BEGIN");
  if (!rtc.begin()) {
    Serial.println("NOT FOUND");
    while (true) delay(10);
  }
  Serial.println("READY");
  Serial.print("LOST=");
  Serial.println(rtc.lostPower() ? 1 : 0);
  if (rtc.lostPower()) {
    rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
  }
  Serial.print("LOST=");
  Serial.println(rtc.lostPower() ? 1 : 0);
}

void loop() {
  if (readings == 5) {
    Serial.println("OWN DATE");
    rtc.adjust(DateTime(2024, 2, 29, 23, 59, 58));
  }
  readings++;
  DateTime now = rtc.now();
  Serial.print("NOW=");
  Serial.print(now.year());
  Serial.print('-');
  print2(now.month());
  Serial.print('-');
  print2(now.day());
  Serial.print(' ');
  print2(now.hour());
  Serial.print(':');
  print2(now.minute());
  Serial.print(':');
  print2(now.second());
  Serial.print(" DOW=");
  Serial.print(now.dayOfTheWeek());
  Serial.print(" T=");
  Serial.println(rtc.getTemperature());
  delay(200);
}
