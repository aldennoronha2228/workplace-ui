/**
 * The compiled BMP280 (simulation/buses/models/bmp280.c) against the bus
 * vectors the hand-written copies replay: test/fixtures/i2c-vectors/bmp280.json.
 * Project i2c-model-fidelity-2026-09, P5 step 2 (decision O4): the tab's half
 * of the proof that one model stands in for VirtualBMP280 and BMP280Slave. The
 * worker's half replays the same file against the same .wasm
 * (test/backend/unit/test_wasm_i2c_models.py).
 *
 * The model is hosted the way the part hosts it (WasmBMP280 in
 * simulation/parts/wasmI2cModels.ts): ChipRuntime, the chip's own I2C device,
 * the panel's values and the address pushed into the model's memory.
 * bmp280-vectors.test.ts replays the file against the part itself, which runs
 * this model by default.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BMP280_RULES, VirtualBMP280 } from '../simulation/I2CBusManager';
import { i2cTargetOf } from '../simulation/parts/i2cPart';
import {
  WasmBMP280,
  primeWasmI2cModel,
  resetWasmI2cModelsForTest,
  setWasmI2cModelsForTest,
  wasmI2cModelEnabled,
  wasmI2cModule,
} from '../simulation/parts/wasmI2cModels';
import { I2C_MODEL_WASM_B64 } from '../simulation/buses/models/i2cModelBytes.generated';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import { BUS_FLAVOURS, loadBusVectors, replayVector, type VectorHost } from './helpers/busVectors';

const VECTORS = loadBusVectors('bmp280.json');
const ADDR = parseInt(VECTORS.address, 16);

const models = (p: string) =>
  fileURLToPath(new URL(`../simulation/buses/models/${p}`, import.meta.url));
const WASM = readFileSync(fileURLToPath(new URL('../../public/bus-chips/bmp280.wasm', import.meta.url)));
const MODULE = new WebAssembly.Module(WASM);

function powerOn(address = ADDR): WasmBMP280 {
  const dev = new WasmBMP280(MODULE, address);
  dev.temperatureC = VECTORS.inputs.temperature;
  dev.pressureHPa = VECTORS.inputs.pressure;
  return dev;
}

const setInputs = (dev: WasmBMP280 | VirtualBMP280, values: Record<string, number>): void => {
  if ('temperature' in values) dev.temperatureC = values.temperature;
  if ('pressure' in values) dev.pressureHPa = values.pressure;
};

/** On the fabric's target contract, as a board whose firmware runs in the tab reaches it. */
function fabricHost(dev: WasmBMP280): VectorHost {
  const target = i2cTargetOf(dev);
  return {
    start: (read) => target.start(dev.address, read),
    write: (byte) => target.write(byte),
    read: () => target.read(),
    stop: () => target.stop(),
    inputs: (values) => setInputs(dev, values),
    dump: () => target.dumpRegisters!(),
  };
}

/** A host that never says where a read begins (bmp280-vectors.test.ts, bareHost). */
function bareHost(dev: WasmBMP280): VectorHost {
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
  };
}

describe('bmp280.wasm: the artifact', () => {
  it('was built from the sources next to it (buses/models/build.sh)', () => {
    const manifest = JSON.parse(readFileSync(models('manifest.json'), 'utf-8'));
    const sha = (p: string) => createHash('sha256').update(readFileSync(models(p))).digest('hex');
    expect(manifest.bmp280.sourceSha256).toBe(sha('bmp280.c'));
    expect(manifest.bmp280.includeSha256).toEqual({ 'i2c_host.h': sha('i2c_host.h') });
  });

  it('is the one the bundle carries', () => {
    expect(Buffer.from(I2C_MODEL_WASM_B64.bmp280, 'base64').equals(WASM)).toBe(true);
  });

  it('powers on as the rules table says, with the datasheet calibration', () => {
    const dump = powerOn().dumpRegisters();
    const reference = new VirtualBMP280(ADDR).dumpRegisters();
    for (const [reg, value] of Object.entries(BMP280_RULES.power_on)) {
      expect(dump[Number(reg)], `register 0x${Number(reg).toString(16)}`).toBe(value);
    }
    expect(Array.from(dump)).toEqual(Array.from(reference));
  });

  it('answers at the address the part gives it, and only 0x76 or 0x77', () => {
    expect(powerOn(0x76).address).toBe(0x76);
    expect(powerOn(0x77).address).toBe(0x77);
    expect(new WasmBMP280(MODULE, 0x42).address).toBe(0x76);
  });
});

