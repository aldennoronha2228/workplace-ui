// @vitest-environment jsdom
/**
 * Board buses F6: the Raspberry Pi's header UART as a controller port
 * (project/board-buses-2026-09, F6-SPEC "Motores": "Pi shim / instant: UART0
 * (PL011)"), and the gate TESTS.md sets for this phase: the direction board
 * TO part, in both engines, with the temporary seam gone.
 *
 * Both engines that run a Pi script reach the board's header UART through
 * the same PiBridgeShim: the Linux guest's bytes arrive raw on the bridge
 * (`uart_tx`), the in-browser engine hands its bytes to the shim itself, and
 * what a part answers leaves through `sendSerialBytes` to whichever engine is
 * running. Until F6 the board's outgoing bytes reached the parts through
 * `noteHeaderUartTxTemporary`, a seam PR #358 added so the fifteen Grove
 * modules that only speak when spoken to could hear the question; this file
 * proves the fabric's port carries that direction now that the seam is
 * deleted, and that a part which talks on its own cannot make it pass
 * (evidence/FINDINGS.md `pi-board-uart-tx-never-reaches-parts`).
 *
 * The shared conformance suite runs first, on the store's own board. Then the
 * gate: an AT stand-in that says nothing until asked, wired to GPIO14/15,
 * asked by each engine in turn, read BEFORE asking.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

vi.mock('../../simulation/RaspberryPi3Bridge', () => ({
  RaspberryPi3Bridge: class {
    boardId: string;
    boardKind: string;
    connected = false;
    onSerialData: unknown = null;
    onPinChange: unknown = null;
    onPinPull: unknown = null;
    onBusRequest: unknown = null;
    onBusRelay: ((v: number) => void) | null = null;
    onGpioPwm: unknown = null;
    onBooted: unknown = null;
    onDisconnected: (() => void) | null = null;
    onError: unknown = null;
    /** The header UART's two slots, as RaspberryPi3Bridge declares them: the
     *  text one Interconnect chains for the peer boards, the raw one the shim
     *  owns for its UART port. */
    onUartTx: ((text: string) => void) | null = null;
    onUartTxBytes: ((bytes: Uint8Array) => void) | null = null;
    quietBootDefault = false;
    quietBootLabel = '';
    /** Every byte for the guest's header UART RX, in order. */
    rx: number[] = [];
    constructor(id: string, kind: string) {
      this.boardId = id;
      this.boardKind = kind;
    }
    connect() {}
    disconnect() {}
    sendPinEvent() {}
    sendBusTopology() {}
    sendUartBytes(bytes: number[]) {
      this.rx.push(...bytes);
    }
    /** The backend relayed `uart_tx`: what the real bridge does with it. */
    uartTx(bytes: number[]) {
      const raw = Uint8Array.from(bytes);
      this.onUartTxBytes?.(raw);
      this.onUartTx?.(new TextDecoder().decode(raw));
    }
  },
}));

import {
  useSimulatorStore,
  getBoardSimulator,
  getBoardBridge,
} from '../../store/useSimulatorStore';
import { PiBridgeShim } from '../../simulation/PiBridgeShim';
import { busRegistry } from '../../simulation/buses/registry';
import { attachUartEndpoint } from '../../simulation/buses';
import {
  defineUartPortConformance,
  type UartConformanceRig,
} from '../../simulation/buses/conformance/uartPortConformance';
import type { BusDiagnostic, UartEndpoint } from '../../simulation/buses/types';
import { feedBoardSerialOut } from '../../simulation/Interconnect';
import { setWires } from '../helpers/multiBoardSetup';

beforeAll(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

interface MockBridge {
  onBusRelay: ((v: number) => void) | null;
  onUartTx: ((text: string) => void) | null;
  onUartTxBytes: ((bytes: Uint8Array) => void) | null;
  rx: number[];
  uartTx(bytes: number[]): void;
}

const flush = () => new Promise<void>((r) => queueMicrotask(r));
const text = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const decode = (bytes: number[]) => new TextDecoder().decode(Uint8Array.from(bytes));

function addPi(kind = 'raspberry-pi-4') {
  const id = useSimulatorStore.getState().addBoard(kind as never, 100, 100);
  const shim = getBoardSimulator(id) as PiBridgeShim;
  const bridge = getBoardBridge(id) as unknown as MockBridge;
  return { id, shim, bridge };
}

/** Wire a part's RX/TX pads to the Pi's header UART pads, as the canvas does. */
function wireUart(boardId: string, componentId: string, rxTo = 'GPIO14', txTo = 'GPIO15'): void {
  useSimulatorStore.setState((s) => ({
    wires: [
      ...s.wires.filter((w) => w.start.componentId !== componentId),
      ...([
        ['RX', rxTo],
        ['TX', txTo],
      ] as const).map(([pinName, pad]) => ({
        id: `${componentId}-${pinName}`,
        start: { componentId, pinName, x: 0, y: 0 },
        end: { componentId: boardId, pinName: pad, x: 0, y: 0 },
        waypoints: [],
        color: '#0a0',
      })),
    ],
  }) as never);
  busRegistry.netlistChanged();
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setWires(useSimulatorStore, []);
  useSimulatorStore.setState({ wires: [] } as never);
});

