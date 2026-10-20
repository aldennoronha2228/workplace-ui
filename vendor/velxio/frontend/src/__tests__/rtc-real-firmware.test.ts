/**
 * The DS1307 and DS3231 parts under firmware that was compiled, not
 * imitated: real sketches on avr8js, the ATmega's TWI on the bus fabric, the
 * part attached the way the canvas attaches it. What is proved here is what a
 * user sees in the serial monitor.
 *
 * fixtures/avr-rtclib-ds3231 is the setup of RTClib's own DS3231 example:
 * `if (rtc.lostPower()) rtc.adjust(DateTime(F(__DATE__), F(__TIME__)))`.
 * The part powers on with OSF clear, so that sketch reads the host's time
 * and sets nothing; the tests of the adjust() give it a module fresh from
 * the bag.
 * fixtures/avr-rtclib-ds1307 sets the clock with the same two strings and no
 * F(). Both are what decision D7 of project i2c-model-fidelity-2026-09 is
 * about: a clock set to the build time of its firmware stays on the host's
 * time, and the model knows the build time from the image.
 *
 *   - What the firmware writes to the chip is read off the bus, and it is
 *     what the scan of the image finds (simulation/firmwareBuildTime.ts). So
 *     the strings RTClib parses at run time are the ones in flash.
 *   - With the image in the store, as a compile leaves it, the sketch prints
 *     the host's time. Without it, it prints the time of the build, counting:
 *     that is the chip, and the fallback when no build time can be told.
 *   - A date of the sketch's own is kept, CH stops the clock, the RAM keeps
 *     its byte.
 *
 * fixtures/avr-grove-rtc-ds1307 is the example of the Seeed library, which
 * counts Monday as day 1: the day of week it set is the one it reads.
 *
 * The host's clock is the test's: nothing here reads the time of the machine.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import {
  DS3231_RULES,
  VirtualDS1307,
  VirtualDS3231,
  type I2CDevice,
} from '../simulation/I2CBusManager';
import { buildTimesOfProgram } from '../simulation/firmwareBuildTime';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { busRegistry } from '../simulation/buses';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { bareBoard, putI2cDevice, wireI2cPins, clearBench } from './helpers/i2cBench';

const firmware = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}/${name}.ino.hex`, import.meta.url)),
    'utf-8',
  );
const RTCLIB_DS3231 = firmware('avr-rtclib-ds3231');
const RTCLIB_DS1307 = firmware('avr-rtclib-ds1307');
const GROVE_DS1307 = firmware('avr-grove-rtc-ds1307');

// The Uno's TWI pins (A4 / A5) as board pins of the fabric.
const UNO = 'uno';
const UNO_SDA = 18;
const UNO_SCL = 19;
const CYCLES_PER_MS = 16_000;

// The host: 12:34:56.250 of Wednesday 30 September 2026, local time.
const HOST = new Date(2026, 8, 30, 12, 34, 56, 250);

interface Bench {
  /** Run until the sketch has printed `count` more lines that match, or fail. */
  lines(pattern: RegExp, count: number, withinMs?: number): string[];
  out(): string;
  /** Every write phase the firmware put on the bus, pointer first. */
  writes: number[][];
}

type Attach = (sim: AVRSimulator) => void;

/** The part of the canvas, attached as the canvas attaches it. */
const part =
  (type: 'ds1307' | 'ds3231'): Attach =>
  (sim) => {
    wireI2cPins('rtc', { boardId: UNO, pin: UNO_SDA }, { boardId: UNO, pin: UNO_SCL });
    const el = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    PartSimulationRegistry.get(type)!.attachEvents!(
      el as unknown as HTMLElement,
      sim as never,
      () => null,
      'rtc',
    );
  };

/** A model on its own, for a chip that is told nothing about the firmware. */
const model =
  (device: I2CDevice): Attach =>
  () => {
    putI2cDevice(device, { boardId: UNO, pin: UNO_SDA }, { boardId: UNO, pin: UNO_SCL });
  };

function bench(hex: string, attach: Attach): Bench {
  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(hex);
  let out = '';
  sim.onSerialData = (ch: string) => {
    out += ch;
  };
  bareBoard(UNO, 'arduino-uno', sim);
  attach(sim);

  const bus = busRegistry.fabric(UNO).i2cBuses.get(UNO_SDA)!;
  const writes: number[][] = [];
  let phase: number[] | null = null;
  const { start, write, stop } = bus;
  const close = () => {
    if (phase && phase.length) writes.push(phase);
    phase = null;
  };
  bus.start = (address, rd) => {
    close();
    if (!rd) phase = [];
    return start.call(bus, address, rd);
  };
  bus.write = (byte) => {
    phase?.push(byte);
    return write.call(bus, byte);
  };
  bus.stop = () => {
    close();
    stop.call(bus);
  };

  const cycles = () => (sim as unknown as { cpu: { cycles: number } }).cpu.cycles;
  let seen = 0;
  return {
    out: () => out,
    writes,
    lines(pattern, count, withinMs = 3000) {
      const found: string[] = [];
      const limit = cycles() + withinMs * CYCLES_PER_MS;
      for (;;) {
        for (let nl = out.indexOf('\n', seen); nl >= 0; nl = out.indexOf('\n', seen)) {
          const line = out.slice(seen, nl).replace(/\r$/, '');
          seen = nl + 1;
          if (pattern.test(line)) found.push(line);
          if (found.length === count) return found;
        }
        if (cycles() >= limit) {
          throw new Error(
            `${found.length} of ${count} lines matching ${pattern} in ${withinMs} ms of guest time; ` +
              `the sketch printed ${JSON.stringify(out)}`,
          );
        }
        for (let i = 0; i < 20_000; i++) sim.step();
      }
    },
  };
}

