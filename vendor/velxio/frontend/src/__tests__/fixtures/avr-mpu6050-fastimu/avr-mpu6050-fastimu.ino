// Arduino Uno + one MPU-6050 at 0x68 on Wire, driven by FastIMU (LiquidCGS),
// the library whose update() reads only when INT_STATUS says DATA_RDY and
// whose calibrateAccelGyro() averages FIFO packets and divides by their
// count. Against a model with no sample clock the loop printed nothing and
// the calibration divided by zero (an IntegerDivideByZero reboot loop on
// ESP32).
//
// Serial protocol (115200):
//   F0 init=0
//   F1 valid=1 accel_bias_z=<g> gyro_bias_x=<dps>   the FIFO calibration returned
//   F2 init=0
//   A <ax> <ay> <az> G <gx> <gy> <gz>      one line per update() that read
//   FAST_DONE                              after five of them
//
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --out <this dir> <this dir>/avr-mpu6050-fastimu.ino \
//   <this dir>/F_MPU6050.cpp <this dir>/F_MPU6050.hpp <this dir>/IMUBase.hpp <this dir>/IMUUtils.cpp <this dir>/IMUUtils.hpp
#include <Wire.h>
#include "F_MPU6050.hpp"

MPU6050 IMU;
calData calib = { 0 };
AccelData a;
GyroData g;
static int lines = 0;

void setup() {
  Wire.begin();
  Wire.setClock(400000);
  Serial.begin(115200);
  int err = IMU.init(calib, 0x68);
  Serial.print("F0 init=");
  Serial.println(err);
  IMU.calibrateAccelGyro(&calib);
  Serial.print("F1 valid=");
  Serial.print(calib.valid);
  Serial.print(" accel_bias_z=");
  Serial.print(calib.accelBias[2], 3);
  Serial.print(" gyro_bias_x=");
  Serial.println(calib.gyroBias[0], 3);
  err = IMU.init(calib, 0x68);
  Serial.print("F2 init=");
  Serial.println(err);
}

void loop() {
  IMU.update();
  IMU.getAccel(&a);
  IMU.getGyro(&g);
  if (a.timestamp == 0 || lines >= 5) {
    if (lines == 5) {
      Serial.println("FAST_DONE");
      lines++;
    }
    return;
  }
  static uint32_t last = 0;
  if (a.timestamp == last) return;
  last = a.timestamp;
  Serial.print("A ");
  Serial.print(a.accelX, 2); Serial.print(' ');
  Serial.print(a.accelY, 2); Serial.print(' ');
  Serial.print(a.accelZ, 2);
  Serial.print(" G ");
  Serial.print(g.gyroX, 1); Serial.print(' ');
  Serial.print(g.gyroY, 1); Serial.print(' ');
  Serial.println(g.gyroZ, 1);
  lines++;
}
