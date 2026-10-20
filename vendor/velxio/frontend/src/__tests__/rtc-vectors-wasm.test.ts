/**
 * The compiled clocks (simulation/buses/models/ds1307.c and ds3231.c, on
 * rtc.h) against the bus vectors the hand-written copies replay:
 * test/fixtures/i2c-vectors/ds1307.json and ds3231.json. Project
 * i2c-model-fidelity-2026-09, P5 (decision O4): the tab's half of the proof
 * that one model stands in for both copies. The worker's half replays the same
 * files against the same .wasm (test/backend/unit/test_wasm_i2c_models.py).
 *
 * The models are hosted the way the parts host them
 * (simulation/parts/wasmI2cModels.ts): ChipRuntime, the chip's own I2C
 * device, the host's clock and the temperature pushed into the model's
 * memory, the build times as a live attribute.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DS1307_RULES,
  DS3231_RULES,
  VirtualDS1307,
  VirtualDS3231,
  type RtcOptions,
} from '../simulation/I2CBusManager';
import { ChipInstance } from '../simulation/customChips/ChipRuntime';
import { PinManager } from '../simulation/PinManager';
import { i2cTargetOf } from '../simulation/parts/i2cPart';
import {
  WasmDS1307,
  WasmDS3231,
  primeWasmI2cModel,
  resetWasmI2cModelsForTest,
  setWasmI2cModelsForTest,
  wasmI2cModelEnabled,
  wasmI2cModule,
} from '../simulation/parts/wasmI2cModels';
import { I2C_MODEL_WASM_B64 } from '../simulation/buses/models/i2cModelBytes.generated';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import {
  BUS_FLAVOURS,
  VectorClock,
  buildTime,
  loadVectors,
  replayVector,
  type BusVector,
  type BusVectorFile,
  type VectorHost,
} from './helpers/i2cVectors';

const models = (p: string) =>
  fileURLToPath(new URL(`../simulation/buses/models/${p}`, import.meta.url));
const wasmOf = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../public/bus-chips/${name}.wasm`, import.meta.url)));

type Rtc = WasmDS1307 | WasmDS3231 | VirtualDS1307 | VirtualDS3231;

interface Chip {
  name: 'ds1307' | 'ds3231';
  file: BusVectorFile;
  wasm: Buffer;
  module: WebAssembly.Module;
  make(module: WebAssembly.Module, o: RtcOptions): Rtc;
  wrapsAfter: number;
  rules: { power_on: Readonly<Record<number, number>> };
}

const chip = (
  name: Chip['name'],
  file: BusVectorFile,
  make: Chip['make'],
  wrapsAfter: number,
  rules: Chip['rules'],
): Chip => {
  const wasm = wasmOf(name);
  const module = new WebAssembly.Module(wasm);
  return { name, file, wasm, module, make, wrapsAfter, rules };
};

const CHIPS: Chip[] = [
  chip('ds1307', loadVectors('ds1307'), (m, o) => new WasmDS1307(m, o), 0x3f, DS1307_RULES),
  chip('ds3231', loadVectors('ds3231'), (m, o) => new WasmDS3231(m, o), 0x12, DS3231_RULES),
];

function powerOn(c: Chip, vector: BusVector): { dev: Rtc; clock: VectorClock } {
  const clock = new VectorClock(vector.clock ?? c.file.clock!);
  const built = (vector.build_times ?? c.file.build_times ?? []).map(buildTime);
  const dev = c.make(c.module, { clock: clock.read, buildTimes: () => built });
  if ('temperature' in c.file.inputs) (dev as WasmDS3231).temperatureC = c.file.inputs.temperature;
  return { dev, clock };
}

const setInputs = (dev: Rtc, values: Record<string, number>): void => {
  if ('temperature' in values) (dev as WasmDS3231).temperatureC = values.temperature;
};

/** On the fabric's target contract, as a board whose firmware runs in the tab reaches it. */
function fabricHost(dev: Rtc, clock: VectorClock): VectorHost {
  const target = i2cTargetOf(dev);
  return {
    start: (read) => target.start(dev.address, read),
    write: (byte) => target.write(byte),
    read: () => target.read(),
    stop: () => target.stop(),
    inputs: (values) => setInputs(dev, values),
    dump: () => target.dumpRegisters!(),
    clock: (step) => clock.step(step),
  };
}

/** A host that never says where a transfer begins (rtc-vectors.test.ts, bareHost). */
function bareHost(dev: Rtc, clock: VectorClock): VectorHost {
  return {
    start: (read) => {
      if (!read) dev.stop();
      return true;
    },
    write: (byte) => dev.writeByte(byte),
    read: () => dev.readByte(),
    stop: () => dev.stop(),
    inputs: (values) => setInputs(dev, values),
    dump: () => dev.dumpRegisters(),
    clock: (step) => clock.step(step),
  };
}

