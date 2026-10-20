/**
 * The parity gate of the shared I2C bus vectors (test/fixtures/i2c-vectors,
 * format in the README there; project i2c-model-fidelity-2026-09, P5).
 *
 * A chip Velxio models more than once (the tab model here, the backend twin
 * in backend/app/services/esp32_i2c_slaves.py, the copy the Raspberry Pi
 * relay mirrors from the tab's map) stays one chip only while every copy
 * replays the same vectors and works from the same rules table. This file
 * fails when that stops being true on the tab's side:
 *
 *  - a vector file has no tab model here, or no test that replays it;
 *  - a model's exported rules table is not the `rules` of its file;
 *  - the registers the model tells a mirroring host to ask for
 *    (volatileReads) or to keep its pointer on (pointerStays) are not the
 *    `volatile_reads` and `pointer_stays` of its file;
 *  - a chip that also runs as a compiled model (buses/models/, P5) has no
 *    test that replays the file against that model in both flavours, or the
 *    model powers on with registers the file's `power_on` does not say, or
 *    tells a mirroring host something else than the hand-written copy.
 *
 * test/backend/unit/test_i2c_vector_parity.py is the same gate for the
 * backend twins.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BMP280_RULES,
  DS1307_RULES,
  DS3231_RULES,
  VirtualBMP280,
  VirtualDS1307,
  VirtualDS3231,
  type I2CDevice,
} from '../simulation/I2CBusManager';
import { MPU6050_RULES, VirtualMPU6050 } from '../simulation/parts/ProtocolParts';
import { i2cTargetOf } from '../simulation/parts/i2cPart';
import {
  WasmBMP280,
  WasmDS1307,
  WasmDS3231,
  WasmMPU6050,
  wasmI2cModelEnabled,
  wasmI2cModule,
} from '../simulation/parts/wasmI2cModels';

const VECTOR_DIR = fileURLToPath(new URL('../../../test/fixtures/i2c-vectors/', import.meta.url));
const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const pairs = (o: Record<string | number, number>) =>
  Object.fromEntries(Object.entries(o).map(([reg, v]) => [hex(Number(reg)), hex(v)]));

/**
 * A rules table as the vectors write it: a table keyed by register has
 * hexadecimal keys and bytes, a list of pairs is inclusive register ranges
 * in hexadecimal, everything else is a plain number or list (the converter
 * of protocol-parts.test.ts).
 */
function genericRules(rules: object): Record<string, unknown> {
  const value = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      if (v.length > 0 && v.every(Array.isArray)) return v.map(([a, b]) => [hex(a), hex(b)]);
      return v.map(value);
    }
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v);
      if (entries.every(([k]) => /^\d+$/.test(k))) {
        return Object.fromEntries(entries.map(([k, x]) => [hex(Number(k)), hex(x as number)]));
      }
      return Object.fromEntries(entries.map(([k, x]) => [k, value(x)]));
    }
    return v;
  };
  return Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, value(v)]));
}

interface TabModel {
  /** The model's exported rules table, as the vector file writes it. */
  rules(): unknown;
  /** A model of the chip, as a part places it. */
  make(): I2CDevice;
  /** The test that replays every vector of the file against this model. */
  replayedBy: string;
}

/**
 * Every chip with a vector file, and its tab model. A new vector file fails
 * the gate until it has an entry here and a test that replays it.
 */
