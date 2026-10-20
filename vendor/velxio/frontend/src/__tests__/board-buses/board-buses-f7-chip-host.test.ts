/**
 * Board buses F7: the browser chip host's time and pins.
 *
 * Unit rows behind the F0 acceptance rows in board-buses-repro-chips-other:
 * the chip's clock is the board's guest clock (browser-chip-clock-always-zero),
 * a chip's output on a board pin is one driver of that pin's net and VX_INPUT
 * is its release (chip-release-to-input-keeps-board-pin-driven), and the settle
 * kernel keeps every board's nets on that board's PinManager
 * (buskernel-global-pinmanager-misroutes-multiboard).
 *
 * Real chips (fixtures/chips-other-chips, compiled from C with wasi-sdk), the
 * real ChipInstance, the real PinManager and the real net kernel. The guest
 * clock is a fake with the GuestClock contract: cycles that move when the
 * test says so, and an event queue that drops its events on a reset the way a
 * rebuilt CPU does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PinManager } from '../../simulation/PinManager';
import { ChipInstance } from '../../simulation/customChips/ChipRuntime';
import { resetBusNets } from '../../simulation/customChips/busNets';
import { publishNetLevel, resetBusKernel } from '../../simulation/customChips/busKernel';
import { busRegistry } from '../../simulation/buses';
import type { GuestClock } from '../../simulation/buses/types';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const wasmOf = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, `chips-other-chips/${name}.wasm`)));
const spiWasmOf = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, `chips-spi-chips/${name}.wasm`)));

const HZ = 16_000_000;
const ms = (n: number) => n * (HZ / 1000);

/** A board's clock as the fabric sees it: cycles and an event queue. */
class FakeClock implements GuestClock {
  cycles = 0;
  hz = HZ;
  events: Array<{ at: number; cb: () => void }> = [];
  now(): number {
    return this.cycles;
  }
  clockHz(): number {
    return this.hz;
  }
  scheduleEdge(): void {}
  at(atCycle: number, cb: () => void): () => void {
    const e = { at: atCycle, cb };
    this.events.push(e);
    return () => {
      const i = this.events.indexOf(e);
      if (i >= 0) this.events.splice(i, 1);
    };
  }
  /** Run the guest to `toCycle`, firing each event at its cycle, in order. */
  run(toCycle: number): void {
    for (;;) {
      let due: { at: number; cb: () => void } | null = null;
      for (const e of this.events) if (e.at <= toCycle && (!due || e.at < due.at)) due = e;
      if (!due) break;
      this.events.splice(this.events.indexOf(due), 1);
      this.cycles = Math.max(this.cycles, due.at);
      due.cb();
    }
    this.cycles = toCycle;
  }
  /** A rebuilt CPU: the counter starts over and every event is gone. */
  reset(): void {
    this.cycles = 0;
    this.events = [];
  }
}

let logs: string[] = [];
let chips: ChipInstance[] = [];

beforeEach(() => {
  logs = [];
  chips = [];
  resetBusNets();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const c of chips) c.dispose();
  busRegistry.clear();
  resetBusNets();
  vi.restoreAllMocks();
});

interface Host {
  chip: ChipInstance;
  pm: PinManager;
  /** Every level the chip's host put into the guest, per chip pin name. */
  guest: Array<[string, boolean]>;
}

async function chip(
  name: string,
  wires: Record<string, number>,
  opts: { clock?: GuestClock | null; attrs?: Record<string, number>; pm?: PinManager; spi?: boolean; id?: string } = {},
): Promise<Host> {
  const pm = opts.pm ?? new PinManager();
  const guest: Array<[string, boolean]> = [];
  const inst = await ChipInstance.create({
    wasm: opts.spi ? spiWasmOf(name) : wasmOf(name),
    componentId: opts.id ?? name,
    pinManager: pm,
    clock: opts.clock ?? null,
    wires: new Map(Object.entries(wires)),
    attrs: new Map(Object.entries(opts.attrs ?? {})),
    log: (s) => logs.push(`${opts.id ?? name}: ${s.replace(/\n$/, '')}`),
  });
  inst.onDigitalWrite((pinName, level) => guest.push([pinName, level]));
  inst.start();
  chips.push(inst);
  return { chip: inst, pm, guest };
}

/** What a chip said with vx_log after `prefix`, in order. */
const said = (id: string, prefix: string) => {
  const head = `${id}: [chip] ${prefix}`;
  return logs.filter((l) => l.startsWith(head)).map((l) => l.slice(head.length));
};

// ── Time ────────────────────────────────────────────────────────────────────

