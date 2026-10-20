/**
 * Board buses F6, second part: the NEO-6M GPS module on real AVR firmware,
 * the module a UART endpoint of the fabric with a TX leg and no RX leg
 * (project board-buses-2026-09, TESTS.md layer 3, scenarios U03 and U04).
 *
 * Everything under test is the real thing: avr8js behind AVRSimulator through
 * the store's own lifecycle (addBoard, compileBoardProgram, startBoard), the
 * part attached through PartSimulationRegistry as the canvas attaches it, the
 * wires in the store, and TinyGPS++ parsing the stream in firmware built with
 * the production toolchain (fixtures/avr-gps-*; each .ino says how to
 * rebuild it). The store's frame clock is the only stand-in: its
 * requestAnimationFrame never fires and the test steps the CPU itself, moving
 * the part's poll along with the guest's cycle counter (the part measures its
 * cadence on that counter, never on the wall clock).
 *
 * Three wirings of the same module:
 *   - Uno D4, SoftwareSerial(4, 3): a plain GPIO, so the fabric's software
 *     emitter puts the frames on the pin as edges on the guest clock;
 *   - Mega RX1 (19), Serial1: the controller port of USART1;
 *   - Uno D0, Serial: the controller port of USART0, shared with the console.
 * And the two ways it can be wrong: TX to the board's TX (D1), which is two
 * drivers on one wire and is reported, and TX to nothing, which is on no wire.
 * Neither ever puts a byte on UART0, which is what the old classifyPin route
 * did for any pin it could not place.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node environment, with the browser globals the store's Run path touches.
vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
let nextFrame = 1;
vi.stubGlobal('requestAnimationFrame', () => nextFrame++);
vi.stubGlobal('cancelAnimationFrame', () => {});

import { useSimulatorStore, getBoardSimulator } from '../../store/useSimulatorStore';
import type { AVRSimulator } from '../../simulation/AVRSimulator';
import { busRegistry } from '../../simulation/buses';
import type { BusDiagnostic } from '../../simulation/buses/types';
import { PartSimulationRegistry } from '../../simulation/parts/PartSimulationRegistry';
import { dispatchSensorUpdate } from '../../simulation/SensorUpdateRegistry';
import { GPS_TICK_MS } from '../../simulation/parts/GpsParts';
import '../../simulation/parts/GpsParts';

const fixture = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)), 'utf-8');

const SOFTSERIAL_HEX = fixture('avr-gps-softserial/avr-gps-softserial.ino.hex');
const SERIAL0_HEX = fixture('avr-gps-serial0/avr-gps-serial0.ino.hex');
const SERIAL1_HEX = fixture('avr-gps-serial1/avr-gps-serial1.ino.hex');

let rigSeq = 0;
const liveBoards = new Set<Board>();
const cleanups: Array<() => void> = [];
const diags: BusDiagnostic[] = [];
let offDiag: (() => void) | null = null;

beforeEach(() => {
  // The part polls the guest clock on a timer; the test owns that timer so a
  // poll lands every GPS_TICK_MS of GUEST time, however fast the CPU steps.
  vi.useFakeTimers();
  diags.length = 0;
  offDiag = busRegistry.onDiagnostic((d) => diags.push(d));
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const b of liveBoards) b.dispose();
  liveBoards.clear();
  offDiag?.();
  busRegistry.resetDiagnostics();
  useSimulatorStore.setState({ components: [], wires: [] } as never);
  vi.useRealTimers();
});

/** One AVR board of the real store, with a loaded sketch, stepped by the test. */
class Board {
  readonly id: string;
  out = '';
  private wireSeq = 0;

  constructor(kind: 'arduino-uno' | 'arduino-mega', hex: string) {
    this.id = `${kind}-gps${++rigSeq}`;
    liveBoards.add(this);
    const st = useSimulatorStore.getState();
    st.addBoard(kind, 0, 0, this.id);
    this.sim.onSerialData = (ch: string) => {
      this.out += ch;
    };
    st.compileBoardProgram(this.id, hex);
    st.startBoard(this.id);
  }

