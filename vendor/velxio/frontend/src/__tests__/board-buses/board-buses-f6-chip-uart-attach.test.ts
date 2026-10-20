/**
 * Board buses F6, second part: a custom chip is on a board's UART wires from
 * its own vx_uart_attach (project/board-buses-2026-09, STATUS "F6: UART",
 * open items 2 and 3).
 *
 * Until here the part hosting the chip (CustomChipPart) did the attach after
 * start(), from the pads it asked the chip for, and skipped the ESP32 kind so
 * an overlay extension (chipUartLink, deleted) could do the same job there;
 * and a chip a QEMU worker hosts was never on the tab's fabric at all: the
 * part classified its wired GPIOs against a static pin table and sent the
 * worker a {gpio: uart} map, the classic ESP32's table for every variant, so
 * a module on an S3's UART1 pins was placed on UART2
 * (esp32-variant-uart-table-wrong, the remaining path).
 *
 * Now ChipRuntime registers the endpoint in vx_uart_attach itself, on every
 * engine kind, and the part of a worker-hosted chip places the chip's pads
 * (read off an inert copy of the WASM, chipUartPads.ts) so the UART half of
 * the bus map names the guest's controller for the worker.
 *
 * Everything here is real: the uart-probe chip of the chips-other fixtures
 * (compiled from C with wasi-sdk; it logs every byte it hears as "rx HH" and
 * answers 'G' with a 96-byte burst), the real ChipRuntime, the real
 * CustomChipPart through PartSimulationRegistry, the store's own boards and
 * wires. The engine of the in-browser cases is a fake binding with one UART
 * port per controller, routed where the test says; the QEMU cases use the
 * store's real Esp32Bridge behind the real shim, with the socket scripted.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});
// The part asks the document for its element (to paint a chip display).
vi.stubGlobal('document', { getElementById: () => null });

/** The socket a QEMU bridge opens. Records every frame the tab sends. */
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
  /** A message from the backend. */
  push(type: string, data: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
}
vi.stubGlobal('WebSocket', ScriptedSocket);

import { ChipInstance } from '../../simulation/customChips/ChipRuntime';
import { hostsChipsInWorker } from '../../simulation/customChips/simulatorBridges';
import { PartSimulationRegistry } from '../../simulation/parts/PartSimulationRegistry';
import '../../simulation/parts';
import { boardPinsFromPinManager, busRegistry } from '../../simulation/buses';
import type { UartConfig, UartControllerPort, UartRouting } from '../../simulation/buses';
import {
  getBoardPinManager,
  getBoardSimulator,
  getEsp32Bridge,
  useSimulatorStore,
} from '../../store/useSimulatorStore';

// ── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PROBE_WASM = readFileSync(join(FIXTURES, 'chips-other-chips/uart-probe.wasm'));
const PROBE_B64 = PROBE_WASM.toString('base64');
const PROBE_PINS = ['RX', 'TX', 'GND', 'VCC'];
const G = 'G'.charCodeAt(0);

// ── Rig ─────────────────────────────────────────────────────────────────────

/** One UART controller of an engine running in this tab, routed where the test says. */
class FakeUartPort implements UartControllerPort {
  readonly bus = 'uart' as const;
  readonly unit: number;
  readonly name: string;
  /** What the guest read on this controller's RX. */
  received: number[] = [];
  private handler: ((byte: number) => void) | null = null;
  private readonly pads: UartRouting;
  constructor(unit: number, pads: UartRouting) {
    this.unit = unit;
    this.name = `UART${unit}`;
    this.pads = pads;
  }
  setTxHandler(h: ((byte: number) => void) | null): void {
    this.handler = h;
  }
  receive(byte: number): void {
    this.received.push(byte);
  }
  config(): UartConfig {
    return { baud: 9600, frame: '8N1' };
  }
  routing(): UartRouting {
    return { ...this.pads };
  }
  /** The guest shifts bytes out. */
  transmit(bytes: number[]): void {
    for (const b of bytes) this.handler?.(b);
  }
}