const TAB_MODELS: Record<string, TabModel> = {
  mpu6050: {
    rules: () => genericRules(MPU6050_RULES),
    make: () => new VirtualMPU6050(0x68),
    replayedBy: 'protocol-parts.test.ts',
  },
  bmp280: {
    rules: () => ({
      power_on: pairs(BMP280_RULES.power_on),
      writable: BMP280_RULES.writable.map(hex),
      reset: pairs(BMP280_RULES.reset),
      status: pairs(BMP280_RULES.status),
      mode: {
        register: hex(BMP280_RULES.mode.register),
        mask: hex(BMP280_RULES.mode.mask),
        sleep: hex(BMP280_RULES.mode.sleep),
        normal: hex(BMP280_RULES.mode.normal),
      },
      sample: BMP280_RULES.sample.map(hex),
    }),
    make: () => new VirtualBMP280(0x76),
    replayedBy: 'bmp280-vectors.test.ts',
  },
  ds1307: {
    rules: () => ({
      power_on: pairs(DS1307_RULES.power_on),
      write_mask: pairs(DS1307_RULES.write_mask),
      last_register: hex(DS1307_RULES.last_register),
    }),
    make: () => new VirtualDS1307(),
    replayedBy: 'rtc-vectors.test.ts',
  },
  ds3231: {
    rules: () => ({
      power_on: pairs(DS3231_RULES.power_on),
      write_mask: pairs(DS3231_RULES.write_mask),
      self_clearing: pairs(DS3231_RULES.self_clearing),
      write_zero_to_clear: pairs(DS3231_RULES.write_zero_to_clear),
      read_only: DS3231_RULES.read_only.map(([first, last]) => [hex(first), hex(last)]),
      last_register: hex(DS3231_RULES.last_register),
      temp_lsb_per_c: DS3231_RULES.temp_lsb_per_c,
    }),
    make: () => new VirtualDS3231(),
    replayedBy: 'rtc-vectors.test.ts',
  },
};

interface CompiledModel {
  /** The model as the part builds it, from the module the bundle carries. */
  make(module: WebAssembly.Module): I2CDevice;
  /** The test that replays every vector of the file against it. */
  replayedBy: string;
}

/**
 * The chips that also run as one compiled model in the tab and the worker
 * (buses/models/, project i2c-model-fidelity-2026-09, P5). A model the part
 * runs by default has to be here.
 */
const COMPILED_MODELS: Record<string, CompiledModel> = {
  bmp280: { make: (m) => new WasmBMP280(m, 0x76), replayedBy: 'bmp280-vectors-wasm.test.ts' },
  ds1307: { make: (m) => new WasmDS1307(m, { clock: () => 0 }), replayedBy: 'rtc-vectors-wasm.test.ts' },
  ds3231: { make: (m) => new WasmDS3231(m, { clock: () => 0 }), replayedBy: 'rtc-vectors-wasm.test.ts' },
  mpu6050: {
    make: (m) =>
      new WasmMPU6050(m, {
        address: 0x68,
        variant: 'mpu6050',
        volatileReads: registersOfRules(MPU6050_RULES.volatile_reads),
        pointerStays: registersOfRules(MPU6050_RULES.pointer_stays),
      }),
    replayedBy: 'mpu6050-vectors-wasm.test.ts',
  },
};

/** The registers of inclusive ranges of a rules table, as the part hands them to its model. */
function registersOfRules(ranges: readonly (readonly [number, number])[]): number[] {
  return ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
}

interface VectorFile {
  device: string;
  rules: Record<string, unknown>;
  vectors: unknown[];
}

const FILES: Array<[string, VectorFile]> = readdirSync(VECTOR_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => [name, JSON.parse(readFileSync(VECTOR_DIR + name, 'utf8')) as VectorFile]);

/** ["72", "74"] ranges of a rules table, as the register numbers they hold. */
function registersOf(ranges: unknown): number[] {
  if (ranges === undefined) return [];
  return (ranges as Array<[string, string]>).flatMap(([first, last]) => {
    const a = parseInt(first, 16);
    return Array.from({ length: parseInt(last, 16) - a + 1 }, (_, i) => a + i);
  });
}

/** The test loads this file and runs every vector of it in both bus flavours. */
function expectReplays(testFile: string, device: string): void {
  const source = readFileSync(TEST_DIR + testFile, 'utf8');
  // The test loads this very file...
  expect(source).toMatch(new RegExp(`(loadVectors\\(\\s*'${device}'|['/]${device}\\.json')`));
  // ...and runs every vector of it in both of the ways a repeated START arrives.
  expect(source).toMatch(/\.vectors\b/);
  const bothFlavours =
    /\bBUS_FLAVOURS\b/.test(source) ||
    (source.includes("'repeated-start'") && source.includes("'stop-start'"));
  expect(bothFlavours, 'replays in both bus flavours').toBe(true);
}