describe('F7 chip host: the chip keeps the guest clock', () => {
  const WIRES = { IN: 3, OUT: 2 };

  it('vx_sim_now_nanos is guest cycles at the clock rate: 20 ms between two rises reads 20000 us', async () => {
    const clock = new FakeClock();
    const h = await chip('clock-probe', WIRES, { clock });
    clock.cycles = ms(5);
    h.pm.triggerPinChange(3, true);
    h.pm.triggerPinChange(3, false);
    clock.cycles = ms(25);
    h.pm.triggerPinChange(3, true);
    expect(said('clock-probe', 'dt ')).toEqual(['20000']);
  });

  it('a 1 ms repeating timer fires at its guest instant, one event per period, from the engine queue', async () => {
    const clock = new FakeClock();
    const h = await chip('clock-probe', WIRES, { clock });
    const at: number[] = [];
    h.pm.onPinChange(2, () => at.push(clock.cycles));
    clock.run(ms(5.5));
    expect(at).toEqual([ms(1), ms(2), ms(3), ms(4), ms(5)]);
    expect(said('clock-probe', 'tick')).toHaveLength(1);
    // Every fire reached the guest through the host's door as well.
    expect(h.guest.filter(([p]) => p === 'OUT').map(([, l]) => l)).toEqual([false, true, false, true, false, true]);
  });

  it('after the MCU is rebuilt the lost event is re-armed by the tick, and the chip clock does not run backwards', async () => {
    const clock = new FakeClock();
    const h = await chip('clock-probe', WIRES, { clock });
    let fires = 0;
    h.pm.onPinChange(2, () => fires++);
    clock.run(ms(4.5));
    h.pm.triggerPinChange(3, true);
    expect(fires).toBe(4);
    // Stop, Run: a new CPU at cycle 0 and no events. Nothing fires on its own.
    clock.reset();
    clock.run(ms(0.5));
    expect(fires).toBe(4);
    // The host's tick notices the counter started over: the chip's clock is
    // at 4.5 + 0.5 = 5 ms, so the fifth fire is due there and then, and the
    // sixth is armed on the live CPU at guest 1.5 ms.
    h.chip.tickTimers();
    expect(fires).toBe(5);
    expect(clock.events.map((e) => e.at)).toEqual([ms(1.5)]);
    clock.run(ms(3.5));
    expect(fires).toBe(8);
  });

  it('the chip clock is monotonic across a reset: a rise before and one after measure the sum of both runs', async () => {
    const clock = new FakeClock();
    const h = await chip('clock-probe', WIRES, { clock });
    clock.cycles = ms(4);
    h.pm.triggerPinChange(3, true);
    h.pm.triggerPinChange(3, false);
    clock.run(ms(6));
    clock.reset();
    clock.cycles = ms(1);
    h.pm.triggerPinChange(3, true);
    // 6 ms of the old run, then 1 ms of the new one, minus the rise at 4 ms.
    expect(said('clock-probe', 'dt ')).toEqual(['3000']);
  });

  it('with no guest clock the host clock is what tickTimers was last handed, and it never goes back', async () => {
    const h = await chip('clock-probe', WIRES);
    let fires = 0;
    h.pm.onPinChange(2, () => fires++);
    h.chip.tickTimers(3_500_000n);
    expect(fires).toBe(3);
    h.pm.triggerPinChange(3, true);
    h.pm.triggerPinChange(3, false);
    h.chip.tickTimers(23_500_000n);
    expect(fires).toBe(23);
    h.pm.triggerPinChange(3, true);
    expect(said('clock-probe', 'dt ')).toEqual(['20000']);
    // An earlier instant (a fresh run's zero) does not turn the clock back.
    h.chip.tickTimers(0n);
    h.pm.triggerPinChange(3, false);
    h.pm.triggerPinChange(3, true);
    expect(said('clock-probe', 'dt ')).toEqual(['20000', '0']);
  });

  it('a chip with no clock at all stands at zero and fires nothing', async () => {
    const h = await chip('clock-probe', WIRES);
    let fires = 0;
    h.pm.onPinChange(2, () => fires++);
    h.pm.triggerPinChange(3, true);
    h.pm.triggerPinChange(3, false);
    h.pm.triggerPinChange(3, true);
    expect(said('clock-probe', 'dt ')).toEqual(['0']);
    expect(fires).toBe(0);
  });

  it('a guest with no time yet (0 Hz) arms nothing and the timer starts once the clock runs', async () => {
    const clock = new FakeClock();
    clock.hz = 0;
    const h = await chip('clock-probe', WIRES, { clock });
    expect(clock.events).toHaveLength(0);
    h.chip.tickTimers();
    expect(clock.events).toHaveLength(0);
    clock.hz = HZ;
    h.chip.tickTimers();
    expect(clock.events).toHaveLength(1);
    let fires = 0;
    h.pm.onPinChange(2, () => fires++);
    clock.run(ms(2.5));
    expect(fires).toBe(2);
  });

  it('disposing the chip cancels its events', async () => {
    const clock = new FakeClock();
    const h = await chip('clock-probe', WIRES, { clock });
    expect(clock.events).toHaveLength(1);
    h.chip.dispose();
    expect(clock.events).toHaveLength(0);
  });
});

