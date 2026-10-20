/**
 * The BMP280 part under firmware that was compiled, not imitated: a real
 * sketch on avr8js, the ATmega's TWI on the bus fabric, the part attached the
 * way the canvas attaches it. What is proved here is what a user sees in the
 * serial monitor (project i2c-model-fidelity-2026-09).
 *
 * fixtures/avr-adafruit-bmp280 reads the part with Adafruit_BMP280 3.0.0, the
 * driver most projects use, first as the gallery examples do (begin(0x76) and
 * their setSampling() for normal mode) and then in forced mode:
 *
 *   - the readings are the panel's, before and after the model learned that
 *     the chip powers on asleep: the driver selects a mode before it reads;
 *   - takeForcedMeasurement() comes back, and every reading after it is what
 *     the panel said when that measurement was taken;
 *   - the driver trace of test/fixtures/i2c-vectors/bmp280.json was read from
 *     the library's source. Here the compiled library puts its own traffic
 *     next to it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { busRegistry } from '../simulation/buses';
import type { BusDiagnostic } from '../simulation/buses';
import { bareBoard, wireI2cPins, clearBench } from './helpers/i2cBench';
import { hexText, loadBusVectors, type VectorStep } from './helpers/busVectors';

const ADAFRUIT = readFileSync(
  fileURLToPath(
    new URL('./fixtures/avr-adafruit-bmp280/avr-adafruit-bmp280.ino.hex', import.meta.url),
  ),
  'utf-8',
);
const VECTORS = loadBusVectors('bmp280.json');

// The Uno's TWI pins (A4 / A5) as board pins of the fabric.
const UNO = 'uno';
const UNO_SDA = 18;
const UNO_SCL = 19;
const CYCLES_PER_MS = 16_000;
const PART = 'bmp';
/** The sketch reads in normal mode for this many passes, then in forced mode. */
const NORMAL_PASSES = 6;

interface Bench {
  /** Everything the sketch printed so far. */
  out(): string;
  /** Run until the sketch has printed `count` more lines that match, or fail. */
  lines(pattern: RegExp, count: number, withinMs?: number): string[];
  /** What the firmware put on the wire, as steps of the vector format. */
  traffic: VectorStep[];
  notes: BusDiagnostic[];
}

const listeners: Array<() => void> = [];

