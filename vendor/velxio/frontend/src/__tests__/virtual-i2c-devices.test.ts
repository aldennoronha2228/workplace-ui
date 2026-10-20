/**
 * virtual-i2c-devices.test.ts
 *
 * Unit tests for the virtual I2C sensor library:
 *   VirtualBMP280   — barometric pressure / temperature sensor (0x76 / 0x77)
 *   VirtualDS3231   — real-time clock with on-chip temperature sensor (0x68)
 *   VirtualPCF8574  — 8-bit I/O expander (0x20–0x27 / 0x38–0x3F)
 *
 * Also covers the I2CBusManager as the TWI's controller port (connectToSlave /
 * writeByte / readByte reaching a device on the fabric) and the pre-existing
 * VirtualDS1307, VirtualTempSensor, I2CMemoryDevice helpers.
 *
 * NOTE: these tests import directly from I2CBusManager.ts which only uses
 * `import type` from avr8js — so they run in the plain Node / Vitest environment
 * without needing the third-party to be built.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { bareBoard, putI2cDevice, clearBench } from './helpers/i2cBench';
import {
  I2CBusManager,
  I2CMemoryDevice,
  VirtualDS1307,
  VirtualTempSensor,
  VirtualBMP280,
  VirtualDS3231,
  VirtualPCF8574,
  type I2CDevice,
} from '../simulation/I2CBusManager';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal mock of AVRTWI used by I2CBusManager */
function makeTWI() {
  const calls: string[] = [];
  let readResult = 0xff;
  let writeAck = true;
  let connectAck = true;

  return {
    calls,
    _setReadResult: (v: number) => {
      readResult = v;
    },
    _setWriteAck: (v: boolean) => {
      writeAck = v;
    },
    _setConnectAck: (v: boolean) => {
      connectAck = v;
    },

    // --- AVRTWI API ---
    set eventHandler(_: any) {
      /* set by I2CBusManager constructor */
    },
    completeStart() {
      calls.push('start');
    },
    completeStop() {
      calls.push('stop');
    },
    completeConnect(ack: boolean) {
      calls.push(`connect:${ack}`);
    },
    completeWrite(ack: boolean) {
      calls.push(`write:${ack}`);
    },
    completeRead(value: number) {
      calls.push(`read:${value}`);
    },
  };
}

// ─── I2CBusManager as the TWI's port ─────────────────────────────────────────

/**
 * The manager as the Uno's controller port on the fabric, with a device on
 * the TWI's pins (A4/A5 = 18/19) the way a part is: what the mock TWI drives
 * into the manager reaches the device through the bus, as on the board.
 */
function twiPort() {
  const twi = makeTWI();
  const bus = new I2CBusManager(twi as any);
  bareBoard('uno', 'arduino-uno', {
    getBusBinding: () => ({
      pins: { onPinChange: () => () => {}, peekPinState: () => undefined },
      spi: [],
      i2c: [bus],
    }),
  });
  return {
    twi,
    bus,
    put: (device: I2CDevice) => putI2cDevice(device, { boardId: 'uno', pin: 18 }, { boardId: 'uno', pin: 19 }),
  };
}

afterEach(() => clearBench());

describe('I2CBusManager — the TWI port', () => {
  it('completes start unconditionally', () => {
    const { twi, bus } = twiPort();
    bus.start(false);
    expect(twi.calls).toContain('start');
  });

  it('NACKs an address with no device on the bus', () => {
    const { twi, bus } = twiPort();
    bus.connectToSlave(0x42, true);
    expect(twi.calls).toContain('connect:false');
  });

  it('ACKs when a device on the bus has the address', () => {
    const { twi, bus, put } = twiPort();
    put(new I2CMemoryDevice(0x42));
    bus.connectToSlave(0x42, true);
    expect(twi.calls).toContain('connect:true');
  });

  it('routes writeByte to the addressed device and returns ACK', () => {
    const { twi, bus, put } = twiPort();
    const device = new I2CMemoryDevice(0x50);
    put(device);
    bus.connectToSlave(0x50, true);
    bus.writeByte(0x10); // set register pointer
    expect(twi.calls).toContain('write:true');
  });

  it('routes readByte to the addressed device', () => {
    const { twi, bus, put } = twiPort();
    const device = new I2CMemoryDevice(0x50);
    device.registers[0x00] = 0xab;
    put(device);
    bus.connectToSlave(0x50, true);
    bus.writeByte(0x00); // set register pointer to 0
    bus.connectToSlave(0x50, false); // repeated start, read mode
    bus.readByte(true);
    const readCall = twi.calls.find((c) => c.startsWith('read:'));
    expect(readCall).toBe('read:171'); // 0xAB = 171
  });

  it('returns 0xFF on read when no device at address', () => {
    const { twi, bus } = twiPort();
    bus.readByte(true);
    expect(twi.calls).toContain('read:255');
  });

  it('NACKs write when no active device', () => {
    const { twi, bus } = twiPort();
    bus.writeByte(0x00);
    expect(twi.calls).toContain('write:false');
  });

  it('a device taken off the bus is no longer addressed', () => {
    const { twi, bus, put } = twiPort();
    put(new I2CMemoryDevice(0x42)).dispose();
    bus.connectToSlave(0x42, true);
    expect(twi.calls).toContain('connect:false');
  });

  it('calls device.stop() on stop condition', () => {
    const { twi, bus, put } = twiPort();
    let stopped = false;
    const device: I2CDevice = {
      address: 0x42,
      writeByte: () => true,
      readByte: () => 0,
      stop: () => {
        stopped = true;
      },
    };
    put(device);
    bus.connectToSlave(0x42, true);
    bus.stop();
    expect(stopped).toBe(true);
    expect(twi.calls).toContain('stop');
  });
});