// ── Pins on a board pin ─────────────────────────────────────────────────────

describe('F7 chip host: a chip output on a board pin is one driver of its net', () => {
  const WIRES = { IRQ: 2, TRIG: 3 };

  /** The sketch's pinMode(2, INPUT_PULLUP), as the AVR reports it. */
  function pullUp(pm: PinManager, pin: number): void {
    pm.reportPad(pin, 'z', 1, 0);
    pm.triggerPinChange(pin, true, 'mcu');
  }

  for (const idiom of [0, 1] as const) {
    it(`idiom ${idiom}: the pull reaches the guest, and vx_pin_set_mode(VX_INPUT) lets the pull-up restore HIGH`, async () => {
      const h = await chip('open-drain', WIRES, { attrs: { idiom } });
      pullUp(h.pm, 2);
      h.pm.triggerPinChange(3, true);
      expect(h.guest.at(-1)).toEqual(['IRQ', false]);
      expect(h.pm.getPinState(2)).toBe(false);
      h.pm.triggerPinChange(3, false);
      expect(h.guest.at(-1)).toEqual(['IRQ', true]);
      expect(h.pm.getPinState(2)).toBe(true);
    });
  }

  it('a release on a pad with no pull leaves the line where it is', async () => {
    const h = await chip('open-drain', WIRES, { attrs: { idiom: 1 } });
    h.pm.reportPad(2, 'z', 0, 0);
    h.pm.triggerPinChange(2, true, 'mcu');
    h.pm.triggerPinChange(3, true);
    expect(h.guest.at(-1)).toEqual(['IRQ', false]);
    const before = h.guest.length;
    h.pm.triggerPinChange(3, false);
    expect(h.guest.length).toBe(before);
    expect(h.pm.getPinState(2)).toBe(false);
  });

  it('two chips on one line are a wired-AND: the line rises when the last one lets go', async () => {
    const pm = new PinManager();
    const a = await chip('open-drain', WIRES, { attrs: { idiom: 1 }, pm, id: 'a' });
    const b = await chip('open-drain', { IRQ: 2, TRIG: 4 }, { attrs: { idiom: 1 }, pm, id: 'b' });
    pullUp(pm, 2);
    pm.triggerPinChange(3, true);
    pm.triggerPinChange(4, true);
    expect(pm.getPinState(2)).toBe(false);
    pm.triggerPinChange(3, false);
    expect(pm.getPinState(2)).toBe(false);
    expect(a.guest.at(-1)).toEqual(['IRQ', false]);
    pm.triggerPinChange(4, false);
    expect(pm.getPinState(2)).toBe(true);
    expect(b.guest.at(-1)).toEqual(['IRQ', true]);
  });

  it('a chip that is deleted while holding the line releases it', async () => {
    const h = await chip('open-drain', WIRES, { attrs: { idiom: 1 } });
    pullUp(h.pm, 2);
    h.pm.triggerPinChange(3, true);
    expect(h.pm.getPinState(2)).toBe(false);
    h.chip.dispose();
    expect(h.pm.getPinState(2)).toBe(true);
    expect(h.guest.at(-1)).toEqual(['IRQ', true]);
  });

  it('while the MCU drives the pad the chip cannot move it: contention is reported, nothing is fed back', async () => {
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
    const h = await chip('open-drain', WIRES, { attrs: { idiom: 1 } });
    h.pm.reportPad(2, 'high', 0, 0);
    h.pm.triggerPinChange(2, true, 'mcu');
    h.pm.triggerPinChange(3, true);
    expect(h.guest.filter(([p]) => p === 'IRQ')).toEqual([]);
    expect(h.pm.getPinState(2)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('contention on board pin 2');
    // The sketch releases the pad with a pull-up: the chip's low is what it reads now.
    pullUp(h.pm, 2);
    expect(h.guest.at(-1)).toEqual(['IRQ', false]);
    expect(h.pm.getPinState(2)).toBe(false);
  });

  it('the sketch writing the latch of an input pin after the chip took it low does not lift the level channel', async () => {
    const h = await chip('open-drain', WIRES, { attrs: { idiom: 1 } });
    h.pm.reportPad(2, 'z', 0, 0);
    h.pm.triggerPinChange(3, true);
    expect(h.pm.getPinState(2)).toBe(false);
    // pinMode(2, INPUT_PULLUP) on the AVR: the pad is reported, then the PORT
    // bit lands on the level channel as if it were the wire's level.
    h.pm.reportPad(2, 'z', 1, 0);
    h.pm.triggerPinChange(2, true, 'mcu');
    expect(h.pm.getPinState(2)).toBe(false);
    expect(h.guest.at(-1)).toEqual(['IRQ', false]);
  });

  it('VX_OUTPUT_LOW drives at registration, a plain VX_OUTPUT waits for its first write, and both release with VX_INPUT', async () => {
    const h = await chip('plain-output', { A: 5, B: 6, T: 7 });
    expect(h.guest).toEqual([['B', false]]);
    h.pm.reportPad(5, 'z', 1, 0);
    h.pm.triggerPinChange(5, true, 'mcu');
    h.pm.triggerPinChange(7, true);
    expect(h.guest.at(-1)).toEqual(['A', true]);
    h.pm.triggerPinChange(7, false);
    // Released onto the pull-up: the level stays high and nothing else is fed.
    expect(h.pm.getPinState(5)).toBe(true);
    expect(h.guest.filter(([p]) => p === 'A')).toEqual([['A', true], ['A', true]]);
  });

  it('a pin a bus drives (the MISO of vx_spi_attach) is not held by its mode', async () => {
    // The probe declares MISO an output (VX_OUTPUT_LOW) and never writes it:
    // the bus answers on it. Registration puts the low there once, as before,
    // and the attach withdraws it, so a level the bus puts on the pin stays.
    const h = await chip('spi-probe', { CS: 4, SCK: 5, MOSI: 6, MISO: 7, GROW: 8 }, { spi: true });
    expect(h.guest).toEqual([['MISO', false]]);
    h.pm.triggerPinChange(7, true, 'external');
    expect(h.pm.getPinState(7)).toBe(true);
    expect(h.guest).toEqual([['MISO', false]]);
  });

  it('a chip input on a board pin sees the level channel, wherever it comes from', async () => {
    const h = await chip('pulse-counter', { PULSE: 2, OVF: 4 });
    h.pm.reportPad(2, 'z', 0, 0);
    // A part's injection reaches the level channel through the engine's
    // external door (AVRSimulator.setPinState); here it is written directly.
    for (let i = 0; i < 4; i++) {
      h.pm.triggerPinChange(2, true, 'external');
      h.pm.triggerPinChange(2, false, 'external');
    }
    expect(h.guest.at(-1)).toEqual(['OVF', true]);
  });
});

// ── The kernel per board ────────────────────────────────────────────────────

describe('F7 chip host: the settle kernel applies every board net to its own PinManager', () => {
  beforeEach(() => resetBusKernel());
  afterEach(() => resetBusKernel());

  it('a delta that carries nets of two boards lands each on its board', () => {
    const pmA = new PinManager();
    const pmB = new PinManager();
    const N = 100_600;
    const L = 100_601;
    const M = 100_602;
    // Board A: L follows N. Interconnect: N mirrors onto board B. Board B: M follows N.
    pmA.onPinChange(N, (_p, v) => publishNetLevel(pmA, L, v));
    pmA.onPinChange(N, (_p, v) => pmB.triggerPinChange(N, v));
    pmB.onPinChange(N, (_p, v) => publishNetLevel(pmB, M, v));
    publishNetLevel(pmA, N, true);
    expect({
      L_on_A: pmA.getPinState(L),
      M_on_B: pmB.getPinState(M),
      M_on_A: pmA.peekPinState(M),
      L_on_B: pmB.peekPinState(L),
    }).toEqual({ L_on_A: true, M_on_B: true, M_on_A: undefined, L_on_B: undefined });
  });

  it('a pending level applies through the door it was published with', () => {
    const pm = new PinManager();
    const guest: boolean[] = [];
    publishNetLevel(pm, 7, true, (lvl) => {
      guest.push(lvl);
      pm.triggerPinChange(7, lvl, 'external');
    });
    expect(guest).toEqual([true]);
    expect(pm.getPinState(7)).toBe(true);
  });
});
