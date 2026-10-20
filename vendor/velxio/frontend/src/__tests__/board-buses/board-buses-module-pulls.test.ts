/**
 * A module's own pull resistors on a board pin (finding
 * module-pullup-not-modelled).
 *
 * Breakout and Grove modules carry resistors on their data lines: 10k
 * pull-ups on a TM1637 display's CLK and DIO, 4.7k on a DS18B20 module's DQ.
 * An open-drain driver releases a line with pinMode(INPUT) and reads HIGH
 * only through them; avishorp's TM1637Display does it for every 1 bit. The
 * board-pin net did not know the resistor existed, so a released line kept
 * whatever the MCU last drove (LOW) in the guest and on the level channel,
 * and the display never saw a clock edge.
 *
 * The rule under test (busNets.ts header, docs/wiki/board-buses.md "Pull
 * resistors on a line"): a module pull is a PULL-strength driver of the board
 * pin that stays on the net while the part exists. Any strong drive beats it
 * (the MCU's output, a chip pulling low, a part's injection) with no
 * contention; with none it sets the level, and it beats the MCU's internal
 * pull the other way (the smaller resistor sets the divider).
 *
 * Two hosts, because an MCU says "released" through different channels:
 *   - a pad-reporting engine (AVR, RP2040, RP2350, XIAO ARM): pad events;
 *   - an ESP32 engine: direction and pull channels only, and a level only
 *     when its output latch moves.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PinManager } from '../../simulation/PinManager';
import { ChipInstance } from '../../simulation/customChips/ChipRuntime';
import { resetBusNets, setBoardPinPull } from '../../simulation/customChips/busNets';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const openDrain = () => new Uint8Array(readFileSync(join(FIXTURES, 'chips-other-chips/open-drain.wasm')));

const LINE = 5; // the open-drain line: the chip's IRQ, the module's pull-up
const TRIG = 6; // a pin the sketch drives, which tells the chip when to pull

async function bootChip(pm: PinManager, pulls: Record<string, 'up' | 'down'> | null) {
  const chip = await ChipInstance.create({
    wasm: openDrain(),
    pinManager: pm,
    wires: new Map([['IRQ', LINE], ['TRIG', TRIG]]),
    attrs: new Map([['idiom', 1]]),
    componentId: 'od',
    pulls,
    log: () => {},
  });
  // What reaches the guest's input register, through the host's door.
  const guest: boolean[] = [];
  chip.onDigitalWrite((name, level) => {
    if (name === 'IRQ') guest.push(level);
  });
  chip.start();
  return { chip, guest };
}

/** AVR / RP2040 shaped: what the MCU does to a pad is on the pad channel. */
function padMcu(pm: PinManager) {
  let cycle = 0;
  return {
    drive(pin: number, high: boolean) {
      pm.reportPad(pin, high ? 'high' : 'low', 0, cycle++);
      pm.setPinState(pin, high, 'mcu');
    },
    /** pinMode(INPUT), or INPUT_PULLUP / INPUT_PULLDOWN with `pull`. */
    release(pin: number, pull: 0 | 1 | 2 = 0) {
      pm.reportPad(pin, 'z', pull, cycle++);
    },
  };
}

/** ESP32 shaped (esp32c6js gpio.ts): direction and pull channels, and a level
 *  only when the output latch moves or the pad becomes an output. */
function esp32Mcu(pm: PinManager) {
  const latch = new Map<number, boolean>();
  const out = new Map<number, boolean>();
  return {
    write(pin: number, high: boolean) {
      const before = latch.get(pin);
      latch.set(pin, high);
      if (out.get(pin) && before !== high) pm.setPinState(pin, high, 'mcu');
    },
    output(pin: number) {
      const was = out.get(pin);
      out.set(pin, true);
      pm.setPinPull(pin, 0);
      pm.setPinDirection(pin, 1);
      if (!was) pm.setPinState(pin, latch.get(pin) ?? false, 'mcu');
    },
    release(pin: number, pull: 0 | 1 | 2 = 0) {
      out.set(pin, false);
      pm.setPinPull(pin, pull);
      pm.setPinDirection(pin, 0);
    },
  };
}

afterEach(() => {
  resetBusNets();
  vi.restoreAllMocks();
});

