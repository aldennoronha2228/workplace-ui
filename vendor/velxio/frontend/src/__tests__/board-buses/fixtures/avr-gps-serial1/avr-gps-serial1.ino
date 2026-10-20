// The NEO-6M on the Mega second hardware UART: module TX -> RX1 (19).
// Serial stays the console. Rebuild with
// project/board-buses-2026-09/harness/compile-fixture.mjs --fqbn arduino:avr:mega
// --libs TinyGPSPlus.
#include <TinyGPS++.h>

TinyGPSPlus gps;

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600);
  Serial.println("GPS READY");
}

void loop() {
  while (Serial1.available()) gps.encode(Serial1.read());
  if (gps.location.isUpdated()) {
    Serial.print("FIX lat=");
    Serial.print(gps.location.lat(), 4);
    Serial.print(" lng=");
    Serial.print(gps.location.lng(), 4);
    Serial.print(" alt=");
    Serial.print(gps.altitude.meters(), 1);
    Serial.print(" sats=");
    Serial.print(gps.satellites.value());
    Serial.print(" time=");
    Serial.println(gps.time.value());
  }
  // Once a second, what the parser has seen so far: a module on the wrong
  // pin shows up here as chars=0, a rate mismatch as fail>0.
  static unsigned long last = 0;
  if (millis() - last >= 1000) {
    last = millis();
    Serial.print("STAT chars=");
    Serial.print(gps.charsProcessed());
    Serial.print(" ok=");
    Serial.print(gps.passedChecksum());
    Serial.print(" fail=");
    Serial.println(gps.failedChecksum());
  }
}
