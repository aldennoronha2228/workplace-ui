/**
 * The compiled MPU-6050 (simulation/buses/models/mpu6050.c) against the bus
 * vectors the hand-written copies replay: test/fixtures/i2c-vectors/mpu6050.json.
 * Project i2c-model-fidelity-2026-09, P5 step 3 (decision O4): the tab's half
 * of the proof that one model stands in for VirtualMPU6050 and MPU6050Slave.
 * The worker's half replays the same file against the same .wasm
 * (test/backend/unit/test_wasm_i2c_models.py).
 *
 * The model is hosted the way the part hosts it (WasmMPU6050 in
 * simulation/parts/wasmI2cModels.ts): ChipRuntime, the chip's own I2C device,
 * the guest's clock, the panel's values, the address and the die pushed into
 * the model's memory. protocol-parts.test.ts replays the file against the
 * part itself, which runs this model by default, and the real-firmware tests
 * run compiled sketches against that part.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  MPU6050_RULES,
  VirtualMPU6050,
  parseMpuVariant,
  type Mpu6050Model,
} from '../simulation/parts/ProtocolParts';
import { i2cTargetOf } from '../simulation/parts/i2cPart';
import {
  WasmMPU6050,
  primeWasmI2cModel,
  resetWasmI2cModelsForTest,
  setWasmI2cModelsForTest,
  wasmI2cModelEnabled,
  wasmI2cModule,
} from '../simulation/parts/wasmI2cModels';
import { I2C_MODEL_WASM_B64 } from '../simulation/buses/models/i2cModelBytes.generated';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import type { GuestClock } from '../simulation/buses/types';
import { BUS_FLAVOURS, loadBusVectors, replayVector, type VectorHost } from './helpers/busVectors';

const VECTORS = loadBusVectors('mpu6050.json');
const ADDR = parseInt(VECTORS.address, 16);

const models = (p: string) =>
  fileURLToPath(new URL(`../simulation/buses/models/${p}`, import.meta.url));
const WASM = readFileSync(
  fileURLToPath(new URL('../../public/bus-chips/mpu6050.wasm', import.meta.url)),
);
const MODULE = new WebAssembly.Module(WASM);

const registersOf = (ranges: readonly (readonly [number, number])[]): number[] =>
  ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));

function powerOn(variant = 'mpu6050', address = ADDR): WasmMPU6050 {
  const dev = new WasmMPU6050(MODULE, {
    address,
    variant,
    volatileReads: registersOf(MPU6050_RULES.volatile_reads),
    pointerStays: registersOf(MPU6050_RULES.pointer_stays),
  });
  dev.setInputs(VECTORS.inputs);
  return dev;
}

/** A guest clock of 16 MHz that stands still until the test moves it. */
class TestClock implements GuestClock {
  cycles = 0;
  now(): number {
    return this.cycles;
  }
  clockHz(): number {
    return 16_000_000;
  }
  scheduleEdge(): void {}
  at(): () => void {
    return () => {};
  }
  advanceUs(us: number): void {
    this.cycles += Math.round(us * 16);
  }
}

/** On the fabric's target contract, as a board whose firmware runs in the tab reaches it. */
function fabricHost(dev: Mpu6050Model, clock: TestClock | null): VectorHost {
  const target = i2cTargetOf(dev);
  target.setClock?.(clock);
  return {
    start: (read) => target.start(ADDR, read),
    write: (byte) => target.write(byte),
    read: () => target.read(),
    stop: () => target.stop(),
    inputs: (values) => dev.setInputs(values),
    dump: () => target.dumpRegisters!(),
    advanceUs: clock ? (us) => clock.advanceUs(us) : undefined,
    intPad: () => dev.intPad(),
  };
}

/** A host that never says where a read begins (protocol-parts.test.ts, bareHost). */
function bareHost(dev: Mpu6050Model, clock: TestClock | null): VectorHost {
  dev.setClock?.(clock);
  return {
    start: (read) => {
      if (!read) dev.stop?.();
      return true;
    },
    write: (byte) => dev.writeByte(byte),
    read: () => dev.readByte(),
    stop: () => dev.stop?.(),
    inputs: (values) => dev.setInputs(values),
    dump: () => dev.dumpRegisters!(),
    advanceUs: clock ? (us) => clock.advanceUs(us) : undefined,
    intPad: () => dev.intPad(),
  };
}

const read = (dev: Mpu6050Model, reg: number, n: number): number[] => {
  dev.start?.(false);
  dev.writeByte(reg);
  dev.start?.(true);
  const out = Array.from({ length: n }, () => dev.readByte());
  dev.stop?.();
  return out;
};
const write = (dev: Mpu6050Model, reg: number, ...values: number[]) => {
  dev.start?.(false);
  dev.writeByte(reg);
  for (const v of values) dev.writeByte(v);
  dev.stop?.();
};