for (const c of CHIPS) {
  describe(`${c.name}.wasm: the artifact`, () => {
    it('was built from the sources next to it (buses/models/build.sh)', () => {
      const manifest = JSON.parse(readFileSync(models('manifest.json'), 'utf-8'));
      const sha = (p: string) => createHash('sha256').update(readFileSync(models(p))).digest('hex');
      expect(manifest[c.name].sourceSha256).toBe(sha(`${c.name}.c`));
      expect(manifest[c.name].includeSha256).toEqual({
        'i2c_host.h': sha('i2c_host.h'),
        'rtc.h': sha('rtc.h'),
      });
    });

    it('is the one the bundle carries', () => {
      expect(Buffer.from(I2C_MODEL_WASM_B64[c.name], 'base64').equals(c.wasm)).toBe(true);
    });

    it('powers on as the rules table says, before the tab hands the table over', () => {
      const raw = ChipInstance.createSync({ wasm: c.module, pinManager: new PinManager() });
      const at = (raw.exports.chip_power_on as () => number)();
      const table = new Uint8Array(raw.memory!.buffer, at, c.wrapsAfter + 1);
      const expected = new Uint8Array(c.wrapsAfter + 1);
      for (const [reg, value] of Object.entries(c.rules.power_on)) expected[Number(reg)] = value;
      expect(Array.from(table.slice(7))).toEqual(Array.from(expected.slice(7)));
      raw.dispose();
    });

    it('answers at the address of the vectors, and says where its pointer wraps', () => {
      const dev = c.make(c.module, {});
      expect(dev.address).toBe(parseInt(c.file.address, 16));
      expect(dev.pointerWrapsAfter).toBe(c.wrapsAfter);
      expect(i2cTargetOf(dev).pointerWrapsAfter).toBe(c.wrapsAfter);
    });
  });

  describe(`${c.name}.wasm: the bus vectors the two copies replay`, () => {
    for (const flavour of BUS_FLAVOURS) {
      for (const vector of c.file.vectors) {
        it(`[${flavour}] ${vector.name}`, () => {
          const { dev, clock } = powerOn(c, vector);
          replayVector(fabricHost(dev, clock), vector, flavour);
        });

        it(`[${flavour}, a host that hears no START] ${vector.name}`, () => {
          const { dev, clock } = powerOn(c, vector);
          replayVector(bareHost(dev, clock), vector, flavour);
        });
      }
    }
  });
}

describe('the hand-written clocks say where their pointer wraps too', () => {
  it('0x3F on the DS1307, 0x12 on the DS3231', () => {
    expect(new VirtualDS1307().pointerWrapsAfter).toBe(0x3f);
    expect(new VirtualDS3231().pointerWrapsAfter).toBe(0x12);
  });
});

describe('the compiled clocks: on by default, and the flag that turns them off', () => {
  afterEach(() => {
    setWasmI2cModelsForTest(null);
    resetWasmI2cModelsForTest();
    vi.unstubAllGlobals();
  });

  /** A board whose firmware runs in a QEMU worker: the part files a record. */
  const workerSim = () => ({
    registerSensor: vi.fn(),
    updateSensor: vi.fn(),
    unregisterSensor: vi.fn(),
  });
  const element = () =>
    ({ addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as HTMLElement;
  const attach = (type: string, sim: ReturnType<typeof workerSim>, id: string) =>
    PartSimulationRegistry.get(type)!.attachEvents!(element(), sim as never, () => null, id);

  it('both clocks run compiled unless the flag says otherwise', () => {
    expect(wasmI2cModelEnabled('ds1307')).toBe(true);
    expect(wasmI2cModelEnabled('ds3231')).toBe(true);
    // A chip with no compiled model (the MPU-6050 has one since P5 step 3).
    expect(wasmI2cModelEnabled('ssd1306')).toBe(false);
  });

  it('?i2cwasm=off turns every model off, and a list names the ones that stay', () => {
    const at = (search: string) => vi.stubGlobal('window', { location: { search } });
    at('?i2cwasm=off');
    expect(wasmI2cModelEnabled('ds3231')).toBe(false);
    expect(wasmI2cModelEnabled('ds1307')).toBe(false);
    at('?i2cwasm=ds3231');
    expect(wasmI2cModelEnabled('ds3231')).toBe(true);
    expect(wasmI2cModelEnabled('ds1307')).toBe(false);
    at('');
    expect(wasmI2cModelEnabled('ds1307')).toBe(true);
  });

  it('the bundle compiles both models', () => {
    for (const c of CHIPS) expect(wasmI2cModule(c.name)).toBeInstanceOf(WebAssembly.Module);
  });

  for (const c of CHIPS) {
    it(`${c.name}, on: the worker record carries the bytes the tab runs`, () => {
      const sim = workerSim();
      attach(c.name, sim, `${c.name}-wasm-on`)();
      const [type, , props] = sim.registerSensor.mock.calls[0];
      expect(type).toBe(c.name);
      expect(Buffer.from(props.wasmB64 as string, 'base64').equals(c.wasm)).toBe(true);
      expect(props).toMatchObject({ addr: 0x68, owner: `${c.name}-wasm-on` });
    });

    it(`${c.name}, off: the record carries no model, and the worker keeps its twin`, () => {
      setWasmI2cModelsForTest([]);
      const sim = workerSim();
      attach(c.name, sim, `${c.name}-wasm-off`)();
      const [, , props] = sim.registerSensor.mock.calls[0];
      expect(props).not.toHaveProperty('wasmB64');
    });

    it(`${c.name}: a model that cannot be built leaves the hand-written one, in both hosts`, () => {
      primeWasmI2cModel(c.name, null);
      const sim = workerSim();
      attach(c.name, sim, `${c.name}-wasm-broken`)();
      const [, , props] = sim.registerSensor.mock.calls[0];
      expect(props).not.toHaveProperty('wasmB64');
    });
  }

  it('the DS3231 part starts the model at the panel temperature', () => {
    const dev = new WasmDS3231(CHIPS[1].module, { clock: () => 0 });
    dev.temperatureC = 21.5;
    // 21.5 C is 86 quarters: 0x15, 0x80.
    expect(Array.from(dev.dumpRegisters().slice(0x11, 0x13))).toEqual([0x15, 0x80]);
  });
});
