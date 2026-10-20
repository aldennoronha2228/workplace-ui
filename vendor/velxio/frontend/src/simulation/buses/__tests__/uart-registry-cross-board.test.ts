/**
 * Layer 1 of project board-buses-2026-09 (TESTS.md), F6 second part: UART
 * between boards is the fabric's.
 *
 * A wire from one board's UART pin to another's is one net on the bench, and
 * here one UartNet per board that the registry links as peers (relinkUart):
 * a Pico's UART1 TX wired to an Uno's RX is a controller on each end of one
 * wire, and what one transmits the other's controller receives, with the
 * fabric's wiring checks and rate checks between them. Before this the
 * Interconnect's byte fan-out carried the wire outside the fabric, with no
 * diagnostics and a byte delivered whatever the receiver's rate. Fake
 * circuit, fake ports, fake pins and clock with the real contracts; no
 * engine, and no Interconnect: nothing here reaches the other board unless
 * the fabric carries it.
 */
import { describe, it, expect } from 'vitest';
import { BusRegistry } from '../registry';
import { registerBoardPinFunctions } from '../pinFunctions';
import type {
  BoardPins,
  BusDiagnostic,
  EngineBinding,
  GuestClock,
  NetResolver,
  PinRef,
  ResolvedPin,
  UartConfig,
  UartControllerPort,
  UartEndpoint,
  UartRouting,
} from '../types';

// ── Fakes ───────────────────────────────────────────────────────────────────

/** A controller port whose guest is a TX call and an RX queue. */
class Port implements UartControllerPort {
  readonly bus = 'uart' as const;
  readonly unit: number;
  readonly name: string;
  handler: ((byte: number) => void) | null = null;
  routingChanged: (() => void) | null = null;
  rx: number[] = [];
  cfg: UartConfig = {};
  route: UartRouting | 'static';
  constructor(unit: number, name: string, route: UartRouting | 'static' = 'static') {
    this.unit = unit;
    this.name = name;
    this.route = route;
  }
  setTxHandler(h: ((byte: number) => void) | null): void {
    this.handler = h;
  }
  setRoutingChangeHandler(h: (() => void) | null): void {
    this.routingChanged = h;
  }
  receive(byte: number): void {
    this.rx.push(byte);
  }
  config(): UartConfig {
    return { ...this.cfg };
  }
  routing(): UartRouting | 'static' {
    return this.route;
  }
  /** Serial.write. */
  tx(...bytes: number[]): void {
    for (const b of bytes) this.handler?.(b);
  }
}

type End = { boardId: string; pin: number } | { comp: string; pin: string };

/**
 * The circuit as nets: each group is one wire's worth of ends, board pads
 * and component pins alike. `resolve` names the first board of a component
 * pin's net (the store's trace does the same); `resolveAll` names every
 * board on the net, from a component pin or from a board pad, which is what
 * createStoreNetResolver does by walking the pad-to-pad wires.
 */
class Circuit implements NetResolver {
  groups: End[][] = [];
  kinds = new Map<string, string>();
  link(...ends: End[]): void {
    this.groups.push(ends);
  }
  clear(): void {
    this.groups = [];
  }
  private groupOf(pred: (e: End) => boolean): End[] | undefined {
    return this.groups.find((g) => g.some(pred));
  }
  private boardEnds(g: End[] | undefined): ResolvedPin[] {
    const out: ResolvedPin[] = [];
    for (const e of g ?? []) {
      if (!('boardId' in e) || !this.kinds.has(e.boardId)) continue;
      if (out.some((o) => o.kind === 'board' && o.boardId === e.boardId)) continue;
      out.push({ kind: 'board', boardId: e.boardId, pin: e.pin });
    }
    return out;
  }
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    const ends = this.boardEnds(this.groupOf((e) => 'comp' in e && e.comp === ref.componentId && e.pin === ref.pinName));
    return ends[0] ?? { kind: 'floating' };
  }
  resolveAll(ref: PinRef): ResolvedPin[] {
    if (ref.kind === 'board') {
      const ends = this.boardEnds(this.groupOf((e) => 'boardId' in e && e.boardId === ref.boardId && e.pin === ref.pin));
      return ends.length ? ends : [{ kind: 'board', boardId: ref.boardId, pin: ref.pin }];
    }
    return this.boardEnds(this.groupOf((e) => 'comp' in e && e.comp === ref.componentId && e.pin === ref.pinName));
  }
  boardKind(id: string): string | undefined {
    return this.kinds.get(id);
  }
  boards(): string[] {
    return Array.from(this.kinds.keys());
  }
}

