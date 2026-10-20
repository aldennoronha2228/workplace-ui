/**
 * One UART net = one board pin and the wire on it (DESIGN sections 3.3 and
 * 6.2). A UART line has no bus arbitration: it has DRIVERS (whoever
 * transmits onto the wire) and LISTENERS (whoever receives from it), and a
 * byte any driver puts on the wire reaches every listener. On a board pin
 * the possible drivers are a controller whose TX is routed there and the
 * endpoints whose TX leg lands there; the listeners are a controller whose
 * RX is routed there and the endpoints whose RX leg lands there. One TX to
 * several RX is legal and works; two TX on one wire is the contention silicon
 * suffers, and is reported.
 *
 * Rates: an endpoint declares the baud it talks at, a controller reports the
 * one the guest configured. When they disagree beyond what a receiver
 * tolerates, the listener gets what silicon would read at its own rate from
 * the sender's frame (see resampleUartFrame), and the mismatch is reported
 * once. A listener that declares no rate takes bytes as they are.
 *
 * Between boards: a wire from one board's pin to another's is one net on the
 * bench and one UartNet per board here, and the registry links those nets as
 * PEERS (a clique: every net of the wire names every other). A byte a driver
 * puts on any of them reaches the listeners and the controller RX of all of
 * them, and the wiring checks count every board's drivers, so a Pico's UART1
 * TX wired to an Uno's RX0 is a controller on each end of one wire, and a TX
 * wired to a TX between boards is the same contention it is on one board.
 */

import type { DiagnosticSink } from './spiBus';
import type { UartConfig, UartEndpoint, UartEndpointDescriptor } from './types';
import {
  baudsMatch,
  DEFAULT_UART_FRAME,
  frameName,
  parseUartFrame,
  resampleUartFrame,
  sameFrame,
  validBaud,
  type UartFrameErrors,
  type UartFrameSpec,
} from './uartFrame';

/** Net-side view of one leg of a registered endpoint. */
export interface UartMember {
  readonly owner: string;
  readonly desc: UartEndpointDescriptor;
  readonly endpoint: UartEndpoint;
  /** Which leg of the endpoint this is: its RX listens here, its TX drives here. */
  readonly role: 'rx' | 'tx';
  /** The endpoint's frame, parsed once. */
  readonly spec: UartFrameSpec;
  /** The endpoint's rate, when it declares a usable one. */
  readonly baud: number | undefined;
}

/** What the net needs of a controller routed to its pin. */
export interface UartControllerRef {
  readonly unit: number;
  readonly name: string;
  readonly remote: boolean;
  config(): UartConfig;
  /** A byte into the controller's RX (only used through `controllerRx`). */
  receive(byte: number): void;
}

/** A listener's rate and frame, the key its software decoder is shared under. */
export function listenerKey(m: UartMember): string {
  return `${m.baud}|${frameName(m.spec)}`;
}

export function uartMember(
  desc: UartEndpointDescriptor,
  endpoint: UartEndpoint,
  role: 'rx' | 'tx',
): UartMember {
  return {
    owner: desc.owner,
    desc,
    endpoint,
    role,
    spec: parseUartFrame(desc.frame),
    baud: validBaud(desc.baud) ? desc.baud : undefined,
  };
}

export class UartNet {
  /** Endpoints whose RX leg is on this pin, by owner. */
  readonly listeners = new Map<string, UartMember>();
  /** Endpoints whose TX leg is on this pin, by owner. */
  readonly drivers = new Map<string, UartMember>();
  /** The controller whose TX is routed to this pin, if any (set by the fabric). */
  controllerTx: UartControllerRef | null = null;
  /** The controller whose RX is routed to this pin, if any (set by the fabric). */
  controllerRx: UartControllerRef | null = null;
  /**
   * Installed by the fabric when the pin is a plain GPIO the MCU reads: puts
   * a byte an endpoint transmits on the wire as timed edges, so a
   * SoftwareSerial RX sees it. Null when a controller's RX takes the byte
   * directly, or when the board cannot time edges.
   */
  emit: ((byte: number, baud: number, spec: UartFrameSpec) => void) | null = null;
  /**
   * The nets of OTHER boards on this wire (see the header). Maintained by the
   * registry, which relinks every board-to-board wire whenever the circuit,
   * a controller's routing or a board's engine changes; a net with peers and
   * no member of its own is kept alive by them.
   */
  readonly peers = new Set<UartNet>();

  readonly boardId: string;
  readonly pin: number;
  private readonly report: DiagnosticSink;

  constructor(boardId: string, pin: number, report: DiagnosticSink) {
    this.boardId = boardId;
    this.pin = pin;
    this.report = report;
  }

  get size(): number {
    return this.listeners.size + this.drivers.size;
  }

  /** Nothing of this board's and no peer board on the wire: the net can go. */
  get idle(): boolean {
    return this.size === 0 && this.peers.size === 0;
  }

