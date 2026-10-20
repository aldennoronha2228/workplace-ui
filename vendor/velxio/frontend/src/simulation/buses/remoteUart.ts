/**
 * One board's remote UART lane (project board-buses-2026-09, F6).
 *
 * An ESP32 or an STM32 on QEMU runs its firmware in a backend worker. Unlike
 * SPI and I2C, a UART never waits for the other side: a byte the guest
 * transmits reaches the tab later than it left the shift register, and a byte
 * a part here answers reaches the guest's RX FIFO later still, which is what
 * a real cable does too, only slower. So the tab's UART endpoints (a
 * TypeScript AT modem, a HuskyLens) work across the socket, and the worker
 * only has to host the chips it already hosts: the WASM modules the parts
 * ship it. What the worker cannot know is the circuit: which of the guest's
 * UARTs each of those chips is wired to. Before F6 it pinned every chip to
 * Serial1 unless the frontend guessed a `uart_map` from a static pin
 * classifier that did not know the S3 (grove-worker-no-uart-map,
 * esp32-variant-uart-table-wrong).
 *
 * This lane is the tab's half. It publishes the board's UART controllers as
 * ports, so the fabric routes each one to its pads and checks the wiring as it
 * does for a local engine; it feeds those ports with the bytes the worker
 * relays (`serial_output`) and carries what an endpoint answers back as
 * `uart_send`; and it builds the `uart` half of the bus map the SPI and I2C
 * lanes already send (remoteLane.ts, remoteI2c.ts): per endpoint the fabric
 * placed on this board, the controller each of its legs is wired to. Same
 * transport, same whole-list rule: an endpoint that left is gone by being
 * absent, and one the worker holds a record for but the fabric put on no wire
 * of this board is named in `unplaced`, so the worker keeps it silent instead
 * of falling back to Serial1.
 *
 * The controller is named from the fabric's routing when a controller is on
 * the leg's net, else from the pad's functions in the board's pin table when
 * exactly one UART can drive it (the IO_MUX pins of a matrix board, the
 * alternates of a muxed one). On an ESP32 the sketch can still move a port to
 * any pad (`Serial1.begin(9600, SERIAL_8N1, 16, 17)`), so the pads travel too
 * and the worker reads the live GPIO matrix first (uart_bus_table.py).
 */

import { controllerOf, functionsOfPin, getBoardPinFunctions, type UartSignal } from './pinFunctions';
import { busRegistry, type RemoteUartMapEntry } from './registry';
import type { UartConfig, UartControllerPort, UartRouting } from './types';

/**
 * The owners the worker must keep silent: endpoints it holds a record for
 * (a sensor record with this owner) that the fabric has registered but put
 * on no wire of this board. A record the map says nothing about keeps the
 * UART its own table gave it, which is right only for a part that is not on
 * the fabric at all.
 */
export interface RemoteUartUnplacedEntry {
  unplaced: string[];
}

/**
 * The controller port of a board whose CPU is in a backend worker.
 *
 * Bytes the guest transmitted arrive through deliver(), chunked the way the
 * backend relays them, and go to the fabric one at a time as the TX handler
 * contract asks. Bytes an endpoint answers land in receive() one at a time
 * and leave for the worker coalesced per task: a modem's "OK\r\n" is one
 * socket frame, not four, and the guest's RX FIFO takes them in order either
 * way.
 */
export class RemoteUartPort implements UartControllerPort {
  readonly bus = 'uart' as const;
  readonly unit: number;
  readonly name: string;
  /** The guest is in the worker: bytes flow both ways, later than it clocked them. */
  readonly remote = true;

  private handler: ((byte: number) => void) | null = null;
  private readonly send: (unit: number, bytes: number[]) => void;
  private readonly boardKind: string;
  private routed: UartRouting | null = null;
  private pending: number[] = [];
  private flushQueued = false;

  constructor(unit: number, name: string, boardKind: string, send: (unit: number, bytes: number[]) => void) {
    this.unit = unit;
    this.name = name;
    this.boardKind = boardKind;
    this.send = send;
  }

  setTxHandler(handler: ((byte: number) => void) | null): void {
    this.handler = handler;
  }

  /** Whether the fabric holds this port right now (tests, inspector). */
  get bound(): boolean {
    return this.handler !== null;
  }