/**
 * A classic ESP32 DevKit on the store whose engine is three fake ports:
 * UART0 on its console pads and UART2 on TX 17 / RX 16, where the classic
 * silkscreen prints TX2 / RX2.
 */
function browserEsp32(): { id: string; uart0: FakeUartPort; uart1: FakeUartPort; uart2: FakeUartPort } {
  const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
  const uart0 = new FakeUartPort(0, { tx: 1, rx: 3 });
  const uart1 = new FakeUartPort(1, { tx: 10, rx: 9 });
  const uart2 = new FakeUartPort(2, { tx: 17, rx: 16 });
  busRegistry.bindEngine(id, {
    pins: boardPinsFromPinManager(getBoardPinManager(id)!),
    spi: [],
    uart: [uart0, uart1, uart2],
  });
  return { id, uart0, uart1, uart2 };
}

function wire(boardId: string, componentId: string, pads: Record<string, string>): void {
  useSimulatorStore.setState(
    (s) =>
      ({
        wires: [
          ...s.wires,
          ...Object.entries(pads).map(([pinName, pad]) => ({
            id: `${componentId}-${pinName}`,
            start: { componentId, pinName, x: 0, y: 0 },
            end: { componentId: boardId, pinName: pad, x: 0, y: 0 },
            waypoints: [],
            color: '#0a0',
          })),
        ],
      }) as never,
  );
  busRegistry.netlistChanged();
}

/** Put a custom chip in the store, the way the canvas holds one. */
function placeChip(id: string): void {
  useSimulatorStore.setState(
    (s) =>
      ({
        components: [
          ...s.components.filter((c) => c.id !== id),
          {
            id,
            metadataId: 'custom-chip',
            x: 0,
            y: 0,
            properties: { wasmBase64: PROBE_B64, chipJson: JSON.stringify({ name: 'uart-probe', pins: PROBE_PINS }), attrs: {} },
          },
        ],
      }) as never,
  );
}

/** Attach through the real CustomChipPart, as DynamicComponent does on a hexEpoch change. */
function attachPart(sim: unknown, id: string, pins: Record<string, number>): () => void {
  placeChip(id);
  const off = PartSimulationRegistry.get('custom-chip')!.attachEvents!(
    { id } as unknown as HTMLElement,
    sim as never,
    (pin: string) => (pin in pins ? pins[pin] : null),
    id,
  );
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    off?.();
  };
  cleanups.push(once);
  return once;
}

/** The chip loads and starts asynchronously; wait until the fabric has it. */
async function placed(owner: string): Promise<void> {
  await vi.waitFor(() => expect(busRegistry.uartPlacement(owner)).not.toBeNull(), { timeout: 5000, interval: 2 });
}

/** The in-browser ESP32 engine's simulator, as the part tells it apart: an ESP32 kind with no worker. */
const browserSim = (boardId: string) => ({
  pinManager: getBoardPinManager(boardId),
  sendPinEvent: () => {},
  registerSensor: () => {
    throw new Error('a browser-hosted chip is never shipped as a sensor record');
  },
  hostsCustomChips: () => false,
});

let logLines: string[] = [];
let cleanups: Array<() => void> = [];

/** Bytes the uart-probe chip logged as "rx HH", in order. */
function heard(lines: string[] = logLines): number[] {
  return lines
    .map((l) => /rx ([0-9a-f]{2})$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => parseInt(m[1], 16));
}

beforeEach(() => {
  logLines = [];
  cleanups = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logLines.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const b of [...useSimulatorStore.getState().boards]) {
    useSimulatorStore.getState().removeBoard?.(b.id);
  }
  useSimulatorStore.setState({ wires: [], components: [] } as never);
  vi.restoreAllMocks();
});

// ── The runtime: vx_uart_attach is the registration ─────────────────────────

/** A ChipInstance of the probe with a canvas identity, on `boardId`'s pin manager. */
async function chip(
  boardId: string,
  componentId: string,
  wires: Record<string, number>,
  extra: { busPads?: Record<string, string>; drivesWires?: () => boolean } = {},
): Promise<{ inst: ChipInstance; said: string[] }> {
  const said: string[] = [];
  const inst = await ChipInstance.create({
    wasm: PROBE_WASM,
    componentId,
    pinManager: getBoardPinManager(boardId)!,
    wires: new Map(Object.entries(wires)),
    log: (s) => said.push(s.replace(/\n$/, '')),
    ...extra,
  });
  cleanups.push(() => inst.dispose());
  inst.start();
  return { inst, said };
}

