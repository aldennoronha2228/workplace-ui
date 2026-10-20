/**
 * printf from a custom chip reaches the log line by line, from every
 * callback, not only the first line (finding chip-printf-fully-buffered,
 * 2026-09-27).
 *
 * wasi-libc decides stdout's buffering on the first write: it asks
 * fd_fdstat_get whether fd 1 is a character device with no seek/tell rights
 * (its isatty), and if not it switches stdout to FULL buffering. The shim
 * answered success without writing the fdstat struct, so the answer was
 * whatever the stack held: the first line came out, and every later printf
 * sat in libc's 1 KB buffer until it filled, which is minutes of silence for
 * a chip that prints a line a second. vx_log was not affected.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PinManager } from '../simulation/PinManager';
import { ChipInstance } from '../simulation/customChips/ChipRuntime';

const wasm = () =>
  new Uint8Array(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'board-buses/fixtures/chips-other-chips/printf-probe.wasm'),
    ),
  );

describe('chip-printf-fully-buffered', () => {
  it('every printf line of a chip reaches the log when its newline is printed', async () => {
    const lines: string[] = [];
    let now = 0n;
    const chip = await ChipInstance.create({
      wasm: wasm(),
      pinManager: new PinManager(),
      simNanos: () => now,
      log: (s) => lines.push(s.replace(/\n$/, '')),
    });
    chip.start();
    expect(lines).toEqual(['setup']);
    for (let k = 1; k <= 3; k++) {
      now = BigInt(k) * 1_000_000n;
      chip.tickTimers(now);
      // Before the fix: still ['setup'] here, the tick lines were buffered.
      expect(lines.at(-1)).toBe(`tick ${k}`);
    }
    chip.dispose();
  });
});
