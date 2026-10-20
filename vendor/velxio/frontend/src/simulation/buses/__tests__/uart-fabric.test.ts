/**
 * Layer 1 of project board-buses-2026-09 (TESTS.md), F6: the UART fabric on
 * its own, with a fake circuit, fake board pins, a fake guest clock and fake
 * controller ports that follow the real contracts. No engine here; the
 * engine adapters prove their ports with conformance/uartPortConformance.ts.
 */
import { describe, it, expect } from 'vitest';
import { BusRegistry } from '../registry';
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
  UartHandle,
  UartRouting,
} from '../types';
import { registerBoardPinFunctions } from '../pinFunctions';
import {
  frameBitCount,
  frameTransitions,
  parseUartFrame,
  resampleUartFrame,
  UartBitDecoder,
  type UartFrameSpec,
} from '../uartFrame';

// ── Fakes ───────────────────────────────────────────────────────────────────

/**
 * Board pins. `levels` is what the MCU latches, `driven` what a part puts on
 * a pin through driveInput. With `echo`, the engine reports the LINE (latch
 * AND driven) as the pin state and fires a pin change when a part drives it,
 * which is what some engines do with an input they are handed.
 */
class FakePins implements BoardPins {
  levels = new Map<number, boolean>();
  driven = new Map<number, boolean>();
  pads = new Map<number, { drive: 'low' | 'high' | 'z'; pull: 0 | 1 | 2 }>();
  echo = false;
  private listeners = new Map<number, Set<(p: number, l: boolean) => void>>();
  private padListeners = new Map<number, Set<() => void>>();
  onPinChange(pin: number, cb: (p: number, l: boolean) => void): () => void {
    let s = this.listeners.get(pin);
    if (!s) this.listeners.set(pin, (s = new Set()));
    s.add(cb);
    return () => this.listeners.get(pin)?.delete(cb);
  }
  peekPinState(pin: number): boolean | undefined {
    if (this.echo) return (this.levels.get(pin) ?? true) && this.driven.get(pin) !== false;
    return this.levels.get(pin);
  }
  peekPad(pin: number): { drive: 'low' | 'high' | 'z'; pull: 0 | 1 | 2 } | undefined {
    return this.pads.get(pin);
  }
  onPadChange(pin: number, cb: () => void): () => void {
    let s = this.padListeners.get(pin);
    if (!s) this.padListeners.set(pin, (s = new Set()));
    s.add(cb);
    return () => this.padListeners.get(pin)?.delete(cb);
  }
  driveInput(pin: number, level: boolean): void {
    const before = this.peekPinState(pin);
    this.driven.set(pin, level);
    if (this.echo && before !== this.peekPinState(pin)) this.fire(pin);
  }
  /** The MCU writes the pin (digitalWrite). */
  write(pin: number, level: boolean): void {
    const before = this.peekPinState(pin);
    this.levels.set(pin, level);
    if (before !== this.peekPinState(pin) || !this.echo) this.fire(pin);
  }
  pad(pin: number, drive: 'low' | 'high' | 'z', pull: 0 | 1 | 2 = 0): void {
    this.pads.set(pin, { drive, pull });
    for (const cb of this.padListeners.get(pin) ?? []) cb();
  }
  /** An MCU reset: the MCU's own latches and pads, not what the parts drive. */
  reset(): void {
    this.levels.clear();
    this.pads.clear();
  }
  private fire(pin: number): void {
    const l = this.peekPinState(pin) ?? true;
    for (const cb of this.listeners.get(pin) ?? []) cb(pin, l);
  }
}

/**
 * The guest's clock: cycles advanced by the test, timers run and scheduled
 * input edges applied in cycle order as the clock passes them (an edge and a
 * timer at the same cycle: the edge first, as an engine applies its inputs
 * before it runs a clock event).
 */
class FakeClock implements GuestClock {
  cycles = 0;
  /** Mutable: an engine's clock moves (the ESP32 boots at the ROM rate, the app raises it). */
  hz: number;
  /** Every scheduled edge, in the order it was scheduled. */
  edges: Array<{ pin: number; level: boolean; at: number }> = [];
  /** The engine applying a scheduled input at its cycle; null = only logged. */
  apply: ((pin: number, level: boolean) => void) | null = null;
  private pending: Array<{ pin: number; level: boolean; at: number }> = [];
  private timers: Array<{ at: number; cb: () => void; live: boolean }> = [];
  constructor(hz = 16e6) {
    this.hz = hz;
  }
  now(): number {
    return this.cycles;
  }
  clockHz(): number {
    return this.hz;
  }
  scheduleEdge(pin: number, level: boolean, at: number): void {
    this.edges.push({ pin, level, at });
    this.pending.push({ pin, level, at });
  }
  at(at: number, cb: () => void): () => void {
    const t = { at, cb, live: true };
    this.timers.push(t);
    return () => {
      t.live = false;
    };
  }
  get liveTimers(): number {
    return this.timers.filter((t) => t.live).length;
  }
  advance(to: number): void {
    for (;;) {
      let e: (typeof this.pending)[number] | null = null;
      for (const x of this.pending) if (x.at <= to && (!e || x.at < e.at)) e = x;
      let t: (typeof this.timers)[number] | null = null;
      for (const x of this.timers) if (x.live && x.at <= to && (!t || x.at < t.at)) t = x;
      if (!e && !t) break;
      if (e && (!t || e.at <= t.at)) {
        this.pending.splice(this.pending.indexOf(e), 1);
        this.cycles = Math.max(this.cycles, e.at);
        this.apply?.(e.pin, e.level);
      } else if (t) {
        t.live = false;
        this.cycles = Math.max(this.cycles, t.at);
        t.cb();
      }
    }
    this.cycles = Math.max(this.cycles, to);
  }
}