describe('ChipRuntime: a chip is on the wires its vx_uart_config pads reach', () => {
  it('hears the controller on its RX pad and answers into the one on its TX pad, from its own attach', async () => {
    const { id, uart0, uart1, uart2 } = browserEsp32();
    wire(id, 'chip-a', { RX: 'D17', TX: 'D16' });
    const { inst, said } = await chip(id, 'chip-a', { RX: 17, TX: 16 });
    expect(busRegistry.uartPlacement('chip-a')).toEqual({
      rx: { boardId: id, pin: 17, controller: 'UART2' },
      tx: { boardId: id, pin: 16, controller: 'UART2' },
    });
    expect(busRegistry.uartMap(id).map((e) => [e.owner, e.baud, e.frame])).toEqual([['chip-a', 9600, '8N1']]);
    uart0.transmit([0x5a]); // the console: never the chip's
    uart1.transmit([0x5b]);
    expect(heard(said)).toEqual([]);
    uart2.transmit([0x41]);
    expect(heard(said)).toEqual([0x41]);
    // Nobody registered an ear on the instance: the bytes reach the
    // controller because the runtime put them on the wire itself.
    uart2.transmit([G]);
    expect(uart2.received.length).toBe(96);
    expect(uart2.received.slice(0, 10)).toEqual(Array.from('0123456789', (c) => c.charCodeAt(0)));
    expect(uart0.received).toEqual([]);
    expect(uart1.received).toEqual([]);
    // Gone with the chip.
    inst.dispose();
    expect(busRegistry.uartPlacement('chip-a')).toBeNull();
    uart2.transmit([0x42]);
    expect(heard(said)).toEqual([0x41, G]);
  });

  it('onUartTx is an ear on the wire, not a second wire: the controller reads each byte once', async () => {
    const { id, uart2 } = browserEsp32();
    wire(id, 'chip-a', { RX: 'D17', TX: 'D16' });
    const { inst } = await chip(id, 'chip-a', { RX: 17, TX: 16 });
    const ear: number[] = [];
    inst.onUartTx((b) => ear.push(b));
    uart2.transmit([G]);
    expect(ear.length).toBe(96);
    expect(uart2.received).toEqual(ear);
  });

  it('drivesWires false keeps the chip off the wire while it still hears it: a copy whose worker twin answers', async () => {
    // The QEMU fallback of a delegating ESP32 engine: the worker runs a copy
    // of this chip and answers the guest; this copy paints from what it hears
    // and must not answer a second time. The gate is the runtime's, read per
    // byte, so a host flips it without registering a second endpoint.
    const { id, uart2 } = browserEsp32();
    wire(id, 'chip-a', { RX: 'D17', TX: 'D16' });
    let owns = false;
    const { inst, said } = await chip(id, 'chip-a', { RX: 17, TX: 16 }, { drivesWires: () => owns });
    const ear: number[] = [];
    inst.onUartTx((b) => ear.push(b));
    uart2.transmit([G]);
    expect(heard(said)).toEqual([G]);
    expect(ear.length, 'the ear hears the burst').toBe(96);
    expect(uart2.received, 'the wire carries nothing while another copy drives it').toEqual([]);
    owns = true;
    uart2.transmit([G]);
    expect(uart2.received.length).toBe(96);
  });

  it('pads wired to nothing are on no wire: no controller feeds the chip and nothing it writes lands anywhere', async () => {
    const { id, uart0, uart1, uart2 } = browserEsp32();
    const { inst, said } = await chip(id, 'chip-b', {});
    expect(busRegistry.uartPlacement('chip-b')).toEqual({ rx: null, tx: null });
    for (const p of [uart0, uart1, uart2]) p.transmit([G]);
    expect(heard(said)).toEqual([]);
    inst.feedUart(G); // a host feeding it directly: its burst goes into the air
    expect([uart0.received, uart1.received, uart2.received]).toEqual([[], [], []]);
  });

  it('a chip with no canvas identity joins nothing, as its SPI and I2C do not', async () => {
    const { id, uart2 } = browserEsp32();
    wire(id, 'chip-x', { RX: 'D17', TX: 'D16' });
    const { said } = await chip(id, '', { RX: 17, TX: 16 });
    expect(busRegistry.uartMap(id)).toEqual([]);
    uart2.transmit([0x41]);
    expect(heard(said)).toEqual([]);
  });

  it('pads named apart from the chip pins (a module socket) resolve through busPads', async () => {
    const { id, uart2 } = browserEsp32();
    // The socket's pads are SRX/STX; the chip calls them RX/TX. The wires
    // carry the socket's names, so the plain names would resolve to nothing.
    wire(id, 'mod-a', { SRX: 'D17', STX: 'D16' });
    const { said } = await chip(id, 'mod-a', { RX: 17, TX: 16 }, { busPads: { RX: 'SRX', TX: 'STX' } });
    expect(busRegistry.uartPlacement('mod-a')).toEqual({
      rx: { boardId: id, pin: 17, controller: 'UART2' },
      tx: { boardId: id, pin: 16, controller: 'UART2' },
    });
    uart2.transmit([0x41, G]);
    expect(heard(said)).toEqual([0x41, G]);
    expect(uart2.received.length).toBe(96);
  });
});

