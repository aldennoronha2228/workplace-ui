// Arduino Uno + one BMP280 at 0x76 on Wire (SDA = A4, SCL = A5).
//
// Prints the compensated temperature the part reports, so a test can tell
// which value the simulated sensor is holding: the one the project set, a
// value the sensor panel pushed while running, or the panel's own default.
// Registers are read directly (chip id, calibration, raw temperature and the
// datasheet's integer compensation) so there is no library in the way.
//
// Serial protocol (115200): BOOT, then once per loop "T=<c>" with one
// decimal, or "T=ERR" when the part does not answer.
//
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --out <this dir> <this dir>/avr-bmp280-temp.ino
#include <Wire.h>

#define BMP_ADDR 0x76

static bool readRegs(uint8_t reg, uint8_t *buf, uint8_t n) {
  Wire.beginTransmission(BMP_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)BMP_ADDR, n) != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

static bool writeReg(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(BMP_ADDR);
  Wire.write(reg);
  Wire.write(v);
  return Wire.endTransmission() == 0;
}

void setup() {
  Serial.begin(115200);
  Serial.println(F("BOOT"));
  Wire.begin();
}

void loop() {
  uint8_t id = 0, cal[6], raw[3];
  bool ok = readRegs(0xD0, &id, 1) && id == 0x58 && writeReg(0xF4, 0x27) &&
            readRegs(0x88, cal, 6) && readRegs(0xFA, raw, 3);
  if (!ok) {
    Serial.println(F("T=ERR"));
  } else {
    uint16_t T1 = cal[0] | (cal[1] << 8);
    int16_t T2 = (int16_t)(cal[2] | (cal[3] << 8));
    int16_t T3 = (int16_t)(cal[4] | (cal[5] << 8));
    int32_t adc = ((int32_t)raw[0] << 12) | ((int32_t)raw[1] << 4) | (raw[2] >> 4);
    int32_t v1 = ((((adc >> 3) - ((int32_t)T1 << 1))) * ((int32_t)T2)) >> 11;
    int32_t d = (adc >> 4) - (int32_t)T1;
    int32_t v2 = (((d * d) >> 12) * ((int32_t)T3)) >> 14;
    int32_t centi = ((v1 + v2) * 5 + 128) >> 8;
    Serial.print(F("T="));
    Serial.println(centi / 100.0, 1);
  }
  delay(20);
}
