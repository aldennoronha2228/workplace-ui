/**
 * The membrane keypad model (models/matrix-keypad.ts): the circuit rules on
 * their own, then the model hosted by the real avr8js and rp2040js engines,
 * driven at the register level in both scan orders. The order that matters
 * most is the Keypad library's (issue #327): rows INPUT_PULLUP, each column
 * driven LOW in turn, rows read back.
 */
import { describe, expect, it, vi } from 'vitest';
import { RP2040 } from 'rp2040js';
import { AVRSimulator } from '../../AVRSimulator';
import { RP2040Simulator } from '../../RP2040Simulator';
import { PinManager } from '../../PinManager';
import { createLineModel, framesOf } from '../lineModels';
import { INITIAL_PAD, type PadEvent } from '../padEvent';
import { solveKeypad, type WirePad } from '../models/matrix-keypad';
import { requestLine, type LineLease } from '../requestLine';
import '../index';

vi.stubGlobal('requestAnimationFrame', () => 1);
vi.stubGlobal('cancelAnimationFrame', () => {});

const ROWS = [9, 8, 7, 6];
const COLS = [5, 4, 3, 2];

const pad = (drive: WirePad['drive'], pull: WirePad['pull'] = 0): WirePad => ({
  drive,
  pull,
  level: drive !== 'low',
});
const padsOf = (m: Record<number, WirePad>) => (pin: number) => m[pin] ?? pad('z', 1);

describe('matrix keypad: the circuit', () => {
  it('a column driven low pulls the row of a held key, and only that row', () => {
    const out = solveKeypad(ROWS, COLS, [[2, 2]], padsOf({ [COLS[2]]: pad('low') }));
    expect(out.get(ROWS[2])).toBe('low');
    for (const r of [0, 1, 3]) expect(out.get(ROWS[r])).toBe('free');
    expect(out.get(COLS[2])).toBe('free'); // the guest drives it
  });

  it('a row driven low pulls the column of a held key (the other scan order)', () => {
    const out = solveKeypad(ROWS, COLS, [[3, 0]], padsOf({ [ROWS[3]]: pad('low') }));
    expect(out.get(COLS[0])).toBe('low');
    expect(out.get(ROWS[3])).toBe('free');
  });

  it('with no key held every wire is left alone', () => {
    const out = solveKeypad(ROWS, COLS, [], padsOf({ [COLS[0]]: pad('low') }));
    for (const v of out.values()) expect(v).toBe('free');
  });

  it('a driven high reaches a released wire, and low beats high in one group', () => {
    const high = solveKeypad(ROWS, COLS, [[0, 0]], padsOf({ [COLS[0]]: pad('high') }));
    expect(high.get(ROWS[0])).toBe('high');
    const fight = solveKeypad(
      ROWS,
      COLS,
      [
        [0, 0],
        [0, 1],
      ],
      padsOf({ [COLS[0]]: pad('high'), [COLS[1]]: pad('low') }),
    );
    expect(fight.get(ROWS[0])).toBe('low');
  });

  it('ghosting: three corners of a rectangle held make the fourth read as held', () => {
    const held: Array<[number, number]> = [
      [0, 0],
      [0, 1],
      [1, 0],
    ];
    const out = solveKeypad(ROWS, COLS, held, padsOf({ [COLS[1]]: pad('low') }));
    expect(out.get(ROWS[0])).toBe('low');
    expect(out.get(ROWS[1])).toBe('low'); // C1 -> R0 -> C0 -> R1
  });

  it('the first event of a run puts nothing on a wire that is already at rest', () => {
    // Eight no-op frames at one cycle is not a tidiness problem: the engines'
    // edge heaps are not stable for equal cycles, so a real decision taken in
    // the same cycle could be applied before one of the no-ops and then
    // overwritten by it. That is what made the first pass of a scan miss the
    // key on all six in-browser ESP32 engines while the second pass saw it.
    const m = createLineModel({
      sensor_type: 'matrix-keypad',
      pin: ROWS[0],
      rows: ROWS,
      cols: COLS,
      pressed: [],
    })!;
    const clock = { now: () => 1000, us: (n: number) => n * 16 };
    const pullUp: PadEvent = {
      pin: ROWS[0],
      drive: 'z',
      pull: 1,
      level: true,
      cycle: 1000,
      prev: INITIAL_PAD,
    };
    expect(framesOf(m.onPad(pullUp, clock))).toEqual([]);

    // And the decision that follows is one frame, on one wire, alone.
    const driveLow: PadEvent = {
      pin: COLS[0],
      drive: 'low',
      pull: 0,
      level: false,
      cycle: 1000,
      prev: INITIAL_PAD,
    };
    m.update({ pressed: [[0, 0]] }, clock);
    const frames = framesOf(m.onPad(driveLow, clock));
    expect(frames.map((f) => f.pin)).toEqual([ROWS[0], COLS[0]]);
    expect(frames[0].edges).toEqual([{ level: false, atCycle: 1000 }]);
  });

  it('two decisions on one wire in the same cycle are ordered, and a release follows its level', () => {
    // A pinMode and the digitalWrite after it can land in the same cycle on an
    // engine whose clock does not move between two register writes. The second
    // decision has to win, and a release must never be applied before the
    // level it releases.
    const m = createLineModel({
      sensor_type: 'matrix-keypad',
      pin: ROWS[0],
      rows: ROWS,
      cols: COLS,
      pressed: [[0, 0]],
    })!;
    const clock = { now: () => 500, us: (n: number) => n * 16 };
    const low = framesOf(
      m.onPad(
        { pin: COLS[0], drive: 'low', pull: 0, level: false, cycle: 500, prev: INITIAL_PAD },
        clock,
      ),
    );
    const rowFrame = low.find((f) => f.pin === ROWS[0])!;
    expect(rowFrame.edges[0].atCycle).toBe(500);
    const released = framesOf(
      m.onPad(
        {
          pin: COLS[0],
          drive: 'z',
          pull: 1,
          level: true,
          cycle: 500,
          prev: { drive: 'low', pull: 0, level: false, cycle: 500 },
        },
        clock,
      ),
    );
    const rowAfter = released.find((f) => f.pin === ROWS[0])!;
    expect(rowAfter.edges[0].atCycle).toBeGreaterThan(rowFrame.edges[0].atCycle);
    expect(rowAfter.releaseAtCycle).toBeGreaterThan(rowAfter.edges[0].atCycle);
  });

  it('an unwired row or column is skipped, never treated as pin -1', () => {
    const out = solveKeypad([9, -1, 7, 6], COLS, [[1, 0]], padsOf({ [COLS[0]]: pad('low') }));
    expect(out.has(-1)).toBe(false);
    expect([...out.values()].every((v) => v === 'free')).toBe(true);
  });
});