// ── The part on an in-browser ESP32 kind: the gate is gone ──────────────────

describe('CustomChipPart on an in-browser ESP32 engine: the chip is on the fabric with no overlay extension', () => {
  it('answers the controller its pads are wired to, and leaves the wire with the part', async () => {
    const { id, uart0, uart2 } = browserEsp32();
    wire(id, 'chip1', { RX: 'D17', TX: 'D16' });
    const off = attachPart(browserSim(id), 'chip1', { RX: 17, TX: 16 });
    await placed('chip1');
    expect(busRegistry.uartPlacement('chip1')).toEqual({
      rx: { boardId: id, pin: 17, controller: 'UART2' },
      tx: { boardId: id, pin: 16, controller: 'UART2' },
    });
    uart0.transmit([G]);
    expect(uart0.received).toEqual([]);
    uart2.transmit([0x41, G]);
    expect(heard()).toEqual([0x41, G]);
    expect(uart2.received.length).toBe(96);
    off();
    expect(busRegistry.uartPlacement('chip1')).toBeNull();
    uart2.transmit([G]);
    expect(uart2.received.length).toBe(96);
  });
});

// ── The QEMU lane: an S3 with a chip on its UART1 pins ──────────────────────

function connect(id: string): ScriptedSocket {
  getEsp32Bridge(id)!.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  cleanups.push(() => getEsp32Bridge(id)?.disconnect());
  return ws;
}

const flush = () => new Promise<void>((r) => queueMicrotask(r));

const uartMapOf = (ws: ScriptedSocket, type = 'start_esp32') =>
  ws.sent.find((m) => m.type === type)?.data?.bus_map as { uart?: unknown[] } | undefined;

const chipRecords = (ws: ScriptedSocket) =>
  ((ws.sent.find((m) => m.type === 'start_esp32')?.data?.sensors as Array<Record<string, unknown>>) ?? []).filter(
    (s) => s.sensor_type === 'custom-chip',
  );