/** Board pins that remember what a part (or the fabric's emitter) drives. */
class Pins implements BoardPins {
  driven: Array<{ pin: number; level: boolean }> = [];
  onPinChange(): () => void {
    return () => {};
  }
  peekPinState(): boolean | undefined {
    return undefined;
  }
  driveInput(pin: number, level: boolean): void {
    this.driven.push({ pin, level });
  }
}

/** A guest clock that only records the edges scheduled on it. */
class Clock implements GuestClock {
  cycles = 0;
  edges: Array<{ pin: number; level: boolean; at: number }> = [];
  now(): number {
    return this.cycles;
  }
  clockHz(): number {
    return 16e6;
  }
  scheduleEdge(pin: number, level: boolean, at: number): void {
    this.edges.push({ pin, level, at });
  }
  at(): () => void {
    return () => {};
  }
}

class Module implements UartEndpoint {
  heard: number[] = [];
  receive(byte: number): void {
    this.heard.push(byte);
  }
}

// AVR-like board a: USART0 on 0/1, USART1 on 19 (RX) / 18 (TX). RP-like
// board b: UART0 on 1 (RX) / 0 (TX), UART1 on 9 (RX) / 8 (TX).
registerBoardPinFunctions(['test-xb-avr'], {
  routing: 'fixed',
  source: 'test',
  controllers: [
    { bus: 'uart', unit: 0, name: 'USART0', arduino: ['Serial'], defaultPins: { rx: 0, tx: 1 } },
    { bus: 'uart', unit: 1, name: 'USART1', arduino: ['Serial1'], defaultPins: { rx: 19, tx: 18 } },
  ],
  pins: {
    0: [{ bus: 'uart', unit: 0, signal: 'rx' }],
    1: [{ bus: 'uart', unit: 0, signal: 'tx' }],
    18: [{ bus: 'uart', unit: 1, signal: 'tx' }],
    19: [{ bus: 'uart', unit: 1, signal: 'rx' }],
  },
});
registerBoardPinFunctions(['test-xb-rp'], {
  routing: 'mux',
  source: 'test',
  controllers: [
    { bus: 'uart', unit: 0, name: 'UART0', arduino: ['Serial1'], defaultPins: { rx: 1, tx: 0 } },
    { bus: 'uart', unit: 1, name: 'UART1', arduino: ['Serial2'], defaultPins: { rx: 9, tx: 8 } },
  ],
  pins: {
    0: [{ bus: 'uart', unit: 0, signal: 'tx' }],
    1: [{ bus: 'uart', unit: 0, signal: 'rx' }],
    8: [{ bus: 'uart', unit: 1, signal: 'tx' }],
    9: [{ bus: 'uart', unit: 1, signal: 'rx' }],
  },
});

const on = (boardId: string, pin: number): End => ({ boardId, pin });
const leg = (comp: string, pin: string): End => ({ comp, pin });

interface RigOptions {
  /** Board a gets pins and a guest clock (it can time its pads). */
  aClock?: boolean;
  /** Board b's ports report live routing (an RP-like funcsel) instead of the table. */
  liveB?: boolean;
}

