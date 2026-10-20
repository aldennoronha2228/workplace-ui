// Arduino Uno + one DS1307 at 0x68 on Wire (SDA = A4, SCL = A5), read with
// RTClib. The other way sketches write the line that sets the clock to the
// moment of the build, with the two strings in RAM and not behind F():
//
//   rtc.adjust(DateTime(__DATE__, __TIME__));
//
// The strings are in the image all the same (the initial values of .data are
// in flash), and the model reads them there: set to its own build time, the
// clock stays on the host's time (project i2c-model-fidelity-2026-09,
// decision D7). After five readings the sketch stops the clock, which
// isrunning() reports, and keeps a byte in the chip's RAM.
//
// Serial protocol (115200): BEGIN, then READY (or NOT FOUND), RUNNING=<0|1>,
// then "NOW=<yyyy-mm-dd hh:mm:ss>" every 200 ms; between the fifth reading
// and the sixth, "RUNNING=<0|1> NVRAM=<byte>" after the clock was stopped.
//
// Libraries: RTClib 2.1.4, Adafruit BusIO 1.17.4
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --libs "RTClib,Adafruit BusIO" \
//   --out <this dir> <this dir>/avr-rtclib-ds1307.ino
#include <Wire.h>
#include <RTClib.h>

RTC_DS1307 rtc;
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
  Serial.print("RUNNING=");
  Serial.println(rtc.isrunning() ? 1 : 0);
  rtc.adjust(DateTime(__DATE__, __TIME__));
}

void loop() {
  if (readings == 5) {
    // Clock halt: bit 7 of the seconds register.
    Wire.beginTransmission(0x68);
    Wire.write((uint8_t)0x00);
    Wire.write((uint8_t)0x80);
    Wire.endTransmission();
    rtc.writenvram(3, 0x5A);
    Serial.print("RUNNING=");
    Serial.print(rtc.isrunning() ? 1 : 0);
    Serial.print(" NVRAM=");
    Serial.println(rtc.readnvram(3), HEX);
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
  Serial.println();
  delay(200);
}
