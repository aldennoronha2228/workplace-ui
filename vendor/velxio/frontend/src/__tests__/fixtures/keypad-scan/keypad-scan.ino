// Fixture for membrane-keypad-real-firmware.test.ts. The wiring is the one
// from issue #327 (rows 9 8 7 6, columns 5 4 3 2) and the scan is the Keypad
// library's own: rows INPUT_PULLUP, each column driven LOW in turn.
// Compiled with arduino-cli for arduino:avr:uno against Keypad 3.1.1.
#include <Keypad.h>

const byte ROWS = 4;
const byte COLS = 4;

char keys[ROWS][COLS] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'}
};

byte rowPins[ROWS] = {9, 8, 7, 6};
byte colPins[COLS] = {5, 4, 3, 2};

Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);

void setup() {
  Serial.begin(115200);
  Serial.println("READY");
}

void loop() {
  char key = keypad.getKey();
  if (key) {
    Serial.print("KEY:");
    Serial.println(key);
  }
}
