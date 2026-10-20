// Copy of pro/frontend/src/pro/esp32sim/__tests__/fixtures/esp32js-mega-serial1-mhz16/mega-serial1-mhz16.ino and its .hex
// (arduino:avr, production toolchain), so the OSS engine suite can drive the
// same sketch without reaching into the overlay. Rebuild with
// project/board-buses-2026-09/harness/compile-fixture.mjs --fqbn arduino:avr:mega.
// Grove CO2 Sensor (MH-Z16) on an Arduino Mega's second hardware UART:
// module TX -> RX1 (19), module RX -> TX1 (18). Serial stays the console.
const uint8_t READ_CMD[9] = {0xFF, 0x01, 0x86, 0x00, 0x00, 0x00, 0x00, 0x00, 0x79};

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600);
  Serial.println("READY");
}

void loop() {
  Serial1.write(READ_CMD, 9);
  uint8_t r[9];
  uint8_t n = 0;
  unsigned long t0 = millis();
  while (n < 9 && millis() - t0 < 100) {
    if (Serial1.available()) r[n++] = Serial1.read();
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
