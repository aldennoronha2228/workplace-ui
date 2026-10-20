/**
 * bmp280-vectors.test.ts
 *
 * The BMP280 of the tab against the bus vectors it shares with the worker's
 * copy (test/fixtures/i2c-vectors/bmp280.json, format in the README next to
 * it; project i2c-model-fidelity-2026-09). The Python twin replays the same
 * file in test/backend/unit/test_i2c_slaves.py, so the two cannot drift.
 *
 * Every vector runs against the part on the bus fabric, which is how a board
 * whose firmware runs in the tab reaches it, and against the model alone
 * under a host that never says where a read begins, and in both of the ways
 * a repeated START is delivered.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import { BMP280_RULES, VirtualBMP280 } from '../simulation/I2CBusManager';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { SENSOR_CONTROLS } from '../simulation/sensorControlConfig';
import { busRegistry } from '../simulation/buses';
import type {
  BusDiagnostic,
  I2cControllerPort,
  I2cTransactionHandler,
  NetResolver,
} from '../simulation/buses';
import {
  BUS_FLAVOURS,
  hexText,
  loadBusVectors,
  replayVector,
  type VectorHost,
} from './helpers/busVectors';

const VECTORS = loadBusVectors('bmp280.json');
const ADDR = parseInt(VECTORS.address, 16);

const BOARD = 'rig-board';
const SDA = 18;
const SCL = 19;
const PART = 'bmp';

afterEach(() => {
  busRegistry.clear();
});

/** One board with one I2C controller on SDA 18 / SCL 19, the part wired to it. */
function rig(): { bus: () => I2cTransactionHandler; reset: () => void } {
  let handler: I2cTransactionHandler | null = null;
  let onReset: (() => void) | null = null;
  const port: I2cControllerPort = {
    bus: 'i2c',
    unit: 0,
    name: 'TWI',
    setTransactionHandler(h) {
      handler = h;
    },
    routing: () => ({ sda: SDA, scl: SCL }),
  };
  const resolver: NetResolver = {
    resolve(ref) {
      if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
      if (ref.componentId !== PART) return { kind: 'floating' };
      if (ref.pinName === 'SDA') return { kind: 'board', boardId: BOARD, pin: SDA };
      if (ref.pinName === 'SCL') return { kind: 'board', boardId: BOARD, pin: SCL };
      return { kind: 'floating' };
    },
    boardKind: () => 'arduino-uno',
    boards: () => [BOARD],
  };
  busRegistry.setResolver(resolver);
  busRegistry.bindEngine(BOARD, {
    pins: { onPinChange: () => () => {}, peekPinState: () => undefined },
    spi: [],
    i2c: [port],
    setResetHandler: (h) => {
      onReset = h;
    },
  });
  return { bus: () => handler!, reset: () => onReset?.() };
}

function attachPart(props: Record<string, unknown> = {}): () => void {
  const element = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    ...props,
  } as unknown as HTMLElement;
  const simulator = {
    pinManager: { onPinChange: vi.fn().mockReturnValue(() => {}) },
    setPinState: vi.fn(),
  };
  return PartSimulationRegistry.get('bmp280')!.attachEvents!(
    element,
    simulator as never,
    () => null,
    PART,
  );
}

/** The part on the rig's bus, as a board whose firmware runs in the tab reaches it. */
function partHost(bus: I2cTransactionHandler, address = ADDR): VectorHost {
  return {
    start: (read) => bus.start(address, read),
    write: (byte) => bus.write(byte),
    read: () => bus.read(),
    stop: () => bus.stop(),
    inputs: (values) => dispatchSensorUpdate(PART, values),
    dump: () => {
      const target = busRegistry.fabric(BOARD).i2cBuses.get(SDA)!.targetsAt(address)[0].target;
      return (target as { dumpRegisters?: () => Uint8Array }).dumpRegisters!();
    },
  };
}

/**
 * The model alone, under a host that never says where a read begins: it
 * clears the pointer flag on a START for writing and that is all it knows
 * (the overlay's PartI2cTarget).
 */
