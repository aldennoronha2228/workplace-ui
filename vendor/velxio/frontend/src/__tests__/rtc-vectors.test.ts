/**
 * The DS1307 and the DS3231 against the bus vectors they share with their
 * backend twins: test/fixtures/i2c-vectors/ds1307.json and ds3231.json, format
 * in the README next to them. The Python twins replay the same files
 * (test/backend/unit/test_i2c_slaves.py), so the two copies of each chip
 * cannot drift apart.
 *
 * Every vector runs on a clock the vector moves by hand. Nothing here reads
 * the time of the machine that runs the test.
 */
import { describe, it, expect } from 'vitest';
import {
  DS1307_RULES,
  DS3231_RULES,
  VirtualDS1307,
  VirtualDS3231,
  type I2CDevice,
  type RtcOptions,
} from '../simulation/I2CBusManager';
import { i2cTargetOf } from '../simulation/parts/i2cPart';
import { SENSOR_CONTROLS } from '../simulation/sensorControlConfig';
import {
  BUS_FLAVOURS,
  VectorClock,
  buildTime,
  hexText,
  loadVectors,
  replayVector,
  type BusVector,
  type BusVectorFile,
  type VectorHost,
} from './helpers/i2cVectors';

type Rtc = I2CDevice & { dumpRegisters(): Uint8Array; temperatureC?: number };

interface Chip {
  file: BusVectorFile;
  make(options: RtcOptions): Rtc;
}

const CHIPS: Record<string, Chip> = {
  ds1307: { file: loadVectors('ds1307'), make: (o) => new VirtualDS1307(o) },
  ds3231: { file: loadVectors('ds3231'), make: (o) => new VirtualDS3231(o) },
};

/** A chip that has just been powered on, under the clock and the firmware of the vector. */
function powerOn(chip: Chip, vector: BusVector): { dev: Rtc; clock: VectorClock } {
  const clock = new VectorClock(vector.clock ?? chip.file.clock!);
  const built = (vector.build_times ?? chip.file.build_times ?? []).map(buildTime);
  const dev = chip.make({ clock: clock.read, buildTimes: () => built });
  if ('temperature' in chip.file.inputs) dev.temperatureC = chip.file.inputs.temperature;
  return { dev, clock };
}

const setInputs = (dev: Rtc, values: Record<string, number>): void => {
  if ('temperature' in values) dev.temperatureC = values.temperature;
};

/** The model on the fabric's target contract, as a board whose firmware runs in the tab reaches it. */
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

/**
 * The model alone, under a host that never says where a transfer begins: it
 * clears the pointer flag on a START for writing and that is all it knows
 * (the overlay's PartI2cTarget). The model then takes the first byte after a
 * STOP, and the first byte read after a write, as the start of a transfer.
 */
function bareHost(dev: Rtc, clock: VectorClock): VectorHost {
  return {
    start: (read) => {
      if (!read) dev.stop?.();
      return true;
    },
    write: (byte) => dev.writeByte(byte),
    read: () => dev.readByte(),
    stop: () => dev.stop?.(),
    inputs: (values) => setInputs(dev, values),
    dump: () => dev.dumpRegisters(),
    clock: (step) => clock.step(step),
  };
}

const hex = (n: number) => hexText([n]);
const pairs = (o: Record<number, number>) =>
  Object.fromEntries(Object.entries(o).map(([reg, v]) => [hex(Number(reg)), hex(v)]));

describe('ds1307 and ds3231: the rules tables', () => {
  it('ds1307: is the table the shared vectors carry', () => {
    expect({
      power_on: pairs(DS1307_RULES.power_on),
      write_mask: pairs(DS1307_RULES.write_mask),
      last_register: hex(DS1307_RULES.last_register),
    }).toEqual(CHIPS.ds1307.file.rules);
  });

  it('ds3231: is the table the shared vectors carry', () => {
    expect({
      power_on: pairs(DS3231_RULES.power_on),
      write_mask: pairs(DS3231_RULES.write_mask),
      self_clearing: pairs(DS3231_RULES.self_clearing),
      write_zero_to_clear: pairs(DS3231_RULES.write_zero_to_clear),
      read_only: DS3231_RULES.read_only.map(([first, last]) => [hex(first), hex(last)]),
      last_register: hex(DS3231_RULES.last_register),
      temp_lsb_per_c: DS3231_RULES.temp_lsb_per_c,
    }).toEqual(CHIPS.ds3231.file.rules);
  });

  it('ds3231: starts every vector from the temperature the panel starts from', () => {
    expect(CHIPS.ds3231.file.inputs).toEqual(SENSOR_CONTROLS.ds3231.defaultValues);
    expect(new VirtualDS3231().temperatureC).toBe(CHIPS.ds3231.file.inputs.temperature);
  });
});

for (const [name, chip] of Object.entries(CHIPS)) {
  describe(`${name}: the bus vectors it shares with the backend twin`, () => {
    it('answers at the address of the vectors', () => {
      expect(chip.make({}).address).toBe(parseInt(chip.file.address, 16));
    });

    for (const flavour of BUS_FLAVOURS) {
      for (const vector of chip.file.vectors) {
        it(`[${flavour}] ${vector.name}`, () => {
          const { dev, clock } = powerOn(chip, vector);
          replayVector(fabricHost(dev, clock), vector, flavour);
        });

        it(`[${flavour}, a host that hears no START] ${vector.name}`, () => {
          const { dev, clock } = powerOn(chip, vector);
          replayVector(bareHost(dev, clock), vector, flavour);
        });
      }
    }
  });
}