// ─── I2CMemoryDevice ─────────────────────────────────────────────────────────

describe('I2CMemoryDevice', () => {
  it('first byte sets register pointer, subsequent bytes write data', () => {
    const dev = new I2CMemoryDevice(0x50);
    dev.writeByte(0x05); // register pointer
    dev.writeByte(0xab); // write data to register 5
    expect(dev.registers[0x05]).toBe(0xab);
  });

  it('reads back written data starting at register pointer', () => {
    const dev = new I2CMemoryDevice(0x50);
    dev.registers[0x02] = 0xcc;
    dev.writeByte(0x02); // set pointer
    expect(dev.readByte()).toBe(0xcc);
  });

  it('auto-increments register pointer on read', () => {
    const dev = new I2CMemoryDevice(0x50);
    dev.registers[0x00] = 0x11;
    dev.registers[0x01] = 0x22;
    dev.writeByte(0x00);
    expect(dev.readByte()).toBe(0x11);
    expect(dev.readByte()).toBe(0x22);
  });

  it('fires onRegisterWrite callback', () => {
    const dev = new I2CMemoryDevice(0x50);
    const log: [number, number][] = [];
    dev.onRegisterWrite = (r, v) => log.push([r, v]);
    dev.writeByte(0x0a); // pointer
    dev.writeByte(0xff); // data → register 0x0A
    expect(log).toEqual([[0x0a, 0xff]]);
  });

  it('resets firstByte on stop()', () => {
    const dev = new I2CMemoryDevice(0x50);
    dev.writeByte(0x03); // pointer set, firstByte = false
    dev.stop(); // reset
    dev.writeByte(0x07); // new pointer
    dev.writeByte(0x55); // write to register 7
    expect(dev.registers[0x07]).toBe(0x55);
  });
});

// ─── VirtualDS1307 ────────────────────────────────────────────────────────────
//
// What the chip does register by register is in the bus vectors the model
// shares with its backend twin (rtc-vectors.test.ts). These are the cases a
// sketch runs into first, on a clock the test holds still.

/** A clock a test moves by hand: 12:34:56.250 of Wednesday 30 September 2026. */
function rtcClock() {
  const clock = { now: Date.UTC(2026, 8, 30, 12, 34, 56, 250), read: () => clock.now };
  return clock;
}

/** Wire.beginTransmission, the pointer, the bytes, endTransmission. */
function rtcWrite(dev: I2CDevice, ...bytes: number[]): void {
  dev.start?.(false);
  for (const b of bytes) dev.writeByte(b);
  dev.stop?.();
}

/** The pointer, a repeated START, n bytes. */
function rtcRead(dev: I2CDevice, reg: number, n: number): number[] {
  dev.start?.(false);
  dev.writeByte(reg);
  dev.start?.(true);
  const out = Array.from({ length: n }, () => dev.readByte());
  dev.stop?.();
  return out;
}