function rig(opts: RigOptions = {}) {
  const reg = new BusRegistry();
  const circuit = new Circuit();
  circuit.kinds.set('a', 'test-xb-avr');
  circuit.kinds.set('b', 'test-xb-rp');
  reg.setResolver(circuit);
  const diags: BusDiagnostic[] = [];
  reg.onDiagnostic((d) => diags.push(d));
  const a0 = new Port(0, 'USART0');
  const a1 = new Port(1, 'USART1');
  const b0 = new Port(0, 'UART0', opts.liveB ? { tx: 0, rx: 1 } : 'static');
  const b1 = new Port(1, 'UART1', opts.liveB ? { tx: 8, rx: 9 } : 'static');
  const aPins = new Pins();
  const aClock = new Clock();
  const bPins = new Pins();
  const bindingA: EngineBinding = { pins: aPins, spi: [], uart: [a0, a1], ...(opts.aClock ? { clock: aClock } : {}) };
  const bindingB: EngineBinding = { pins: bPins, spi: [], uart: [b0, b1] };
  reg.bindEngine('a', bindingA);
  reg.bindEngine('b', bindingB);
  const codes = (code: BusDiagnostic['code']) => diags.filter((d) => d.code === code);
  return { reg, circuit, diags, codes, a0, a1, b0, b1, aPins, aClock, bindingA, bindingB };
}

/** The two-board bench: a's USART1 TX to b's UART1 RX, b's UART1 TX to a's USART1 RX. */
function crossed(r: ReturnType<typeof rig>): void {
  r.circuit.link(on('a', 18), on('b', 9));
  r.circuit.link(on('b', 8), on('a', 19));
  r.reg.netlistChanged();
}