describe('bmp280.wasm: the bus vectors the two copies replay', () => {
  for (const flavour of BUS_FLAVOURS) {
    for (const vector of VECTORS.vectors) {
      it(`[${flavour}] ${vector.name}`, () => {
        replayVector(fabricHost(powerOn()), vector, flavour);
      });

      it(`[${flavour}, a host that hears no START] ${vector.name}`, () => {
        replayVector(bareHost(powerOn()), vector, flavour);
      });
    }
  }
});

describe('bmp280.wasm: what the hand-written copy does besides the vectors', () => {
  const read = (dev: WasmBMP280 | VirtualBMP280, reg: number, n: number): number[] => {
    dev.start(false);
    dev.writeByte(reg);
    dev.start(true);
    const out = Array.from({ length: n }, () => dev.readByte());
    dev.stop();
    return out;
  };
  const write = (dev: WasmBMP280 | VirtualBMP280, reg: number, value: number) => {
    dev.start(false);
    dev.writeByte(reg);
    dev.writeByte(value);
    dev.stop();
  };

  it('encodes any panel value as VirtualBMP280 does', () => {
    for (const [t, p] of [
      [-40, 300],
      [0.005, 1100],
      [24.125, 1013.25],
      [85, 850.5],
      [-0.015, 999.99],
    ]) {
      const [a, b] = [powerOn(), new VirtualBMP280(ADDR)];
      for (const dev of [a, b]) {
        dev.temperatureC = t;
        dev.pressureHPa = p;
        write(dev, 0xf4, 0x27);
      }
      expect(read(a, 0xf7, 6), `${t} C, ${p} hPa`).toEqual(read(b, 0xf7, 6));
    }
  });

  it('tells the part once a run that it was read asleep, as VirtualBMP280 does', () => {
    const dev = powerOn();
    const heard = vi.fn();
    dev.onAsleepRead = heard;
    read(dev, 0xd0, 1);
    read(dev, 0x88, 24);
    expect(heard).not.toHaveBeenCalled();
    read(dev, 0xf7, 6);
    read(dev, 0xf7, 6);
    expect(heard).toHaveBeenCalledTimes(1);
    dev.boardReset();
    read(dev, 0xfa, 3);
    expect(heard).toHaveBeenCalledTimes(2);
    write(dev, 0xf4, 0x27);
    dev.boardReset();
    read(dev, 0xf7, 6);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe('the compiled BMP280: on by default, and the flag that turns it off', () => {
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
    ({ addEventListener: vi.fn(), removeEventListener: vi.fn(), ...props }) as unknown as HTMLElement;
  const attach = (sim: ReturnType<typeof workerSim>, id: string, props = {}) =>
    PartSimulationRegistry.get('bmp280')!.attachEvents!(element(props), sim as never, () => null, id);

  it('runs compiled unless the flag says otherwise', () => {
    expect(wasmI2cModelEnabled('bmp280')).toBe(true);
    vi.stubGlobal('window', { location: { search: '?i2cwasm=off' } });
    expect(wasmI2cModelEnabled('bmp280')).toBe(false);
    vi.stubGlobal('window', { location: { search: '?i2cwasm=ds3231' } });
    expect(wasmI2cModelEnabled('bmp280')).toBe(false);
    vi.stubGlobal('window', { location: { search: '?i2cwasm=bmp280' } });
    expect(wasmI2cModelEnabled('bmp280')).toBe(true);
  });

  it('the bundle compiles it', () => {
    expect(wasmI2cModule('bmp280')).toBeInstanceOf(WebAssembly.Module);
  });

  it('on: the worker record carries the bytes the tab runs, at the address of the part', () => {
    const sim = workerSim();
    attach(sim, 'bmp-wasm-on', { i2cAddress: '0x77', temperature: '31.5' })();
    const [type, , props] = sim.registerSensor.mock.calls[0];
    expect(type).toBe('bmp280');
    expect(Buffer.from(props.wasmB64 as string, 'base64').equals(WASM)).toBe(true);
    expect(props).toMatchObject({ addr: 0x77, temperature: 31.5, pressure: 1013.25 });
  });

  it('off: the record carries no model, and the worker keeps its twin', () => {
    setWasmI2cModelsForTest([]);
    const sim = workerSim();
    attach(sim, 'bmp-wasm-off')();
    const [, , props] = sim.registerSensor.mock.calls[0];
    expect(props).not.toHaveProperty('wasmB64');
  });

  it('a model that cannot be built leaves the hand-written one, in both hosts', () => {
    primeWasmI2cModel('bmp280', null);
    const sim = workerSim();
    attach(sim, 'bmp-wasm-broken')();
    const [, , props] = sim.registerSensor.mock.calls[0];
    expect(props).not.toHaveProperty('wasmB64');
  });
});