// ── The shared suite, through the store ─────────────────────────────────────

async function storePiRig(kind: string): Promise<UartConformanceRig> {
  const { id, shim, bridge } = addPi(kind);
  // The probe stands where the fabric would: the store bound the board to
  // the page's fabric, which would otherwise hold the port beside it.
  busRegistry.unbindBoard(id);
  return {
    units: [0],
    binding: () => shim.getBusBinding(),
    transmit: async (_unit, bytes) => {
      bridge.uartTx(bytes);
    },
    read: async (_unit, n) => {
      // What the shim queued for the guest leaves per task.
      await flush();
      return bridge.rx.splice(0, n);
    },
    // A guest reboot under a running board: the backend announces the new
    // guest and the store restarts the bus sync.
    reset: async () => {
      bridge.onBusRelay?.(1);
    },
    stopRun: async () => {
      useSimulatorStore.getState().stopBoard(id);
      useSimulatorStore.getState().startBoard(id);
      bridge.onBusRelay?.(1);
    },
    // A Pi has no firmware to reload: a new Run boots a fresh guest.
    reload: async () => {
      useSimulatorStore.getState().stopBoard(id);
      useSimulatorStore.getState().startBoard(id);
      bridge.onBusRelay?.(1);
    },
    expectedRouting: () => ({ tx: 14, rx: 15 }),
    dispose: () => {
      useSimulatorStore.getState().removeBoard?.(id);
    },
  };
}

defineUartPortConformance('Raspberry Pi 4 shim (store board, Linux guest)', () => storePiRig('raspberry-pi-4'), {
  staticRouting: true,
});

// ── The gate: board to part, both engines, seam deleted ─────────────────────

/**
 * An AT modem in ten lines: it says nothing until it is spoken to, and
 * answers OK to a well-formed AT line through its handle, as the real Grove
 * AT modems (ESP8285, WizFi360, HM-11, BC417, Wio-E5) do through theirs.
 */
function attachAtModem(boardId: string, owner = 'modem'): { heard: number[] } {
  let line = '';
  const heard: number[] = [];
  const ep: UartEndpoint = {
    receive: (byte) => {
      heard.push(byte);
      const ch = String.fromCharCode(byte);
      if (ch !== '\r') {
        line += ch;
        return;
      }
      const reply = line.trim().toUpperCase() === 'AT' ? 'OK\r\n' : 'ERROR\r\n';
      line = '';
      for (const b of text(reply)) handle.transmit(b);
    },
  };
  wireUart(boardId, owner);
  const handle = attachUartEndpoint({ owner, pins: { rx: 'RX', tx: 'TX' } }, ep);
  cleanups.push(() => handle.dispose());
  return { heard };
}