describe('i2c vector parity: the tab models', () => {
  it('finds the vector files', () => {
    expect(FILES.map(([name]) => name)).toEqual(
      expect.arrayContaining(['bmp280.json', 'ds1307.json', 'ds3231.json', 'mpu6050.json']),
    );
  });

  it('has a tab model for every vector file, named as the file names its chip', () => {
    for (const [name, file] of FILES) {
      expect(file.device, `${name} names its chip`).toBe(name.replace(/\.json$/, ''));
      expect(TAB_MODELS, `${name}: no tab model replays it`).toHaveProperty([file.device]);
    }
    for (const device of Object.keys(TAB_MODELS)) {
      expect(
        FILES.map(([, f]) => f.device),
        `${device} has a vector file`,
      ).toContain(device);
    }
  });

  for (const [name, file] of FILES) {
    const model = TAB_MODELS[file.device];
    if (!model) continue;

    describe(name, () => {
      it(`is replayed, every vector in both bus flavours, by ${model.replayedBy}`, () => {
        expectReplays(model.replayedBy, file.device);
      });

      it("holds the model's exported rules table to the file's", () => {
        expect(model.rules()).toEqual(file.rules);
      });

      it('tells a host that mirrors its registers what the file says to ask for', () => {
        const dev = model.make();
        expect(dev.dumpRegisters, 'a register file a host can mirror').toBeTypeOf('function');
        // What busTopology() publishes to the Raspberry Pi relay comes from the target.
        const target = i2cTargetOf(dev) as {
          volatileReads?: readonly number[];
          pointerStays?: readonly number[];
        };
        expect([...(target.volatileReads ?? [])]).toEqual(registersOf(file.rules.volatile_reads));
        expect([...(target.pointerStays ?? [])]).toEqual(registersOf(file.rules.pointer_stays));
      });
    });
  }
});

describe('i2c vector parity: the compiled models', () => {
  it('has an entry for every chip the parts run compiled by default', () => {
    for (const [, file] of FILES) {
      if (wasmI2cModelEnabled(file.device)) expect(COMPILED_MODELS).toHaveProperty([file.device]);
    }
    for (const device of Object.keys(COMPILED_MODELS)) {
      expect(FILES.map(([, f]) => f.device), `${device} has a vector file`).toContain(device);
    }
  });

  for (const [name, file] of FILES) {
    const compiled = COMPILED_MODELS[file.device];
    if (!compiled) continue;

    describe(name, () => {
      it(`is replayed against the compiled model, every vector in both flavours, by ${compiled.replayedBy}`, () => {
        expectReplays(compiled.replayedBy, file.device);
      });

      it("powers on with the registers of the file's power_on", () => {
        const module = wasmI2cModule(file.device);
        expect(module, 'the bundle carries the model').toBeInstanceOf(WebAssembly.Module);
        const dump = compiled.make(module!).dumpRegisters!();
        const powerOn = file.rules.power_on as Record<string, string>;
        for (const [reg, value] of Object.entries(powerOn)) {
          const r = parseInt(reg, 16);
          // The time of a clock chip is the host's, not a power-on value.
          if (file.device.startsWith('ds') && r < 7) continue;
          expect(hex(dump[r]), `register ${reg}`).toBe(value);
        }
      });

      it('tells a host that mirrors its registers what the hand-written copy tells it', () => {
        const model = compiled.make(wasmI2cModule(file.device)!);
        const copy = TAB_MODELS[file.device].make();
        const said = (dev: I2CDevice) => {
          const t = i2cTargetOf(dev) as {
            volatileReads?: readonly number[];
            pointerStays?: readonly number[];
            pointerWrapsAfter?: number;
          };
          return [[...(t.volatileReads ?? [])], [...(t.pointerStays ?? [])], t.pointerWrapsAfter];
        };
        expect(said(model)).toEqual(said(copy));
      });
    });
  }
});
