/**
 * Board buses F6: the UART half of a QEMU board's bus map, and the bytes that
 * cross the socket in both directions, as the tab sends them
 * (project/board-buses-2026-09, F6-SPEC "Motores", findings
 * grove-worker-no-uart-map and esp32-variant-uart-table-wrong, browser half).
 *
 * An ESP32 or STM32 on QEMU keeps its UART chips in its worker; what the tab
 * owes it is the circuit: which of the guest's UARTs each endpoint's legs are
 * wired to. The worker places each chip by the map
 * (app/services/uart_bus_table.py, test/backend/unit/test_board_buses_f6_worker_uart.py).
 * The tab's own endpoints (a TypeScript modem) work across the socket: the
 * guest's bytes arrive as `serial_output` and go through the board's UART
 * port to the fabric, and what the endpoint answers leaves as `uart_send`.
 *
 * Pinned here, on the store's own boards with their real bridges and shims:
 *  - the map rides in the start config and names every endpoint the fabric
 *    placed, by owner, with the controller each leg is on and its pins;
 *  - a leg on a controller's default pad is named by the fabric; one on an
 *    IO_MUX pad the sketch would have to name is named from the pin table;
 *    one on a plain GPIO is named null, and its pads travel for the worker's
 *    own read of the matrix;
 *  - an endpoint the worker holds a record for but the fabric put on no wire
 *    of this board is listed as unplaced; a record with no endpoint is not;
 *  - a membership change mid-run sends the UART half alone;
 *  - the guest's bytes reach the endpoint on the controller they came from
 *    and no other, raw when the backend sends them raw;
 *  - what the endpoint answers goes to the guest's UART, coalesced per task;
 *  - the QEMU boards publish their UART controllers to the fabric as ports.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

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
  /** A message from the backend. */
  push(type: string, data: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
}
vi.stubGlobal('WebSocket', ScriptedSocket);

import {
  getBoardSimulator,
  getEsp32Bridge,
  getStm32Bridge,
  useSimulatorStore,
} from '../../store/useSimulatorStore';
import { attachUartEndpoint, busRegistry } from '../../simulation/buses';
import type { UartEndpoint } from '../../simulation/buses';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const b of [...useSimulatorStore.getState().boards]) {
    useSimulatorStore.getState().removeBoard?.(b.id);
  }
  useSimulatorStore.setState({ wires: [], components: [] } as never);
});

class Modem implements UartEndpoint {
  heard: number[] = [];
  receive(byte: number): void {
    this.heard.push(byte);
  }
}

/** A UART endpoint `owner`, its RX leg wired to board pad `rx` and its TX leg to `tx` (null = unwired). */
function endpoint(
  boardId: string,
  owner: string,
  rx: string | null,
  tx: string | null,
  extra: { baud?: number; frame?: string } = {},
) {
  const wires = (
    [
      ['RX', rx],
      ['TX', tx],
    ] as const
  )
    .filter((w): w is readonly ['RX' | 'TX', string] => w[1] !== null)
    .map(([pinName, pad], i) => ({
      id: `${owner}-w${i}`,
      start: { componentId: owner, pinName, x: 0, y: 0 },
      end: { componentId: boardId, pinName: pad, x: 0, y: 0 },
      waypoints: [],
      color: '#0a0',
    }));
  useSimulatorStore.setState((s) => ({ wires: [...s.wires, ...wires] }) as never);
  busRegistry.netlistChanged();
  const modem = new Modem();
  const handle = attachUartEndpoint({ owner, pins: { rx: 'RX', tx: 'TX' }, ...extra }, modem);
  cleanups.push(() => handle.dispose());
  return { modem, handle };
}

function startEsp32(id: string): ScriptedSocket {
  getEsp32Bridge(id)!.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  return ws;
}

function startStm32(id: string): ScriptedSocket {
  getStm32Bridge(id)!.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  return ws;
}

const busMapOf = (ws: ScriptedSocket, type: string) =>
  ws.sent.find((m) => m.type === type)?.data?.bus_map as {
    spi: unknown[];
    i2c?: unknown[];
    uart?: unknown[];
  };

const flush = () => new Promise<void>((r) => queueMicrotask(r));
const text = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const b64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes));

type Shim = {
  registerSensor: (type: string, pin: number, props: Record<string, unknown>) => boolean;
  unregisterSensor: (pin: number) => void;
  getBusBinding: () => { uart?: Array<{ unit: number; name: string }> };
};