describe('the header UART, board to part (TESTS.md, "Requisito de F6")', () => {
  it('Linux guest: the modem is silent until asked, then answers OK into the guest', async () => {
    const { id, bridge } = addPi();
    const { heard } = attachAtModem(id);
    // Read the port BEFORE asking: a part that talks on its own would make
    // this pass without the board ever being heard.
    await flush();
    expect(bridge.rx).toEqual([]);
    bridge.uartTx(text('AT\r'));
    await flush();
    expect(heard).toEqual(text('AT\r'));
    expect(decode(bridge.rx)).toBe('OK\r\n');
  });

  it('in-browser engine: the same modem, asked through the shim, answers into the engine', async () => {
    const { id, shim, bridge } = addPi();
    useSimulatorStore.setState((s) => ({
      boards: s.boards.map((b) => (b.id === id ? { ...b, engineMode: 'instant' } : b)),
    }));
    const answered: number[] = [];
    shim.instantAdapter = { onUartRx: (bytes) => answered.push(...bytes) };
    const { heard } = attachAtModem(id);
    await flush();
    expect(answered).toEqual([]);
    shim.headerUartTx(text('AT\r'));
    await flush();
    expect(heard).toEqual(text('AT\r'));
    expect(decode(answered)).toBe('OK\r\n');
    // The bridge is the OTHER engine: nothing went there.
    expect(bridge.rx).toEqual([]);
  });

  it('the temporary seam is gone: the Interconnect fan-out alone reaches no part', async () => {
    const { id, shim, bridge } = addPi();
    const { heard } = attachAtModem(id);
    expect((shim as unknown as { noteHeaderUartTxTemporary?: unknown }).noteHeaderUartTxTemporary).toBeUndefined();
    expect((shim as unknown as { tapHeaderUartTx?: unknown }).tapHeaderUartTx).toBeUndefined();
    for (const ch of 'AT\r') feedBoardSerialOut(id, ch, 0);
    await flush();
    expect(heard).toEqual([]);
    expect(bridge.rx).toEqual([]);
  });

  it('a modem wired RX-to-RX hears nothing, and the fabric says why', async () => {
    const { id, bridge } = addPi();
    const diags: BusDiagnostic[] = [];
    const off = busRegistry.onDiagnostic((d) => diags.push(d));
    cleanups.push(off);
    let heard: number[] = [];
    const handle = attachUartEndpoint(
      { owner: 'crossed', pins: { rx: 'RX', tx: 'TX' } },
      { receive: (b) => heard.push(b) },
    );
    cleanups.push(() => handle.dispose());
    wireUart(id, 'crossed', 'GPIO15', 'GPIO14');
    heard = [];
    bridge.uartTx(text('AT\r'));
    await flush();
    expect(heard).toEqual([]);
    expect(diags.map((d) => d.code)).toContain('uart-wiring');
  });

  it('one part, two engines: switching the engine keeps the same port and the same endpoint', async () => {
    const { id, shim, bridge } = addPi();
    const { heard } = attachAtModem(id);
    const port = shim.getBusBinding().uart![0];
    bridge.uartTx(text('AT\r'));
    await flush();
    expect(decode(bridge.rx.splice(0))).toBe('OK\r\n');
    useSimulatorStore.setState((s) => ({
      boards: s.boards.map((b) => (b.id === id ? { ...b, engineMode: 'instant' } : b)),
    }));
    const answered: number[] = [];
    shim.instantAdapter = { onUartRx: (bytes) => answered.push(...bytes) };
    shim.headerUartTx(text('AT\r'));
    await flush();
    expect(decode(answered)).toBe('OK\r\n');
    expect(shim.getBusBinding().uart![0]).toBe(port);
    expect(heard).toEqual(text('AT\rAT\r'));
    // Stop/Run: the port and the endpoint survive. A Run picks the engine
    // again (no in-browser engine is registered here, so the router says
    // Linux) and the real engine installs its adapter per run; both are
    // put back the way installInstantEngine does it.
    useSimulatorStore.getState().stopBoard(id);
    useSimulatorStore.getState().startBoard(id);
    useSimulatorStore.setState((s) => ({
      boards: s.boards.map((b) => (b.id === id ? { ...b, engineMode: 'instant' } : b)),
    }));
    shim.instantAdapter = { onUartRx: (bytes) => answered.push(...bytes) };
    expect(shim.getBusBinding().uart![0]).toBe(port);
    shim.headerUartTx(text('AT\r'));
    await flush();
    expect(decode(answered)).toBe('OK\r\nOK\r\n');
    expect(heard).toEqual(text('AT\rAT\rAT\r'));
  });

  it('hears each byte once while a peer board is on the same wire', async () => {
    const { id, bridge } = addPi();
    const { id: peerId, bridge: peerBridge } = addPi('raspberry-pi-3');
    const { heard } = attachAtModem(id);
    setWires(useSimulatorStore, [{ fromBoard: id, fromPin: 'GPIO14', toBoard: peerId, toPin: 'GPIO15' }]);
    // The Interconnect chains the text slot for the peer; the shim owns the
    // raw one. Each byte reaches the part once and the peer once.
    bridge.uartTx(text('AT'));
    await flush();
    expect(heard).toEqual([0x41, 0x54]);
    expect(decode(peerBridge.rx)).toBe('AT');
  });

  it('a byte above 0x7f reaches the part as it was on the pin', async () => {
    const { id } = addPi();
    const heard: number[] = [];
    wireUart(id, 'reader');
    const handle = attachUartEndpoint({ owner: 'reader', pins: { rx: 'RX', tx: 'TX' } }, { receive: (b) => heard.push(b) });
    cleanups.push(() => handle.dispose());
    (getBoardBridge(id) as unknown as MockBridge).uartTx([0xef, 0x01, 0xff, 0xff, 0xff, 0xff]);
    await flush();
    expect(heard).toEqual([0xef, 0x01, 0xff, 0xff, 0xff, 0xff]);
  });

  it('what several parts answer in one task leaves for the guest as one frame, in order', async () => {
    const { id, bridge } = addPi();
    const sent: number[][] = [];
    (bridge as unknown as { sendUartBytes: (b: number[]) => void }).sendUartBytes = (b) => sent.push(b);
    wireUart(id, 'gps');
    const handle = attachUartEndpoint({ owner: 'gps', pins: { rx: 'RX', tx: 'TX' } }, { receive: () => {} });
    cleanups.push(() => handle.dispose());
    for (const b of text('$GPGGA,1\r\n')) handle.transmit(b);
    expect(sent).toEqual([]);
    await flush();
    expect(sent).toEqual([text('$GPGGA,1\r\n')]);
  });
});