  receive(byte: number): void {
    this.pending.push(byte & 0xff);
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => this.flush());
  }

  /** Send what receive() queued, now. */
  flush(): void {
    this.flushQueued = false;
    if (this.pending.length === 0) return;
    const out = this.pending;
    this.pending = [];
    try {
      this.send(this.unit, out);
    } catch (e) {
      console.warn(`[RemoteUartPort:${this.name}] bytes for the guest could not be sent`, e);
    }
  }

  config(): UartConfig {
    // The worker does not report the guest's rate or frame, so the port says
    // nothing rather than a guess: a mismatch the fabric reported from an
    // invented rate would be worse than none.
    return {};
  }

  routing(): UartRouting {
    // The worker does not report routing to the tab, so the pads come from
    // the board table: the core's default for the controller, else the one
    // pad of the package that can carry the signal (USART2 of a Blue Pill is
    // PA2/PA3 and nothing else, and the core binds no Serial object to it,
    // so the table has no default to give). A controller with neither is
    // routed nowhere here; the map still carries the pads it reaches, for
    // the worker's own read of the matrix.
    if (!this.routed) {
      const def = controllerOf(this.boardKind, 'uart', this.unit)?.defaultPins;
      const first = (v: number | number[] | undefined): number | undefined =>
        Array.isArray(v) ? v[0] : v;
      const only = (signal: UartSignal): number | undefined => {
        const table = getBoardPinFunctions(this.boardKind);
        if (!table) return undefined;
        const pads: number[] = [];
        for (const [pin, fns] of Object.entries(table.pins)) {
          if (fns.some((f) => f.bus === 'uart' && f.unit === this.unit && f.signal === signal)) {
            pads.push(Number(pin));
          }
        }
        return pads.length === 1 ? pads[0] : undefined;
      };
      const tx = first(def?.tx) ?? only('tx');
      const rx = first(def?.rx) ?? only('rx');
      this.routed = Object.freeze({ ...(tx === undefined ? {} : { tx }), ...(rx === undefined ? {} : { rx }) });
    }
    return this.routed;
  }

  /** Bytes the guest already transmitted on this controller, in order. */
  deliver(bytes: ArrayLike<number>): void {
    const handler = this.handler;
    if (!handler) return;
    for (let i = 0; i < bytes.length; i++) handler(bytes[i] & 0xff);
  }
}

export class RemoteUartLane {
  /** One port per UART controller the board's pin table lists. */
  readonly ports: RemoteUartPort[];

  private readonly boardId: string;
  private readonly boardKind: string;
  private lastKey = '';

  constructor(boardId: string, boardKind: string, send: (unit: number, bytes: number[]) => void) {
    this.boardId = boardId;
    this.boardKind = boardKind;
    const controllers = getBoardPinFunctions(boardKind)?.controllers ?? [];
    this.ports = controllers
      .filter((c) => c.bus === 'uart')
      .map((c) => new RemoteUartPort(c.unit, c.name, boardKind, send));
  }

  /** Bytes the worker relayed from controller `unit`. A unit the table does not list goes nowhere. */
  deliver(unit: number, bytes: ArrayLike<number>): void {
    this.ports.find((p) => p.unit === unit)?.deliver(bytes);
  }

  /**
   * The `uart` half of the bus map: every endpoint the fabric placed on this
   * board (sorted by owner, so the list never depends on mount order), then
   * the owners among `knownOwners` (the records this board's worker holds)
   * that the fabric registered but placed on none of its wires.
   */
  publication(knownOwners: Iterable<string>): Array<RemoteUartMapEntry | RemoteUartUnplacedEntry> {
    const entries: RemoteUartMapEntry[] = busRegistry.uartMap(this.boardId).map((e) => ({
      ...e,
      rx_uart: e.rx_uart ?? (e.rx_pin === null ? null : this.onlyController(e.rx_pin, 'tx')),
      tx_uart: e.tx_uart ?? (e.tx_pin === null ? null : this.onlyController(e.tx_pin, 'rx')),
    }));
    const placed = new Set(entries.map((e) => e.owner));
    const unplaced: string[] = [];
    for (const owner of new Set(knownOwners)) {
      if (placed.has(owner)) continue;
      if (busRegistry.uartPlacement(owner) !== null) unplaced.push(owner);
    }
    unplaced.sort();
    // Left out when empty, so a board with every endpoint placed sends a
    // list of entries and nothing else.
    return unplaced.length ? [...entries, { unplaced }] : entries;
  }

  /**
   * The publication, and whether it differs from the last one this lane
   * returned. The caller sends the map when it does; a map that went anyway
   * (another half changed) should still take it, so both are returned.
   */
  poll(knownOwners: Iterable<string>): {
    uart: Array<RemoteUartMapEntry | RemoteUartUnplacedEntry>;
    changed: boolean;
  } {
    const uart = this.publication(knownOwners);
    const key = JSON.stringify(uart);
    const changed = key !== this.lastKey;
    this.lastKey = key;
    return { uart, changed };
  }

  /**
   * The one UART controller whose `signal` the pad can carry, from the pin
   * table, or null when none or several can: the IO_MUX pad of a port a
   * sketch used without naming pins, the alternate of a muxed pad.
   */
  private onlyController(pin: number, signal: 'tx' | 'rx'): number | null {
    const units = new Set<number>();
    for (const f of functionsOfPin(this.boardKind, pin)) {
      if (f.bus === 'uart' && f.signal === signal) units.add(f.unit);
    }
    return units.size === 1 ? [...units][0] : null;
  }
}
