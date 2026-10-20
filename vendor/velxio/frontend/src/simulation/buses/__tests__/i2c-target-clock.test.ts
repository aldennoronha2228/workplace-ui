/**
 * The guest clock on the I2C target contract (project
 * i2c-model-fidelity-2026-09, decision O1).
 *
 * A chip that does something between two transactions (the MPU-6050 takes a
 * sample every period) needs the time of the board it is wired to. The
 * registry hands it the fabric's clock when it places the chip on a bus, and
 * takes it back when the chip leaves:
 *
 *  - the clock is the one of the board the chip's SDA and SCL reach;
 *  - it reads the engine bound at the moment of the call, so a chip placed
 *    before the engine binds, or kept across a new Run, is never left with
 *    the clock of a binding that is gone;
 *  - a board with no clock answers clockHz() 0, which is "no time";
 *  - a register-file part (`I2CDevice`) gets it through `i2cTargetOf`.
 *
 * Fake circuit and fake ports with the real contracts; no engine.
 */
import { describe, it, expect } from 'vitest';
import { BusRegistry } from '../registry';
import { i2cTargetOf } from '../../parts/i2cPart';
import type { I2CDevice } from '../../I2CBusManager';
import type {
  BoardPins,
  GuestClock,
  I2cControllerPort,
  I2cTarget,
  I2cTransactionHandler,
  NetResolver,
  PinRef,
  ResolvedPin,
} from '../types';

const PINS: BoardPins = {
  onPinChange: () => () => {},
  peekPinState: () => undefined,
  driveInput: () => {},
};

function port(sda: number, scl: number): I2cControllerPort {
  return {
    bus: 'i2c',
    unit: 0,
    name: 'I2C0',
    setTransactionHandler(_h: I2cTransactionHandler | null) {},
    routing: () => ({ sda, scl }),
  };
}

class Circuit implements NetResolver {
  nets = new Map<string, ResolvedPin>();
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    return this.nets.get(`${ref.componentId}:${ref.pinName}`) ?? { kind: 'floating' };
  }
  boardKind(): string | undefined {
    return undefined;
  }
  boards(): string[] {
    return ['a', 'b'];
  }
  wire(comp: string, boardId: string | null, sda = 21, scl = 22): void {
    const at = (pin: number): ResolvedPin =>
      boardId === null ? { kind: 'floating' } : { kind: 'board', boardId, pin };
    this.nets.set(`${comp}:SDA`, at(sda));
    this.nets.set(`${comp}:SCL`, at(scl));
  }
}

/** A clock a test moves by hand: 16 MHz, like an Uno. */
class Clock implements GuestClock {
  cycles = 0;
  readonly hz: number;
  readonly edges: Array<[number, boolean, number]> = [];
  readonly timers: Array<{ at: number; cb: () => void }> = [];
  constructor(hz = 16_000_000) {
    this.hz = hz;
  }
  now(): number {
    return this.cycles;
  }
  clockHz(): number {
    return this.hz;
  }
  scheduleEdge(pin: number, level: boolean, atCycle: number): void {
    this.edges.push([pin, level, atCycle]);
  }
  at(atCycle: number, cb: () => void): () => void {
    const timer = { at: atCycle, cb };
    this.timers.push(timer);
    return () => {
      const i = this.timers.indexOf(timer);
      if (i >= 0) this.timers.splice(i, 1);
    };
  }
}

function chip() {
  const clocks: Array<GuestClock | null> = [];
  const target: I2cTarget = {
    start: () => true,
    write: () => true,
    read: () => 0x42,
    stop: () => {},
    setClock: (clock) => {
      clocks.push(clock);
    },
  };
  return { target, clocks, last: () => clocks[clocks.length - 1] };
}

function rig() {
  const reg = new BusRegistry();
  const circuit = new Circuit();
  reg.setResolver(circuit);
  const attach = (owner: string, target: I2cTarget) =>
    reg.attachI2c({ owner, pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x68] }, target);
  return { reg, circuit, attach };
}