  get sim(): AVRSimulator {
    return getBoardSimulator(this.id) as unknown as AVRSimulator;
  }

  /** Wire a component pin to one of this board's pins, as the canvas does. */
  wire(componentId: string, pinName: string, boardPin: number): void {
    useSimulatorStore.getState().addWire({
      id: `${this.id}-w${++this.wireSeq}`,
      start: { componentId, pinName, x: 0, y: 0 },
      end: { componentId: this.id, pinName: String(boardPin), x: 0, y: 0 },
      waypoints: [],
      color: '#0a0',
    } as never);
  }

  /**
   * Run up to `ms` of guest time, stopping once `done` holds. The part's poll
   * is clocked from the guest's own cycle counter: one poll per GPS_TICK_MS
   * of guest time, which is how the browser's timer and a board running at
   * real speed line up.
   */
  run(ms: number, done: () => boolean = () => false): void {
    const sim = this.sim;
    const hz = sim.getClockHz();
    const tick = (GPS_TICK_MS / 1000) * hz;
    const end = sim.getCurrentCycles() + (ms / 1000) * hz;
    let nextPoll = sim.getCurrentCycles() + tick;
    while (sim.getCurrentCycles() < end) {
      for (let i = 0; i < 0x400; i++) sim.step();
      if (sim.getCurrentCycles() >= nextPoll) {
        vi.advanceTimersByTime(GPS_TICK_MS);
        nextPoll += tick;
      }
      if (done()) return;
    }
  }

  /** The STAT lines the sketch printed so far, oldest first. */
  stats(): Array<{ chars: number; ok: number; fail: number }> {
    return [...this.out.matchAll(/STAT chars=(\d+) ok=(\d+) fail=(\d+)\r?\n/g)].map((m) => ({
      chars: Number(m[1]),
      ok: Number(m[2]),
      fail: Number(m[3]),
    }));
  }

  dispose(): void {
    if (!liveBoards.delete(this)) return;
    useSimulatorStore.getState().removeBoard(this.id);
  }
}

const GPS = 'gps-neo6m-1';

/** The module on the canvas, its TX wired to `boardPin` (null: to nothing). */
function gpsOn(board: Board, boardPin: number | null): Record<string, unknown> {
  if (boardPin !== null) board.wire(GPS, 'TX', boardPin);
  const el: Record<string, unknown> = {};
  const logic = PartSimulationRegistry.get('gps-neo6m')!;
  cleanups.push(logic.attachEvents!(el as unknown as HTMLElement, board.sim as never, () => null, GPS));
  return el;
}

const FIX = /FIX lat=(-?[\d.]+) lng=(-?[\d.]+) alt=([\d.]+) sats=(\d+) time=(\d+)\r?\n/;