describe('VirtualDS1307', () => {
  it('address is 0x68', () => {
    expect(new VirtualDS1307().address).toBe(0x68);
  });

  it('reads the host clock in BCD, with Monday as day 1', () => {
    const dev = new VirtualDS1307({ clock: rtcClock().read });
    expect(rtcRead(dev, 0x00, 7)).toEqual([0x56, 0x34, 0x12, 0x03, 0x30, 0x09, 0x26]);
  });

  it('with no clock given, reads the time of the browser', () => {
    vi.useFakeTimers();
    try {
      // Local time, whatever the zone of the machine that runs the test.
      vi.setSystemTime(new Date(2026, 8, 30, 12, 34, 56, 250));
      const dev = new VirtualDS1307();
      expect(rtcRead(dev, 0x00, 7)).toEqual([0x56, 0x34, 0x12, 0x03, 0x30, 0x09, 0x26]);
      vi.setSystemTime(new Date(2026, 8, 30, 23, 59, 59, 0));
      expect(rtcRead(dev, 0x00, 3)).toEqual([0x59, 0x59, 0x23]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a host that calls no start() is answered as well', () => {
    const dev = new VirtualDS1307({ clock: rtcClock().read });
    dev.writeByte(0x00);
    expect(Array.from({ length: 3 }, () => dev.readByte())).toEqual([0x56, 0x34, 0x12]);
  });

  it('stop() resets firstByte so next write is a new pointer', () => {
    const dev = new VirtualDS1307({ clock: rtcClock().read });
    dev.writeByte(0x02); // set pointer to hours
    dev.stop();
    dev.writeByte(0x00); // new pointer (seconds)
    expect(dev.readByte()).toBe(0x56);
  });

  it('keeps the time a sketch sets and counts from it', () => {
    // The write used to be dropped: the Grove example set 12:30:00 and
    // printed the time of the browser.
    const clock = rtcClock();
    const dev = new VirtualDS1307({ clock: clock.read });
    rtcWrite(dev, 0x00, 0x00, 0x30, 0x12, 0x06, 0x19, 0x01, 0x13);
    clock.now += 2000;
    expect(rtcRead(dev, 0x00, 7)).toEqual([0x02, 0x30, 0x12, 0x06, 0x19, 0x01, 0x13]);
  });

  it('stays on the host clock when the sketch sets the build time of its firmware', () => {
    const clock = rtcClock();
    const built = [{ year: 2026, month: 9, day: 29, hour: 23, minute: 39, second: 41 }];
    const dev = new VirtualDS1307({ clock: clock.read, buildTimes: () => built });
    rtcWrite(dev, 0x00, 0x41, 0x39, 0x23, 0x00, 0x29, 0x09, 0x26);
    clock.now += 2000;
    expect(rtcRead(dev, 0x00, 3)).toEqual([0x58, 0x34, 0x12]);
  });

  it('asks for the build times when the sketch sets the clock, and not before', () => {
    let asked = 0;
    const dev = new VirtualDS1307({
      clock: rtcClock().read,
      buildTimes: () => {
        asked++;
        return [];
      },
    });
    rtcRead(dev, 0x00, 7);
    rtcWrite(dev, 0x08, 0xaa);
    rtcWrite(dev, 0x03, 0x05);
    expect(asked).toBe(0);
    rtcWrite(dev, 0x00, 0x00, 0x30, 0x12);
    expect(asked).toBe(1);
  });

  it('CH stops the clock, and isrunning() reads it', () => {
    const clock = rtcClock();
    const dev = new VirtualDS1307({ clock: clock.read });
    const isrunning = () => !(rtcRead(dev, 0x00, 1)[0] >> 7);
    expect(isrunning()).toBe(true);
    rtcWrite(dev, 0x00, 0x80 | 0x56);
    clock.now += 5000;
    expect(isrunning()).toBe(false);
    expect(rtcRead(dev, 0x00, 3)).toEqual([0xd6, 0x34, 0x12]);
  });

  it('keeps the 56 bytes of RAM and wraps the pointer from 0x3F to 0x00', () => {
    const dev = new VirtualDS1307({ clock: rtcClock().read });
    rtcWrite(dev, 0x3e, 0xa1, 0xb2);
    expect(rtcRead(dev, 0x3e, 4)).toEqual([0xa1, 0xb2, 0x56, 0x34]);
  });

  it('dumpRegisters() is the time of the moment, CONTROL and the RAM', () => {
    const clock = rtcClock();
    const dev = new VirtualDS1307({ clock: clock.read });
    rtcWrite(dev, 0x08, 0xca, 0xfe);
    clock.now += 4000;
    expect(Array.from(dev.dumpRegisters().slice(0, 10))).toEqual([
      0x00, 0x35, 0x12, 0x03, 0x30, 0x09, 0x26, 0x03, 0xca, 0xfe,
    ]);
  });
});

// ─── VirtualTempSensor ────────────────────────────────────────────────────────

describe('VirtualTempSensor', () => {
  it('address is 0x48', () => {
    expect(new VirtualTempSensor().address).toBe(0x48);
  });

  it('reads temperature high byte (register 0) correctly', () => {
    const dev = new VirtualTempSensor();
    dev.temperature = 2350; // 23.50°C
    dev.writeByte(0x00);
    expect(dev.readByte()).toBe((2350 >> 8) & 0xff);
  });

  it('reads humidity bytes from registers 2–3', () => {
    const dev = new VirtualTempSensor();
    dev.humidity = 5500; // 55.00%
    dev.writeByte(0x02);
    expect(dev.readByte()).toBe((5500 >> 8) & 0xff);
    expect(dev.readByte()).toBe(5500 & 0xff);
  });
});

// ─── VirtualBMP280 ────────────────────────────────────────────────────────────

describe('VirtualBMP280 — construction & addresses', () => {
  it('default address is 0x76', () => {
    expect(new VirtualBMP280().address).toBe(0x76);
  });

  it('accepts 0x77 as alternate address', () => {
    expect(new VirtualBMP280(0x77).address).toBe(0x77);
  });

  it('chip_id register (0xD0) reads 0x58', () => {
    const dev = new VirtualBMP280();
    dev.writeByte(0xd0);
    expect(dev.readByte()).toBe(0x58);
  });

  it('stop() resets firstByte so register pointer can be re-set', () => {
    const dev = new VirtualBMP280();
    dev.writeByte(0xd0);
    dev.stop();
    dev.writeByte(0xf3); // new pointer → status register
    expect(dev.readByte()).toBe(0x00); // status = 0 (ready)
  });
});

describe('VirtualBMP280 — calibration registers', () => {
  /**
   * Reads an unsigned 16-bit little-endian value from two consecutive register
   * bytes starting at `regAddr`.
   */
  function readU16LE(dev: VirtualBMP280, regAddr: number): number {
    dev.writeByte(regAddr);
    const lo = dev.readByte();
    const hi = dev.readByte();
    dev.stop();
    return lo | (hi << 8);
  }

  function readS16LE(dev: VirtualBMP280, regAddr: number): number {
    const u = readU16LE(dev, regAddr);
    return u > 0x7fff ? u - 0x10000 : u;
  }

  it('dig_T1 (0x88) equals 27504', () => {
    const dev = new VirtualBMP280();
    expect(readU16LE(dev, 0x88)).toBe(27504);
  });

  it('dig_T2 (0x8A) equals 26435', () => {
    expect(readS16LE(new VirtualBMP280(), 0x8a)).toBe(26435);
  });

  it('dig_T3 (0x8C) equals -1000', () => {
    expect(readS16LE(new VirtualBMP280(), 0x8c)).toBe(-1000);
  });

  it('dig_P1 (0x8E) equals 36477', () => {
    expect(readU16LE(new VirtualBMP280(), 0x8e)).toBe(36477);
  });

  it('dig_P2 (0x90) equals -10685', () => {
    expect(readS16LE(new VirtualBMP280(), 0x90)).toBe(-10685);
  });
});

describe('VirtualBMP280 — temperature compensation', () => {
  /**
   * Reads the 6-byte pressure+temperature burst (0xF7–0xFC) and reconstructs
   * the two 20-bit raw ADC values.  Returns { adcP, adcT }.
   */
  function readRawAdc(dev: VirtualBMP280): { adcP: number; adcT: number } {
    // The chip powers on asleep and measures nothing there: normal mode,
    // oversampling x1, as every driver selects before it reads.
    dev.writeByte(0xf4);
    dev.writeByte(0x27);
    dev.stop();
    dev.writeByte(0xf7);
    const pMsb = dev.readByte();
    const pLsb = dev.readByte();
    const pXlsb = dev.readByte();
    const tMsb = dev.readByte();
    const tLsb = dev.readByte();
    const tXlsb = dev.readByte();
    dev.stop();
    const adcP = (pMsb << 12) | (pLsb << 4) | (pXlsb >> 4);
    const adcT = (tMsb << 12) | (tLsb << 4) | (tXlsb >> 4);
    return { adcP, adcT };
  }

  /**
   * BMP280 Bosch 32-bit integer temperature compensation formula.
   * Returns temperature in 0.01°C.
   */
  function compensateT(adcT: number, digT1 = 27504, digT2 = 26435, digT3 = -1000): number {
    const var1 = (((adcT >> 3) - (digT1 << 1)) * digT2) >> 11;
    const sub = (adcT >> 4) - digT1;
    const var2 = (((sub * sub) >> 12) * digT3) >> 14;
    const tFine = var1 + var2;
    return (tFine * 5 + 128) >> 8;
  }

  /**
   * BMP280 floating-point pressure compensation formula.
   * Returns pressure in Pa.
   */
  function compensateP(
    adcP: number,
    adcT: number,
    digT1 = 27504,
    digT2 = 26435,
    digT3 = -1000,
    digP1 = 36477,
    digP2 = -10685,
    digP3 = 3024,
    digP4 = 2855,
    digP5 = 140,
    digP6 = -7,
    digP7 = 15500,
    digP8 = -14600,
    digP9 = 6000,
  ): number {
    const var1 = (((adcT >> 3) - (digT1 << 1)) * digT2) >> 11;
    const sub = (adcT >> 4) - digT1;
    const var2 = (((sub * sub) >> 12) * digT3) >> 14;
    const tf = var1 + var2;

    let v1 = tf / 2.0 - 64000.0;
    let v2 = (v1 * v1 * digP6) / 32768.0;
    v2 = v2 + v1 * digP5 * 2.0;
    v2 = v2 / 4.0 + digP4 * 65536.0;
    v1 = ((digP3 * v1 * v1) / 524288.0 + digP2 * v1) / 524288.0;
    v1 = (1.0 + v1 / 32768.0) * digP1;
    if (v1 === 0) return 0;
    let p = 1048576.0 - adcP;
    p = ((p - v2 / 4096.0) * 6250.0) / v1;
    return p + ((digP9 * p * p) / 2147483648.0 + (p * digP8) / 32768.0 + digP7) / 16.0;
  }

  it('default 24°C, where the sensor panel starts, produces compensated temperature within ±0.5°C', () => {
    const dev = new VirtualBMP280();
    const { adcT } = readRawAdc(dev);
    const centideg = compensateT(adcT);
    expect(centideg / 100).toBeCloseTo(24, 0);
  });

  it('setting temperatureC = 20 produces ~20°C compensated output', () => {
    const dev = new VirtualBMP280();
    dev.temperatureC = 20;
    const { adcT } = readRawAdc(dev);
    expect(compensateT(adcT) / 100).toBeCloseTo(20, 0);
  });

  it('setting temperatureC = 0 produces ~0°C compensated output', () => {
    const dev = new VirtualBMP280();
    dev.temperatureC = 0;
    const { adcT } = readRawAdc(dev);
    expect(compensateT(adcT) / 100).toBeCloseTo(0, 0);
  });

  it('setting temperatureC = 85 produces ~85°C compensated output', () => {
    const dev = new VirtualBMP280();
    dev.temperatureC = 85;
    const { adcT } = readRawAdc(dev);
    expect(compensateT(adcT) / 100).toBeCloseTo(85, 0);
  });
});

describe('VirtualBMP280 — pressure compensation', () => {
  function readRawAdc(dev: VirtualBMP280): { adcP: number; adcT: number } {
    dev.writeByte(0xf4);
    dev.writeByte(0x27); // normal mode, oversampling x1
    dev.stop();
    dev.writeByte(0xf7);
    const pMsb = dev.readByte(),
      pLsb = dev.readByte(),
      pXlsb = dev.readByte();
    const tMsb = dev.readByte(),
      tLsb = dev.readByte(),
      tXlsb = dev.readByte();
    dev.stop();
    return {
      adcP: (pMsb << 12) | (pLsb << 4) | (pXlsb >> 4),
      adcT: (tMsb << 12) | (tLsb << 4) | (tXlsb >> 4),
    };
  }

  function compensateP(adcP: number, adcT: number): number {
    const digT1 = 27504,
      digT2 = 26435,
      digT3 = -1000;
    const digP1 = 36477,
      digP2 = -10685,
      digP3 = 3024;
    const digP4 = 2855,
      digP5 = 140,
      digP6 = -7;
    const digP7 = 15500,
      digP8 = -14600,
      digP9 = 6000;
    const var1 = (((adcT >> 3) - (digT1 << 1)) * digT2) >> 11;
    const sub = (adcT >> 4) - digT1;
    const var2 = (((sub * sub) >> 12) * digT3) >> 14;
    const tf = var1 + var2;
    let v1 = tf / 2.0 - 64000.0;
    let v2 = (v1 * v1 * digP6) / 32768.0;
    v2 = v2 + v1 * digP5 * 2.0;
    v2 = v2 / 4.0 + digP4 * 65536.0;
    v1 = ((digP3 * v1 * v1) / 524288.0 + digP2 * v1) / 524288.0;
    v1 = (1.0 + v1 / 32768.0) * digP1;
    if (v1 === 0) return 0;
    let p = 1048576.0 - adcP;
    p = ((p - v2 / 4096.0) * 6250.0) / v1;
    return p + ((digP9 * p * p) / 2147483648.0 + (p * digP8) / 32768.0 + digP7) / 16.0;
  }

  it('default 1013.25 hPa produces compensated pressure within ±5 hPa', () => {
    const dev = new VirtualBMP280();
    const { adcP, adcT } = readRawAdc(dev);
    const pHPa = compensateP(adcP, adcT) / 100;
    expect(Math.abs(pHPa - 1013.25)).toBeLessThan(5);
  });

  it('setting pressureHPa = 900 produces ~900 hPa compensated output (±5)', () => {
    const dev = new VirtualBMP280();
    dev.pressureHPa = 900;
    const { adcP, adcT } = readRawAdc(dev);
    expect(Math.abs(compensateP(adcP, adcT) / 100 - 900)).toBeLessThan(5);
  });

  it('setting pressureHPa = 1100 produces ~1100 hPa compensated output (±5)', () => {
    const dev = new VirtualBMP280();
    dev.pressureHPa = 1100;
    const { adcP, adcT } = readRawAdc(dev);
    expect(Math.abs(compensateP(adcP, adcT) / 100 - 1100)).toBeLessThan(5);
  });
});

describe('VirtualBMP280 — ctrl_meas register is writable', () => {
  it('can write and read back ctrl_meas (0xF4)', () => {
    const dev = new VirtualBMP280();
    // Set reg pointer via normal write
    dev.writeByte(0xf4); // pointer → 0xF4
    dev.writeByte(0x57); // write 0x57 (normal mode + oversampling)
    dev.stop();
    dev.writeByte(0xf4); // read back
    expect(dev.readByte()).toBe(0x57);
  });
});

// The rules below are held to the datasheet, step by step, by the shared bus
// vectors (bmp280-vectors.test.ts). These are the same rules on the bare
// model, one driver's habit each.
describe('VirtualBMP280 — what a driver can tell from the chip', () => {
  const write = (dev: VirtualBMP280, ...bytes: number[]) => {
    for (const b of bytes) expect(dev.writeByte(b)).toBe(true);
    dev.stop();
  };
  const read = (dev: VirtualBMP280, reg: number, n: number): number[] => {
    dev.writeByte(reg);
    const out = Array.from({ length: n }, () => dev.readByte());
    dev.stop();
    return out;
  };
  const RESET_VALUE = [0x80, 0x00, 0x00, 0x80, 0x00, 0x00];

  it('holds the reset value 0x80000 in the data registers until a mode is selected', () => {
    const dev = new VirtualBMP280();
    expect(read(dev, 0xf7, 6)).toEqual(RESET_VALUE);
    dev.temperatureC = 30;
    dev.pressureHPa = 900;
    expect(read(dev, 0xf7, 6)).toEqual(RESET_VALUE);
  });

  it('measuring reads 1 on the first status read after a forced write and 0 after', () => {
    // SparkFun's Example6 and pocketBME280's examples wait for the 1 with no
    // timeout, Adafruit's takeForcedMeasurement() waits for the 0.
    const dev = new VirtualBMP280();
    expect(read(dev, 0xf3, 1)).toEqual([0x00]);
    write(dev, 0xf4, 0x25);
    expect([0, 1, 2].map(() => read(dev, 0xf3, 1)[0])).toEqual([0x08, 0, 0]);
  });

  it('im_update is never seen', () => {
    // esp-idf-lib and the Bosch API wait for it to clear after a soft reset.
    const dev = new VirtualBMP280();
    write(dev, 0xe0, 0xb6);
    expect(read(dev, 0xf3, 1)[0] & 0x01).toBe(0);
    write(dev, 0xf4, 0x25);
    expect(read(dev, 0xf3, 1)[0] & 0x01).toBe(0);
  });

  it('forced mode is one measurement, and the mode bits are back at 00', () => {
    const dev = new VirtualBMP280();
    dev.temperatureC = 30;
    write(dev, 0xf4, 0x25);
    expect(read(dev, 0xf4, 1)).toEqual([0x24]);
    const first = read(dev, 0xf7, 6);
    expect(first).not.toEqual(RESET_VALUE);
    dev.temperatureC = 10;
    expect(read(dev, 0xf7, 6), 'what was measured stays until the next conversion').toEqual(first);
    write(dev, 0xf4, 0x26); // 10 is forced mode too
    expect(read(dev, 0xf4, 1)).toEqual([0x24]);
    expect(read(dev, 0xf7, 6)).not.toEqual(first);
  });

  it('a soft reset restores the power-on registers and reads 0x00, and keeps the panel', () => {
    const dev = new VirtualBMP280();
    dev.temperatureC = 30;
    write(dev, 0xf5, 0x90);
    write(dev, 0xf4, 0x57);
    const measured = read(dev, 0xf7, 6);
    write(dev, 0xe0, 0xb6);
    expect(read(dev, 0xe0, 1)).toEqual([0x00]);
    expect(read(dev, 0xf3, 3)).toEqual([0x00, 0x00, 0x00]);
    expect(read(dev, 0xf7, 6)).toEqual(RESET_VALUE);
    expect(read(dev, 0xd0, 1)).toEqual([0x58]);
    expect(dev.temperatureC).toBe(30);
    write(dev, 0xf4, 0x57);
    expect(read(dev, 0xf7, 6)).toEqual(measured);
  });

  it('only the reset word resets', () => {
    const dev = new VirtualBMP280();
    write(dev, 0xf4, 0x27);
    write(dev, 0xe0, 0xb5);
    expect(read(dev, 0xe0, 1)).toEqual([0x00]);
    expect(read(dev, 0xf4, 1)).toEqual([0x27]);
  });

  it('a write is pairs of register address and data, with no auto-increment', () => {
    const dev = new VirtualBMP280();
    write(dev, 0xf5, 0xa0, 0xf4, 0x27);
    expect(read(dev, 0xf4, 2)).toEqual([0x27, 0xa0]);
    // Three bytes from a master that expects the address to count up: the
    // third is taken for an address, and config keeps what it had.
    write(dev, 0xf4, 0x57, 0x10);
    expect(read(dev, 0xf4, 2)).toEqual([0x57, 0xa0]);
  });

  it('esp-idf-lib reads status and ctrl_meas with its two-byte write', () => {
    // bmp280_is_measuring() sends { 0xF3, 0xF4 } and reads two bytes. The
    // chip takes 0xF4 for the data of the read-only status, and the read
    // begins at 0xF3. With an auto-incrementing write it read ctrl_meas and
    // config, and its busy flag was bit 3 of the oversampling.
    const dev = new VirtualBMP280();
    write(dev, 0xf4, 0x6d); // forced, temperature x4, pressure x4
    const poll = (): boolean => {
      dev.writeByte(0xf3);
      dev.writeByte(0xf4);
      const [status, ctrl] = [dev.readByte(), dev.readByte()];
      dev.stop();
      return (ctrl & 0x03) === 0x01 || (status & 0x08) !== 0;
    };
    expect([poll(), poll(), poll()]).toEqual([true, false, false]);
    expect(read(dev, 0xf3, 2), 'status was not written').toEqual([0x00, 0x6c]);
  });

  it('the calibration, the id and the data registers cannot be written', () => {
    const dev = new VirtualBMP280();
    const before = Array.from(dev.dumpRegisters());
    for (const reg of [0x88, 0x9f, 0xd0, 0xf3, 0xf7, 0xfc, 0x00, 0xf6]) write(dev, reg, 0xaa);
    expect(Array.from(dev.dumpRegisters())).toEqual(before);
  });

  it('dumpRegisters is what a read would find, with no trigger bit', () => {
    const dev = new VirtualBMP280();
    expect(Array.from(dev.dumpRegisters().slice(0xf7, 0xfd))).toEqual(RESET_VALUE);
    write(dev, 0xf4, 0x27);
    dev.temperatureC = 30;
    const dump = dev.dumpRegisters();
    expect(dump[0xf3]).toBe(0x00);
    expect(Array.from(dump.slice(0xf7, 0xfd))).toEqual(read(dev, 0xf7, 6));
  });
});

// ─── VirtualDS3231 ────────────────────────────────────────────────────────────

describe('VirtualDS3231 — time registers', () => {
  it('address is 0x68', () => {
    expect(new VirtualDS3231().address).toBe(0x68);
  });

  it('reads the host clock in BCD, with Monday as day 1', () => {
    const dev = new VirtualDS3231({ clock: rtcClock().read });
    expect(rtcRead(dev, 0x00, 7)).toEqual([0x56, 0x34, 0x12, 0x03, 0x30, 0x09, 0x26]);
  });

  it('a burst is one instant, however long the guest takes over it', () => {
    const clock = rtcClock();
    clock.now = Date.UTC(2026, 8, 30, 12, 59, 59, 900);
    const dev = new VirtualDS3231({ clock: clock.read });
    dev.start(false);
    dev.writeByte(0x00);
    dev.start(true);
    const seconds = dev.readByte();
    clock.now += 200; // 13:00:00.100
    const rest = [dev.readByte(), dev.readByte()];
    dev.stop();
    expect([seconds, ...rest]).toEqual([0x59, 0x59, 0x12]);
    expect(rtcRead(dev, 0x00, 3)).toEqual([0x00, 0x00, 0x13]);
  });

  it('register 0x0E (control) powers on at 0x1C', () => {
    // It read 0x00, and RTClib's setAlarm1() refuses to arm an alarm unless
    // INTCN reads 1.
    const dev = new VirtualDS3231({ clock: rtcClock().read });
    expect(rtcRead(dev, 0x0e, 1)).toEqual([0x1c]);
  });

  it('register 0x0F (status) powers on at 0x08, and lostPower() is false', () => {
    // A module somebody set, as the DS1307 powers on with CH 0.
    const dev = new VirtualDS3231({ clock: rtcClock().read });
    const lostPower = () => rtcRead(dev, 0x0f, 1)[0] >> 7 === 1;
    expect(rtcRead(dev, 0x0f, 1)).toEqual([0x08]);
    expect(lostPower()).toBe(false);
    // OSF can only be written to 0: a sketch cannot set it either.
    rtcWrite(dev, 0x0f, 0x88);
    expect(lostPower()).toBe(false);
  });

  it('CONV is over by the next read', () => {
    const dev = new VirtualDS3231({ clock: rtcClock().read });
    rtcWrite(dev, 0x0e, 0x1c | 0x20);
    expect(rtcRead(dev, 0x0e, 2)).toEqual([0x1c, 0x08]);
  });

  it('A1F latches when the time matches and clears when the sketch writes 0 to it', () => {
    const clock = rtcClock();
    const dev = new VirtualDS3231({ clock: clock.read });
    const alarmFired = () => (rtcRead(dev, 0x0f, 1)[0] & 0x01) === 1;
    // RTClib setAlarm1(12:35:00, DS3231_A1_Hour), then AI1E.
    rtcWrite(dev, 0x07, 0x00, 0x35, 0x12, 0x80 | 0x30);
    rtcWrite(dev, 0x0e, 0x1c | 0x01);
    clock.now += 3000;
    expect(alarmFired()).toBe(false);
    clock.now += 1000;
    expect(alarmFired()).toBe(true);
    clock.now += 60_000;
    expect(alarmFired()).toBe(true);
    rtcWrite(dev, 0x0f, rtcRead(dev, 0x0f, 1)[0] & ~0x01);
    expect(alarmFired()).toBe(false);
  });

  it('wraps the pointer from 0x12 to 0x00', () => {
    const dev = new VirtualDS3231({ clock: rtcClock().read });
    expect(rtcRead(dev, 0x11, 4)).toEqual([0x19, 0x00, 0x56, 0x34]);
  });
});

describe('VirtualDS3231 — temperature registers', () => {
  const temperature = (celsius: number): number[] => {
    const dev = new VirtualDS3231({ clock: rtcClock().read });
    dev.temperatureC = celsius;
    return rtcRead(dev, 0x11, 2);
  };

  it('register 0x11 returns integer part of temperature (25°C = 0x19)', () => {
    expect(temperature(25.0)).toEqual([25, 0x00]);
  });

  it('register 0x12 returns 0x80 for 0.5°C fractional (bits 7:6 = 0b10)', () => {
    // 0.5°C / 0.25°C = 2 = 0b10 → stored in bits 7:6 = 0x80
    expect(temperature(25.5)).toEqual([25, 0x80]);
  });

  it('handles negative temperature: -5°C MSB = 0xFB (251 as unsigned)', () => {
    expect(temperature(-5.0)).toEqual([-5 & 0xff, 0x00]);
  });

  it("is two's complement in quarter degrees below zero", () => {
    // MSB = trunc(T) and the fraction added on top read -0.25 C as +0.75 and
    // -5.25 C as -4.25. The ten bits are one number: q = round(T x 4).
    expect(temperature(-0.25)).toEqual([0xff, 0xc0]);
    expect(temperature(-5.25)).toEqual([0xfa, 0xc0]);
    expect(temperature(-10.75)).toEqual([0xf5, 0x40]);
  });

  it('is read-only', () => {
    const dev = new VirtualDS3231({ clock: rtcClock().read });
    rtcWrite(dev, 0x11, 0xaa, 0xbb);
    expect(rtcRead(dev, 0x11, 2)).toEqual([0x19, 0x00]);
  });
});

describe('VirtualDS3231 — stop/firstByte reset', () => {
  it('stop() resets pointer acquisition', () => {
    const dev = new VirtualDS3231({ clock: rtcClock().read });
    dev.writeByte(0x11); // set pointer
    dev.stop();
    dev.writeByte(0x00); // new pointer → seconds
    expect(dev.readByte()).toBe(0x56);
  });
});

// ─── VirtualPCF8574 ────────────────────────────────────────────────────────────

describe('VirtualPCF8574 — construction', () => {
  it('default address is 0x27', () => {
    expect(new VirtualPCF8574().address).toBe(0x27);
  });

  it('accepts custom address', () => {
    expect(new VirtualPCF8574(0x20).address).toBe(0x20);
    expect(new VirtualPCF8574(0x3f).address).toBe(0x3f);
  });

  it('default portState and outputLatch are both 0xFF', () => {
    const dev = new VirtualPCF8574();
    expect(dev.portState).toBe(0xff);
    expect(dev.outputLatch).toBe(0xff);
  });
});

describe('VirtualPCF8574 — write', () => {
  it('writeByte updates outputLatch', () => {
    const dev = new VirtualPCF8574();
    dev.writeByte(0b10101010);
    expect(dev.outputLatch).toBe(0b10101010);
  });

  it('writeByte fires onWrite callback with the written value', () => {
    const dev = new VirtualPCF8574();
    const log: number[] = [];
    dev.onWrite = (v) => log.push(v);
    dev.writeByte(0x42);
    expect(log).toEqual([0x42]);
  });

  it('multiple writes update outputLatch each time', () => {
    const dev = new VirtualPCF8574();
    dev.writeByte(0xaa);
    dev.writeByte(0x55);
    expect(dev.outputLatch).toBe(0x55);
  });
});

describe('VirtualPCF8574 — read (open-drain model)', () => {
  it('readByte returns portState & outputLatch (both 0xFF → 0xFF)', () => {
    const dev = new VirtualPCF8574();
    expect(dev.readByte()).toBe(0xff);
  });

  it('readByte: pin driven LOW by Arduino (outputLatch=0) → reads 0 regardless of portState', () => {
    const dev = new VirtualPCF8574();
    dev.portState = 0xff;
    dev.writeByte(0x00); // drive all LOW
    expect(dev.readByte()).toBe(0x00);
  });

  it('readByte: external input LOW overrides Hi-Z output (open-drain)', () => {
    const dev = new VirtualPCF8574();
    dev.portState = 0b00001111; // lower 4 pins pulled low by external device
    dev.outputLatch = 0xff; // Arduino released all pins
    expect(dev.readByte()).toBe(0b00001111);
  });

  it('readByte reflects mix of output-low and external-low', () => {
    const dev = new VirtualPCF8574();
    dev.outputLatch = 0b11110000; // Arduino drives lower 4 LOW, upper 4 Hi-Z
    dev.portState = 0b10101010; // external: alternate HIGH/LOW
    // result: upper 4 from portState masked, lower 4 forced LOW by outputLatch
    expect(dev.readByte()).toBe(0b10100000);
  });
});

describe('VirtualPCF8574 — writeByte returns ACK', () => {
  it('always returns true (ACK)', () => {
    const dev = new VirtualPCF8574();
    expect(dev.writeByte(0x00)).toBe(true);
    expect(dev.writeByte(0xff)).toBe(true);
  });
});