describe('CustomChipPart on a QEMU ESP32-S3: the chip is placed by the fabric, not by a pin classifier', () => {
  it('a chip on the S3 UART1 IO_MUX pads (17/18) is UART1 in the map the worker gets, where the classic table says UART2', async () => {
    const id = useSimulatorStore.getState().addBoard('esp32-s3', 0, 0);
    const shim = getBoardSimulator(id);
    expect(hostsChipsInWorker(shim)).toBe(true);
    // Chip RX on the board's U1TXD, chip TX on U1RXD. On a classic ESP32 the
    // same GPIO17 is U2TXD, and GPIO18 is VSPI's clock.
    wire(id, 'chip1', { RX: 'D17', TX: 'D18' });
    attachPart(shim, 'chip1', { RX: 17, TX: 18 });
    await placed('chip1');
    const ws = connect(id);
    expect(uartMapOf(ws)?.uart).toEqual([
      { owner: 'chip1', rx_uart: 1, tx_uart: 1, rx_pin: 17, tx_pin: 18, baud: 9600, frame: '8N1' },
    ]);
    // The record the worker hosts carries the same identity and no table of its own.
    const [rec] = chipRecords(ws);
    expect(rec).toBeTruthy();
    expect(rec.component_id).toBe('chip1');
    expect(rec.pin_map).toEqual({ RX: 17, TX: 18 });
    expect('uart_map' in rec).toBe(false);
  });

  it("a chip on the S3 core's Serial1 default pads (16/15) is UART1 by the controller's routing", async () => {
    const id = useSimulatorStore.getState().addBoard('esp32-s3', 0, 0);
    wire(id, 'chip2', { RX: 'D16', TX: 'D15' });
    attachPart(getBoardSimulator(id), 'chip2', { RX: 16, TX: 15 });
    await placed('chip2');
    expect(busRegistry.uartPlacement('chip2')).toEqual({
      rx: { boardId: id, pin: 16, controller: 'UART1' },
      tx: { boardId: id, pin: 15, controller: 'UART1' },
    });
    const ws = connect(id);
    expect(uartMapOf(ws)?.uart).toEqual([
      { owner: 'chip2', rx_uart: 1, tx_uart: 1, rx_pin: 16, tx_pin: 15, baud: 9600, frame: '8N1' },
    ]);
  });

  it('a chip wired to nothing is named unplaced, so the worker keeps it silent instead of putting it on Serial1', async () => {
    const id = useSimulatorStore.getState().addBoard('esp32-s3', 0, 0);
    attachPart(getBoardSimulator(id), 'loose', {});
    await placed('loose');
    expect(busRegistry.uartPlacement('loose')).toEqual({ rx: null, tx: null });
    const ws = connect(id);
    expect(uartMapOf(ws)?.uart).toEqual([{ unplaced: ['loose'] }]);
  });

  it('a chip attached mid-run reaches the worker as a new UART half, and leaves it when the part goes', async () => {
    const id = useSimulatorStore.getState().addBoard('esp32-s3', 0, 0);
    const ws = connect(id);
    const before = ws.sent.length;
    wire(id, 'chip3', { RX: 'D17', TX: 'D18' });
    const off = attachPart(getBoardSimulator(id), 'chip3', { RX: 17, TX: 18 });
    await placed('chip3');
    await flush();
    const maps = () => ws.sent.slice(before).filter((m) => m.type === 'esp32_bus_map').map((m) => m.data!.uart);
    expect(maps().at(-1)).toEqual([
      { owner: 'chip3', rx_uart: 1, tx_uart: 1, rx_pin: 17, tx_pin: 18, baud: 9600, frame: '8N1' },
    ]);
    off();
    await flush();
    expect(maps().at(-1)).toEqual([]);
    expect(busRegistry.uartPlacement('chip3')).toBeNull();
  });

  it("the tab answers nothing for a worker-hosted chip: the guest's bytes on UART1 send no reply back", async () => {
    const id = useSimulatorStore.getState().addBoard('esp32-s3', 0, 0);
    wire(id, 'chip1', { RX: 'D17', TX: 'D18' });
    attachPart(getBoardSimulator(id), 'chip1', { RX: 17, TX: 18 });
    await placed('chip1');
    const ws = connect(id);
    const before = ws.sent.length;
    ws.push('serial_output', { data: 'G', uart: 1 });
    await flush();
    expect(ws.sent.slice(before).filter((m) => m.type === 'esp32_serial_input')).toEqual([]);
    // And no browser copy of the chip ran, or spoke: not the byte it would
    // have logged, nor the "ready" its setup prints (the inert copy that
    // read the pads is mute; the worker's copy is the one that speaks).
    expect(heard()).toEqual([]);
    expect(logLines.filter((l) => l.includes('uart-probe ready'))).toEqual([]);
  });
});