describe('mpu6050.wasm: the artifact', () => {
  it('was built from the sources next to it (buses/models/build.sh)', () => {
    const manifest = JSON.parse(readFileSync(models('manifest.json'), 'utf-8'));
    const sha = (p: string) =>
      createHash('sha256')
        .update(readFileSync(models(p)))
        .digest('hex');
    expect(manifest.mpu6050.sourceSha256).toBe(sha('mpu6050.c'));
    expect(manifest.mpu6050.includeSha256).toEqual({ 'i2c_host.h': sha('i2c_host.h') });
  });

  it('is the one the bundle carries', () => {
    expect(Buffer.from(I2C_MODEL_WASM_B64.mpu6050, 'base64').equals(WASM)).toBe(true);
  });

  it('powers on as VirtualMPU6050, as each die', () => {
    for (const variant of ['mpu6050', 'mpu9250'] as const) {
      const dump = powerOn(variant).dumpRegisters();
      const reference = new VirtualMPU6050(ADDR, variant).dumpRegisters();
      expect(Array.from(dump), variant).toEqual(Array.from(reference));
    }
  });

  it('answers at the address the part gives it', () => {
    for (const address of [0x68, 0x69]) {
      const dev = powerOn('mpu6050', address);
      const target = i2cTargetOf(dev);
      expect(dev.address).toBe(address);
      target.start(address, false);
      target.write(0x75);
      target.start(address, true);
      expect(target.read()).toBe(0x68);
      target.stop();
    }
  });
});

describe('mpu6050.wasm: the bus vectors the two copies replay', () => {
  for (const flavour of BUS_FLAVOURS) {
    for (const vector of VECTORS.vectors) {
      const variant = parseMpuVariant(vector.variant);
      const clock = () => (vector.clock === false ? null : new TestClock());

      it(`[${flavour}] ${vector.name}`, () => {
        replayVector(fabricHost(powerOn(variant), clock()), vector, flavour);
      });

      it(`[${flavour}, a host that hears no START] ${vector.name}`, () => {
        replayVector(bareHost(powerOn(variant), clock()), vector, flavour);
      });
    }
  }
});

describe('mpu6050.wasm: what the hand-written copy does besides the vectors', () => {
  const pair = (variant = 'mpu6050') => {
    const a = powerOn(variant);
    const b = new VirtualMPU6050(ADDR, parseMpuVariant(variant));
    b.setInputs(VECTORS.inputs);
    return [a, b] as const;
  };

  it('encodes any panel value at every range as VirtualMPU6050 does', () => {
    const panels = [
      {
        accelX: 0.123,
        accelY: -1.5,
        accelZ: 15.99,
        gyroX: 250.25,
        gyroY: -1999.9,
        gyroZ: 0.5,
        temp: -40,
      },
      {
        accelX: -16,
        accelY: 16,
        accelZ: 1e308,
        gyroX: -32.75,
        gyroY: 65.5,
        gyroZ: 131.001,
        temp: 85,
      },
      {
        accelX: 1 / 3,
        accelY: -2 / 3,
        accelZ: 0.99999,
        gyroX: 0.0078,
        gyroY: -0.0038,
        gyroZ: 7.62,
        temp: 36.53,
      },
    ];
    for (const variant of ['mpu6050', 'mpu9250']) {
      for (const values of panels) {
        const [a, b] = pair(variant);
        for (const dev of [a, b]) {
          dev.setInputs(values);
          write(dev, 0x6b, 0x00);
        }
        for (let range = 0; range < 4; range++) {
          for (const dev of [a, b]) write(dev, 0x1b, range << 3, range << 3);
          // Offsets and trims too: a gyro offset and an accelerometer trim.
          for (const dev of [a, b]) write(dev, 0x13, 0xff, 0x9c, 0x00, 0x21);
          expect(read(a, 0x3b, 14), `${variant} ${JSON.stringify(values)} range ${range}`).toEqual(
            read(b, 0x3b, 14),
          );
        }
      }
    }
  });

  it('takes from the panel what VirtualMPU6050 takes, and says what it holds', () => {
    const [a, b] = pair();
    for (const values of [
      { accelX: 0.5 },
      { accelY: Number.NaN },
      { temp: Infinity },
      { gyroZ: '3' },
      { bogus: 1 },
    ]) {
      a.setInputs(values);
      b.setInputs(values);
      expect(a.getInputs()).toEqual(b.getInputs());
    }
  });

  it('moves the INT pad and says when it moves next as VirtualMPU6050 does', () => {
    const [a, b] = pair();
    const clocks = [new TestClock(), new TestClock()];
    a.setClock(clocks[0]);
    b.setClock(clocks[1]);
    const both = (f: (dev: Mpu6050Model, i: number) => unknown) => [f(a, 0), f(b, 1)];
    const same = (label: string, f: (dev: Mpu6050Model, i: number) => unknown) => {
      const [x, y] = both(f);
      expect(x, label).toEqual(y);
    };
    both((dev) => write(dev, 0x19, 0x07)); // 1 kHz
    both((dev) => write(dev, 0x38, 0x01)); // DATA_RDY_EN
    both((dev) => write(dev, 0x6b, 0x00));
    for (let step = 0; step < 12; step++) {
      same(`pad at step ${step}`, (dev) => dev.intPad());
      same(`wake at step ${step}`, (dev) => dev.intWakeNs());
      both((_dev, i) => clocks[i].advanceUs(275));
      if (step === 5) {
        both((dev) => write(dev, 0x37, 0xa0)); // active low, latched
      }
      if (step === 8) same('INT_STATUS', (dev) => read(dev, 0x3a, 1));
    }
  });

  it('after DEVICE_RESET an empty FIFO repeats 0, as both old copies do', () => {
    // A register reset on the bench starts the FIFO_R_W repeat from 0;
    // VirtualMPU6050 (powerOn clears fifoLast) and MPU6050Slave agree.
    const dev = powerOn();
    write(dev, 0x6b, 0x00);
    write(dev, 0x74, 0x5a);
    expect(read(dev, 0x74, 2)).toEqual([0x5a, 0x5a]);
    write(dev, 0x6b, 0x80);
    expect(read(dev, 0x74, 1)).toEqual([0x00]);
  });

  it('tells the part once a run that it was read asleep, and that the DMP image is not one it runs', () => {
    const dev = powerOn();
    const asleep = vi.fn();
    const unknown = vi.fn();
    dev.onAsleepRead = asleep;
    dev.onDmpUnknown = unknown;
    read(dev, 0x75, 1);
    expect(asleep).not.toHaveBeenCalled();
    read(dev, 0x3b, 14);
    read(dev, 0x43, 6);
    expect(asleep).toHaveBeenCalledTimes(1);
    dev.boardReset();
    read(dev, 0x3b, 2);
    expect(asleep).toHaveBeenCalledTimes(2);
    write(dev, 0x6b, 0x00);
    write(dev, 0x6a, 0xc0);
    write(dev, 0x6a, 0xc0);
    expect(unknown).toHaveBeenCalledTimes(1);
    dev.boardReset();
    write(dev, 0x6a, 0xc0);
    expect(unknown).toHaveBeenCalledTimes(2);
  });

  it('tells the pad driver where VirtualMPU6050 does', () => {
    const [a, b] = pair();
    const heard = [vi.fn(), vi.fn()];
    a.onIntChange = heard[0];
    b.onIntChange = heard[1];
    for (const dev of [a, b]) {
      write(dev, 0x38, 0x01);
      read(dev, 0x3a, 1);
      dev.setClock?.(new TestClock());
      dev.boardReset?.();
      dev.dumpRegisters?.();
    }
    expect(heard[0].mock.calls.length).toBe(heard[1].mock.calls.length);
  });
});