describe('module pull-ups on a board pin, pad-reporting engine', () => {
  it('a line the MCU releases with pinMode(INPUT) reads HIGH through the module pull-up', async () => {
    const pm = new PinManager();
    const mcu = padMcu(pm);
    mcu.drive(LINE, false);
    const { chip, guest } = await bootChip(pm, { IRQ: 'up' });
    expect(pm.getPinState(LINE)).toBe(false);
    mcu.release(LINE);
    // Before: false in both places, the level the MCU last drove.
    expect(pm.getPinState(LINE)).toBe(true);
    expect(guest.at(-1)).toBe(true);
    mcu.drive(LINE, false);
    expect(pm.getPinState(LINE)).toBe(false);
    mcu.release(LINE);
    expect(pm.getPinState(LINE)).toBe(true);
    chip.dispose();
  });

  it('without the declaration the released line keeps its level, as before', async () => {
    const pm = new PinManager();
    const mcu = padMcu(pm);
    mcu.drive(LINE, false);
    const { chip } = await bootChip(pm, null);
    mcu.release(LINE);
    expect(pm.getPinState(LINE)).toBe(false);
    chip.dispose();
  });

  it('the chip pulls the line low and its release hands it back to the pull-up', async () => {
    const pm = new PinManager();
    const mcu = padMcu(pm);
    mcu.drive(TRIG, false);
    mcu.release(LINE);
    const { chip, guest } = await bootChip(pm, { IRQ: 'up' });
    expect(pm.getPinState(LINE)).toBe(true);
    for (let i = 0; i < 3; i++) {
      mcu.drive(TRIG, true);
      expect(pm.getPinState(LINE)).toBe(false);
      expect(guest.at(-1)).toBe(false);
      mcu.drive(TRIG, false);
      expect(pm.getPinState(LINE)).toBe(true);
      expect(guest.at(-1)).toBe(true);
    }
    chip.dispose();
  });

  it('a strong drive wins over the pull with no contention warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pm = new PinManager();
    const mcu = padMcu(pm);
    mcu.release(LINE);
    const { chip } = await bootChip(pm, { IRQ: 'up' });
    mcu.drive(LINE, false);
    expect(pm.getPinState(LINE)).toBe(false);
    // The chip pulls low too: same level, still no fight.
    mcu.drive(TRIG, true);
    mcu.drive(TRIG, false);
    mcu.release(LINE);
    expect(pm.getPinState(LINE)).toBe(true);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[chipbus]'))).toEqual([]);
    chip.dispose();
  });

  it("a part's injection (a button to GND) beats the pull; the pad's own latch does not", async () => {
    const pm = new PinManager();
    const mcu = padMcu(pm);
    mcu.release(LINE);
    const { chip } = await bootChip(pm, { IRQ: 'up' });
    expect(pm.getPinState(LINE)).toBe(true);
    pm.setPinState(LINE, false, 'external');
    expect(pm.getPinState(LINE)).toBe(false);
    pm.setPinState(LINE, true, 'external');
    expect(pm.getPinState(LINE)).toBe(true);
    // The AVR's PORT latch of an input pad comes through updatePort as the
    // pad's pull: INPUT_PULLUP then back to INPUT leaves the module's HIGH.
    pm.updatePort('PORTD', 1 << LINE, 0, undefined, 0);
    expect(pm.getPinState(LINE)).toBe(true);
    pm.updatePort('PORTD', 0, 1 << LINE, undefined, 0);
    expect(pm.getPinState(LINE)).toBe(true);
    chip.dispose();
  });

  it("the module's resistor beats the MCU's internal pull the other way", async () => {
    const pm = new PinManager();
    const mcu = padMcu(pm);
    const { chip } = await bootChip(pm, { IRQ: 'up' });
    mcu.release(LINE, 2); // INPUT_PULLDOWN against a 10k pull-up
    expect(pm.getPinState(LINE)).toBe(true);
    chip.dispose();
    // The part gone, the pad's pull-down has the line again.
    const { chip: down } = await bootChip(pm, { IRQ: 'down' });
    mcu.release(LINE, 1); // INPUT_PULLUP against a module pull-down
    expect(pm.getPinState(LINE)).toBe(false);
    down.dispose();
  });

  it('two modules pulling a line opposite ways say so once and hold the level', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pm = new PinManager();
    const mcu = padMcu(pm);
    mcu.release(LINE);
    const { chip } = await bootChip(pm, { IRQ: 'up' });
    expect(pm.getPinState(LINE)).toBe(true);
    setBoardPinPull(pm, LINE, 'other::DQ~pull', 'down', () => {});
    expect(pm.getPinState(LINE)).toBe(true);
    mcu.drive(LINE, false);
    mcu.release(LINE);
    const pullWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('pull-up and a pull-down'));
    expect(pullWarnings).toHaveLength(1);
    setBoardPinPull(pm, LINE, 'other::DQ~pull', null, () => {});
    chip.dispose();
  });

  it('a board reset puts the pulled level back on the wire', async () => {
    const pm = new PinManager();
    const mcu = padMcu(pm);
    const { chip } = await bootChip(pm, { IRQ: 'up' });
    mcu.drive(LINE, true);
    pm.hardResetPinStates();
    expect(pm.getPinState(LINE)).toBe(true);
    chip.dispose();
  });

  it('pinMode(OUTPUT) over a latch already at 0 pulls the line low for the parts on it', async () => {
    // The AVR moves no PORT bit for this, so the level channel hears nothing
    // from the engine: only the pad channel says the line is driven. On a
    // line the module pulled HIGH the parts must still see it go LOW, or a
    // TM1637 never sees a clock edge (avishorp's library, on a real Uno).
    const pm = new PinManager();
    let cycle = 0;
    const { chip } = await bootChip(pm, { IRQ: 'up' });
    const seen: boolean[] = [];
    pm.onPinChange(LINE, (_p, l) => seen.push(l));
    for (let i = 0; i < 3; i++) {
      pm.reportPad(LINE, 'z', 0, cycle++);
      expect(pm.getPinState(LINE)).toBe(true);
      pm.reportPad(LINE, 'low', 0, cycle++);
      expect(pm.getPinState(LINE)).toBe(false);
    }
    expect(seen).toEqual([false, true, false, true, false]);
    chip.dispose();
  });

  it('dispose takes the resistor off the line', async () => {
    const pm = new PinManager();
    const mcu = padMcu(pm);
    mcu.drive(LINE, false);
    const { chip } = await bootChip(pm, { IRQ: 'up' });
    chip.dispose();
    mcu.release(LINE);
    expect(pm.getPinState(LINE)).toBe(false);
  });
});

