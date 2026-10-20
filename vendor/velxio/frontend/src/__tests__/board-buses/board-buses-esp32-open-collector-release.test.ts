/**
 * A chip that releases an open-collector line on an ESP32 pin lets the
 * guest's INPUT_PULLUP restore HIGH (finding
 * esp32-open-collector-release-reads-low, Kshyhoo's A3144 anemometer,
 * 2026-09-27).
 *
 * The in-browser ESP32 engines (and the QEMU bridge) do not report their pads
 * on the PinManager's pad channel; they report the direction and the pull the
 * guest programmed (onPinDir / onPinPull -> setPinDirection / setPinPull).
 * The board-pin net only read the pad channel, so on these boards the pull
 * was invisible: the chip's release resolved the line to Z, a Z leaves the
 * wire where it was, and the sketch read LOW for the rest of the run after
 * the first pulse. The AVR test of the same idiom (board-buses-repro-chips-
 * other, "chip releases a board pin") passed because the AVR reports pads.
 *
 * This drives the real open-drain fixture (vx_pin_set_mode(VX_OUTPUT_LOW) to
 * pull, vx_pin_set_mode(VX_INPUT) to release) against a PinManager shaped
 * like an ESP32 board: pull and direction reported, no pad events.
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

const IRQ = 5; // the sketch's INPUT_PULLUP + attachInterrupt(FALLING) pin
const TRIG = 6; // a pin the sketch drives, which tells the chip when to pull

async function esp32ShapedBoard(idiom: number, pull: 0 | 1 | 2) {
  const pm = new PinManager();
  // What an ESP32 bridge reports for pinMode(IRQ, INPUT_PULLUP) and
  // pinMode(TRIG, OUTPUT): direction and pull, never a pad event.
  pm.setPinDirection(IRQ, 0);
  pm.setPinPull(IRQ, pull);
  pm.setPinDirection(TRIG, 1);
  pm.triggerPinChange(IRQ, pull === 1, 'mcu');
  pm.triggerPinChange(TRIG, false, 'mcu');
  const chip = await ChipInstance.create({
    wasm: openDrain(),
    pinManager: pm,
    wires: new Map([['IRQ', IRQ], ['TRIG', TRIG]]),
    attrs: new Map([['idiom', idiom]]),
    componentId: 'od',
    log: () => {},
  });
  // The chip host's door into the guest's input register.
  const guest: boolean[] = [];
  chip.onDigitalWrite((name, level) => {
    if (name === 'IRQ') guest.push(level);
  });
  chip.start();
  return { pm, chip, guest };
}

afterEach(() => resetBusNets());

describe('esp32-open-collector-release-reads-low', () => {
  for (const [idiom, label] of [[1, 'set_mode(VX_OUTPUT_LOW)'], [0, 'set_mode(VX_OUTPUT) + write(0)']] as const) {
    it(`a pull made with ${label} reaches the pin, and the release restores the INPUT_PULLUP level`, async () => {
      const { pm, chip, guest } = await esp32ShapedBoard(idiom, 1);
      for (let pulse = 0; pulse < 3; pulse++) {
        pm.triggerPinChange(TRIG, true, 'mcu');
        expect(pm.getPinState(IRQ)).toBe(false);
        expect(guest.at(-1)).toBe(false);
        pm.triggerPinChange(TRIG, false, 'mcu');
        // Before the fix: still false, so the second FALLING edge never came.
        expect(pm.getPinState(IRQ)).toBe(true);
        expect(guest.at(-1)).toBe(true);
      }
      chip.dispose();
    });
  }

  it('with no pull the released line keeps its level, as a floating input does', async () => {
    const { pm, chip } = await esp32ShapedBoard(1, 0);
    pm.triggerPinChange(TRIG, true, 'mcu');
    expect(pm.getPinState(IRQ)).toBe(false);
    pm.triggerPinChange(TRIG, false, 'mcu');
    expect(pm.getPinState(IRQ)).toBe(false);
    chip.dispose();
  });
});