function bareHost(dev: VirtualBMP280): VectorHost {
  return {
    start: (read) => {
      if (!read) dev.stop();
      return true;
    },
    write: (byte) => dev.writeByte(byte),
    read: () => dev.readByte(),
    stop: () => dev.stop(),
    inputs: (values) => {
      if ('temperature' in values) dev.temperatureC = values.temperature;
      if ('pressure' in values) dev.pressureHPa = values.pressure;
    },
    dump: () => dev.dumpRegisters(),
  };
}

describe('bmp280 — the rules table', () => {
  it('is the table the shared vectors carry', () => {
    const hex = (n: number) => hexText([n]);
    const pairs = (o: Record<string, number>) =>
      Object.fromEntries(Object.entries(o).map(([reg, v]) => [hex(Number(reg)), hex(v)]));
    expect({
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
    }).toEqual(VECTORS.rules);
  });

  it('starts every vector from the values the panel starts from', () => {
    expect(VECTORS.inputs).toEqual(SENSOR_CONTROLS.bmp280.defaultValues);
    const dev = new VirtualBMP280(ADDR);
    expect({ temperature: dev.temperatureC, pressure: dev.pressureHPa }).toEqual(VECTORS.inputs);
  });

  it('is the format the runner reads', () => {
    expect(VECTORS.format).toBe(1);
    expect(VECTORS.device).toBe('bmp280');
    expect(VECTORS.vectors.length).toBeGreaterThanOrEqual(22);
  });
});

describe('bmp280 — shared bus vectors', () => {
  const named = VECTORS.vectors.map((v) => [v.name, v] as const);

  describe.each(BUS_FLAVOURS)('the part on the bus fabric, %s', (flavour) => {
    it.each(named)('%s', (_name, vector) => {
      const { bus } = rig();
      attachPart();
      const host = partHost(bus());
      host.inputs(VECTORS.inputs);
      replayVector(host, vector, flavour);
    });
  });

  describe.each(BUS_FLAVOURS)('the part at 0x77, as the Grove BMP280 sets it, %s', (flavour) => {
    it.each(named)('%s', (_name, vector) => {
      const { bus } = rig();
      attachPart({ i2cAddress: '0x77' });
      const host = partHost(bus(), 0x77);
      host.inputs(VECTORS.inputs);
      replayVector(host, vector, flavour);
    });
  });

  describe.each(BUS_FLAVOURS)(
    'the model under a host that does not announce START, %s',
    (flavour) => {
      it.each(named)('%s', (_name, vector) => {
        const host = bareHost(new VirtualBMP280(ADDR));
        host.inputs(VECTORS.inputs);
        replayVector(host, vector, flavour);
      });
    },
  );
});

describe('bmp280 — what the part starts from', () => {
  const DATA = 0xf7;
  const readData = (bus: I2cTransactionHandler): number[] => {
    bus.start(ADDR, false);
    bus.write(DATA);
    bus.start(ADDR, true);
    const out = Array.from({ length: 6 }, () => bus.read());
    bus.stop();
    return out;
  };
  const normalMode = (bus: I2cTransactionHandler) => {
    bus.start(ADDR, false);
    bus.write(0xf4);
    bus.write(0x27);
    bus.stop();
  };
  const encoded = (temperature: number, pressure: number): number[] => {
    const dev = new VirtualBMP280();
    dev.temperatureC = temperature;
    dev.pressureHPa = pressure;
    dev.writeByte(0xf4);
    dev.writeByte(0x27);
    return Array.from(dev.dumpRegisters().slice(DATA, DATA + 6));
  };

  it('the values of the element, once the sketch selects a mode', () => {
    const { bus } = rig();
    attachPart({ temperature: '31.5', pressure: '990' });
    expect(readData(bus())).toEqual([0x80, 0, 0, 0x80, 0, 0]);
    normalMode(bus());
    expect(readData(bus())).toEqual(encoded(31.5, 990));
  });

  it("the panel's own when the element says nothing", () => {
    const { bus } = rig();
    attachPart();
    normalMode(bus());
    expect(readData(bus())).toEqual(encoded(24, 1013.25));
  });
});

