/**
 * A module's pull resistors reach a board whose guest runs in a QEMU worker.
 *
 * The tab puts a module's resistor on the board pin's net (busNets
 * setBoardPinPull; board-buses-module-pulls.test.ts is the tab's own
 * resolution), but on the ESP32 and STM32 QEMU boards the guest's input
 * register is the worker's: QEMU keeps the last level written, so a line the
 * guest releases with pinMode(INPUT) read the LOW it drove. The worker now has
 * a pad model (backend app/services/pad_model.py) and needs to know where the
 * resistors are: the `pulls` half of the bus map, which
 *  - rides with start_esp32 / start_stm32, so a pad the guest reads before it
 *    ever drives it already has its resistor;
 *  - is sent again, alone, when a part's resistors come, move or go, and not
 *    when nothing changed;
 *  - carries the resistors of a custom chip the worker hosts (chip.json
 *    "pulls"), which no ChipInstance in this tab put on the net before.
 *
 * On the store's own boards with their real bridges and shims; the socket is
 * scripted and records every frame the tab sends.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});
vi.stubGlobal('document', { getElementById: () => null });

class ScriptedSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last: ScriptedSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  sent: Array<{ type: string; data?: Record<string, unknown> }> = [];
  constructor(_url: string) {
    ScriptedSocket.last = this;
  }
  send(frame: string): void {
    this.sent.push(JSON.parse(frame));
  }
  close(): void {
    this.readyState = ScriptedSocket.CLOSED;
  }
  open(): void {
    this.readyState = ScriptedSocket.OPEN;
    this.onopen?.();
  }
}
vi.stubGlobal('WebSocket', ScriptedSocket);

import { PartSimulationRegistry } from '../../simulation/parts/PartSimulationRegistry';
import '../../simulation/parts';
import { setBoardPinPull, boardPinPulls } from '../../simulation/customChips/busNets';
import {
  getBoardPinManager,
  getBoardSimulator,
  getEsp32Bridge,
  getStm32Bridge,
  useSimulatorStore,
} from '../../store/useSimulatorStore';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const OPEN_DRAIN_B64 = readFileSync(join(FIXTURES, 'chips-other-chips/open-drain.wasm')).toString('base64');

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const b of [...useSimulatorStore.getState().boards]) {
    useSimulatorStore.getState().removeBoard?.(b.id);
  }
  useSimulatorStore.setState({ wires: [], components: [] } as never);
});

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const noSink = () => {};

/** A module's resistor on a board pin, as ChipRuntime._applyModulePulls puts it. */
function pull(boardId: string, pin: number, owner: string, dir: 'up' | 'down' | null): void {
  setBoardPinPull(getBoardPinManager(boardId)!, pin, `${owner}~pull`, dir, noSink);
}

function connectEsp32(id: string): ScriptedSocket {
  getEsp32Bridge(id)!.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  cleanups.push(() => getEsp32Bridge(id)?.disconnect());
  return ws;
}

function connectStm32(id: string): ScriptedSocket {
  getStm32Bridge(id)!.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  cleanups.push(() => getStm32Bridge(id)?.disconnect());
  return ws;
}

const startPulls = (ws: ScriptedSocket, type: string) =>
  (ws.sent.find((m) => m.type === type)?.data?.bus_map as { pulls?: unknown[] } | undefined)?.pulls;

const livePulls = (ws: ScriptedSocket, type: string) =>
  ws.sent.filter((m) => m.type === type && m.data && 'pulls' in m.data).map((m) => m.data!.pulls);

const TM1637 = [
  { pin: 18, pull: 'up', owner: 'grove::CLK~pull' },
  { pin: 19, pull: 'up', owner: 'grove::DIO~pull' },
];