describe('UART between boards: one wire, a controller on each end', () => {
  it('what one board transmits the other board\'s controller receives, both ways, and only on the wired controllers', () => {
    const r = rig();
    crossed(r);
    expect(r.reg.uartPeers('a', 18)).toEqual([{ boardId: 'b', pin: 9 }]);
    expect(r.reg.uartPeers('b', 9)).toEqual([{ boardId: 'a', pin: 18 }]);
    expect(r.reg.uartPeers('a', 0), 'a pin wired to no other board').toEqual([]);
    r.a1.tx(0x48, 0x69);
    expect(r.b1.rx).toEqual([0x48, 0x69]);
    r.b1.tx(0x4f);
    expect(r.a1.rx).toEqual([0x4f]);
    // The other controllers are on no wire between the boards.
    r.a0.tx(0x01);
    r.b0.tx(0x02);
    expect(r.b0.rx).toEqual([]);
    expect(r.a0.rx).toEqual([]);
    expect(r.b1.rx).toEqual([0x48, 0x69]);
    expect(r.a1.rx).toEqual([0x4f]);
    expect(r.diags).toEqual([]);
  });

  it('the Interconnect\'s question: the fabric serves a wire from a transmitting controller to a listening one, and nothing else', () => {
    const r = rig();
    crossed(r);
    expect(r.reg.servesUartWire('a', 18, 'b', 9)).toBe(true);
    expect(r.reg.servesUartWire('b', 8, 'a', 19)).toBe(true);
    // The wrong way round: nobody transmits on b's RX pin.
    expect(r.reg.servesUartWire('b', 9, 'a', 18)).toBe(false);
    // Not the same wire.
    expect(r.reg.servesUartWire('a', 18, 'b', 8)).toBe(false);
    expect(r.reg.servesUartWire('a', 0, 'b', 1)).toBe(false);
  });

  it('a module on one board\'s canvas is heard by the other board\'s controller, and hears it', () => {
    const r = rig();
    // A GPS on a's canvas: its TX on a plain GPIO of a, and that wire runs
    // on to b's UART1 RX. A modem on a's canvas listening on the wire b's
    // UART1 TX drives.
    r.circuit.link(leg('gps', 'TX'), on('a', 2), on('b', 9));
    r.circuit.link(leg('modem', 'RX'), on('a', 3), on('b', 8));
    r.reg.netlistChanged();
    const modem = new Module();
    const gps = r.reg.attachUart({ owner: 'gps', pins: { tx: 'TX' }, baud: 9600 }, new Module());
    r.reg.attachUart({ owner: 'modem', pins: { rx: 'RX' }, baud: 9600 }, modem);
    expect(r.reg.uartPlacement('gps')?.tx).toEqual({ boardId: 'a', pin: 2, controller: null });
    expect(r.reg.uartPeers('a', 2)).toEqual([{ boardId: 'b', pin: 9 }]);
    gps.transmit(0x24);
    gps.transmit(0x47);
    expect(r.b1.rx).toEqual([0x24, 0x47]);
    r.b1.tx(0x4f, 0x4b);
    expect(modem.heard).toEqual([0x4f, 0x4b]);
    // A wire b's controller drives is no wire a's MCU bit-bangs: no decoder
    // was wanted on a's pin, so a board that cannot time its pads is not told
    // to wire the modem to a hardware UART.
    expect(r.diags).toEqual([]);
  });

  it('a board that reads the wire as a plain GPIO gets the peer\'s bytes as edges at the sender\'s rate', () => {
    const r = rig({ aClock: true });
    // b's UART1 TX to a's pin 5, a SoftwareSerial RX.
    r.circuit.link(on('b', 8), on('a', 5));
    r.reg.netlistChanged();
    r.b1.cfg = { baud: 9600, frame: '8N1' };
    r.b1.tx(0x55);
    // 0x55 (LSB first: 1,0,1,0,1,0,1,0) after a start bit and before the
    // stop bit: every one of the ten bit slots is an edge.
    expect(r.aClock.edges.map((e) => e.pin)).toEqual(Array(10).fill(5));
    expect(r.aClock.edges[0]).toEqual({ pin: 5, level: false, at: 0 });
    const bit = 16e6 / 9600;
    expect(r.aClock.edges[1].at).toBe(Math.round(bit));
    expect(r.aClock.edges[9]).toEqual({ pin: 5, level: true, at: Math.round(9 * bit) });
    // A sender with no known rate cannot be clocked onto a GPIO.
    r.aClock.edges.length = 0;
    r.b1.cfg = {};
    r.b1.tx(0x55);
    expect(r.aClock.edges).toEqual([]);
  });

  it('a board that cannot time its pads gets nothing on a plain GPIO, and is not told so', () => {
    const r = rig();
    r.circuit.link(on('b', 8), on('a', 5));
    r.reg.netlistChanged();
    r.b1.cfg = { baud: 9600 };
    r.b1.tx(0x55);
    expect(r.aClock.edges).toEqual([]);
    expect(r.aPins.driven).toEqual([]);
    expect(r.diags).toEqual([]);
  });

  it('TX to TX between boards is contention, said once; RX to RX is a wire nobody drives, said once', () => {
    const r = rig();
    r.circuit.link(on('a', 18), on('b', 8));
    r.circuit.link(on('a', 19), on('b', 9));
    r.reg.netlistChanged();
    const tx = r.codes('uart-tx-contention');
    expect(tx).toHaveLength(1);
    expect(tx[0].message).toContain('USART1 of a (pin 18)');
    expect(tx[0].message).toContain('UART1 of b (pin 8)');
    expect(tx[0].message).toContain("each board's TX to the other board's RX");
    const rx = r.codes('uart-wiring');
    expect(rx).toHaveLength(1);
    expect(rx[0].message).toContain('USART1 of a (pin 19)');
    expect(rx[0].message).toContain('UART1 of b (pin 9)');
    expect(rx[0].message).toContain('both RX ends');
    // And nothing crosses: two transmitters and two listeners.
    r.a1.tx(0x01);
    r.b1.tx(0x02);
    expect(r.a1.rx).toEqual([]);
    expect(r.b1.rx).toEqual([]);
  });

  it('rates that disagree are reported, and the receiver reads what silicon would, not the byte', () => {
    const r = rig();
    crossed(r);
    r.a1.cfg = { baud: 115200, frame: '8N1' };
    r.b1.cfg = { baud: 9600, frame: '8N1' };
    r.a1.tx(0x55);
    expect(r.b1.rx).not.toEqual([0x55]);
    const m = r.codes('uart-baud-mismatch');
    expect(m).toHaveLength(1);
    expect(m[0].message).toContain('UART1');
    expect(m[0].message).toContain('USART1');
    // The same rate on both sides: the byte, and nothing more is said.
    r.b1.cfg = { baud: 115200, frame: '8N1' };
    r.b1.rx.length = 0;
    r.a1.tx(0x55);
    expect(r.b1.rx).toEqual([0x55]);
    expect(r.codes('uart-baud-mismatch')).toHaveLength(1);
  });

  it('lifting the wire ends the link; wiring it back restores it with no re-bind', () => {
    const r = rig();
    crossed(r);
    r.a1.tx(0x01);
    expect(r.b1.rx).toEqual([0x01]);
    r.circuit.clear();
    r.reg.netlistChanged();
    expect(r.reg.uartPeers('a', 18)).toEqual([]);
    expect(r.reg.servesUartWire('a', 18, 'b', 9)).toBe(false);
    r.a1.tx(0x02);
    expect(r.b1.rx).toEqual([0x01]);
    crossed(r);
    r.a1.tx(0x03);
    expect(r.b1.rx).toEqual([0x01, 0x03]);
  });

  it('a board whose engine is unbound receives nothing; bound again, the link is back', () => {
    const r = rig();
    crossed(r);
    r.reg.bindEngine('b', null);
    expect(r.reg.servesUartWire('a', 18, 'b', 9)).toBe(false);
    r.a1.tx(0x01);
    expect(r.b1.rx).toEqual([]);
    r.reg.bindEngine('b', r.bindingB);
    expect(r.reg.servesUartWire('a', 18, 'b', 9)).toBe(true);
    r.a1.tx(0x02);
    expect(r.b1.rx).toEqual([0x02]);
    r.b1.tx(0x03);
    expect(r.a1.rx).toEqual([0x03]);
  });

  it('a board that leaves the project takes its end of the wire', () => {
    const r = rig();
    crossed(r);
    r.circuit.kinds.delete('b');
    r.reg.unbindBoard('b');
    // The store recomputes membership right after a board leaves.
    r.reg.netlistChanged();
    expect(r.reg.uartPeers('a', 18)).toEqual([]);
    expect(r.reg.uartPeers('b', 9)).toEqual([]);
    r.a1.tx(0x01);
    expect(r.b1.rx).toEqual([]);
  });

  it('a resolver without resolveAll links nothing: each board is alone on its wires', () => {
    const r = rig();
    const bare: NetResolver = {
      resolve: (ref) => r.circuit.resolve(ref),
      boardKind: (id) => r.circuit.boardKind(id),
      boards: () => r.circuit.boards(),
    };
    r.reg.setResolver(bare);
    r.circuit.link(on('a', 18), on('b', 9));
    r.reg.netlistChanged();
    expect(r.reg.uartPeers('a', 18)).toEqual([]);
    expect(r.reg.servesUartWire('a', 18, 'b', 9)).toBe(false);
    r.a1.tx(0x01);
    expect(r.b1.rx).toEqual([]);
  });

  it('the link follows a controller the sketch moves to other pins', () => {
    const r = rig({ liveB: true });
    r.circuit.link(on('a', 18), on('b', 9));
    r.circuit.link(on('a', 1), on('b', 5));
    r.reg.netlistChanged();
    r.a1.tx(0x01);
    expect(r.b1.rx).toEqual([0x01]);
    // Serial2.setRX(5): UART1 now listens on GP5, which a's USART0 TX is wired to.
    r.b1.route = { tx: 4, rx: 5 };
    r.b1.routingChanged?.();
    expect(r.reg.servesUartWire('a', 18, 'b', 9)).toBe(false);
    expect(r.reg.servesUartWire('a', 1, 'b', 5)).toBe(true);
    r.a1.tx(0x02);
    expect(r.b1.rx).toEqual([0x01]);
    r.a0.tx(0x03);
    expect(r.b1.rx).toEqual([0x01, 0x03]);
  });

  it('a wire that reaches three boards is one net: every listening controller hears the transmitter once', () => {
    const r = rig();
    r.circuit.kinds.set('c', 'test-xb-rp');
    const c1 = new Port(1, 'UART1');
    r.reg.bindEngine('c', { pins: new Pins(), spi: [], uart: [new Port(0, 'UART0'), c1] });
    r.circuit.link(on('a', 18), on('b', 9), on('c', 9));
    r.reg.netlistChanged();
    expect(r.reg.uartPeers('a', 18)).toEqual([
      { boardId: 'b', pin: 9 },
      { boardId: 'c', pin: 9 },
    ]);
    r.a1.tx(0x07);
    expect(r.b1.rx).toEqual([0x07]);
    expect(c1.rx).toEqual([0x07]);
    expect(r.diags).toEqual([]);
  });
});
