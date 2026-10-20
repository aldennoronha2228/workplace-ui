# Third-party code in avr-mpu6050-fastimu

`F_MPU6050.cpp`, `F_MPU6050.hpp`, `IMUBase.hpp`, `IMUUtils.cpp` and
`IMUUtils.hpp` are the MPU-6050 driver of FastIMU (LiquidCGS/FastIMU at
ca3edb7a0ba0, `src/` and `src/sensors/`), passed to the compile service as
sketch files because its library index does not carry FastIMU. The only
change is the two `#include "../..."` lines of `F_MPU6050.hpp`, which name
the headers beside it. The firmware image is the sketch linked with them.

| Library | Version | Licence |
|---|---|---|
| FastIMU | ca3edb7a0ba0 | MIT |
| Arduino AVR core and Wire | as installed by the compile service | LGPL 2.1 or later |

## FastIMU

    MIT License
    
    Copyright (c) 2022 LiquidCGS
    
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