describe('bmp280 — read before it ever measured', () => {
  const NOTE =
    'BMP280 0x76 is in sleep mode and has not measured: write the mode to ctrl_meas (0xF4), 0x27 for normal mode';

  const listeners: Array<() => void> = [];
  afterEach(() => {
    for (const off of listeners.splice(0)) off();
  });

  function listen(): BusDiagnostic[] {
    const heard: BusDiagnostic[] = [];
    listeners.push(
      busRegistry.onDiagnostic((d) => {
        if (d.code === 'i2c-target-asleep') heard.push(d);
      }),
    );
    return heard;
  }

  const read = (bus: I2cTransactionHandler, reg: number, n: number, address = ADDR): number[] => {
    bus.start(address, false);
    bus.write(reg);
    bus.start(address, true);
    const out = Array.from({ length: n }, () => bus.read());
    bus.stop();
    return out;
  };
  const write = (bus: I2cTransactionHandler, reg: number, value: number) => {
    bus.start(ADDR, false);
    bus.write(reg);
    bus.write(value);
    bus.stop();
  };

  it('the first read of the data registers tells the monitor of its board, and only the first', () => {
    const { bus } = rig();
    attachPart();
    const heard = listen();
    read(bus(), 0xf7, 6);
    expect(heard).toEqual([
      { code: 'i2c-target-asleep', bus: 'i2c', boardId: BOARD, owners: [PART], message: NOTE },
    ]);
    read(bus(), 0xfa, 3);
    read(bus(), 0xf7, 6);
    expect(heard).toHaveLength(1);
  });

  it('the id, the calibration, status and the control registers can be read in silence', () => {
    const { bus } = rig();
    attachPart();
    const heard = listen();
    read(bus(), 0xd0, 1);
    read(bus(), 0x88, 24);
    read(bus(), 0xf3, 3);
    expect(heard).toEqual([]);
  });

  it('a sketch that selects normal mode first never hears it', () => {
    const { bus } = rig();
    attachPart();
    const heard = listen();
    write(bus(), 0xf4, 0x27);
    read(bus(), 0xf7, 6);
    expect(heard).toEqual([]);
  });

  it('nor one that reads what a forced measurement left', () => {
    const { bus } = rig();
    attachPart();
    const heard = listen();
    write(bus(), 0xf4, 0x25);
    expect(read(bus(), 0xf4, 1)).toEqual([0x24]);
    read(bus(), 0xf7, 6);
    expect(heard).toEqual([]);
  });

  it('a soft reset puts the chip back where a read says it', () => {
    const { bus } = rig();
    attachPart();
    const heard = listen();
    write(bus(), 0xf4, 0x27);
    read(bus(), 0xf7, 6);
    write(bus(), 0xe0, 0xb6);
    read(bus(), 0xf7, 6);
    expect(heard).toHaveLength(1);
  });

  it('names the address the chip is at', () => {
    const { bus } = rig();
    attachPart({ i2cAddress: '0x77' });
    const heard = listen();
    read(bus(), 0xf7, 6, 0x77);
    expect(heard.map((d) => d.message)).toEqual([NOTE.replace('0x76', '0x77')]);
  });

  it('the next run is told again: an MCU reset leaves the chip powered, and as it was', () => {
    const r = rig();
    attachPart();
    const heard = listen();
    write(r.bus(), 0xf5, 0x90);
    read(r.bus(), 0xf7, 6);
    r.reset();
    expect(read(r.bus(), 0xf5, 1), 'the MCU reset is not a power cycle').toEqual([0x90]);
    read(r.bus(), 0xf7, 6);
    read(r.bus(), 0xf7, 6);
    expect(heard).toHaveLength(2);
  });

  it('a copy taken for a host that mirrors the registers is not a read', () => {
    const { bus } = rig();
    attachPart();
    const heard = listen();
    partHost(bus()).dump!();
    expect(heard).toEqual([]);
  });
});