function bench(hex: string, properties: Record<string, unknown> = {}): Bench {
  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(hex);
  let out = '';
  sim.onSerialData = (ch: string) => {
    out += ch;
  };
  bareBoard(UNO, 'arduino-uno', sim);
  wireI2cPins(PART, { boardId: UNO, pin: UNO_SDA }, { boardId: UNO, pin: UNO_SCL });
  const el = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, ...properties };
  PartSimulationRegistry.get('bmp280')!.attachEvents!(
    el as unknown as HTMLElement,
    sim as never,
    () => null,
    PART,
  );

  const notes: BusDiagnostic[] = [];
  listeners.push(busRegistry.onDiagnostic((d) => notes.push(d)));

  // Every START, byte and STOP the ATmega's TWI puts on the bus.
  const bus = busRegistry.fabric(UNO).i2cBuses.get(UNO_SDA)!;
  const traffic: VectorStep[] = [];
  let phases: Array<{ read: boolean; bytes: number[] }> = [];
  const { start, write, read, stop } = bus;
  bus.start = (address, rd) => {
    phases.push({ read: rd, bytes: [] });
    return start.call(bus, address, rd);
  };
  bus.write = (byte) => {
    phases[phases.length - 1].bytes.push(byte);
    return write.call(bus, byte);
  };
  bus.read = () => {
    const v = read.call(bus);
    phases[phases.length - 1].bytes.push(v);
    return v;
  };
  bus.stop = () => {
    const [first, second] = phases;
    if (phases.length === 1 && !first.read) {
      traffic.push({ op: 'write', data: hexText(first.bytes) });
    } else if (phases.length === 2 && !first.read && first.bytes.length === 1 && second.read) {
      traffic.push({
        op: 'read',
        reg: hexText(first.bytes),
        n: second.bytes.length,
        expect: hexText(second.bytes),
      });
    } else {
      traffic.push({ op: `unexpected: ${JSON.stringify(phases)}` });
    }
    phases = [];
    stop.call(bus);
  };

  const cycles = () => (sim as unknown as { cpu: { cycles: number } }).cpu.cycles;
  let seen = 0;
  return {
    out: () => out,
    traffic,
    notes,
    lines(pattern, count, withinMs = 3000) {
      const found: string[] = [];
      const limit = cycles() + withinMs * CYCLES_PER_MS;
      for (;;) {
        for (let nl = out.indexOf('\n', seen); nl >= 0; nl = out.indexOf('\n', seen)) {
          const line = out.slice(seen, nl).trim();
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

afterEach(() => {
  for (const off of listeners.splice(0)) off();
  clearBench();
});

describe('Adafruit_BMP280 on an Arduino Uno, compiled', () => {
  it('begin(0x76) finds the chip and the sketch reads where the panel starts', () => {
    const b = bench(ADAFRUIT);
    expect(b.lines(/^BEGIN=/, 1)).toEqual(['BEGIN=OK']);
    expect(b.out().startsWith('BOOT\r\nBEGIN=OK\r\n')).toBe(true);
    expect(b.lines(/^NORMAL /, 2)).toEqual(['NORMAL T=24.00 P=101325', 'NORMAL T=24.00 P=101325']);
    // The driver selects a mode before it reads: there is nothing to say.
    expect(b.notes).toEqual([]);
  }, 120_000);

  it('reads the values of the project, and follows the panel from there', () => {
    const b = bench(ADAFRUIT, { temperature: '31.5', pressure: '990' });
    expect(b.lines(/^NORMAL /, 1)).toEqual(['NORMAL T=31.50 P=99000']);
    dispatchSensorUpdate(PART, { temperature: -5, pressure: 1000.25 });
    // The line being printed when the slider moved may still carry the old reading.
    expect(b.lines(/^NORMAL /, 3).pop()).toBe('NORMAL T=-5.00 P=100025');
  }, 120_000);

  it('takeForcedMeasurement() comes back, and each forced reading is the panel at that measurement', () => {
    const b = bench(ADAFRUIT);
    b.lines(/^NORMAL /, NORMAL_PASSES);
    expect(b.lines(/^FORCED/, 2)).toEqual(['FORCED T=24.00 P=101325', 'FORCED T=24.00 P=101325']);
    dispatchSensorUpdate(PART, { temperature: 31.5, pressure: 990 });
    expect(b.lines(/^FORCED/, 3).pop()).toBe('FORCED T=31.50 P=99000');
    expect(b.out()).not.toContain('FORCED=FAIL');
    expect(b.notes).toEqual([]);
  }, 120_000);

  it('at 0x77 the sketch does not find it, as on the bench', () => {
    const b = bench(ADAFRUIT, { i2cAddress: '0x77' });
    expect(b.lines(/^BEGIN=/, 1)).toEqual(['BEGIN=FAIL']);
  }, 120_000);

  it('puts on the wire what the driver trace of the shared vectors says', () => {
    const b = bench(ADAFRUIT);
    b.lines(/^NORMAL /, 1);
    const golden = VECTORS.vectors.find(
      (v) => v.driver === 'adafruit-bmp280-arduino' && !/forced mode/.test(v.name),
    )!.steps;
    // Up to the first reading; after it the vector moves a slider.
    const untilTheSlider = golden.slice(
      0,
      golden.findIndex((s) => s.op === 'inputs'),
    );
    expect(untilTheSlider.length).toBeGreaterThan(15);
    expect(b.traffic.slice(0, untilTheSlider.length)).toEqual(untilTheSlider);
  }, 120_000);

  it('in forced mode, status shows the conversion to the first poll and the mode bits are back at sleep', () => {
    const b = bench(ADAFRUIT);
    b.lines(/^NORMAL /, NORMAL_PASSES);
    b.lines(/^FORCED/, 2);
    // One takeForcedMeasurement() as the library puts it on the wire: the
    // mode write, status until bit 3 is clear, then the reads of report().
    const at = b.traffic.map((s) => `${s.op} ${s.data ?? s.reg}`).lastIndexOf('write F4 25');
    expect(b.traffic.slice(at, at + 3)).toEqual([
      { op: 'write', data: 'F4 25' },
      { op: 'read', reg: 'F3', n: 1, expect: '08' },
      { op: 'read', reg: 'F3', n: 1, expect: '00' },
    ]);
  }, 120_000);
});