// ── The model on real engines ─────────────────────────────────────────────

interface Board {
  sim: AVRSimulator | RP2040Simulator;
  inputPullup(pin: number): void;
  /** Input with the pull left as the latch/pads say (pinMode(INPUT) after a HIGH write). */
  input(pin: number): void;
  output(pin: number): void;
  write(pin: number, level: boolean): void;
  read(pin: number): boolean;
  /** Run the guest a few instructions, so edges due now are applied. */
  settle(): void;
}

/** Uno, through DDRx / PORTx / PINx exactly as pinMode / digitalWrite / digitalRead compile. */
function avrBoard(): Board {
  const sim = new AVRSimulator(new PinManager());
  sim.loadHex(':02000000FFCF30\n:00000001FF\n'); // rjmp .-2
  const cpu = (
    sim as unknown as {
      cpu: { data: Uint8Array; writeData(a: number, v: number): void; readData(a: number): number };
    }
  ).cpu;
  const reg = (pin: number) =>
    pin < 8
      ? { DDR: 0x2a, PORT: 0x2b, PIN: 0x29, bit: 1 << pin }
      : { DDR: 0x24, PORT: 0x25, PIN: 0x23, bit: 1 << (pin - 8) };
  const set = (addr: number, bit: number, on: boolean) =>
    cpu.writeData(addr, on ? cpu.data[addr] | bit : cpu.data[addr] & ~bit);
  return {
    sim,
    inputPullup(pin) {
      const r = reg(pin);
      set(r.DDR, r.bit, false);
      set(r.PORT, r.bit, true);
    },
    input(pin) {
      const r = reg(pin);
      set(r.DDR, r.bit, false);
    },
    output(pin) {
      const r = reg(pin);
      set(r.DDR, r.bit, true);
    },
    write(pin, level) {
      const r = reg(pin);
      set(r.PORT, r.bit, level);
    },
    read(pin) {
      const r = reg(pin);
      return (cpu.readData(r.PIN) & r.bit) !== 0;
    },
    settle() {
      for (let i = 0; i < 4; i++) sim.step();
    },
  };
}

