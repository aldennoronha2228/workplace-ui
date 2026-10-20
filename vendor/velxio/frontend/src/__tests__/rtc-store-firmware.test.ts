/**
 * The clock parts on boards the store built, with the firmware loaded the
 * way a compile loads it: `compileBoardProgram` hands the image to the engine
 * and keeps it on the board, and that copy is where the part reads the build
 * time of the firmware from (project i2c-model-fidelity-2026-09, decision
 * D7). rtc-real-firmware.test.ts holds the models to what the sketches print;
 * this file holds the path from the compile to the part, on the two engines
 * of the open-source build that run in the tab.
 *
 * The firmware is RTClib's DS3231 example setup, built by the compile
 * service for the Uno (Intel HEX) and for the Pico (.bin):
 * `if (rtc.lostPower()) rtc.adjust(DateTime(F(__DATE__), F(__TIME__)))`.
 * The part powers on with OSF clear, and then the sketch sets nothing; the
 * tests of the path give it a module fresh from the bag.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AVRSimulator } from '../simulation/AVRSimulator';
import type { RP2040Simulator } from '../simulation/RP2040Simulator';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import { useSimulatorStore, getBoardSimulator } from '../store/useSimulatorStore';
import { busRegistry } from '../simulation/buses/registry';
import { DS3231_RULES } from '../simulation/I2CBusManager';
import type { NetResolver, PinRef, ResolvedPin } from '../simulation/buses/types';

// ── Frame clock ──────────────────────────────────────────────────────────────
const frameCallbacks = new Map<number, FrameRequestCallback>();
let frameId = 0;
let frameClockMs = 0;
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  frameCallbacks.set(++frameId, cb);
  return frameId;
});
vi.stubGlobal('cancelAnimationFrame', (id: number) => {
  frameCallbacks.delete(id);
});
if (typeof (globalThis as { document?: unknown }).document === 'undefined') {
  vi.stubGlobal('document', { getElementById: () => null, activeElement: null });
}
function frame(): void {
  frameClockMs += 16;
  const due = [...frameCallbacks.values()];
  frameCallbacks.clear();
  for (const cb of due) cb(frameClockMs);
}
vi.spyOn(console, 'log').mockImplementation(() => {});

const fixture = (name: string, ext: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}/${name}.ino.${ext}`, import.meta.url)));
const UNO_HEX = fixture('avr-rtclib-ds3231', 'hex').toString('utf8');
const PICO_BIN = fixture('rp2040-rtclib-ds3231', 'bin').toString('base64');

// The host: 12:34:56.250 of Wednesday 30 September 2026, local time.
const HOST = new Date(2026, 8, 30, 12, 34, 56, 250);

type Kind = 'arduino-uno' | 'raspberry-pi-pico';
type Board = AVRSimulator | RP2040Simulator;

/** Wire's pads: A4 / A5 on the Uno, GP4 / GP5 on the Pico. */
const WIRE: Record<Kind, { sda: number; scl: number }> = {
  'arduino-uno': { sda: 18, scl: 19 },
  'raspberry-pi-pico': { sda: 4, scl: 5 },
};

/** One board, and the clock's SDA and SCL on its Wire pads. */
class Circuit implements NetResolver {
  private readonly boardId: string;
  private readonly kind: Kind;

  constructor(boardId: string, kind: Kind) {
    this.boardId = boardId;
    this.kind = kind;
  }

  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    if (ref.componentId !== 'rtc') return { kind: 'floating' };
    if (ref.pinName === 'SDA')
      return { kind: 'board', boardId: this.boardId, pin: WIRE[this.kind].sda };
    if (ref.pinName === 'SCL')
      return { kind: 'board', boardId: this.boardId, pin: WIRE[this.kind].scl };
    return { kind: 'floating' };
  }
  resolveAll(ref: PinRef): ResolvedPin[] {
    const r = this.resolve(ref);
    return r.kind === 'floating' ? [] : [r];
  }
  boardKind(boardId: string): string | undefined {
    return boardId === this.boardId ? this.kind : undefined;
  }
  boards(): string[] {
    return [this.boardId];
  }
}

/**
 * A DS3231 fresh from the bag, OSF set, for as long as the test runs. The
 * part powers on with OSF clear (DS3231_RULES.power_on says why), so RTClib's
 * example `if (rtc.lostPower()) rtc.adjust(...)` leaves it alone; a module
 * that says it lost power is how these sketches get to set the clock.
 */
function freshFromTheBag(): void {
  const powerOn = DS3231_RULES.power_on as Record<number, number>;
  const status = powerOn[0x0f];
  powerOn[0x0f] = status | 0x80;
  restoreStatus.push(() => {
    powerOn[0x0f] = status;
  });
}
const restoreStatus: Array<() => void> = [];

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (restoreStatus.length) restoreStatus.pop()!();
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      /* a part that throws on teardown must not hide the next test */
    }
  }
  frameCallbacks.clear();
  vi.useRealTimers();
  useSimulatorStore.setState({ components: [] } as never);
  busRegistry.clear();
});

