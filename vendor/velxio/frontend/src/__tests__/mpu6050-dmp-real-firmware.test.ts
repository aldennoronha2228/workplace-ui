/**
 * The MPU-6050's DMP under the library that drives it, compiled: the
 * example MPU6050_DMP6 of Electronic Cats' MPU6050 1.4.5 (jrowberg's
 * i2cdevlib, MotionApps 2.0) built for an Arduino Uno and run on avr8js,
 * the part attached the way the canvas attaches it, INT on pin 2 as the
 * example wires it.
 *
 * dmpInitialize() uploads the DMP image, the example calibrates the offsets
 * and enables the DMP, and loop() prints yaw, pitch and roll from the
 * quaternion of each packet. The model had the memory port but no DMP: no
 * packet reached the FIFO, dmpGetCurrentFIFOPacket() never returned one and
 * the sketch printed "DMP ready!" and nothing after it (the Grove copy of
 * the library, which waits for FIFO_COUNT inside dmpInitialize(), hung
 * there). What is proved here is that the angles the sketch prints are the
 * panel's: pitch and roll from the accelerometer, yaw from the gyroscope.
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

const DMP6 = readFileSync(
  fileURLToPath(new URL('./fixtures/avr-mpu6050-dmp6/avr-mpu6050-dmp6.ino.hex', import.meta.url)),
  'utf-8',
);

const UNO = 'uno';
const UNO_SDA = 18;
const UNO_SCL = 19;
/** The example's INTERRUPT_PIN. */
const INT_PIN = 2;
const CYCLES_PER_MS = 16_000;
/** The data-space address of PIND. */
const PIND = 0x29;

const listeners: Array<() => void> = [];

function bench() {
  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(DMP6);
  let out = '';
  sim.onSerialData = (ch: string) => {
    out += ch;
  };
  bareBoard(UNO, 'arduino-uno', sim);
  wireI2cPins('imu', { boardId: UNO, pin: UNO_SDA }, { boardId: UNO, pin: UNO_SCL });
  const el = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  PartSimulationRegistry.get('mpu6050')!.attachEvents!(
    el as unknown as HTMLElement,
    sim as never,
    (name: string) => (name === 'INT' ? INT_PIN : null),
    'imu',
  );
  const notes: BusDiagnostic[] = [];
  listeners.push(busRegistry.onDiagnostic((d) => notes.push(d)));

  const cpu = (sim as unknown as { cpu: { cycles: number; data: Uint8Array } }).cpu;
  const cycles = () => cpu.cycles;
  let seen = 0;
  return {
    sim,
    notes,
    out: () => out,
    /** Rising edges of pin 2 as the ATmega reads it (PIND bit 2), over `ms` of guest time. */
    risesIn(ms: number): number {
      const until = cycles() + ms * CYCLES_PER_MS;
      let rises = 0;
      let level = (cpu.data[PIND] & (1 << INT_PIN)) !== 0;
      while (cycles() < until) {
        sim.step();
        const now = (cpu.data[PIND] & (1 << INT_PIN)) !== 0;
        if (now && !level) rises++;
        level = now;
      }
      return rises;
    },
    /** Run for `ms` of guest time; what it printed is not looked at. */
    run(ms: number) {
      const until = cycles() + ms * CYCLES_PER_MS;
      while (cycles() < until) sim.step();
      seen = out.lastIndexOf('\n') + 1;
    },
    /** Run until the sketch has printed `count` more lines that match, or fail. */
    lines(pattern: RegExp, count: number, withinMs = 3000): string[] {
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
              `the sketch printed ${JSON.stringify(out.slice(-600))}`,
          );
        }
        for (let i = 0; i < 20_000; i++) sim.step();
      }
    },
  };
}

type Bench = ReturnType<typeof bench>;

/** The last `ypr` line of the next `n`, as numbers in degrees. */
function ypr(b: Bench, n = 3): [number, number, number] {
  const line = b.lines(/^ypr\t/, n).pop()!;
  const [, yaw, pitch, roll] = line.split('\t').map(Number);
  return [yaw, pitch, roll];
}

/** The example up to its loop: connection, the key it waits for, DMP init, calibration. */
function start(b: Bench): void {
  expect(b.lines(/^MPU6050 connection /, 1)).toEqual(['MPU6050 connection successful']);
  b.lines(/^Send any character to begin/, 1);
  b.sim.serialWrite('x');
  expect(b.lines(/^DMP ready! Waiting for first interrupt\.\.\.$|failed/, 1, 20_000)).toEqual([
    'DMP ready! Waiting for first interrupt...',
  ]);
}

afterEach(() => {
  for (const off of listeners.splice(0)) off();
  clearBench();
});

describe('i2cdevlib MPU6050_DMP6 (MotionApps 2.0) on an Arduino Uno, compiled', () => {
  it('prints yaw, pitch and roll that follow the panel', () => {
    const b = bench();
    start(b);
    // Level and still, where the calibration left it.
    for (const angle of ypr(b)) expect(Math.abs(angle)).toBeLessThan(0.5);

    // Nose up 30 degrees: gravity leans onto +X.
    dispatchSensorUpdate('imu', { accelX: 0.5, accelY: 0, accelZ: Math.sqrt(3) / 2 });
    let [yaw, pitch, roll] = ypr(b);
    expect(pitch).toBeCloseTo(30, 0);
    expect(Math.abs(roll)).toBeLessThan(0.5);
    expect(Math.abs(yaw)).toBeLessThan(0.5);

    // Rolled 45 degrees onto +Y.
    dispatchSensorUpdate('imu', { accelX: 0, accelY: Math.SQRT1_2, accelZ: Math.SQRT1_2 });
    [yaw, pitch, roll] = ypr(b);
    expect(roll).toBeCloseTo(45, 0);
    expect(Math.abs(pitch)).toBeLessThan(0.5);

    // Level again, turning at 45 deg/s about Z for one second of guest
    // time. The DMP's quaternion turns the chip's axes into the world's, so
    // a turn that is positive about Z (counter-clockwise from above) reads
    // as falling yaw in i2cdevlib's dmpGetYawPitchRoll.
    dispatchSensorUpdate('imu', { accelX: 0, accelY: 0, accelZ: 1, gyroZ: 45 });
    b.lines(/^ypr\t/, 1);
    const before = ypr(b, 1)[0];
    b.run(1000);
    dispatchSensorUpdate('imu', { gyroZ: 0 });
    const after = ypr(b, 2)[0];
    expect(before - after).toBeGreaterThan(44);
    expect(before - after).toBeLessThan(47);
    // It stays where the turn left it.
    expect(ypr(b, 5)[0]).toBeCloseTo(after, 1);

    // A known image is run, not reported.
    expect(b.notes.filter((d) => d.code === 'i2c-target-unmodelled')).toEqual([]);
  }, 300_000);

  it('pulses INT on pin 2 once per packet, 100 a second', () => {
    const b = bench();
    start(b);
    b.lines(/^ypr\t/, 1);
    // MotionApps 2.0 writes D_0_22 = 1: 200 Hz / 2.
    const rises = b.risesIn(500);
    expect(rises).toBeGreaterThanOrEqual(49);
    expect(rises).toBeLessThanOrEqual(51);
  }, 300_000);
});