describe('the guest clock on the I2C target contract', () => {
  it('a chip placed on a bus is handed the clock of that board', () => {
    const r = rig();
    const clockA = new Clock();
    const clockB = new Clock(80_000_000);
    r.reg.bindEngine('a', { pins: PINS, spi: [], i2c: [port(21, 22)], clock: clockA });
    r.reg.bindEngine('b', { pins: PINS, spi: [], i2c: [port(21, 22)], clock: clockB });
    r.circuit.wire('imu', 'b');
    const c = chip();
    r.attach('imu', c.target);

    clockA.cycles = 5;
    clockB.cycles = 1234;
    expect(c.clocks).toHaveLength(1);
    expect(c.last()!.now()).toBe(1234);
    expect(c.last()!.clockHz()).toBe(80_000_000);
  });

  it('a chip placed before the engine binds reads the engine that binds later', () => {
    const r = rig();
    r.circuit.wire('imu', 'a');
    const c = chip();
    r.attach('imu', c.target);
    const clock = c.last()!;
    expect(clock.clockHz(), 'no engine, no time').toBe(0);
    expect(clock.now()).toBe(0);

    const first = new Clock();
    first.cycles = 100;
    r.reg.bindEngine('a', { pins: PINS, spi: [], i2c: [port(21, 22)], clock: first });
    expect([clock.now(), clock.clockHz()]).toEqual([100, 16_000_000]);

    // The next Run binds again: the same object reads the new engine.
    const second = new Clock(8_000_000);
    second.cycles = 7;
    r.reg.bindEngine('a', { pins: PINS, spi: [], i2c: [port(21, 22)], clock: second });
    expect([clock.now(), clock.clockHz()]).toEqual([7, 8_000_000]);
    expect(c.clocks, 'handed over once').toHaveLength(1);
  });

  it('timers and edges go to the engine bound when they are asked for', () => {
    const r = rig();
    const engine = new Clock();
    r.reg.bindEngine('a', { pins: PINS, spi: [], i2c: [port(21, 22)], clock: engine });
    r.circuit.wire('imu', 'a');
    const c = chip();
    r.attach('imu', c.target);

    const fired: string[] = [];
    const cancel = c.last()!.at(800, () => fired.push('sample'));
    c.last()!.scheduleEdge(2, true, 800);
    expect(engine.timers.map((t) => t.at)).toEqual([800]);
    expect(engine.edges).toEqual([[2, true, 800]]);
    engine.timers[0].cb();
    expect(fired).toEqual(['sample']);
    cancel();
    expect(engine.timers).toEqual([]);
  });

  it('an engine that offers no clock is a board with no time', () => {
    const r = rig();
    r.reg.bindEngine('a', { pins: PINS, spi: [], i2c: [port(21, 22)] });
    r.circuit.wire('imu', 'a');
    const c = chip();
    r.attach('imu', c.target);
    expect(c.last()!.clockHz()).toBe(0);
    // Nothing to run a timer on: the cancel is still a function.
    expect(() => c.last()!.at(10, () => {})()).not.toThrow();
  });

  it('the clock is taken back when the chip leaves its bus, and follows it to another board', () => {
    const r = rig();
    const clockA = new Clock();
    const clockB = new Clock(80_000_000);
    r.reg.bindEngine('a', { pins: PINS, spi: [], i2c: [port(21, 22)], clock: clockA });
    r.reg.bindEngine('b', { pins: PINS, spi: [], i2c: [port(21, 22)], clock: clockB });
    r.circuit.wire('imu', 'a');
    const c = chip();
    const handle = r.attach('imu', c.target);
    expect(c.last()!.clockHz()).toBe(16_000_000);

    // The wires move to the other board.
    r.circuit.wire('imu', 'b');
    r.reg.netlistChanged();
    expect(c.last()!.clockHz()).toBe(80_000_000);
    expect(c.clocks.slice(0, -1).pop(), 'taken back in between').toBeNull();

    // Unwired: on no bus, no clock.
    r.circuit.wire('imu', null);
    r.reg.netlistChanged();
    expect(c.last()).toBeNull();

    handle.dispose();
    expect(c.last()).toBeNull();
  });

  it('a register-file part hears it through i2cTargetOf, and only if it asks', () => {
    const r = rig();
    const engine = new Clock();
    engine.cycles = 32_000;
    r.reg.bindEngine('a', { pins: PINS, spi: [], i2c: [port(21, 22)], clock: engine });

    let held: GuestClock | null = null;
    const keepsTime: I2CDevice = {
      address: 0x68,
      writeByte: () => true,
      readByte: () => 0,
      setClock: (clock) => {
        held = clock;
      },
    };
    r.circuit.wire('imu', 'a');
    r.attach('imu', i2cTargetOf(keepsTime));
    expect(held!.now()).toBe(32_000);

    const plain: I2CDevice = { address: 0x3c, writeByte: () => true, readByte: () => 0 };
    expect(i2cTargetOf(plain).setClock).toBeUndefined();
  });
});