/** The image as a compile leaves it in the store, on the board it was built for. */
function compiled(hex: string | null): void {
  useSimulatorStore.setState((s) => ({
    boards: s.boards.map((b, i) => (i === 0 ? { ...b, compiledProgram: hex } : b)),
  }));
}

const two = (n: number) => String(n).padStart(2, '0');
const bcd = (b: number) => (b >> 4) * 10 + (b & 0x0f);

/** "2026-09-30 00:21:52", from the eight bytes of an adjust(). */
function written(write: number[]): string {
  const [pointer, s, mi, h, , d, mo, y] = write;
  expect(pointer).toBe(0x00);
  return `20${two(bcd(y))}-${two(bcd(mo))}-${two(bcd(d))} ${two(bcd(h))}:${two(bcd(mi))}:${two(bcd(s))}`;
}

function builtAt(hex: string): string[] {
  return buildTimesOfProgram(hex).map(
    (b) =>
      `${b.year}-${two(b.month)}-${two(b.day)} ${two(b.hour)}:${two(b.minute)}:${two(b.second)}`,
  );
}

/**
 * A DS3231 fresh from the bag, OSF set, for as long as the test runs. The
 * part powers on with OSF clear (DS3231_RULES.power_on says why), so RTClib's
 * example `if (rtc.lostPower()) rtc.adjust(...)` leaves it alone; a module
 * that says it lost power is how these sketches get to set the clock.
 */
function freshFromTheBag(): void {
  const powerOn = DS3231_RULES.power_on as Record<number, number>;
  const status = powerOn[0x0f];
  powerOn[0x0f] = status | 0x80;
  restoreStatus.push(() => {
    powerOn[0x0f] = status;
  });
}
const restoreStatus: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(HOST);
});

afterEach(() => {
  while (restoreStatus.length) restoreStatus.pop()!();
  compiled(null);
  useSimulatorStore.setState({ compiledHex: null });
  clearBench();
  vi.useRealTimers();
});

