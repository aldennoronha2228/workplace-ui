// D2 is an input the whole time. A chip on the canvas holds it LOW from the
// moment it is placed. The sketch enables the internal pull-up on D2 (a PORT
// write on a pin whose DDR says input) and disables it again: the wire never
// moves, because a push-pull output beats a 35 k pull-up, so a second chip
// watching D2 must see no edge at all.
void setup() {
  Serial.begin(115200);
  pinMode(2, INPUT);
  Serial.print("READY\n");
  delay(5);
  pinMode(2, INPUT_PULLUP);
  delay(5);
  Serial.print("v=");
  Serial.print(digitalRead(2));
  Serial.print("\n");
  pinMode(2, INPUT);
  delay(5);
  Serial.print("DONE\n");
}

void loop() {}
