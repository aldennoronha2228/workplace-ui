/**
 * input-part-rail-pin.test.ts — a button drives the leg that reaches a pin,
 * whichever leg that is.
 *
 * A pushbutton has four legs and no polarity: the user decides which one goes
 * to the GPIO and which to GND. The part resolved its pin with
 * `getArduinoPin('1.l') ?? getArduinoPin('2.l') ?? ...`, which reads as "the
 * first leg that is wired". But a leg on GND does not resolve to null. It
 * resolves to -1 (PinTrace's RAIL), and `??` only falls through on null.
 *
 * Found on a Raspberry Pi, whose shim takes the level a part pushes (the
 * boards whose inputs come from the SPICE solve never call setPinState, which
 * is why this hid for so long). The gallery example with the button wired
 * GND on 1.l and GPIO27 on 2.l sent this to the guest on every press:
 *
 *     {"type":"gpio_in","data":{"pin":-1,"state":0}}
 *
 * while the same button wired the other way round sent pin 17.
 */
import { describe, it, expect, vi } from 'vitest';
import { firstBoardPin } from '../simulation/parts/partUtils';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/BasicParts';

const RAIL = -1;

/** A board that takes the level a part pushes, like the Raspberry Pi shim. */
const pushBoard = () => ({ setPinState: vi.fn(), spiceDrivenInputs: false });

const wiring = (map: Record<string, number | null>) => (name: string) =>
  name in map ? map[name] : null;

describe('firstBoardPin', () => {
  it('skips a rail and an unwired leg, and takes the first real pin', () => {
    expect(firstBoardPin(wiring({ '1.l': RAIL, '2.l': 27 }), ['1.l', '2.l', '1.r', '2.r'])).toBe(27);
    expect(firstBoardPin(wiring({ '1.r': 5 }), ['1.l', '2.l', '1.r', '2.r'])).toBe(5);
    expect(firstBoardPin(wiring({ '1.l': 17, '2.l': RAIL }), ['1.l', '2.l'])).toBe(17);
  });

  it('is null when nothing reaches a pin, and pin 0 is a pin', () => {
    expect(firstBoardPin(wiring({ '1.l': RAIL, '2.l': RAIL }), ['1.l', '2.l'])).toBeNull();
    expect(firstBoardPin(wiring({}), ['1.l'])).toBeNull();
    expect(firstBoardPin(wiring({ '1.l': 0 }), ['1.l'])).toBe(0);
  });
});

describe.each(['pushbutton', 'pushbutton-6mm'])('%s', (partId) => {
  const attach = (map: Record<string, number | null>) => {
    const logic = PartSimulationRegistry.get(partId);
    expect(logic?.attachEvents, `${partId} is registered`).toBeTruthy();
    const element = new EventTarget() as unknown as HTMLElement;
    const board = pushBoard();
    const cleanup = logic!.attachEvents!(element, board as never, wiring(map), 'btn');
    return { element, board, cleanup };
  };

  it('GND on the first leg, GPIO on the second: the press reaches the GPIO', () => {
    const { element, board } = attach({ '1.l': RAIL, '2.l': 27 });
    expect(board.setPinState).toHaveBeenLastCalledWith(27, true); // idles high
    element.dispatchEvent(new Event('button-press'));
    expect(board.setPinState).toHaveBeenLastCalledWith(27, false);
    element.dispatchEvent(new Event('button-release'));
    expect(board.setPinState).toHaveBeenLastCalledWith(27, true);
    for (const call of board.setPinState.mock.calls) expect(call[0]).not.toBe(RAIL);
  });

  it('the other way round still works', () => {
    const { element, board } = attach({ '1.l': 17, '2.l': RAIL });
    element.dispatchEvent(new Event('button-press'));
    expect(board.setPinState).toHaveBeenLastCalledWith(17, false);
  });

  it('a button between two rails drives nothing', () => {
    const { element, board } = attach({ '1.l': RAIL, '2.l': RAIL });
    element.dispatchEvent(new Event('button-press'));
    expect(board.setPinState).not.toHaveBeenCalled();
  });
});

describe('slide-switch', () => {
  it('common on a rail, a throw on the GPIO: the GPIO is the one driven', () => {
    const logic = PartSimulationRegistry.get('slide-switch');
    const element = new EventTarget() as unknown as HTMLElement;
    const board = pushBoard();
    logic!.attachEvents!(element, board as never, wiring({ '2': RAIL, '1': 22 }), 'sw');
    expect(board.setPinState).toHaveBeenCalled();
    for (const call of board.setPinState.mock.calls) expect(call[0]).toBe(22);
  });
});