  add(m: UartMember): void {
    (m.role === 'rx' ? this.listeners : this.drivers).set(m.owner, m);
  }

  remove(owner: string, role: 'rx' | 'tx'): void {
    (role === 'rx' ? this.listeners : this.drivers).delete(owner);
  }

  /** Listeners in owner order, so nothing depends on attach order. */
  private sortedListeners(): UartMember[] {
    return Array.from(this.listeners.values()).sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  }

  // ── Bytes ────────────────────────────────────────────────────────────────

  /** A byte the controller routed to this pin transmits. */
  fromController(ctl: UartControllerRef, byte: number): void {
    const cfg = ctl.config();
    const baud = validBaud(cfg.baud) ? cfg.baud : undefined;
    const spec = cfg.frame ? parseUartFrame(cfg.frame) : undefined;
    for (const m of this.sortedListeners()) this.deliver(m, byte, baud, spec, ctl.name);
    // A board's TX wired to one of its own RX pins: a loopback, as on the bench.
    if (this.controllerRx) this.toController(this.controllerRx, byte, baud, spec, ctl.name);
    for (const p of this.peers) p.fromPeer(byte, baud, spec, ctl.name);
  }

  /** A byte an endpoint whose TX leg is here transmits. */
  fromEndpoint(m: UartMember, byte: number): void {
    for (const l of this.sortedListeners()) this.deliver(l, byte, m.baud, m.spec, m.owner);
    for (const p of this.peers) p.fromPeer(byte, m.baud, m.spec, m.owner);
    if (this.controllerRx) {
      this.toController(this.controllerRx, byte, m.baud, m.spec, m.owner);
      return;
    }
    if (!this.emit) return;
    // The wire is a GPIO the guest samples itself: the byte goes out as edges.
    if (m.baud === undefined) return; // reported at placement (uart-no-baud)
    this.emit(byte & 0xff, m.baud, m.spec);
  }

  /**
   * A byte a driver on a PEER board's net put on the wire: this board's end
   * of it. Its listeners, its controller's RX, or (a plain GPIO the guest
   * samples) its emitter, at the sender's rate. Never forwarded further: the
   * peers are a clique, so the sender's net already reached every board.
   */
  private fromPeer(
    byte: number,
    baud: number | undefined,
    spec: UartFrameSpec | undefined,
    srcName: string,
  ): void {
    for (const l of this.sortedListeners()) this.deliver(l, byte, baud, spec, srcName);
    if (this.controllerRx) {
      this.toController(this.controllerRx, byte, baud, spec, srcName);
      return;
    }
    // A sender with no known rate cannot be clocked onto a GPIO (a remote
    // port that does not report its termios): the byte stays on the sender's
    // board, as it does for an endpoint with no rate (uart-no-baud).
    if (!this.emit || baud === undefined) return;
    this.emit(byte & 0xff, baud, spec ?? DEFAULT_UART_FRAME);
  }

  /**
   * A byte the software decoder read off the wire (the MCU bit-banged it)
   * for the listeners decoding at `key`. The decoder ran at their own rate,
   * so a wrong rate has already produced its garbage; a parity error is
   * dropped as a hardware receiver drops it.
   */
  fromWire(key: string, byte: number, errors: UartFrameErrors): void {
    if (errors.parity) return;
    for (const m of this.sortedListeners()) if (listenerKey(m) === key) m.endpoint.receive(byte & 0xff);
  }

  private deliver(
    m: UartMember,
    byte: number,
    srcBaud: number | undefined,
    srcSpec: UartFrameSpec | undefined,
    srcName: string,
  ): void {
    const b = byte & 0xff;
    if (srcBaud === undefined || m.baud === undefined) {
      m.endpoint.receive(b);
      return;
    }
    const spec = srcSpec ?? m.spec;
    if (baudsMatch(srcBaud, m.baud) && sameFrame(spec, m.spec)) {
      m.endpoint.receive(b);
      return;
    }
    this.mismatch([m.owner], m.owner, m.baud, m.spec, srcName, srcBaud, spec);
    for (const out of resampleUartFrame(b, spec, srcBaud, m.spec, m.baud)) m.endpoint.receive(out);
  }

