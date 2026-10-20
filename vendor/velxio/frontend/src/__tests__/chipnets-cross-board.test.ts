/**
 * A chip-to-chip net with chips on two boards is one net.
 *
 * Each board's browser-hosted endpoints share the PinManager key
 * syntheticNetPin(net); a worker-hosted board keeps the net on its own bus
 * and talks in `chip_net` events. Interconnect mirrors a level between them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

import { resetStore, clearAllPinManagerState } from './helpers/multiBoardSetup';
import { resetInterconnect, getChipNetLinks } from '../simulation/Interconnect';
import { useSimulatorStore, getBoardPinManager, getEsp32Bridge } from '../store/useSimulatorStore';
import {
  resolveCrossBoardChipNets,
  setChipBusEnabledForTest,
  resetChipNetIndexForTest,
} from '../simulation/customChips/chipNets';
import { syntheticNetPin } from '../simulation/customChips/syntheticPins';

const chip = (id: string, x = 300) => ({ id, metadataId: 'custom-chip', x, y: 100, properties: {} });
const wire = (i: number, aId: string, aPin: string, bId: string, bPin: string) => ({
  id: `w${i}`,
  start: { componentId: aId, pinName: aPin },
  end: { componentId: bId, pinName: bPin },
  waypoints: [],
  color: '#0a0',
});

function fullReset() {
  clearAllPinManagerState(useSimulatorStore, getBoardPinManager);
  resetInterconnect();
  resetStore(useSimulatorStore);
  resetChipNetIndexForTest();
}

/** Uno A with chipA, board B (kind given) with chipB, chipA.OUT to chipB.IN. */
function twoBoards(kindB: 'arduino-uno' | 'esp32') {
  const store = useSimulatorStore.getState();
  const idA = 'arduino-uno';
  const idB = store.addBoard(kindB, 500, 100);
  useSimulatorStore.getState().setComponents([chip('chipA'), chip('chipB', 600)] as never);
  useSimulatorStore.getState().setWires([
    wire(1, 'chipA', 'VCC', idA, '5V'), // chipA belongs to board A
    wire(2, 'chipB', 'VCC', idB, kindB === 'esp32' ? '3V3' : '5V'), // chipB to board B
    wire(3, 'chipA', 'OUT', 'chipB', 'IN'), // the chip-to-chip net
  ] as never);
  return { idA, idB };
}

describe('cross-board chip nets', () => {
  beforeEach(() => {
    setChipBusEnabledForTest(true);
    fullReset();
  });
  afterEach(() => {
    fullReset();
    setChipBusEnabledForTest(null);
  });

  it('resolves the net, its shared pin and both owner boards', () => {
    const { idA, idB } = twoBoards('arduino-uno');
    const st = useSimulatorStore.getState();
    const nets = resolveCrossBoardChipNets({ wires: st.wires, components: st.components, boards: st.boards });
    expect(nets).toHaveLength(1);
    expect(nets[0].boards).toEqual([idA, idB].sort());
    expect(nets[0].pin).toBe(syntheticNetPin(nets[0].net));
    expect(getChipNetLinks().map((l) => l.net)).toEqual([nets[0].net]);
  });

  it('mirrors a level between two browser boards, both ways, once', () => {
    const { idA, idB } = twoBoards('arduino-uno');
    const [link] = getChipNetLinks();
    const pmA = getBoardPinManager(idA)!;
    const pmB = getBoardPinManager(idB)!;
    const seenB: boolean[] = [];
    pmB.onPinChange(link.pin, (_p: number, s: boolean) => seenB.push(s));
    pmA.setPinState(link.pin, true);
    expect(pmB.getPinState(link.pin)).toBe(true);
    expect(seenB).toEqual([true]);
    pmB.setPinState(link.pin, false);
    expect(pmA.getPinState(link.pin)).toBe(false);
    expect(seenB).toEqual([true, false]);
  });

  it('carries the level between a browser board and a worker board', () => {
    const { idA, idB } = twoBoards('esp32');
    const [link] = getChipNetLinks();
    const bridge = getEsp32Bridge(idB) as unknown as {
      sendChipNet: (net: string, level: 0 | 1, ts: number) => void;
      onChipNet: ((net: string, level: 0 | 1, ts: number) => void) | null;
    };
    const sent = vi.spyOn(bridge, 'sendChipNet').mockImplementation(() => {});
    // Browser chip on the Uno drives the net: the ESP32 worker hears it.
    getBoardPinManager(idA)!.setPinState(link.pin, true);
    expect(sent).toHaveBeenCalledWith(link.net, 1, expect.any(Number));
    // The worker's chip drives it back: the Uno's PinManager follows.
    bridge.onChipNet?.(link.net, 0, 1);
    expect(getBoardPinManager(idA)!.getPinState(link.pin)).toBe(false);
    // And that write did not echo back to the worker.
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('is nothing when the chips sit on one board', () => {
    const store = useSimulatorStore.getState();
    store.setComponents([chip('chipA'), chip('chipB', 600)] as never);
    store.setWires([
      wire(1, 'chipA', 'VCC', 'arduino-uno', '5V'),
      wire(2, 'chipB', 'VCC', 'arduino-uno', '5V'),
      wire(3, 'chipA', 'OUT', 'chipB', 'IN'),
    ] as never);
    expect(getChipNetLinks()).toEqual([]);
  });
});
