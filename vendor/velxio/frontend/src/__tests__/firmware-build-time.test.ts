/**
 * When a firmware image was compiled, read from the image: the `__DATE__`
 * and `__TIME__` a sketch hands to its clock chip (project
 * i2c-model-fidelity-2026-09, decision D7).
 *
 * The images under fixtures/ were built by the compile service, one per
 * format the tab holds a program in: the Intel HEX of an ATmega328P, the .bin
 * of an RP2040 and the merged flash image of an ESP32. What each sketch
 * writes to its clock when it runs is in rtc-real-firmware.test.ts; here it is
 * what the scan finds in the file.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildTimesInImage,
  buildTimesOfProgram,
  buildTimesOfPrograms,
  firmwareImageOf,
  type BuildTime,
} from '../simulation/firmwareBuildTime';

const fixture = (name: string, ext: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}/${name}.ino.${ext}`, import.meta.url)));

const bytes = (...parts: Array<string | number[]>): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === 'string' ? Array.from(p, (c) => c.charCodeAt(0)) : p)),
  );

const at = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
) => ({ year, month, day, hour, minute, second }) satisfies BuildTime;

const sorted = (times: readonly BuildTime[]): BuildTime[] =>
  [...times].sort(
    (a, b) =>
      Date.UTC(a.year, a.month - 1, a.day, a.hour, a.minute, a.second) -
      Date.UTC(b.year, b.month - 1, b.day, b.hour, b.minute, b.second),
  );

/** A flash image as a UF2 file: 512-byte blocks that carry 256 bytes each. */
function asUf2(image: Uint8Array, base: number): Uint8Array {
  const count = Math.ceil(image.length / 256);
  const file = new Uint8Array(count * 512);
  const view = new DataView(file.buffer);
  for (let i = 0; i < count; i++) {
    const off = i * 512;
    view.setUint32(off, 0x0a324655, true); // "UF2\n"
    view.setUint32(off + 4, 0x9e5d5157, true);
    view.setUint32(off + 8, 0x00002000, true); // family id present
    view.setUint32(off + 12, base + i * 256, true);
    view.setUint32(off + 16, 256, true);
    view.setUint32(off + 20, i, true);
    view.setUint32(off + 24, count, true);
    view.setUint32(off + 28, 0xe48bff56, true); // RP2040
    file.set(image.subarray(i * 256, (i + 1) * 256), off + 32);
    view.setUint32(off + 508, 0x0ab16f30, true);
  }
  return file;
}

describe('the strings in an image', () => {
  it('the two strings of a sketch', () => {
    const image = bytes(new Array(40).fill(0xff), '23:39:41\0Sep 29 2026\0', new Array(9).fill(0));
    expect(buildTimesInImage(image)).toEqual([at(2026, 9, 29, 23, 39, 41)]);
  });

  it('the day is padded with a space', () => {
    expect(buildTimesInImage(bytes('Oct  1 2026\x0000:00:09\0'))).toEqual([
      at(2026, 10, 1, 0, 0, 9),
    ]);
  });

  it('every date goes with every time', () => {
    // An ESP32 image: the bootloader, the application descriptor (two
    // 16-byte fields padded with NULs) and the sketch.
    const image = bytes(
      [0xe9],
      '23:41:52\0',
      new Array(99).fill(0xff),
      '23:41:31',
      new Array(8).fill(0),
      'Sep 29 2026',
      new Array(5).fill(0),
      'velxio-sketch\0',
      '23:41:51\0Sep 29 2026\0',
    );
    expect(sorted(buildTimesInImage(image))).toEqual([
      at(2026, 9, 29, 23, 41, 31),
      at(2026, 9, 29, 23, 41, 51),
      at(2026, 9, 29, 23, 41, 52),
    ]);
  });

  it('midnight between two files of one build', () => {
    const found = buildTimesInImage(
      bytes('Sep 29 2026\x0023:59:58\0', 'Sep 30 2026\x0000:00:03\0'),
    );
    expect(found).toHaveLength(4);
    expect(found).toContainEqual(at(2026, 9, 29, 23, 59, 58));
  });

  it('a time right after another time', () => {
    // Two files of one build whose __TIME__ literals the linker laid end to
    // end: the NUL that ends the first is the character before the second.
    expect(sorted(buildTimesInImage(bytes('Sep 29 2026\x0023:41:51\x0023:41:52\0')))).toEqual([
      at(2026, 9, 29, 23, 41, 51),
      at(2026, 9, 29, 23, 41, 52),
    ]);
  });

  it('what is not the strings', () => {
    for (const text of [
      '',
      '\0'.repeat(64),
      '23:39:41\0', // a time and no date
      'Sep 29 2026\0', // a date and no time
      'Sep 29 2026 23:39:41\0', // no NUL after the date
      'Sep 29 2026\x0023:39:41 UTC\0', // no NUL after the time
      'Sep 29 2026\0AA:BB:12:34:56\0', // the tail of a MAC address
      'Sep 29 2026\x0024:00:00\0',
      'Sep 29 2026\x0023:60:00\0',
      'Sep 32 2026\x0023:39:41\0',
      'Sept 9 2026\x0023:39:41\0',
      '2026-09-29\x0023:39:41\0',
    ]) {
      expect(buildTimesInImage(bytes(text)), JSON.stringify(text)).toEqual([]);
    }
  });
});