/** Pico, through SIO OE / OUT / IN and the PADS pull bits, as arduino-pico compiles them. */
function rp2040Board(): Board {
  const RAM = 0x20000000;
  const SIO = 0xd0000000;
  const IO_BANK0 = 0x40014000;
  const PADS_BANK0 = 0x4001c000;
  const PAD_BASE = 0x52; // IE | DRIVE 4mA | SCHMITT
  const rp = new RP2040();
  [0xbf00, 0xe7fd].forEach((op, i) => rp.writeUint16(RAM + i * 2, op)); // nop; b .-2
  rp.core.PC = RAM;
  const sim = new RP2040Simulator(new PinManager());
  (sim as unknown as { rp2040: RP2040 }).rp2040 = rp;
  (sim as unknown as { setupGpioListeners(): void }).setupGpioListeners();
  for (const pin of [...ROWS, ...COLS]) {
    rp.writeUint32(IO_BANK0 + 4 + 8 * pin, 5); // FUNCSEL SIO
    rp.writeUint32(PADS_BANK0 + 4 + 4 * pin, PAD_BASE);
  }
  return {
    sim,
    inputPullup(pin) {
      rp.writeUint32(SIO + 0x028, 1 << pin); // OE_CLR
      rp.writeUint32(PADS_BANK0 + 4 + 4 * pin, PAD_BASE | 8); // PUE
    },
    input(pin) {
      rp.writeUint32(SIO + 0x028, 1 << pin);
      rp.writeUint32(PADS_BANK0 + 4 + 4 * pin, PAD_BASE);
    },
    output(pin) {
      rp.writeUint32(SIO + 0x024, 1 << pin); // OE_SET
    },
    write(pin, level) {
      rp.writeUint32(SIO + (level ? 0x014 : 0x018), 1 << pin); // OUT_SET / OUT_CLR
    },
    read(pin) {
      return (rp.readUint32(SIO + 0x004) & (1 << pin)) !== 0;
    },
    settle() {
      sim.runFrameForTime(0.01);
    },
  };
}

/** Keypad::scanKeys, call for call. Returns the held keys it saw as "row,col". */
function keypadLibraryScan(b: Board): Set<string> {
  const seen = new Set<string>();
  for (const r of ROWS) b.inputPullup(r);
  COLS.forEach((c, ci) => {
    b.output(c);
    b.write(c, false);
    b.settle();
    ROWS.forEach((r, ri) => {
      if (!b.read(r)) seen.add(`${ri},${ci}`);
    });
    b.write(c, true);
    b.input(c);
    b.settle();
  });
  return seen;
}

/** The common hand-written scan: each row driven LOW, columns read back. */
function rowScan(b: Board): Set<string> {
  const seen = new Set<string>();
  for (const c of COLS) b.inputPullup(c);
  ROWS.forEach((r, ri) => {
    b.output(r);
    b.write(r, false);
    b.settle();
    COLS.forEach((c, ci) => {
      if (!b.read(c)) seen.add(`${ri},${ci}`);
    });
    b.inputPullup(r);
    b.settle();
  });
  return seen;
}

function attach(b: Board): LineLease {
  const answer = requestLine(b.sim, {
    sensor_type: 'matrix-keypad',
    pin: ROWS[0],
    rows: ROWS,
    cols: COLS,
    pressed: [],
  });
  expect(answer.mode).toBe('local');
  return answer as LineLease;
}

describe.each([
  ['avr8js (Uno)', avrBoard],
  ['rp2040js (Pico)', rp2040Board],
])('matrix keypad hosted on %s', (_name, makeBoard) => {
  it('the Keypad library scan sees exactly the held key, pass after pass', () => {
    const b = makeBoard();
    const kp = attach(b);
    expect(keypadLibraryScan(b)).toEqual(new Set());
    kp.update({ pressed: [[2, 2]] });
    expect(keypadLibraryScan(b)).toEqual(new Set(['2,2']));
    // The second pass starts with every column latch HIGH: the drive-low
    // write is the event this time, not the direction change.
    expect(keypadLibraryScan(b)).toEqual(new Set(['2,2']));
    kp.update({ pressed: [] });
    expect(keypadLibraryScan(b)).toEqual(new Set());
  });

  it('a hand-written row scan sees the held key too', () => {
    const b = makeBoard();
    const kp = attach(b);
    kp.update({ pressed: [[3, 0]] });
    expect(rowScan(b)).toEqual(new Set(['3,0']));
    expect(rowScan(b)).toEqual(new Set(['3,0']));
  });

  it('every key of the grid reads in both scan orders', () => {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const lib = makeBoard();
        attach(lib).update({ pressed: [[r, c]] });
        expect(keypadLibraryScan(lib)).toEqual(new Set([`${r},${c}`]));
        const hand = makeBoard();
        attach(hand).update({ pressed: [[r, c]] });
        expect(rowScan(hand)).toEqual(new Set([`${r},${c}`]));
      }
    }
  });

  it('a key pressed while its column is already low reads at once', () => {
    const b = makeBoard();
    const kp = attach(b);
    for (const r of ROWS) b.inputPullup(r);
    b.output(COLS[1]);
    b.write(COLS[1], false);
    b.settle();
    expect(b.read(ROWS[1])).toBe(true);
    kp.update({ pressed: [[1, 1]] });
    b.settle();
    expect(b.read(ROWS[1])).toBe(false);
    kp.update({ pressed: [] });
    b.settle();
    expect(b.read(ROWS[1])).toBe(true);
  });

  it('owns every wire while attached, so no other layer drives them', () => {
    const b = makeBoard();
    const kp = attach(b);
    for (const p of [...ROWS, ...COLS]) expect(b.sim.ownsPin(p)).toBe(true);
    expect(b.sim.ownsPin(12)).toBe(false);
    kp.release();
    for (const p of [...ROWS, ...COLS]) expect(b.sim.ownsPin(p)).toBe(false);
  });
});