describe('the compiled MPU-6050: on by default, and the flag that turns it off', () => {
  afterEach(() => {
    setWasmI2cModelsForTest(null);
    resetWasmI2cModelsForTest();
    vi.unstubAllGlobals();
  });

  const workerSim = () => ({
    registerSensor: vi.fn(),
    updateSensor: vi.fn(),
    unregisterSensor: vi.fn(),
  });
  const element = (props: Record<string, unknown> = {}) =>
    ({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      ...props,
    }) as unknown as HTMLElement;
  const attach = (sim: ReturnType<typeof workerSim>, id: string, props = {}) =>
    PartSimulationRegistry.get('mpu6050')!.attachEvents!(
      element(props),
      sim as never,
      () => null,
      id,
    );

  it('runs compiled unless the flag says otherwise', () => {
    expect(wasmI2cModelEnabled('mpu6050')).toBe(true);
    vi.stubGlobal('window', { location: { search: '?i2cwasm=off' } });
    expect(wasmI2cModelEnabled('mpu6050')).toBe(false);
    vi.stubGlobal('window', { location: { search: '?i2cwasm=bmp280' } });
    expect(wasmI2cModelEnabled('mpu6050')).toBe(false);
    vi.stubGlobal('window', { location: { search: '?i2cwasm=mpu6050' } });
    expect(wasmI2cModelEnabled('mpu6050')).toBe(true);
  });

  it('the bundle compiles it', () => {
    expect(wasmI2cModule('mpu6050')).toBeInstanceOf(WebAssembly.Module);
  });

  it('on: the worker record carries the bytes the tab runs, with the die and the address', () => {
    const sim = workerSim();
    attach(sim, 'imu-wasm-on', { ad0: true, variant: 'MPU-9250' })();
    const [type, , props] = sim.registerSensor.mock.calls[0];
    expect(type).toBe('mpu6050');
    expect(Buffer.from(props.wasmB64 as string, 'base64').equals(WASM)).toBe(true);
    expect(props).toMatchObject({ addr: 0x69, variant: 'mpu9250', accelZ: 1, temp: 24 });
  });

  it('off: the record carries no model, and the worker keeps its twin', () => {
    setWasmI2cModelsForTest([]);
    const sim = workerSim();
    attach(sim, 'imu-wasm-off')();
    const [, , props] = sim.registerSensor.mock.calls[0];
    expect(props).not.toHaveProperty('wasmB64');
  });

  it('a model that cannot be built leaves the hand-written one, in both hosts', () => {
    primeWasmI2cModel('mpu6050', null);
    const sim = workerSim();
    attach(sim, 'imu-wasm-broken')();
    const [, , props] = sim.registerSensor.mock.calls[0];
    expect(props).not.toHaveProperty('wasmB64');
  });
});