describe('QEMU ESP32: the UART half of the start map', () => {
  it('names each placed endpoint by owner with the controller of each leg and its pins', () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    // arduino-esp32 3.x: Serial2 is TX 25 / RX 4, Serial1 TX 27 / RX 26.
    endpoint(id, 'modem', 'D25', 'D4', { baud: 9600 });
    endpoint(id, 'gps', null, 'D26', { baud: 9600, frame: '8N1' });
    const ws = startEsp32(id);
    expect(busMapOf(ws, 'start_esp32').uart).toEqual([
      { owner: 'gps', rx_uart: null, tx_uart: 1, rx_pin: null, tx_pin: 26, baud: 9600, frame: '8N1' },
      { owner: 'modem', rx_uart: 2, tx_uart: 2, rx_pin: 25, tx_pin: 4, baud: 9600, frame: '8N1' },
    ]);
  });

  it('names a leg on an IO_MUX pad from the pin table when the fabric routes no controller there', () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    // U2TXD / U2RXD are GPIO17 / GPIO16 in IO_MUX; the core's default for
    // Serial2 is elsewhere, so the fabric alone names nothing here.
    endpoint(id, 'modem', 'D17', 'D16');
    const ws = startEsp32(id);
    expect(busMapOf(ws, 'start_esp32').uart).toEqual([
      { owner: 'modem', rx_uart: 2, tx_uart: 2, rx_pin: 17, tx_pin: 16, baud: null, frame: '8N1' },
    ]);
  });

  it('a leg on a plain GPIO is on no controller, and its pad travels for the worker to read the matrix', () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    endpoint(id, 'modem', 'D32', 'D33');
    const ws = startEsp32(id);
    expect(busMapOf(ws, 'start_esp32').uart).toEqual([
      { owner: 'modem', rx_uart: null, tx_uart: null, rx_pin: 32, tx_pin: 33, baud: null, frame: '8N1' },
    ]);
  });

  it('lists as unplaced the record owners the fabric registered but put on no wire, and not the others', () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const shim = getBoardSimulator(id) as unknown as Shim;
    // A Grove module the worker holds a record for, wired to nothing.
    shim.registerSensor('custom-chip', 100001, { owner: 'chipX' });
    endpoint(id, 'chipX', null, null);
    // A record for a part that is not on the fabric at all: the worker
    // keeps whatever its record said, so the map says nothing about it.
    shim.registerSensor('custom-chip', 100002, { component_id: 'chipLegacy' });
    // And one placed on the board.
    shim.registerSensor('custom-chip', 100003, { owner: 'chipY' });
    endpoint(id, 'chipY', 'D25', 'D4');
    const ws = startEsp32(id);
    expect(busMapOf(ws, 'start_esp32').uart).toEqual([
      { owner: 'chipY', rx_uart: 2, tx_uart: 2, rx_pin: 25, tx_pin: 4, baud: null, frame: '8N1' },
      { unplaced: ['chipX'] },
    ]);
  });

  it('an endpoint that arrives or moves mid-run sends the UART half alone', async () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const ws = startEsp32(id);
    const before = ws.sent.length;
    endpoint(id, 'modem', 'D25', 'D4');
    await flush();
    const maps = ws.sent.slice(before).filter((m) => m.type === 'esp32_bus_map');
    expect(maps.length).toBe(1);
    expect(Object.keys(maps[0].data!)).toEqual(['uart']);
    expect(maps[0].data!.uart).toEqual([
      { owner: 'modem', rx_uart: 2, tx_uart: 2, rx_pin: 25, tx_pin: 4, baud: null, frame: '8N1' },
    ]);
    // Nothing changed: nothing sent.
    busRegistry.netlistChanged();
    await flush();
    expect(ws.sent.slice(before).filter((m) => m.type === 'esp32_bus_map').length).toBe(1);
  });

  it('a record withdrawn from the worker leaves the unplaced list', async () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const shim = getBoardSimulator(id) as unknown as Shim;
    shim.registerSensor('custom-chip', 100001, { owner: 'chipX' });
    endpoint(id, 'chipX', null, null);
    const ws = startEsp32(id);
    expect(busMapOf(ws, 'start_esp32').uart).toEqual([{ unplaced: ['chipX'] }]);
    const before = ws.sent.length;
    shim.unregisterSensor(100001);
    await flush();
    const maps = ws.sent.slice(before).filter((m) => m.type === 'esp32_bus_map');
    expect(maps.map((m) => m.data!.uart)).toEqual([[]]);
  });
});