describe('the images the compile service builds', () => {
  it('ATmega328P, Intel HEX, DateTime(F(__DATE__), F(__TIME__))', () => {
    const hex = fixture('avr-rtclib-ds3231', 'hex').toString('utf8');
    expect(buildTimesOfProgram(hex)).toEqual([at(2026, 9, 30, 0, 21, 52)]);
  });

  it('ATmega328P, Intel HEX, DateTime(__DATE__, __TIME__)', () => {
    // No F(): the strings are initial values of .data, which are in flash.
    const hex = fixture('avr-rtclib-ds1307', 'hex').toString('utf8');
    expect(buildTimesOfProgram(hex)).toEqual([at(2026, 9, 30, 0, 21, 57)]);
  });

  it('a sketch that never names its build time has none', () => {
    const hex = fixture('avr-grove-rtc-ds1307', 'hex').toString('utf8');
    expect(buildTimesOfProgram(hex)).toEqual([]);
  });

  it('RP2040, .bin in base64', () => {
    const bin = fixture('rp2040-rtclib-ds3231', 'bin');
    expect(buildTimesOfProgram(bin.toString('base64'))).toEqual([at(2026, 9, 30, 0, 22, 10)]);
  });

  it('RP2040, .uf2 in base64: the blocks are put back together first', () => {
    const bin = fixture('rp2040-rtclib-ds3231', 'bin');
    const uf2 = Buffer.from(asUf2(bin, 0x10000000));
    // The last block is filled up to its 256 bytes.
    const image = firmwareImageOf(uf2.toString('base64'))!;
    expect(image.length).toBe(Math.ceil(bin.length / 256) * 256);
    expect(Buffer.from(image.subarray(0, bin.length)).equals(bin)).toBe(true);
    expect(buildTimesOfProgram(uf2.toString('base64'))).toEqual([at(2026, 9, 30, 0, 22, 10)]);
  });

  it('a string that straddles two UF2 blocks is found', () => {
    const image = new Uint8Array(512).fill(0xff);
    image.set(bytes('23:39:41\0Sep 29 2026\0'), 256 - 13);
    const uf2 = Buffer.from(asUf2(image, 0x10000000));
    expect(buildTimesInImage(uf2)).toEqual([]);
    expect(buildTimesOfProgram(uf2.toString('base64'))).toEqual([at(2026, 9, 29, 23, 39, 41)]);
  });

  it('ESP32, merged flash image in base64: the sketch among the times of the build', () => {
    // The bootloader and the application descriptor came out of the build
    // cache, compiled forty minutes before the sketch and the day before.
    const image = fixture('esp32-rtclib-ds3231', 'bin');
    const found = buildTimesOfProgram(image.toString('base64'));
    expect(found).toContainEqual(at(2026, 9, 30, 0, 22, 24));
    expect(sorted(found)).toEqual([
      at(2026, 9, 29, 0, 22, 24),
      at(2026, 9, 29, 23, 41, 31),
      at(2026, 9, 29, 23, 41, 52),
      at(2026, 9, 30, 0, 22, 24),
      at(2026, 9, 30, 23, 41, 31),
      at(2026, 9, 30, 23, 41, 52),
    ]);
  });
});

describe('a program as the store keeps it', () => {
  it('no program, or a mark that stands for one, has no build time', () => {
    for (const program of [null, undefined, '', 'micropython-loaded', 'not base64 !', ':', ':zz']) {
      expect(buildTimesOfProgram(program), String(program)).toEqual([]);
    }
  });

  it('an Intel HEX with a checksum line and an extended address is read where it loads', () => {
    // 16 bytes at 0x0000 and the strings at 0x10000, behind a type 04 record.
    const record = (address: number, type: number, data: number[]): string => {
      const body = [data.length, (address >> 8) & 0xff, address & 0xff, type, ...data];
      const sum = -body.reduce((a, b) => a + b, 0) & 0xff;
      return `:${[...body, sum].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('')}`;
    };
    const text = Array.from(bytes('23:39:41\0Sep 29 2026\0'));
    const hex = [
      record(0x0000, 0, new Array(16).fill(0x0c)),
      record(0x0000, 4, [0x00, 0x01]),
      record(0x0000, 0, text.slice(0, 16)),
      record(0x0010, 0, text.slice(16)),
      record(0x0000, 1, []),
    ].join('\r\n');
    expect(buildTimesOfProgram(hex)).toEqual([at(2026, 9, 29, 23, 39, 41)]);
  });

  it('every program the store holds is looked through, and each of them once', () => {
    const uno = fixture('avr-rtclib-ds3231', 'hex').toString('utf8');
    const pico = fixture('rp2040-rtclib-ds3231', 'bin').toString('base64');
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      const found = buildTimesOfPrograms([uno, null, pico, uno, 'micropython-loaded']);
      expect(found).toEqual([at(2026, 9, 30, 0, 21, 52), at(2026, 9, 30, 0, 22, 10)]);
      expect(decode).toHaveBeenCalledTimes(2);
      buildTimesOfPrograms([uno, pico]);
      expect(decode).toHaveBeenCalledTimes(2);
      // A program that left the store is forgotten, and scanned again if it comes back.
      buildTimesOfPrograms([pico]);
      buildTimesOfPrograms([uno, pico]);
      expect(decode).toHaveBeenCalledTimes(3);
    } finally {
      decode.mockRestore();
    }
  });
});