describe('AVR: the NEO-6M on real TinyGPS++ firmware, by its wiring', () => {
  it('avr-gps-softserial: on the Uno D4 through SoftwareSerial(4, 3), the fix prints and every checksum passes', () => {
    const board = new Board('arduino-uno', SOFTSERIAL_HEX);
    const el = gpsOn(board, 4);
    // A plain GPIO: no controller on the wire, the software emitter serves it.
    expect(busRegistry.uartPlacement(GPS)).toEqual({ rx: null, tx: { boardId: board.id, pin: 4, controller: null } });
    board.run(3000, () => FIX.test(board.out));
    expect(board.out).toMatch(/^GPS READY\r?\n/);
    const m = FIX.exec(board.out)!;
    expect(m, board.out).not.toBeNull();
    expect(m.slice(1, 5)).toEqual(['40.4168', '-3.7038', '667.0', '7']);
    expect(el.pps).toBeDefined();
    // Two more seconds: the stream keeps coming, and nothing in it is corrupt.
    board.run(2200, () => board.stats().length >= 3);
    const last = board.stats().at(-1)!;
    expect(last.chars).toBeGreaterThan(200);
    expect(last.ok).toBeGreaterThanOrEqual(4);
    expect(last.fail).toBe(0);
    // The panel moves the receiver: the next fix is Santiago.
    dispatchSensorUpdate(GPS, { lat: -33.4489, lng: -70.6693 });
    board.run(2500, () => /FIX lat=-33\.4489 lng=-70\.6693/.test(board.out));
    expect(board.out).toContain('FIX lat=-33.4489 lng=-70.6693');
    expect(diags).toEqual([]);
  });

  it('avr-gps-serial1: on the Mega RX1 (19), Serial1 carries the fix through USART1', () => {
    const board = new Board('arduino-mega', SERIAL1_HEX);
    gpsOn(board, 19);
    expect(busRegistry.uartPlacement(GPS)?.tx).toEqual({ boardId: board.id, pin: 19, controller: 'USART1' });
    board.run(3000, () => FIX.test(board.out));
    const m = FIX.exec(board.out)!;
    expect(m, board.out).not.toBeNull();
    expect(m.slice(1, 5)).toEqual(['40.4168', '-3.7038', '667.0', '7']);
    board.run(2200, () => board.stats().length >= 3);
    const last = board.stats().at(-1)!;
    expect(last.chars).toBeGreaterThan(200);
    expect(last.fail).toBe(0);
    expect(diags).toEqual([]);
  });

  it('avr-gps-serial0: on the Uno D0, Serial carries the fix through USART0, the console it shares', () => {
    const board = new Board('arduino-uno', SERIAL0_HEX);
    gpsOn(board, 0);
    expect(busRegistry.uartPlacement(GPS)?.tx).toEqual({ boardId: board.id, pin: 0, controller: 'USART0' });
    board.run(3000, () => FIX.test(board.out));
    const m = FIX.exec(board.out)!;
    expect(m, board.out).not.toBeNull();
    expect(m.slice(1, 5)).toEqual(['40.4168', '-3.7038', '667.0', '7']);
    board.run(2200, () => board.stats().length >= 3);
    expect(board.stats().at(-1)!.fail).toBe(0);
    expect(diags).toEqual([]);
  });
});

describe('AVR: the NEO-6M on the wrong pin, and on no pin', () => {
  it('TX on the Uno D1 (its TX): reported as uart-tx-contention, and Serial never sees a character', () => {
    const board = new Board('arduino-uno', SERIAL0_HEX);
    gpsOn(board, 1);
    expect(busRegistry.uartPlacement(GPS)?.tx).toEqual({ boardId: board.id, pin: 1, controller: null });
    const contention = diags.filter((d) => d.code === 'uart-tx-contention');
    expect(contention).toHaveLength(1);
    expect(contention[0].owners).toEqual([GPS]);
    expect(contention[0].boardId).toBe(board.id);
    expect(contention[0].message).toContain('USART0');
    board.run(3300, () => board.stats().length >= 3);
    expect(board.stats().length).toBeGreaterThanOrEqual(3);
    expect(board.stats().every((s) => s.chars === 0)).toBe(true);
    expect(board.out).not.toContain('FIX');
  });

  it('TX wired to nothing: on no wire, no diagnostic, and Serial never sees a character (no UART0 fallback)', () => {
    const board = new Board('arduino-uno', SERIAL0_HEX);
    const el = gpsOn(board, null);
    expect(busRegistry.uartPlacement(GPS)).toEqual({ rx: null, tx: null });
    board.run(3300, () => board.stats().length >= 3);
    expect(board.stats().length).toBeGreaterThanOrEqual(3);
    expect(board.stats().every((s) => s.chars === 0)).toBe(true);
    expect(board.out).not.toContain('FIX');
    expect(diags).toEqual([]);
    // The receiver ran all along: it pulsed its PPS into the air.
    expect(el.pps).toBeDefined();
  });
});
