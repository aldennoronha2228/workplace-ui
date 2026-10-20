// Copy of pro/frontend/src/pro/esp32sim/__tests__/fixtures/esp32js-softserial-mhz16/softserial-mhz16.ino and its .hex
// (arduino:avr, production toolchain), so the OSS engine suite can drive the
// same sketch without reaching into the overlay. Rebuild with
// project/board-buses-2026-09/harness/compile-fixture.mjs --fqbn arduino:avr:uno.
// Seeed wiki idiom for the Grove CO2 Sensor (MH-Z16) on an Uno: the module on
// D2/D3 through SoftwareSerial, hardware Serial left for debug prints.
// Module TX -> D2 (sketch RX), module RX -> D3 (sketch TX).
#include <SoftwareSerial.h>

SoftwareSerial co2(2, 3);  // RX, TX
const uint8_t READ_CMD[9] = {0xFF, 0x01, 0x86, 0x00, 0x00, 0x00, 0x00, 0x00, 0x79};

void setup() {
  Serial.begin(115200);
  co2.begin(9600);
  Serial.println("READY");
}

void loop() {
  co2.write(READ_CMD, 9);
  uint8_t r[9];
  uint8_t n = 0;
  unsigned long t0 = millis();
  while (n < 9 && millis() - t0 < 100) {
    if (co2.available()) r[n++] = co2.read();
  }
  if (n == 9 && r[0] == 0xFF && r[1] == 0x86) {
    Serial.print("CO2=");
    Serial.println((unsigned)r[2] * 256 + r[3]);
  } else {
    Serial.print("NOFRAME n=");
    Serial.println(n);
  }
  delay(20);
}