describe('QEMU ESP32: bytes across the socket', () => {
  it("the guest's bytes reach the endpoint on the controller they came from, and no other", () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const { modem } = endpoint(id, 'modem', 'D25', 'D4');
    const { modem: other } = endpoint(id, 'other', 'D27', 'D26');
    const ws = startEsp32(id);
    ws.push('serial_output', { data: 'AT\r\n', uart: 2 });
    ws.push('serial_output', { data: 'hello\n', uart: 0 });
    ws.push('serial_output', { data: 'x', uart: 1 });
    expect(modem.heard).toEqual(text('AT\r\n'));
    expect(other.heard).toEqual(text('x'));
  });

  it('a raw chunk from the backend arrives byte for byte; an older backend gives the text', () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const { modem } = endpoint(id, 'modem', 'D25', 'D4');
    const ws = startEsp32(id);
    // A framed reply with a 0xAA sync word: the text is what UTF-8 made of
    // it (U+FFFD), the chunk is what was on the pin.
    ws.push('serial_output', { data: '�U\n', uart: 2, b64: b64([0xaa, 0x55, 0x0a]) });
    expect(modem.heard).toEqual([0xaa, 0x55, 0x0a]);
    ws.push('serial_output', { data: 'OK\n', uart: 2 });
    expect(modem.heard.slice(3)).toEqual(text('OK\n'));
  });

  it("what the endpoint answers goes to the guest's UART, coalesced per task", async () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const { handle } = endpoint(id, 'modem', 'D25', 'D4');
    const ws = startEsp32(id);
    const before = ws.sent.length;
    for (const b of text('OK\r\n')) handle.transmit(b);
    expect(ws.sent.slice(before).filter((m) => m.type === 'esp32_serial_input')).toEqual([]);
    await flush();
    expect(ws.sent.slice(before).filter((m) => m.type === 'esp32_serial_input')).toEqual([
      { type: 'esp32_serial_input', data: { bytes: text('OK\r\n'), uart: 2 } },
    ]);
  });

  it("an endpoint on a plain GPIO is heard by no controller: its bytes go nowhere and it hears nothing", async () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const { modem, handle } = endpoint(id, 'modem', 'D32', 'D33');
    const ws = startEsp32(id);
    const before = ws.sent.length;
    handle.transmit(0x41);
    await flush();
    expect(ws.sent.slice(before).filter((m) => m.type === 'esp32_serial_input')).toEqual([]);
    ws.push('serial_output', { data: 'AT\r\n', uart: 2 });
    expect(modem.heard).toEqual([]);
  });

  it('publishes UART0, UART1 and UART2 as ports of the fabric', () => {
    const id = useSimulatorStore.getState().addBoard('esp32', 0, 0);
    const ports = (getBoardSimulator(id) as unknown as Shim).getBusBinding().uart ?? [];
    expect(ports.map((p) => [p.unit, p.name])).toEqual([
      [0, 'UART0'],
      [1, 'UART1'],
      [2, 'UART2'],
    ]);
  });
});

describe('QEMU STM32: the same lane', () => {
  it('names the USART from the pin table: PA9/PA10 is USART1 (0), PA2/PA3 is USART2 (1)', () => {
    const id = useSimulatorStore.getState().addBoard('stm32-bluepill', 0, 0);
    endpoint(id, 'modem', 'PA9', 'PA10', { baud: 9600 });
    endpoint(id, 'gps', null, 'PA3', { baud: 9600 });
    const ws = startStm32(id);
    expect(busMapOf(ws, 'start_stm32').uart).toEqual([
      { owner: 'gps', rx_uart: null, tx_uart: 1, rx_pin: null, tx_pin: 3, baud: 9600, frame: '8N1' },
      { owner: 'modem', rx_uart: 0, tx_uart: 0, rx_pin: 9, tx_pin: 10, baud: 9600, frame: '8N1' },
    ]);
  });

  it("the guest's bytes reach the endpoint on its USART, and its answer goes back to that USART", async () => {
    const id = useSimulatorStore.getState().addBoard('stm32-bluepill', 0, 0);
    const { modem, handle } = endpoint(id, 'modem', 'PA2', 'PA3');
    const ws = startStm32(id);
    ws.push('serial_output', { data: 'AT\r\n', uart: 1 });
    ws.push('serial_output', { data: 'boot\n', uart: 0 });
    expect(modem.heard).toEqual(text('AT\r\n'));
    const before = ws.sent.length;
    for (const b of text('OK\r\n')) handle.transmit(b);
    await flush();
    expect(ws.sent.slice(before).filter((m) => m.type === 'stm32_serial_input')).toEqual([
      { type: 'stm32_serial_input', data: { bytes: text('OK\r\n'), uart: 1 } },
    ]);
  });

  it('a membership change mid-run sends the UART half alone', async () => {
    const id = useSimulatorStore.getState().addBoard('stm32-bluepill', 0, 0);
    const ws = startStm32(id);
    const before = ws.sent.length;
    endpoint(id, 'modem', 'PA9', 'PA10');
    await flush();
    const maps = ws.sent.slice(before).filter((m) => m.type === 'stm32_bus_map');
    expect(maps.map((m) => Object.keys(m.data!))).toEqual([['uart']]);
  });

  it('publishes every USART of the Blue Pill as a port', () => {
    const id = useSimulatorStore.getState().addBoard('stm32-bluepill', 0, 0);
    const ports = (getBoardSimulator(id) as unknown as Shim).getBusBinding().uart ?? [];
    expect(ports.map((p) => p.unit)).toEqual([0, 1, 2]);
    expect(ports.map((p) => p.name)).toEqual(['USART1', 'USART2', 'USART3']);
  });
});
