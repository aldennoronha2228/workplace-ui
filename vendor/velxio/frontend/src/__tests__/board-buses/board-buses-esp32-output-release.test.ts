/**
 * A chip that pulls a line the ESP32 drives as an OUTPUT, then lets go,
 * hands the wire back to the ESP32's output level (finding
 * chip-release-leaves-esp32-output-at-chip-level).
 *
 * The in-browser ESP32 engines report no pad events, only direction, pull and
 * the level of an output, and that level only when the output latch MOVES
 * (esp32c6js gpio.ts). The board-pin net saw such a pad as Hi-Z, so the
 * chip's release resolved the line to Z and the wire kept the chip's level.
 * The first write of the same level the latch already held moved nothing, so
 * the line stayed where the chip had left it.
 *
 * The Grove 4-Digit Display's TM1637 is the chip that met this: it ACKs every
 * byte by pulling DIO low for the 9th clock while the sketch's latch still
 * holds the byte's last bit. After a byte ending in 1 (0xC0, a digit with the
 * colon) the next 1 bits never reached the chip, and the clock example on the
 * XIAO ESP32-C6 showed a blank first digit.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PinManager } from '../../simulation/PinManager';
import { ChipInstance } from '../../simulation/customChips/ChipRuntime';
import { resetBusNets } from '../../simulation/customChips/busNets';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const openDrain = () => new Uint8Array(readFileSync(join(FIXTURES, 'chips-other-chips/open-drain.wasm')));

const LINE = 5; // the pin the chip pulls and the sketch drives as an OUTPUT
const TRIG = 6; // a pin the sketch drives, which tells the chip when to pull

/** An ESP32-shaped board: an output reports its level only when it moves. */
async function esp32ShapedBoard(lineDirection: 0 | 1, lineLevel: boolean) {
  const pm = new PinManager();
  pm.setPinDirection(LINE, lineDirection);
  pm.setPinDirection(TRIG, 1);
  pm.triggerPinChange(LINE, lineLevel, 'mcu');
  pm.triggerPinChange(TRIG, false, 'mcu');
  const chip = await ChipInstance.create({
    wasm: openDrain(),
    pinManager: pm,
    wires: new Map([['IRQ', LINE], ['TRIG', TRIG]]),
    attrs: new Map([['idiom', 1]]),
    componentId: 'od',
    log: () => {},
  });
  const guest: boolean[] = [];
  chip.onDigitalWrite((name, level) => {
    if (name === 'IRQ') guest.push(level);
  });
  chip.start();
  return { pm, chip, guest };
}

afterEach(() => resetBusNets());

describe('chip-release-leaves-esp32-output-at-chip-level', () => {
  it('the release puts the output latch back on the wire', async () => {
    const { pm, chip, guest } = await esp32ShapedBoard(1, true);
    for (let pulse = 0; pulse < 3; pulse++) {
      pm.triggerPinChange(TRIG, true, 'mcu');
      expect(pm.getPinState(LINE)).toBe(false);
      pm.triggerPinChange(TRIG, false, 'mcu');
      // Before the fix: still false, the chip's level, with the latch HIGH.
      expect(pm.getPinState(LINE)).toBe(true);
      expect(guest.at(-1)).toBe(true);
    }
    chip.dispose();
  });

  it('follows what the output wrote while the chip held the line', async () => {
    const { pm, chip } = await esp32ShapedBoard(1, true);
    pm.triggerPinChange(TRIG, true, 'mcu');
    // The latch moves to LOW while the chip still pulls: the next release
    // must restore LOW, not the HIGH the output had when the pull began.
    pm.triggerPinChange(LINE, false, 'mcu');
    pm.triggerPinChange(TRIG, false, 'mcu');
    expect(pm.getPinState(LINE)).toBe(false);
    // A later pull and release, the latch LOW all along: nothing to restore.
    pm.triggerPinChange(TRIG, true, 'mcu');
    pm.triggerPinChange(TRIG, false, 'mcu');
    expect(pm.getPinState(LINE)).toBe(false);
    // The latch goes HIGH on its own, then a pull: back to HIGH on release.
    pm.triggerPinChange(LINE, true, 'mcu');
    pm.triggerPinChange(TRIG, true, 'mcu');
    expect(pm.getPinState(LINE)).toBe(false);
    pm.triggerPinChange(TRIG, false, 'mcu');
    expect(pm.getPinState(LINE)).toBe(true);
    chip.dispose();
  });

  it('an input with no pull still keeps the level it had, as a floating input does', async () => {
    const { pm, chip } = await esp32ShapedBoard(0, true);
    pm.triggerPinChange(TRIG, true, 'mcu');
    expect(pm.getPinState(LINE)).toBe(false);
    pm.triggerPinChange(TRIG, false, 'mcu');
    expect(pm.getPinState(LINE)).toBe(false);
    chip.dispose();
  });
});
