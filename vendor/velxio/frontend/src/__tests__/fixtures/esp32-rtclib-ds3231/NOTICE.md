# Third-party code in esp32-rtclib-ds3231.ino.bin

The firmware image is the sketch next to it linked with the libraries below,
as the compile service builds it. They are redistributed here in binary form
under their own licences.

| Library | Version | Licence |
|---|---|---|
| RTClib | 2.1.4 | MIT |
| Adafruit BusIO | 1.17.4 | MIT |
| Arduino core for the ESP32 and Wire | as installed by the compile service | LGPL 2.1 or later |
| ESP-IDF, with its second-stage bootloader | as installed by the compile service | Apache 2.0 |

The sketch was built on 30 September 2026 at 00:22:24 UTC, which is what its
`__DATE__` and `__TIME__` are in this image (`Sep 30 2026`, `00:22:24`). The
image is the merged flash image: the second-stage bootloader, the partition
table and the application. The bootloader and the application descriptor came
out of the build cache and carry the time they were compiled at, 23:41:52 and
23:41:31 of the day before. A rebuild changes all of them, and the tests that
name them with it.

## RTClib

    MIT License

    Copyright (c) 2019 Adafruit Industries

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

## Adafruit BusIO

    The MIT License (MIT)

    Copyright (c) 2017 Adafruit Industries

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
