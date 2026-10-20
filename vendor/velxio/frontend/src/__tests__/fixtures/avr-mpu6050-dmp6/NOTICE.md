# Third-party code in avr-mpu6050-dmp6

`avr-mpu6050-dmp6.ino` is the example `MPU6050_DMP6` of Electronic Cats'
MPU6050 library (ElectronicCats/mpu6050, i2cdevlib by Jeff Rowberg) with a
rebuild comment on top. `I2Cdev.cpp`, `I2Cdev.h`, `MPU6050.cpp`,
`MPU6050.h`, `MPU6050_6Axis_MotionApps20.cpp`, `MPU6050_6Axis_MotionApps20.h`
and `helper_3dmath.h` are its `src/` at tag v1.4.3 (8692adce4a40), unchanged,
passed to the compile service as sketch files because its library index does
not carry the library. The firmware image is the sketch linked with them.

v1.4.3 and not the latest v1.4.5: from v1.4.4 (commit 8c32b39)
`MPU6050_Base::PID()` removes `32768 >> range` of gravity from Z where it
removed `16384 >> range`, so `CalibrateAccel()` at the 2 g range drives the
Z offset up by 1 g until the output saturates at 32767, and a 30 degree tilt
afterwards prints a pitch of about 15. The offset registers and the
saturation are the chip's, so a real part calibrated by v1.4.5 would do the
same. The example and every other file are the same in both tags.

| Library | Version | Licence |
|---|---|---|
| Electronic Cats MPU6050 (i2cdevlib) | 1.4.3 | MIT |
| Arduino AVR core and Wire | as installed by the compile service | LGPL 2.1 or later |

## Electronic Cats MPU6050

    MIT License
    
    Copyright (c) 2019 ElectronicCats
    
    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:
    
    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.
    
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
