// I2C RTC Reader — DS1307 at address 0x68
// Reads hours:minutes:seconds from the virtual RTC
// and prints to Serial Monitor every second.

#include <Wire.h>

#define DS1307_ADDR 0x68

byte bcdToDec(byte val) {
  return ((val >> 4) * 10) + (val & 0x0F);
}

void setup() {
  Wire.begin();
  Serial.begin(9600);

  Serial.println("===========================");
  Serial.println("  DS1307 RTC Reader (I2C)");
  Serial.println("===========================");
  Serial.println();
}

void loop() {
  // Set register pointer to 0 (seconds)
  Wire.beginTransmission(DS1307_ADDR);
  Wire.write(0x00);
  Wire.endTransmission();

  // Request 7 bytes: sec, min, hr, dow, date, month, year
  Wire.requestFrom(DS1307_ADDR, 7);

  if (Wire.available() >= 7) {
    byte sec   = bcdToDec(Wire.read() & 0x7F);
    byte min   = bcdToDec(Wire.read());
    byte hr    = bcdToDec(Wire.read() & 0x3F);
    byte dow   = bcdToDec(Wire.read());
    byte date  = bcdToDec(Wire.read());
    byte month = bcdToDec(Wire.read());
    byte year  = bcdToDec(Wire.read());

    // Print formatted time
    Serial.print("Time: ");
    if (hr < 10) Serial.print("0");
    Serial.print(hr);
    Serial.print(":");
    if (min < 10) Serial.print("0");
    Serial.print(min);
    Serial.print(":");
    if (sec < 10) Serial.print("0");
    Serial.print(sec);

    Serial.print("  Date: ");
    if (date < 10) Serial.print("0");
    Serial.print(date);
    Serial.print("/");
    if (month < 10) Serial.print("0");
    Serial.print(month);
    Serial.print("/20");
    if (year < 10) Serial.print("0");
    Serial.println(year);
  } else {
    Serial.println("Error: Could not read RTC");
  }

  delay(1000);
}