/** A controller port whose "guest" is a TX call and an RX queue. */
class FakeUartPort implements UartControllerPort {
  readonly bus = 'uart' as const;
  handler: ((byte: number) => void) | null = null;
  rx: number[] = [];
  cfg: UartConfig = {};
  route: UartRouting | 'static';
  routingChanged: (() => void) | null = null;
  readonly unit: number;
  readonly name: string;
  constructor(unit: number, name: string, route: UartRouting | 'static' = 'static') {
    this.unit = unit;
    this.name = name;
    this.route = route;
  }
  setTxHandler(h: ((byte: number) => void) | null): void {
    this.handler = h;
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
  setRoutingChangeHandler(h: (() => void) | null): void {
    this.routingChanged = h;
  }
  /** Serial.write. */
  tx(...bytes: number[]): void {
    for (const b of bytes) this.handler?.(b);
  }
}

class FakeCircuit implements NetResolver {
  nets = new Map<string, ResolvedPin>();
  kinds = new Map<string, string>();
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    const r = this.nets.get(`${ref.componentId}:${ref.pinName}`) ?? { kind: 'floating' };
    // A wire to a board that left the canvas reaches nothing, as the trace says.
    if (r.kind === 'board' && !this.kinds.has(r.boardId)) return { kind: 'floating' };
    return r;
  }
  boardKind(id: string): string | undefined {
    return this.kinds.get(id);
  }
  boards(): string[] {
    return Array.from(this.kinds.keys());
  }
  wire(comp: string, pin: string, to: ResolvedPin | null): void {
    if (to) this.nets.set(`${comp}:${pin}`, to);
    else this.nets.delete(`${comp}:${pin}`);
  }
}

const gpio = (pin: number, boardId = 'uno'): ResolvedPin => ({ kind: 'board', boardId, pin });

class Modem implements UartEndpoint {
  heard: number[] = [];
  resets = 0;
  receive(byte: number): void {
    this.heard.push(byte);
  }
  boardReset(): void {
    this.resets++;
  }
}