describe('RTClib RTC_DS3231 on an Arduino Uno, compiled', () => {
  it('as it comes, says it kept its power and shows the time of the host', () => {
    compiled(RTCLIB_DS3231);
    const b = bench(RTCLIB_DS3231, part('ds3231'));
    expect(b.lines(/^(READY|NOT FOUND|LOST=.)$/, 3)).toEqual(['READY', 'LOST=0', 'LOST=0']);
    expect(b.writes.some((w) => w.length === 8)).toBe(false);
    expect(b.lines(/^NOW=/, 1)).toEqual(['NOW=2026-09-30 12:34:56 DOW=3 T=25.00']);
  }, 120_000);

  it('writes the build time that the scan of its image finds', () => {
    freshFromTheBag();
    const clock = Date.UTC(2026, 8, 30, 12, 34, 56, 250);
    const b = bench(RTCLIB_DS3231, model(new VirtualDS3231({ clock: () => clock })));
    expect(b.lines(/^(READY|NOT FOUND|LOST=.)$/, 3)).toEqual(['READY', 'LOST=1', 'LOST=0']);
    const adjust = b.writes.find((w) => w.length === 8)!;
    expect(builtAt(RTCLIB_DS3231)).toEqual([written(adjust)]);
    // A chip that knows nothing of the firmware keeps what it was given, and
    // that is the hour of the compile server.
    expect(b.lines(/^NOW=/, 1)).toEqual([`NOW=${written(adjust)} DOW=3 T=25.00`]);
  }, 120_000);

  it('on the canvas, set to the build time, stays on the time of the host', () => {
    freshFromTheBag();
    compiled(RTCLIB_DS3231);
    const b = bench(RTCLIB_DS3231, part('ds3231'));
    expect(b.lines(/^(READY|NOT FOUND|LOST=.)$/, 3)).toEqual(['READY', 'LOST=1', 'LOST=0']);
    expect(b.lines(/^NOW=/, 2)).toEqual([
      'NOW=2026-09-30 12:34:56 DOW=3 T=25.00',
      'NOW=2026-09-30 12:34:56 DOW=3 T=25.00',
    ]);
    vi.setSystemTime(new Date(2026, 8, 30, 23, 59, 59, 900));
    expect(b.lines(/^NOW=/, 1)).toEqual(['NOW=2026-09-30 23:59:59 DOW=3 T=25.00']);
  }, 120_000);

  it('finds the image where the single-board load path leaves it', () => {
    freshFromTheBag();
    useSimulatorStore.setState({ compiledHex: RTCLIB_DS3231 });
    const b = bench(RTCLIB_DS3231, part('ds3231'));
    expect(b.lines(/^NOW=/, 1)).toEqual(['NOW=2026-09-30 12:34:56 DOW=3 T=25.00']);
  }, 120_000);

  it('with no image in the store, keeps the time it was given and counts from it', () => {
    freshFromTheBag();
    const b = bench(RTCLIB_DS3231, part('ds3231'));
    const [built] = builtAt(RTCLIB_DS3231);
    expect(b.lines(/^NOW=/, 1)).toEqual([`NOW=${built} DOW=3 T=25.00`]);
    vi.setSystemTime(new Date(HOST.getTime() + 3000));
    expect(b.lines(/^NOW=/, 1)).toEqual(['NOW=2026-09-30 00:21:55 DOW=3 T=25.00']);
  }, 120_000);

  it('keeps a date of the sketch own, and follows the panel', () => {
    compiled(RTCLIB_DS3231);
    const b = bench(RTCLIB_DS3231, part('ds3231'));
    b.lines(/^OWN DATE$/, 1);
    expect(b.lines(/^NOW=/, 1)).toEqual(['NOW=2024-02-29 23:59:58 DOW=4 T=25.00']);
    dispatchSensorUpdate('rtc', { temperature: -5.25 });
    vi.setSystemTime(new Date(HOST.getTime() + 3000));
    // The line being printed when the clock moved may still carry the old second.
    // RTClib reads the high byte as unsigned, on the bench as here: -5.25 C is 250.75.
    expect(b.lines(/^NOW=/, 3).pop()).toBe('NOW=2024-03-01 00:00:01 DOW=5 T=250.75');
  }, 120_000);
});

describe('RTClib RTC_DS1307 on an Arduino Uno, compiled', () => {
  it('writes the build time that the scan of its image finds', () => {
    const clock = Date.UTC(2026, 8, 30, 12, 34, 56, 250);
    const b = bench(RTCLIB_DS1307, model(new VirtualDS1307({ clock: () => clock })));
    expect(b.lines(/^(READY|NOT FOUND|RUNNING=.)$/, 2)).toEqual(['READY', 'RUNNING=1']);
    const [first] = b.lines(/^NOW=/, 1);
    const adjust = b.writes.find((w) => w.length === 8)!;
    expect(builtAt(RTCLIB_DS1307)).toEqual([written(adjust)]);
    expect(first).toBe(`NOW=${written(adjust)}`);
  }, 120_000);

  it('on the canvas, stays on the time of the host until the sketch stops the clock', () => {
    compiled(RTCLIB_DS1307);
    const b = bench(RTCLIB_DS1307, part('ds1307'));
    expect(b.lines(/^(READY|NOT FOUND|RUNNING=.)$/, 2)).toEqual(['READY', 'RUNNING=1']);
    expect(b.lines(/^NOW=/, 1)).toEqual(['NOW=2026-09-30 12:34:56']);
    vi.setSystemTime(new Date(2026, 8, 30, 12, 35, 10, 0));
    expect(b.lines(/^RUNNING=/, 1)).toEqual(['RUNNING=0 NVRAM=5A']);
    // Stopped with the seconds at 00, and it stays there.
    expect(b.lines(/^NOW=/, 1)).toEqual(['NOW=2026-09-30 12:35:00']);
    vi.setSystemTime(new Date(2026, 8, 30, 18, 0, 0, 0));
    expect(b.lines(/^NOW=/, 2)).toEqual(['NOW=2026-09-30 12:35:00', 'NOW=2026-09-30 12:35:00']);
  }, 120_000);
});

describe('Grove RTC DS1307 on an Arduino Uno, compiled', () => {
  it('reads back the Saturday it set, counting Monday as 1', () => {
    compiled(GROVE_DS1307);
    const b = bench(GROVE_DS1307, part('ds1307'));
    expect(b.lines(/\*/, 1)).toEqual(['15:28:30\t1/19/2013 19*SAT ']);
    vi.setSystemTime(new Date(HOST.getTime() + 2000));
    expect(b.lines(/\*/, 3).pop()).toBe('15:28:32\t1/19/2013 19*SAT ');
    // Midnight: the day of week moves on with the date.
    vi.setSystemTime(new Date(HOST.getTime() + (8 * 3600 + 31 * 60 + 30) * 1000));
    expect(b.lines(/\*/, 3).pop()).toBe('0:0:0\t1/20/2013 20*SUN ');
  }, 120_000);
});