  private toController(
    ctl: UartControllerRef,
    byte: number,
    srcBaud: number | undefined,
    srcSpec: UartFrameSpec | undefined,
    srcName: string,
  ): void {
    const b = byte & 0xff;
    const cfg = ctl.config();
    const baud = validBaud(cfg.baud) ? cfg.baud : undefined;
    if (srcBaud === undefined || baud === undefined) {
      ctl.receive(b);
      return;
    }
    // A side that does not say its frame is taken to use the other side's.
    const spec = cfg.frame ? parseUartFrame(cfg.frame) : (srcSpec ?? DEFAULT_UART_FRAME);
    const from = srcSpec ?? spec;
    if (baudsMatch(srcBaud, baud) && sameFrame(spec, from)) {
      ctl.receive(b);
      return;
    }
    this.mismatch([srcName], ctl.name, baud, spec, srcName, srcBaud, from);
    for (const out of resampleUartFrame(b, from, srcBaud, spec, baud)) ctl.receive(out);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  private mismatch(
    owners: string[],
    receiver: string,
    rxBaud: number,
    rxSpec: UartFrameSpec,
    sender: string,
    txBaud: number,
    txSpec: UartFrameSpec,
  ): void {
    const rate = (baud: number, spec: UartFrameSpec) => `${Math.round(baud)} baud ${frameName(spec)}`;
    this.report({
      code: 'uart-baud-mismatch',
      bus: 'uart',
      boardId: this.boardId,
      owners: owners.slice().sort(),
      message:
        `${receiver} listens at ${rate(rxBaud, rxSpec)} on pin ${this.pin}, but ${sender} sends at ` +
        `${rate(txBaud, txSpec)}: what it receives is garbage, as on hardware. Use the same rate ` +
        `and frame on both sides.`,
    });
  }

  /**
   * Whether this net is the one that speaks for the whole wire. A wire
   * between boards is checked from every one of its nets; only the first by
   * board id (then pin) reports, so a wiring mistake is said once, not once
   * per board.
   */
  private speaksForWire(): boolean {
    for (const p of this.peers) {
      if (p.boardId < this.boardId || (p.boardId === this.boardId && p.pin < this.pin)) return false;
    }
    return true;
  }

  /** `<controller> of <board> (pin n)`, for a wire that spans boards. */
  private endName(net: UartNet, name: string): string {
    return this.peers.size ? `${name} of ${net.boardId} (pin ${net.pin})` : name;
  }

  /** Something on the wire transmits: a driver or a controller's TX, here or on a peer board. */
  private wireHasDriver(): boolean {
    if (this.controllerTx || this.drivers.size > 0) return true;
    for (const p of this.peers) if (p.controllerTx || p.drivers.size > 0) return true;
    return false;
  }

  /**
   * Two drivers on one wire. Checked when membership or routing changes,
   * never per byte: the wiring is wrong before anything is sent. A wire
   * between boards counts every board's drivers: a TX wired to a TX is the
   * classic mistake of the two-board bench.
   */
  checkDrivers(): void {
    if (!this.speaksForWire()) return;
    const owners = Array.from(this.drivers.keys());
    const controllers: string[] = [];
    if (this.controllerTx) controllers.push(this.endName(this, this.controllerTx.name));
    for (const p of this.peers) {
      owners.push(...p.drivers.keys());
      if (p.controllerTx) controllers.push(this.endName(p, p.controllerTx.name));
    }
    owners.sort();
    const names = [...owners, ...controllers];
    if (names.length < 2) return;
    const where = this.peers.size ? 'one wire' : `pin ${this.pin}`;
    let advice: string;
    if (controllers.length >= 2) {
      advice = `and neither board hears the other. Wire each board's TX to the other board's RX pin.`;
    } else if (controllers.length === 1) {
      advice = `and the board cannot hear the module. Wire the module's TX to the board's RX pin.`;
    } else {
      advice = `and the board reads a mix of both. Give each module its own RX pin.`;
    }
    this.report({
      code: 'uart-tx-contention',
      bus: 'uart',
      boardId: this.boardId,
      owners,
      message: `${names.join(' and ')} all transmit on ${where}: two TX on one wire fight each other ${advice}`,
    });
  }

  /**
   * A listener on a wire nothing drives: an endpoint whose RX is on the pin
   * the controller listens on, or, between boards, two controllers' RX on
   * one wire. Nobody transmits, so nobody hears anything. RX to RX is the
   * crossed half of the classic UART wiring mistake (TX to TX is the
   * contention).
   */
  checkListeners(): void {
    const ctl = this.controllerRx;
    if (!ctl || this.wireHasDriver()) return;
    for (const m of this.sortedListeners()) {
      this.report({
        code: 'uart-wiring',
        bus: 'uart',
        boardId: this.boardId,
        owners: [m.owner],
        message:
          `${m.owner}: its RX is on pin ${this.pin}, which ${ctl.name} uses as its own RX, so nothing ` +
          `on that wire ever transmits and the module hears nothing. Wire the module's RX to the ` +
          `board's TX pin.`,
      });
    }
    if (!this.speaksForWire()) return;
    for (const p of this.peers) {
      if (!p.controllerRx) continue;
      this.report({
        code: 'uart-wiring',
        bus: 'uart',
        boardId: this.boardId,
        owners: [],
        message:
          `${this.endName(this, ctl.name)} and ${this.endName(p, p.controllerRx.name)} are both RX ends ` +
          `of one wire: nothing on it transmits, so neither board hears anything. Wire one board's TX ` +
          `to the other board's RX pin.`,
      });
    }
  }
}