interface Run {
  id: string;
  /** Frames until the sketch has printed `count` lines that match. */
  lines(pattern: RegExp, count: number, maxFrames?: number): string[];
}

/** A board of the store with a DS3231 on its Wire pads, not yet compiled. */
function board(kind: Kind): Run {
  vi.useFakeTimers({ toFake: ['Date'], now: HOST });
  const st = useSimulatorStore.getState();
  const id = st.addBoard(kind as never, 0, 0);
  cleanups.push(() => useSimulatorStore.getState().removeBoard(id));
  const sim = getBoardSimulator(id) as Board;
  busRegistry.setResolver(new Circuit(id, kind));
  busRegistry.bindBoard(id, sim);
  cleanups.push(() => busRegistry.unbindBoard(id));
  cleanups.push(() => sim.stop());

  const el = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  const detach = PartSimulationRegistry.get('ds3231')!.attachEvents!(
    el as unknown as HTMLElement,
    sim as never,
    () => null,
    'rtc',
  );
  cleanups.push(detach);

  let out = '';
  let seen = 0;
  let started = false;
  return {
    id,
    lines(pattern, count, maxFrames = 600) {
      if (!started) {
        sim.onSerialData = (ch: string) => {
          out += ch;
        };
        sim.start();
        started = true;
      }
      const found: string[] = [];
      for (let i = 0; ; i++) {
        for (let nl = out.indexOf('\n', seen); nl >= 0; nl = out.indexOf('\n', seen)) {
          const line = out.slice(seen, nl).replace(/\r$/, '');
          seen = nl + 1;
          if (pattern.test(line)) found.push(line);
          if (found.length === count) return found;
        }
        if (i >= maxFrames) {
          throw new Error(
            `${found.length} of ${count} lines matching ${pattern} in ${maxFrames} frames; ` +
              `the sketch printed ${JSON.stringify(out)}`,
          );
        }
        frame();
      }
    },
  };
}

describe('RTClib sets the clock to the build time of the firmware the store compiled', () => {
  it('Arduino Uno: the clock stays on the time of the host', () => {
    freshFromTheBag();
    const run = board('arduino-uno');
    useSimulatorStore.getState().compileBoardProgram(run.id, UNO_HEX);
    expect(run.lines(/^(READY|NOT FOUND|LOST=.)$/, 3)).toEqual(['READY', 'LOST=1', 'LOST=0']);
    expect(run.lines(/^NOW=/, 1)).toEqual(['NOW=2026-09-30 12:34:56 DOW=3 T=25.00']);
  }, 120_000);

  it('Raspberry Pi Pico: the clock stays on the time of the host', () => {
    freshFromTheBag();
    const run = board('raspberry-pi-pico');
    useSimulatorStore.getState().compileBoardProgram(run.id, PICO_BIN);
    expect(run.lines(/^(READY|NOT FOUND|LOST=.)$/, 3, 1200)).toEqual(['READY', 'LOST=1', 'LOST=0']);
    expect(run.lines(/^NOW=/, 1, 1200)).toEqual(['NOW=2026-09-30 12:34:56 DOW=3 T=25.00']);
  }, 120_000);

  it('a clock wired to one board knows the build time of the firmware of every board', () => {
    // The Pico's firmware is what talks to the clock; the Uno beside it was
    // compiled too. Each image is looked through.
    freshFromTheBag();
    const run = board('raspberry-pi-pico');
    const other = useSimulatorStore.getState().addBoard('arduino-uno' as never, 300, 0);
    cleanups.push(() => useSimulatorStore.getState().removeBoard(other));
    useSimulatorStore.getState().compileBoardProgram(other, UNO_HEX);
    useSimulatorStore.getState().compileBoardProgram(run.id, PICO_BIN);
    expect(run.lines(/^NOW=/, 1, 1200)).toEqual(['NOW=2026-09-30 12:34:56 DOW=3 T=25.00']);
  }, 120_000);

  it('as the part comes, the sketch sets nothing and reads the time of the host', () => {
    const run = board('arduino-uno');
    useSimulatorStore.getState().compileBoardProgram(run.id, UNO_HEX);
    expect(run.lines(/^(READY|NOT FOUND|LOST=.)$/, 3)).toEqual(['READY', 'LOST=0', 'LOST=0']);
    expect(run.lines(/^NOW=/, 1)).toEqual(['NOW=2026-09-30 12:34:56 DOW=3 T=25.00']);
  }, 120_000);

  it('after the sketch set a date of its own, that is the date', () => {
    const run = board('arduino-uno');
    useSimulatorStore.getState().compileBoardProgram(run.id, UNO_HEX);
    run.lines(/^OWN DATE$/, 1);
    expect(run.lines(/^NOW=/, 1)).toEqual(['NOW=2024-02-29 23:59:58 DOW=4 T=25.00']);
  }, 120_000);
});
