// Arduino Uno + one DS1307 at 0x68 on Wire (SDA = A4, SCL = A5), read with
// the Seeed library "Grove - RTC DS1307": its example SetTimeAndDisplay, with
// a delay in the loop and the line ending of println.
//
// The sketch sets 19 January 2013, 15:28:30, a Saturday, and prints what it
// reads back. The library counts Monday as 1 (DS1307.h: MON 1 ... SUN 7), so
// the chip has to give back the day of week it was given: a model that
// answers with a weekday of its own, Sunday as 1, prints SUN or MON here.
//
// Serial protocol (9600): "<h>:<m>:<s>\t<month>/<day>/<year> <day>*<DAY> "
// every 200 ms.
//
// Libraries: Grove - RTC DS1307 1.0.0
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --libs "Grove - RTC DS1307" \
//   --out <this dir> <this dir>/avr-grove-rtc-ds1307.ino
#include <Wire.h>
#include "DS1307.h"

DS1307 clock; // define a object of DS1307 class

void setup() {
  Serial.begin(9600);
  clock.begin();
  clock.fillByYMD(2013, 1, 19); // Jan 19,2013
  clock.fillByHMS(15, 28, 30);  // 15:28 30"
  clock.fillDayOfWeek(SAT);     // Saturday
  clock.setTime();              // write time to the RTC chip
}

void loop() {
  printTime();
  delay(200);
}

/*Function: Display time on the serial monitor*/
void printTime() {
  clock.getTime();
  Serial.print(clock.hour, DEC);
  Serial.print(":");
  Serial.print(clock.minute, DEC);
  Serial.print(":");
  Serial.print(clock.second, DEC);
  Serial.print("	");
  Serial.print(clock.month, DEC);
  Serial.print("/");
  Serial.print(clock.dayOfMonth, DEC);
  Serial.print("/");
  Serial.print(clock.year + 2000, DEC);
  Serial.print(" ");
  Serial.print(clock.dayOfMonth);
  Serial.print("*");
  switch (clock.dayOfWeek) { // Friendly printout the weekday
    case MON:
      Serial.print("MON");
      break;
    case TUE:
      Serial.print("TUE");
      break;
    case WED:
      Serial.print("WED");
      break;
    case THU:
      Serial.print("THU");
      break;
    case FRI:
      Serial.print("FRI");
      break;
    case SAT:
      Serial.print("SAT");
      break;
    case SUN:
      Serial.print("SUN");
      break;
  }
  Serial.println(" ");
}