describe('QEMU ESP32: the pulls half of the bus map', () => {
  it('rides with start_esp32', async () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    pull(id, 19, 'grove::DIO', 'up');
    pull(id, 18, 'grove::CLK', 'up');
    await settle();
    const ws = connectEsp32(id);
    expect(startPulls(ws, 'start_esp32')).toEqual(TM1637);
  });

  it('follows the parts while the guest runs, and is not resent when nothing changed', async () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const ws = connectEsp32(id);
    expect(startPulls(ws, 'start_esp32')).toEqual([]);
    pull(id, 18, 'grove::CLK', 'up');
    pull(id, 19, 'grove::DIO', 'up');
    await settle();
    expect(livePulls(ws, 'esp32_bus_map')).toEqual([TM1637]);
    // A re-wire takes the resistors off and puts them back in one burst.
    pull(id, 18, 'grove::CLK', null);
    pull(id, 18, 'grove::CLK', 'up');
    await settle();
    expect(livePulls(ws, 'esp32_bus_map')).toEqual([TM1637]);
    // The part moves DIO to GPIO 21.
    pull(id, 19, 'grove::DIO', null);
    pull(id, 21, 'grove::DIO', 'up');
    await settle();
    // And goes away.
    pull(id, 18, 'grove::CLK', null);
    pull(id, 21, 'grove::DIO', null);
    await settle();
    expect(livePulls(ws, 'esp32_bus_map').slice(1)).toEqual([
      [
        { pin: 18, pull: 'up', owner: 'grove::CLK~pull' },
        { pin: 21, pull: 'up', owner: 'grove::DIO~pull' },
      ],
      [],
    ]);
  });

  it("names only this board's pins", async () => {
    const a = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const b = useSimulatorStore.getState().addBoard('esp32', 400, 0);
    pull(b, 18, 'other::DQ', 'down');
    await settle();
    const ws = connectEsp32(a);
    expect(startPulls(ws, 'start_esp32')).toEqual([]);
    expect(boardPinPulls(getBoardPinManager(b)!)).toEqual([{ pin: 18, pull: 'down', owner: 'other::DQ~pull' }]);
  });

  it("carries a worker-hosted custom chip's chip.json pulls", async () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    useSimulatorStore.setState({
      components: [
        {
          id: 'od',
          metadataId: 'custom-chip',
          x: 0,
          y: 0,
          properties: {
            wasmBase64: OPEN_DRAIN_B64,
            chipJson: JSON.stringify({ name: 'open-drain', pins: ['IRQ', 'TRIG'], pulls: { IRQ: 'up' } }),
            attrs: {},
          },
        },
      ],
    } as never);
    const pins: Record<string, number> = { IRQ: 18, TRIG: 19 };
    const off = PartSimulationRegistry.get('custom-chip')!.attachEvents!(
      { id: 'od' } as unknown as HTMLElement,
      getBoardSimulator(id) as never,
      (pin: string) => (pin in pins ? pins[pin] : null),
      'od',
    );
    await settle();
    const ws = connectEsp32(id);
    const rec = (ws.sent.find((m) => m.type === 'start_esp32')?.data?.sensors as Array<Record<string, unknown>>).find(
      (s) => s.sensor_type === 'custom-chip',
    );
    expect(rec?.pin_map).toEqual(pins);
    expect(startPulls(ws, 'start_esp32')).toEqual([{ pin: 18, pull: 'up', owner: 'od::IRQ~pull' }]);
    off?.();
    await settle();
    expect(livePulls(ws, 'esp32_bus_map').at(-1)).toEqual([]);
  });
});

describe('QEMU STM32: the same half, on stm32_bus_map', () => {
  it('rides with start_stm32 and follows the parts', async () => {
    const id = useSimulatorStore.getState().addBoard('stm32-blackpill', 0, 0);
    pull(id, 0, 'grove::DIO', 'up');
    await settle();
    const ws = connectStm32(id);
    expect(startPulls(ws, 'start_stm32')).toEqual([{ pin: 0, pull: 'up', owner: 'grove::DIO~pull' }]);
    pull(id, 0, 'grove::DIO', null);
    await settle();
    expect(livePulls(ws, 'stm32_bus_map')).toEqual([[]]);
  });
});