// Uno-like: USART0 on 0 (RX) / 1 (TX). Mega-like: plus USART1 on 19 / 18.
registerBoardPinFunctions(['test-uno-uart'], {
  routing: 'fixed',
  source: 'test',
  controllers: [{ bus: 'uart', unit: 0, name: 'USART0', arduino: ['Serial'], defaultPins: { rx: 0, tx: 1 } }],
  pins: {
    0: [{ bus: 'uart', unit: 0, signal: 'rx' }],
    1: [{ bus: 'uart', unit: 0, signal: 'tx' }],
  },
});
registerBoardPinFunctions(['test-mega-uart'], {
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

interface RigOptions {
  kind?: string;
  boardId?: string;
  ports?: FakeUartPort[];
  clock?: FakeClock | null;
  hz?: number;
}

function rig(opts: RigOptions = {}) {
  const reg = new BusRegistry();
  const circuit = new FakeCircuit();
  const boardId = opts.boardId ?? 'uno';
  circuit.kinds.set(boardId, opts.kind ?? 'test-uno-uart');
  const pins = new FakePins();
  const ports = opts.ports ?? [new FakeUartPort(0, 'USART0')];
  const clock = opts.clock === undefined ? new FakeClock(opts.hz) : opts.clock;
  if (clock) clock.apply = (pin, level) => pins.driveInput(pin, level);
  let resetHandler: (() => void) | null = null;
  const binding: EngineBinding = {
    pins,
    spi: [],
    uart: ports,
    ...(clock ? { clock } : {}),
    setResetHandler: (h) => {
      resetHandler = h;
    },
  };
  const diags: BusDiagnostic[] = [];
  reg.onDiagnostic((d) => diags.push(d));
  reg.setResolver(circuit);
  reg.bindEngine(boardId, binding);
  /** Register an endpoint with its RX leg on `rx` and its TX leg on `tx` (null = unwired). */
  const endpoint = (
    id: string,
    modem: UartEndpoint,
    rx: ResolvedPin | null,
    tx: ResolvedPin | null,
    extra: { baud?: number; frame?: string } = {},
  ) => {
    circuit.wire(id, 'RX', rx);
    circuit.wire(id, 'TX', tx);
    return reg.attachUart({ owner: id, pins: { rx: 'RX', tx: 'TX' }, ...extra }, modem);
  };
  return {
    reg,
    circuit,
    pins,
    ports,
    port: ports[0],
    clock: clock as FakeClock,
    binding,
    diags,
    boardId,
    endpoint,
    codes: () => diags.map((d) => d.code),
    mcuReset: () => {
      pins.reset();
      resetHandler?.();
    },
  };
}

/** The guest bit-bangs one frame on `pin` at `baud`, starting now, with per-edge jitter in bits. */
function bang(
  r: ReturnType<typeof rig>,
  pin: number,
  byte: number,
  baud: number,
  opts: { jitter?: () => number; spec?: UartFrameSpec; gapBits?: number } = {},
): void {
  const spec = opts.spec ?? parseUartFrame('8N1');
  const bit = r.clock.hz / baud;
  const t0 = r.clock.cycles;
  for (const tr of frameTransitions(byte, spec)) {
    const at = t0 + (tr.slot + (opts.jitter?.() ?? 0)) * bit;
    r.clock.advance(Math.round(at));
    r.pins.write(pin, tr.level);
  }
  r.clock.advance(Math.round(t0 + (frameBitCount(spec) + (opts.gapBits ?? 0)) * bit));
}

const text = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

// ── Membership ──────────────────────────────────────────────────────────────

describe('UART fabric: membership from the nets', () => {
  it('a builtin whose owner is not a component resolves its pins through componentId', () => {
    // A board's own module ('builtin:<board>:<name>') names the component its
    // pin names belong to; the owner is only its identity.
    const r = rig();
    const m = new Modem();
    r.circuit.wire('radio1', 'RX', gpio(1));
    r.circuit.wire('radio1', 'TX', gpio(0));
    const h = r.reg.attachUart({ owner: 'builtin:uno:radio', componentId: 'radio1', pins: { rx: 'RX', tx: 'TX' } }, m);
    r.port.tx(0x41);
    h.transmit(0x42);
    expect(m.heard).toEqual([0x41]);
    expect(r.port.rx).toEqual([0x42]);
    expect(r.reg.uartPlacement('builtin:uno:radio')?.rx?.controller).toBe('USART0');
  });

  it('a module on the USART pins hears Serial and answers into it', () => {
    const r = rig();
    const m = new Modem();
    const h = r.endpoint('modem', m, gpio(1), gpio(0));
    r.port.tx(...text('AT\r\n'));
    expect(m.heard).toEqual(text('AT\r\n'));
    for (const b of text('OK\r\n')) h.transmit(b);
    expect(r.port.rx).toEqual(text('OK\r\n'));
    expect(r.reg.uartPlacement('modem')).toEqual({
      rx: { boardId: 'uno', pin: 1, controller: 'USART0' },
      tx: { boardId: 'uno', pin: 0, controller: 'USART0' },
    });
    expect(r.codes()).toEqual([]);
  });

  it('a module with only a TX leg (a GPS) reaches the board and hears nothing', () => {
    const r = rig();
    const m = new Modem();
    const h = r.endpoint('gps', m, null, gpio(0));
    h.transmit(0x24);
    r.port.tx(0x41);
    expect(r.port.rx).toEqual([0x24]);
    expect(m.heard).toEqual([]);
    expect(r.reg.uartPlacement('gps')).toEqual({ rx: null, tx: { boardId: 'uno', pin: 0, controller: 'USART0' } });
  });

  it('a module with only an RX leg (a display) hears the board; what it transmits goes nowhere', () => {
    const r = rig();
    const m = new Modem();
    const h = r.endpoint('lcd', m, gpio(1), null);
    r.port.tx(0x41, 0x42);
    h.transmit(0x99);
    expect(m.heard).toEqual([0x41, 0x42]);
    expect(r.port.rx).toEqual([]);
  });

  it('an unwired module is on no wire, silently: no default UART, no diagnostic', () => {
    const r = rig();
    const m = new Modem();
    const h = r.endpoint('modem', m, null, null);
    r.port.tx(0x41);
    h.transmit(0x42);
    expect(m.heard).toEqual([]);
    expect(r.port.rx).toEqual([]);
    expect(r.reg.uartPlacement('modem')).toEqual({ rx: null, tx: null });
    expect(r.codes()).toEqual([]);
  });

  it('a module on the Mega Serial1 pins is on USART1 only, both ways', () => {
    const p0 = new FakeUartPort(0, 'USART0');
    const p1 = new FakeUartPort(1, 'USART1');
    const r = rig({ kind: 'test-mega-uart', ports: [p0, p1] });
    const m = new Modem();
    const h = r.endpoint('modem', m, gpio(18), gpio(19));
    p0.tx(0x11);
    p1.tx(0x22);
    h.transmit(0x33);
    expect(m.heard).toEqual([0x22]);
    expect(p0.rx).toEqual([]);
    expect(p1.rx).toEqual([0x33]);
    expect(r.reg.uartPlacement('modem')?.rx?.controller).toBe('USART1');
  });

  it('a module on another board goes to that board, and boards do not cross-talk', () => {
    const r = rig();
    const espPort = new FakeUartPort(2, 'UART2', { tx: 17, rx: 16 });
    r.circuit.kinds.set('esp', 'test-uno-uart');
    r.reg.bindEngine('esp', {
      pins: new FakePins(),
      spi: [],
      uart: [espPort],
    });
    const onUno = new Modem();
    const onEsp = new Modem();
    const hu = r.endpoint('m-uno', onUno, gpio(1), gpio(0));
    const he = r.endpoint('m-esp', onEsp, gpio(17, 'esp'), gpio(16, 'esp'));
    r.port.tx(0x11);
    espPort.tx(0x22);
    hu.transmit(0xa1);
    he.transmit(0xa2);
    expect(onUno.heard).toEqual([0x11]);
    expect(onEsp.heard).toEqual([0x22]);
    expect(r.port.rx).toEqual([0xa1]);
    expect(espPort.rx).toEqual([0xa2]);
  });

  it('rewiring moves a module between UARTs without re-attaching', () => {
    const p0 = new FakeUartPort(0, 'USART0');
    const p1 = new FakeUartPort(1, 'USART1');
    const r = rig({ kind: 'test-mega-uart', ports: [p0, p1] });
    const m = new Modem();
    const h = r.endpoint('modem', m, gpio(1), gpio(0));
    p0.tx(0x01);
    r.circuit.wire('modem', 'RX', gpio(18));
    r.circuit.wire('modem', 'TX', gpio(19));
    r.reg.netlistChanged();
    p0.tx(0x02);
    p1.tx(0x03);
    h.transmit(0x04);
    expect(m.heard).toEqual([0x01, 0x03]);
    expect(p0.rx).toEqual([]);
    expect(p1.rx).toEqual([0x04]);
    expect(r.reg.uartPlacement('modem')?.tx?.controller).toBe('USART1');
  });

  it('one TX, several RX: every module on the board TX hears every byte once', () => {
    const r = rig();
    const a = new Modem();
    const b = new Modem();
    r.endpoint('a', a, gpio(1), null);
    r.endpoint('b', b, gpio(1), null);
    r.port.tx(0x41, 0x42, 0x43);
    expect(a.heard).toEqual([0x41, 0x42, 0x43]);
    expect(b.heard).toEqual([0x41, 0x42, 0x43]);
    expect(r.codes()).toEqual([]);
  });

  it('a leg on a rail or on nothing is on no wire; the other leg still works', () => {
    const r = rig();
    const m = new Modem();
    r.circuit.wire('m', 'RX', gpio(1));
    r.circuit.wire('m', 'TX', { kind: 'rail', rail: 'gnd' });
    const h = r.reg.attachUart({ owner: 'm', pins: { rx: 'RX', tx: 'TX' } }, m);
    r.port.tx(0x41);
    h.transmit(0x42);
    expect(m.heard).toEqual([0x41]);
    expect(r.port.rx).toEqual([]);
    expect(r.reg.uartPlacement('m')?.tx).toBeNull();
  });

  it('a controller the sketch moves to other pins (the ESP32 matrix) picks the module up there', () => {
    const port = new FakeUartPort(1, 'UART1', { tx: undefined, rx: undefined });
    const r = rig({ ports: [port] });
    const m = new Modem();
    const h = r.endpoint('modem', m, gpio(17), gpio(16), { baud: 9600 });
    // Before Serial1.begin(9600, SERIAL_8N1, 16, 17): the pins are GPIOs.
    expect(r.reg.uartPlacement('modem')?.rx?.controller).toBeNull();
    port.route = { tx: 17, rx: 16 };
    port.routingChanged?.();
    expect(r.reg.uartPlacement('modem')?.rx?.controller).toBe('UART1');
    port.tx(0x41);
    h.transmit(0x42);
    expect(m.heard).toEqual([0x41]);
    expect(port.rx).toEqual([0x42]);
  });
});

// ── Wiring mistakes ─────────────────────────────────────────────────────────

describe('UART fabric: wiring and contention', () => {
  it('RX to RX and TX to TX (crossed) is reported, and nothing flows', () => {
    const r = rig();
    const m = new Modem();
    const h = r.endpoint('modem', m, gpio(0), gpio(1));
    r.port.tx(0x41);
    h.transmit(0x42);
    expect(m.heard).toEqual([]);
    expect(r.port.rx).toEqual([]);
    const codes = r.codes();
    expect(codes).toContain('uart-wiring');
    expect(codes).toContain('uart-tx-contention');
    const cross = r.diags.find((d) => d.code === 'uart-tx-contention')!;
    expect(cross.owners).toEqual(['modem']);
    expect(cross.message).toContain('USART0');
  });

  it('two modules transmitting on one board RX pin: contention, reported once, both still heard', () => {
    const r = rig();
    const a = new Modem();
    const b = new Modem();
    const ha = r.endpoint('a', a, null, gpio(0));
    const hb = r.endpoint('b', b, null, gpio(0));
    ha.transmit(0x01);
    hb.transmit(0x02);
    expect(r.port.rx).toEqual([0x01, 0x02]);
    const c = r.diags.filter((d) => d.code === 'uart-tx-contention');
    expect(c).toHaveLength(1);
    expect(c[0].owners).toEqual(['a', 'b']);
    // Removing one driver ends the contention; nothing new is reported.
    hb.dispose();
    ha.transmit(0x03);
    expect(r.port.rx).toEqual([0x01, 0x02, 0x03]);
    expect(r.diags.filter((d) => d.code === 'uart-tx-contention')).toHaveLength(1);
  });

  it('two modules wired TX to TX on a plain GPIO: contention between them, named', () => {
    const r = rig();
    r.endpoint('a', new Modem(), null, gpio(5), { baud: 9600 });
    r.endpoint('b', new Modem(), null, gpio(5), { baud: 9600 });
    const c = r.diags.find((d) => d.code === 'uart-tx-contention')!;
    expect(c.owners).toEqual(['a', 'b']);
    expect(c.message).not.toContain('USART0');
  });

  it('two controllers routed to the same TX pin are reported', () => {
    const p0 = new FakeUartPort(0, 'UART0', { tx: 4, rx: 5 });
    const p1 = new FakeUartPort(1, 'UART1', { tx: 4, rx: 6 });
    const r = rig({ ports: [p0, p1] });
    r.endpoint('m', new Modem(), gpio(4), null);
    const w = r.diags.find((d) => d.code === 'uart-wiring')!;
    expect(w.owners).toEqual([]);
    expect(w.message).toContain('UART0');
    expect(w.message).toContain('UART1');
  });

  it('a board TX wired to its own RX pin loops back, as on the bench', () => {
    const port = new FakeUartPort(0, 'UART0', { tx: 4, rx: 4 });
    const r = rig({ ports: [port] });
    const m = new Modem();
    r.endpoint('m', m, gpio(4), null);
    port.tx(0x41);
    expect(port.rx).toEqual([0x41]);
    expect(m.heard).toEqual([0x41]);
  });
});

// ── Rates ───────────────────────────────────────────────────────────────────

describe('UART fabric: baud and frame', () => {
  it('the same rate on both sides (within tolerance) passes every byte, with no diagnostic', () => {
    const r = rig();
    r.port.cfg = { baud: 9615, frame: '8N1' };
    const m = new Modem();
    const h = r.endpoint('modem', m, gpio(1), gpio(0), { baud: 9600 });
    const all = Array.from({ length: 256 }, (_, i) => i);
    r.port.tx(...all);
    for (const b of all) h.transmit(b);
    expect(m.heard).toEqual(all);
    expect(r.port.rx).toEqual(all);
    expect(r.codes()).toEqual([]);
  });

  it('a module at 9600 on a controller at 115200 reads garbage both ways, and the mismatch is reported once', () => {
    const r = rig();
    r.port.cfg = { baud: 115200 };
    const m = new Modem();
    const h = r.endpoint('modem', m, gpio(1), gpio(0), { baud: 9600 });
    const msg = text('AT\r\n');
    r.port.tx(...msg);
    const f = parseUartFrame('8N1');
    expect(m.heard).toEqual(msg.flatMap((b) => resampleUartFrame(b, f, 115200, f, 9600)));
    expect(m.heard).not.toEqual(msg);
    for (const b of text('OK')) h.transmit(b);
    expect(r.port.rx).toEqual(text('OK').flatMap((b) => resampleUartFrame(b, f, 9600, f, 115200)));
    expect(r.port.rx).not.toEqual(text('OK'));
    const d = r.diags.filter((x) => x.code === 'uart-baud-mismatch');
    expect(d).toHaveLength(1);
    expect(d[0].owners).toEqual(['modem']);
    expect(d[0].message).toContain('9600');
    expect(d[0].message).toContain('115200');
  });

  it('a module that declares no rate takes the bytes as they are at any rate', () => {
    const r = rig();
    r.port.cfg = { baud: 115200 };
    const m = new Modem();
    const h = r.endpoint('term', m, gpio(1), gpio(0));
    r.port.tx(0x55);
    h.transmit(0xaa);
    expect(m.heard).toEqual([0x55]);
    expect(r.port.rx).toEqual([0xaa]);
    expect(r.codes()).toEqual([]);
  });

  it('a controller whose rate is not known yet is not checked', () => {
    const r = rig();
    const m = new Modem();
    r.endpoint('modem', m, gpio(1), gpio(0), { baud: 9600 });
    r.port.tx(0x55);
    expect(m.heard).toEqual([0x55]);
    expect(r.codes()).toEqual([]);
  });

  it('the same rate with another frame is read through that frame, and reported', () => {
    const r = rig();
    r.port.cfg = { baud: 9600, frame: '8N1' };
    const m = new Modem();
    r.endpoint('modem', m, gpio(1), null, { baud: 9600, frame: '7E1' });
    r.port.tx(0x41, 0x43);
    const f8 = parseUartFrame('8N1');
    const f7 = parseUartFrame('7E1');
    expect(m.heard).toEqual([...resampleUartFrame(0x41, f8, 9600, f7, 9600), ...resampleUartFrame(0x43, f8, 9600, f7, 9600)]);
    expect(m.heard).toEqual([0x41]);
    expect(r.codes()).toEqual(['uart-baud-mismatch']);
  });

  it('the mismatch of a module reaching another module through a board pin names both', () => {
    const r = rig();
    const gps = new Modem();
    const lcd = new Modem();
    const hg = r.endpoint('gps', gps, null, gpio(7), { baud: 9600 });
    r.endpoint('lcd', lcd, gpio(7), null, { baud: 19200 });
    hg.transmit(0x24);
    const d = r.diags.find((x) => x.code === 'uart-baud-mismatch')!;
    expect(d.owners).toEqual(['lcd']);
    expect(d.message).toContain('gps');
    expect(lcd.heard).not.toEqual([0x24]);
  });
});

// ── Order and identity ──────────────────────────────────────────────────────

describe('UART fabric: attach order does not matter', () => {
  it('two modules that answer from receive() reach the board RX in the same order whichever was attached first', () => {
    // A modem answers the byte it hears at once, from inside receive(): the
    // order the board reads the two answers in must not be the mount order.
    class Echo implements UartEndpoint {
      handle: UartHandle | null = null;
      readonly tag: number;
      constructor(tag: number) {
        this.tag = tag;
      }
      receive(): void {
        this.handle?.transmit(this.tag);
      }
    }
    const answers: number[][] = [];
    for (const order of [['a', 'b'], ['b', 'a']]) {
      const r = rig();
      const echoes: Record<string, Echo> = { a: new Echo(0xa1), b: new Echo(0xb2) };
      for (const id of order) echoes[id].handle = r.endpoint(id, echoes[id], gpio(1), gpio(0));
      r.port.tx(0x41);
      answers.push(r.port.rx.slice());
    }
    expect(answers[0]).toEqual([0xa1, 0xb2]);
    expect(answers[1]).toEqual(answers[0]);
  });

  it('every permutation of three modules on one wire gives the same traffic', () => {
    const perms = <T,>(xs: T[]): T[][] =>
      xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
    const results: string[] = [];
    for (const order of perms(['a', 'b', 'c'])) {
      const r = rig();
      const modems: Record<string, Modem> = { a: new Modem(), b: new Modem(), c: new Modem() };
      const handles: Record<string, ReturnType<typeof r.endpoint>> = {};
      for (const id of order) {
        // a and b listen on the board TX; c drives the board RX and listens too.
        handles[id] = r.endpoint(id, modems[id], gpio(1), id === 'c' ? gpio(0) : null);
      }
      r.port.tx(0x11, 0x22);
      handles.c.transmit(0x33);
      results.push(
        JSON.stringify({
          a: modems.a.heard,
          b: modems.b.heard,
          c: modems.c.heard,
          rx: r.port.rx,
          codes: r.codes(),
        }),
      );
    }
    expect(new Set(results).size).toBe(1);
    expect(JSON.parse(results[0])).toEqual({ a: [0x11, 0x22], b: [0x11, 0x22], c: [0x11, 0x22], rx: [0x33], codes: [] });
  });
});

describe('UART fabric: removal by identity', () => {
  it('disposing a module takes both legs off; the other module on the same wires stays', () => {
    const r = rig();
    const a = new Modem();
    const b = new Modem();
    const ha = r.endpoint('a', a, gpio(1), gpio(0));
    const hb = r.endpoint('b', b, gpio(1), gpio(0));
    ha.dispose();
    r.port.rx.length = 0;
    r.port.tx(0x41);
    ha.transmit(0x01);
    hb.transmit(0x02);
    expect(a.heard).toEqual([]);
    expect(b.heard).toEqual([0x41]);
    expect(r.port.rx).toEqual([0x02]);
    expect(r.reg.uartPlacement('a')).toBeNull();
  });

  it('a stale handle never removes the owner registered after it', () => {
    const r = rig();
    const old = new Modem();
    const fresh = new Modem();
    const hOld = r.endpoint('modem', old, gpio(1), gpio(0));
    const hNew = r.endpoint('modem', fresh, gpio(1), gpio(0));
    hOld.dispose();
    r.port.tx(0x41);
    hOld.transmit(0x01);
    hNew.transmit(0x02);
    expect(old.heard).toEqual([]);
    expect(fresh.heard).toEqual([0x41]);
    expect(r.port.rx).toEqual([0x02]);
  });

  it('registering an owner again replaces the old instance', () => {
    const r = rig();
    const old = new Modem();
    const fresh = new Modem();
    r.endpoint('modem', old, gpio(1), gpio(0));
    r.endpoint('modem', fresh, gpio(1), gpio(0));
    r.port.tx(0x41);
    expect(old.heard).toEqual([]);
    expect(fresh.heard).toEqual([0x41]);
    expect(r.reg.uartMap('uno')).toHaveLength(1);
  });

  it('an empty wire goes away, and nothing on it is reported after', () => {
    const r = rig();
    const h = r.endpoint('m', new Modem(), gpio(1), gpio(0));
    expect(r.reg.fabric('uno').uartNets.size).toBe(2);
    h.dispose();
    expect(r.reg.fabric('uno').uartNets.size).toBe(0);
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe('UART fabric: lifecycle', () => {
  it('with the engine unbound, a module on the old USART pins is on no controller, and the next bind finds it', () => {
    // Between one engine leaving and the next binding, the wire has no
    // controller: nothing is reported against a port that is gone.
    const r = rig();
    const m = new Modem();
    const h = r.endpoint('modem', m, gpio(1), gpio(0));
    r.reg.bindEngine('uno', null);
    expect(r.reg.uartPlacement('modem')).toEqual({
      rx: { boardId: 'uno', pin: 1, controller: null },
      tx: { boardId: 'uno', pin: 0, controller: null },
    });
    r.reg.bindEngine('uno', r.binding);
    r.port.tx(0x41);
    h.transmit(0x42);
    expect(m.heard).toEqual([0x41]);
    expect(r.port.rx).toEqual([0x42]);
    expect(r.codes()).toEqual([]);
  });

  it('re-binding the engine keeps every module and releases the old ports', () => {
    const r = rig();
    const m = new Modem();
    const h = r.endpoint('modem', m, gpio(1), gpio(0));
    const port2 = new FakeUartPort(0, 'USART0');
    r.reg.bindEngine('uno', { pins: new FakePins(), spi: [], uart: [port2] });
    expect(r.port.handler).toBeNull();
    r.port.tx(0x01);
    port2.tx(0x02);
    h.transmit(0x03);
    expect(m.heard).toEqual([0x02]);
    expect(port2.rx).toEqual([0x03]);
    expect(r.port.rx).toEqual([]);
  });

  it('an MCU reset tells each module once, whatever legs it has on the board', () => {
    const r = rig();
    const both = new Modem();
    const one = new Modem();
    r.endpoint('both', both, gpio(1), gpio(0));
    r.endpoint('one', one, gpio(1), null);
    r.mcuReset();
    expect(both.resets).toBe(1);
    expect(one.resets).toBe(1);
    // And the wires are still there.
    r.port.tx(0x41);
    expect(both.heard).toEqual([0x41]);
    expect(one.heard).toEqual([0x41]);
  });

  it('an engine with no UART ports still binds, and its pins are software wires', () => {
    const r = rig({ ports: [] });
    const m = new Modem();
    r.endpoint('modem', m, gpio(1), gpio(0), { baud: 9600 });
    expect(r.reg.uartPlacement('modem')).toEqual({
      rx: { boardId: 'uno', pin: 1, controller: null },
      tx: { boardId: 'uno', pin: 0, controller: null },
    });
    expect(r.codes()).toEqual([]);
  });

  it('a board that leaves the circuit takes its modules off', () => {
    const r = rig();
    const m = new Modem();
    const h = r.endpoint('modem', m, gpio(1), gpio(0));
    r.circuit.kinds.delete('uno');
    r.reg.unbindBoard('uno');
    expect(r.reg.uartPlacement('modem')).toEqual({ rx: null, tx: null });
    r.reg.netlistChanged();
    expect(r.reg.uartPlacement('modem')).toEqual({ rx: null, tx: null });
    h.transmit(0x01);
    expect(r.port.rx).toEqual([]);
  });

  it('transmit after dispose is a no-op', () => {
    const r = rig();
    const h = r.endpoint('modem', new Modem(), gpio(1), gpio(0));
    h.dispose();
    h.transmit(0x41);
    expect(r.port.rx).toEqual([]);
  });

  it('the UART map names the controller each leg is wired to, and the map listener hears changes', async () => {
    const p0 = new FakeUartPort(0, 'USART0');
    const p1 = new FakeUartPort(1, 'USART1');
    const r = rig({ kind: 'test-mega-uart', ports: [p0, p1] });
    const changed: string[] = [];
    r.reg.onUartMapChange((id) => changed.push(id));
    r.endpoint('modem', new Modem(), gpio(18), gpio(19), { baud: 9600 });
    r.endpoint('gps', new Modem(), null, gpio(0), { baud: 4800 });
    r.endpoint('soft', new Modem(), gpio(5), gpio(6), { baud: 9600, frame: '7E1' });
    expect(r.reg.uartMap('uno')).toEqual([
      { owner: 'gps', rx_uart: null, tx_uart: 0, rx_pin: null, tx_pin: 0, baud: 4800, frame: '8N1' },
      { owner: 'modem', rx_uart: 1, tx_uart: 1, rx_pin: 18, tx_pin: 19, baud: 9600, frame: '8N1' },
      { owner: 'soft', rx_uart: null, tx_uart: null, rx_pin: 5, tx_pin: 6, baud: 9600, frame: '7E1' },
    ]);
    await Promise.resolve();
    expect(changed).toEqual(['uno']);
  });
});

// ── Software UART ───────────────────────────────────────────────────────────

describe('UART fabric: a bit-banged TX on a plain GPIO is decoded on the guest clock', () => {
  for (const [hz, label] of [
    [16e6, '16 MHz (AVR)'],
    [125e6, '125 MHz (RP2040)'],
  ] as const) {
    for (const baud of [9600, 115200]) {
      it(`${label}, ${baud} baud: SoftwareSerial.print("AT\\r\\n") on D3 reaches the module`, () => {
        const r = rig({ hz });
        const m = new Modem();
        r.endpoint('modem', m, gpio(3), null, { baud });
        r.pins.write(3, true); // the sketch's pinMode(3, OUTPUT); digitalWrite(3, HIGH)
        r.clock.advance(1000);
        for (const b of text('AT\r\n')) bang(r, 3, b, baud);
        expect(m.heard).toEqual(text('AT\r\n'));
        expect(r.codes()).toEqual([]);
      });
    }
  }

  it('the last byte of a message is delivered when the stop bit is sampled, not at the next start bit', () => {
    const r = rig();
    const m = new Modem();
    r.endpoint('modem', m, gpio(3), null, { baud: 9600 });
    r.pins.write(3, true);
    const bit = 16e6 / 9600;
    const t0 = r.clock.cycles;
    // 'A' = 0x41: its last edge is the rising edge into the stop bit.
    for (const tr of frameTransitions(0x41, parseUartFrame('8N1'))) {
      r.clock.advance(Math.round(t0 + tr.slot * bit));
      r.pins.write(3, tr.level);
    }
    const stop = Math.ceil(t0 + 9.5 * bit);
    r.clock.advance(stop - 1);
    expect(m.heard).toEqual([]);
    r.clock.advance(stop);
    expect(m.heard).toEqual([0x41]);
    expect(r.clock.liveTimers).toBe(0);
  });

  it('0xFF and 0x00, the frames with the fewest edges, decode on the clock alone', () => {
    const r = rig();
    const m = new Modem();
    r.endpoint('modem', m, gpio(3), null, { baud: 9600 });
    r.pins.write(3, true);
    bang(r, 3, 0xff, 9600);
    bang(r, 3, 0x00, 9600);
    bang(r, 3, 0xff, 9600);
    expect(m.heard).toEqual([0xff, 0x00, 0xff]);
  });

  it('back-to-back bytes with no idle gap, and jittered edges, still decode', () => {
    const r = rig({ hz: 125e6 });
    const m = new Modem();
    r.endpoint('modem', m, gpio(3), null, { baud: 115200 });
    r.pins.write(3, true);
    let seed = 3;
    const jitter = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 0.4 - 0.2;
    const msg = Array.from({ length: 64 }, (_, i) => (i * 53 + 7) & 0xff);
    for (const b of msg) bang(r, 3, b, 115200, { jitter });
    expect(m.heard).toEqual(msg);
  });

  it('a glitch shorter than half a bit is not a start bit', () => {
    const r = rig();
    const m = new Modem();
    r.endpoint('modem', m, gpio(3), null, { baud: 9600 });
    r.pins.write(3, true);
    r.clock.advance(100);
    r.pins.write(3, false);
    r.clock.advance(100 + 200);
    r.pins.write(3, true);
    r.clock.advance(100000);
    expect(m.heard).toEqual([]);
    bang(r, 3, 0x5a, 9600);
    expect(m.heard).toEqual([0x5a]);
  });

  it('the guest bit-banging at the wrong rate is read as garbage, as on hardware', () => {
    const r = rig();
    const m = new Modem();
    r.endpoint('modem', m, gpio(3), null, { baud: 9600 });
    r.pins.write(3, true);
    for (const b of text('AT\r\n')) bang(r, 3, b, 19200);
    expect(m.heard).not.toEqual(text('AT\r\n'));
  });

  it('two modules at different rates on one wire each decode at their own rate', () => {
    const r = rig();
    const fast = new Modem();
    const slow = new Modem();
    r.endpoint('fast', fast, gpio(3), null, { baud: 19200 });
    r.endpoint('slow', slow, gpio(3), null, { baud: 9600 });
    r.pins.write(3, true);
    for (const b of text('AT')) bang(r, 3, b, 9600);
    expect(slow.heard).toEqual(text('AT'));
    expect(fast.heard).not.toEqual(text('AT'));
  });

  it('a byte with a parity error is dropped, as HardwareSerial drops it; a good one is delivered', () => {
    const r = rig();
    const m = new Modem();
    r.endpoint('modem', m, gpio(3), null, { baud: 9600, frame: '7E1' });
    r.pins.write(3, true);
    // The guest sends 8N1: the MSB lands in the parity slot. 0x41 (two ones,
    // MSB 0) passes even parity; 0x43 (three ones, MSB 0) does not.
    bang(r, 3, 0x43, 9600);
    bang(r, 3, 0x41, 9600);
    expect(m.heard).toEqual([0x41]);
  });

  it('a pad the engine reports as released is the idle line, not a bit', () => {
    const r = rig();
    const m = new Modem();
    r.endpoint('modem', m, gpio(3), null, { baud: 9600 });
    // pinMode(3, INPUT) with the latch low: the line rests high through a pull.
    r.pins.write(3, false);
    r.pins.pad(3, 'z', 1);
    r.clock.advance(100000);
    expect(m.heard).toEqual([]);
    // pinMode(3, OUTPUT): the pad drives what the latch holds.
    r.pins.pad(3, 'high');
    const bit = 16e6 / 9600;
    const t0 = r.clock.cycles;
    for (const tr of frameTransitions(0x41, parseUartFrame('8N1'))) {
      r.clock.advance(Math.round(t0 + tr.slot * bit));
      r.pins.pad(3, tr.level ? 'high' : 'low');
    }
    r.clock.advance(Math.round(t0 + 10 * bit));
    expect(m.heard).toEqual([0x41]);
  });

  it('a pin a controller transmits on is never decoded: what the wire carries comes from the port', () => {
    const r = rig();
    const m = new Modem();
    r.endpoint('modem', m, gpio(1), null, { baud: 9600 });
    r.pins.write(1, true);
    bang(r, 1, 0x41, 9600);
    expect(m.heard).toEqual([]);
    r.port.tx(0x42);
    expect(m.heard).toEqual([0x42]);
  });

  it('when the sketch routes a hardware UART onto the pin, the decoder goes and the port takes over', () => {
    const port = new FakeUartPort(1, 'UART1', { tx: undefined, rx: undefined });
    const r = rig({ ports: [port] });
    const m = new Modem();
    r.endpoint('modem', m, gpio(17), null, { baud: 9600 });
    r.pins.write(17, true);
    bang(r, 17, 0x41, 9600);
    expect(m.heard).toEqual([0x41]);
    port.route = { tx: 17, rx: 16 };
    port.routingChanged?.();
    bang(r, 17, 0x42, 9600);
    expect(m.heard).toEqual([0x41]);
    port.tx(0x43);
    expect(m.heard).toEqual([0x41, 0x43]);
  });

  it('an MCU reset in the middle of a frame starts clean', () => {
    const r = rig();
    const m = new Modem();
    r.endpoint('modem', m, gpio(3), null, { baud: 9600 });
    r.pins.write(3, true);
    const bit = 16e6 / 9600;
    r.pins.write(3, false); // a start bit...
    r.clock.advance(Math.round(4 * bit));
    r.mcuReset();
    expect(r.clock.liveTimers).toBe(0);
    r.pins.write(3, true);
    r.clock.advance(Math.round(20 * bit));
    expect(m.heard).toEqual([]);
    bang(r, 3, 0x5a, 9600);
    expect(m.heard).toEqual([0x5a]);
    expect(m.resets).toBe(1);
  });

  it('a decoder built at the ROM clock follows the clock the app raises: the bit time is the guest clock NOW', () => {
    // The ESP32 engines bind at boot, at the ROM rate; the app raises the CPU
    // clock before the sketch bit-bangs anything. A receiver that kept the
    // cycles-per-bit it was built with would read every frame at a quarter
    // of its length.
    const r = rig({ hz: 40e6 });
    const m = new Modem();
    r.endpoint('modem', m, gpio(3), null, { baud: 9600 });
    r.pins.write(3, true);
    r.clock.hz = 160e6;
    r.clock.advance(1000);
    for (const b of text('AT\r\n')) bang(r, 3, b, 9600);
    expect(m.heard).toEqual(text('AT\r\n'));
    expect(r.codes()).toEqual([]);
  });

  it('a decoder built with no clock (no SoC yet) decodes once the guest runs', () => {
    // Between runs an ESP32 bridge has no SoC: clockHz() is 0. A module
    // attached then, or re-bound then, is built with a bit time of 0.
    const r = rig({ hz: 0 });
    const m = new Modem();
    r.endpoint('modem', m, gpio(3), null, { baud: 115200 });
    r.pins.write(3, true);
    r.clock.hz = 240e6;
    r.clock.advance(1000);
    bang(r, 3, 0xa5, 115200);
    bang(r, 3, 0x3c, 115200);
    expect(m.heard).toEqual([0xa5, 0x3c]);
  });

  it('a frame in progress keeps the bit time it opened with when the clock moves under it', () => {
    const r = rig({ hz: 16e6 });
    const m = new Modem();
    r.endpoint('modem', m, gpio(3), null, { baud: 9600 });
    r.pins.write(3, true);
    r.clock.advance(1000);
    const bit = 16e6 / 9600;
    const t0 = r.clock.cycles;
    // 'U' = 0x55 alternates every bit; the edges are laid at 16 MHz timing...
    for (const tr of frameTransitions(0x55, parseUartFrame('8N1'))) {
      r.clock.advance(Math.round(t0 + tr.slot * bit));
      r.pins.write(3, tr.level);
      // ...while the clock reports a new rate halfway through the frame.
      if (tr.slot === 4) r.clock.hz = 32e6;
    }
    r.clock.advance(Math.round(t0 + 10 * bit));
    expect(m.heard).toEqual([0x55]);
    // The next frame is at the new rate.
    bang(r, 3, 0x42, 9600);
    expect(m.heard).toEqual([0x55, 0x42]);
  });

  it('a board whose engine has no clock reports it per module instead of staying silent', () => {
    const r = rig({ clock: null });
    const m = new Modem();
    r.endpoint('modem', m, gpio(3), gpio(4), { baud: 9600 });
    const d = r.diags.filter((x) => x.code === 'uart-no-clock');
    expect(d).toHaveLength(1);
    expect(d[0].owners).toEqual(['modem']);
    // The hardware wires of the same board still work.
    const hw = new Modem();
    r.endpoint('hw', hw, gpio(1), null, { baud: 9600 });
    r.port.tx(0x41);
    expect(hw.heard).toEqual([0x41]);
  });

  it('a module with no rate on a plain GPIO is reported, and hears nothing', () => {
    const r = rig();
    const m = new Modem();
    r.endpoint('modem', m, gpio(3), null);
    expect(r.codes()).toEqual(['uart-no-baud']);
    r.pins.write(3, true);
    bang(r, 3, 0x41, 9600);
    expect(m.heard).toEqual([]);
  });
});

describe('UART fabric: a module transmitting on a plain GPIO puts edges on it at guest instants', () => {
  for (const [hz, label] of [
    [16e6, '16 MHz (AVR)'],
    [125e6, '125 MHz (RP2040)'],
  ] as const) {
    for (const baud of [9600, 115200]) {
      it(`${label}, ${baud} baud: the edges are one frame per byte, back to back, and decode to the bytes`, () => {
        const r = rig({ hz });
        const h = r.endpoint('gps', new Modem(), null, gpio(2), { baud });
        // The wire rests high the moment the module is on it.
        expect(r.pins.driven.get(2)).toBe(true);
        r.clock.advance(5000);
        const msg = text('$GPGGA,\r\n');
        for (const b of msg) h.transmit(b);
        expect(r.clock.edges.every((e) => e.pin === 2)).toBe(true);
        const bit = hz / baud;
        const first = r.clock.edges[0];
        expect(first.level).toBe(false);
        expect(first.at).toBe(5000);
        // Each frame starts exactly where the previous one ended.
        let k = 0;
        msg.forEach((b, i) => {
          expect(r.clock.edges[k].at, `frame ${i}`).toBe(Math.round(5000 + i * 10 * bit));
          k += frameTransitions(b, parseUartFrame('8N1')).length;
        });
        expect(k).toBe(r.clock.edges.length);
        // A receiver at the module's rate reads the message back from those edges.
        const out: number[] = [];
        const dec = new UartBitDecoder(parseUartFrame('8N1'), bit, (b) => out.push(b));
        for (const e of r.clock.edges) dec.edge(e.at, e.level);
        dec.edge(r.clock.edges[r.clock.edges.length - 1].at + 20 * bit, true);
        if (dec.deadline !== null) dec.finalize();
        expect(out).toEqual(msg);
      });
    }
  }

  it('a byte sent while the wire is busy waits for the frame in progress', () => {
    const r = rig();
    const h = r.endpoint('gps', new Modem(), null, gpio(2), { baud: 9600 });
    h.transmit(0xff);
    h.transmit(0xff);
    const bit = 16e6 / 9600;
    expect(r.clock.edges.map((e) => e.at)).toEqual([0, Math.round(bit), Math.round(10 * bit), Math.round(11 * bit)]);
  });

  it('a module wired to another module through a GPIO hears the byte once, though the engine echoes the edges', () => {
    const r = rig();
    r.pins.echo = true;
    const listener = new Modem();
    const talker = new Modem();
    r.endpoint('listener', listener, gpio(2), null, { baud: 9600 });
    const ht = r.endpoint('talker', talker, null, gpio(2), { baud: 9600 });
    ht.transmit(0x41);
    ht.transmit(0x42);
    r.clock.advance(1e6);
    expect(listener.heard).toEqual([0x41, 0x42]);
  });

  it('the frame the module declares is the frame on the wire', () => {
    const r = rig();
    const h = r.endpoint('m', new Modem(), null, gpio(2), { baud: 9600, frame: '7E1' });
    h.transmit(0x43);
    const bit = 16e6 / 9600;
    expect(r.clock.edges.map((e) => [Math.round(e.at / bit), e.level])).toEqual(
      frameTransitions(0x43, parseUartFrame('7E1')).map((t) => [t.slot, t.level]),
    );
  });

  it('after an MCU reset the wire rests high again and the next byte starts now', () => {
    const r = rig();
    const h = r.endpoint('gps', new Modem(), null, gpio(2), { baud: 9600 });
    h.transmit(0x00);
    r.pins.driven.clear();
    r.clock.advance(100);
    r.mcuReset();
    expect(r.pins.driven.get(2)).toBe(true);
    h.transmit(0x00);
    expect(r.clock.edges[2].at).toBe(100);
  });

  it('when a controller RX is routed onto the pin, bytes go to the port and no edges are scheduled', () => {
    const port = new FakeUartPort(1, 'UART1', { tx: undefined, rx: undefined });
    const r = rig({ ports: [port] });
    const h = r.endpoint('gps', new Modem(), null, gpio(16), { baud: 9600 });
    h.transmit(0x24);
    const n = frameTransitions(0x24, parseUartFrame('8N1')).length;
    expect(r.clock.edges).toHaveLength(n);
    port.route = { tx: 17, rx: 16 };
    port.routingChanged?.();
    h.transmit(0x25);
    expect(r.clock.edges).toHaveLength(n);
    expect(port.rx).toEqual([0x25]);
  });
});
