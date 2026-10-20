/**
 * membrane-keypad-real-firmware.test.ts — the Keypad library itself, compiled
 * for the Uno, reading the membrane-keypad part on avr8js. The wiring is the
 * one from issue #327 (rows 9 8 7 6, columns 5 4 3 2), where no key was ever
 * seen: the library drives the COLUMNS and reads the rows, and the part only
 * modelled the opposite scan.
 *
 * Firmware fixture (`fixtures/keypad-scan/`) was compiled with arduino-cli
 * (arduino:avr:uno, Keypad 3.1.1) from the committed .ino.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/BasicParts';

vi.stubGlobal('requestAnimationFrame', () => 1);
vi.stubGlobal('cancelAnimationFrame', () => {});

const HEX = readFileSync(
  fileURLToPath(new URL('./fixtures/keypad-scan/keypad-scan.ino.hex', import.meta.url)),
  'utf-8',
);

const PINS: Record<string, number> = { R1: 9, R2: 8, R3: 7, R4: 6, C1: 5, C2: 4, C3: 3, C4: 2 };
const LEGENDS = ['123A', '456B', '789C', '*0#D'];

function boot() {
  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(HEX);
  // The wokwi element dispatches button-press / button-release with the key's
  // row and column; an EventTarget is all the part listens on.
  const el = new EventTarget() as unknown as HTMLElement;
  const cleanup = PartSimulationRegistry.get('membrane-keypad')!.attachEvents!(
    el,
    sim as never,
    (name) => PINS[name] ?? null,
    'keypad-1',
  );
  let out = '';
  sim.onSerialData = (ch) => {
    out += ch;
  };
  const runUntil = (budget: number, pred: () => boolean) => {
    for (let i = 0; i < budget; i++) {
      sim.step();
      if ((i & 0x3ff) === 0 && pred()) return;
    }
  };
  const key = (row: number, column: number, down: boolean) =>
    el.dispatchEvent(
      new CustomEvent(down ? 'button-press' : 'button-release', {
        detail: { key: LEGENDS[row][column], row, column },
      }),
    );
  return { out: () => out, runUntil, key, cleanup };
}

describe('membrane keypad — real Keypad.h firmware on the Uno', () => {
  it('reads every pressed key once, on the wiring from issue #327', () => {
    const kp = boot();
    kp.runUntil(5_000_000, () => kp.out().includes('READY'));
    expect(kp.out()).toContain('READY');

    // Corners and a middle key: every row pin and every column pin takes part.
    const presses: Array<[number, number]> = [
      [2, 2],
      [0, 0],
      [3, 3],
      [3, 0],
      [0, 3],
      [1, 1],
    ];
    for (const [row, column] of presses) {
      const want = `KEY:${LEGENDS[row][column]}`;
      kp.key(row, column, true);
      kp.runUntil(5_000_000, () => kp.out().includes(want));
      expect(kp.out()).toContain(want);
      kp.key(row, column, false);
      kp.runUntil(1_000_000, () => false); // past the library's debounce
    }

    const lines = kp.out().split(/\r?\n/).filter((l) => l.startsWith('KEY:'));
    expect(lines).toEqual(presses.map(([r, c]) => `KEY:${LEGENDS[r][c]}`));
    kp.cleanup?.();
  });

  it('reports nothing while no key is held', () => {
    const kp = boot();
    kp.runUntil(5_000_000, () => kp.out().includes('READY'));
    kp.runUntil(3_000_000, () => false);
    expect(kp.out()).not.toContain('KEY:');
    kp.cleanup?.();
  });
});