describe('module pull-ups on a board pin, ESP32 engine (no pad channel)', () => {
  it('pinMode(INPUT) reads HIGH through the module pull-up; OUTPUT LOW wins', async () => {
    const pm = new PinManager();
    const mcu = esp32Mcu(pm);
    mcu.write(LINE, false);
    mcu.output(LINE);
    const { chip, guest } = await bootChip(pm, { IRQ: 'up' });
    // An output the latch holds LOW: the pull loses to it.
    expect(pm.getPinState(LINE)).toBe(false);
    for (let i = 0; i < 3; i++) {
      mcu.release(LINE);
      // Before: nothing told the net, and the line stayed LOW.
      expect(pm.getPinState(LINE)).toBe(true);
      expect(guest.at(-1)).toBe(true);
      mcu.output(LINE);
      expect(pm.getPinState(LINE)).toBe(false);
    }
    chip.dispose();
  });

  it('the chip ACK on a released line, then the pull-up again', async () => {
    const pm = new PinManager();
    const mcu = esp32Mcu(pm);
    mcu.output(TRIG);
    mcu.release(LINE);
    const { chip } = await bootChip(pm, { IRQ: 'up' });
    expect(pm.getPinState(LINE)).toBe(true);
    mcu.write(TRIG, true);
    expect(pm.getPinState(LINE)).toBe(false);
    mcu.write(TRIG, false);
    expect(pm.getPinState(LINE)).toBe(true);
    chip.dispose();
  });

  it('an output HIGH the chip pulls low comes back HIGH on release, the pull changes nothing', async () => {
    const pm = new PinManager();
    const mcu = esp32Mcu(pm);
    mcu.output(TRIG);
    mcu.write(LINE, true);
    mcu.output(LINE);
    const { chip } = await bootChip(pm, { IRQ: 'up' });
    mcu.write(TRIG, true);
    expect(pm.getPinState(LINE)).toBe(false);
    mcu.write(TRIG, false);
    expect(pm.getPinState(LINE)).toBe(true);
    // The sketch writes LOW: the output, not the pull, has the line.
    mcu.write(LINE, false);
    expect(pm.getPinState(LINE)).toBe(false);
    chip.dispose();
  });
});
