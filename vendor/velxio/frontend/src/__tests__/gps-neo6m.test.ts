/**
 * gps-neo6m.test.ts: the u-blox NEO-6M GPS module as a UART endpoint of the
 * bus fabric (project board-buses-2026-09, F6).
 *
 * Covers:
 *   - NMEA building blocks: checksum, ddmm.mmmmm coordinate encoding,
 *     GPGGA / GPRMC structure, CRLF cycle framing.
 *   - The module on the fabric, layer 1 (TESTS.md): a fake circuit, fake
 *     board pins, a fake guest clock and fake controller ports that follow the
 *     real contracts. Its TX pad on a hardware RX pin reaches that controller
 *     and no other; on a plain GPIO it leaves as 8N1 edges on the guest clock
 *     (the software emitter, what SoftwareSerial decodes); on the board's own
 *     TX pin it is reported as contention and heard by nobody; on nothing it
 *     is on no wire, with no fallback to UART0. The descriptor has no RX leg.
 *   - Time: one cycle a second and one character time between bytes, both on
 *     the GUEST clock; the wall clock alone moves nothing. A stopped board
 *     silences the module. Live position updates, the UTC field, the PPS
 *     marker.
 *
 * The same module on real firmware (TinyGPS++ on an Uno, a Mega and the ESP32
 * devkit) is board-buses/board-buses-f6-gps-avr.test.ts and the pro
 * esp32sim/__tests__/gps-uart-esp32js.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { busRegistry } from '../simulation/buses';
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
  UartRouting,
} from '../simulation/buses/types';
import {
  GPS_BAUD,
  GPS_BYTE_MS,
  GPS_PPS_MS,
  GPS_TICK_MS,
  nmeaChecksum,
  nmeaSentence,
  formatNmeaCoord,
  buildGpgga,
  buildGprmc,
  buildNmeaCycle,
} from '../simulation/parts/GpsParts';
import '../simulation/parts/GpsParts';

const MADRID = { lat: 40.4168, lng: -3.7038, altitude: 667, speed: 0, course: 0 };
const T0 = new Date(Date.UTC(2026, 6, 31, 12, 35, 19));

/** Validate `$<body>*<cs>` framing + checksum for a single sentence. */
function expectValidSentence(sentence: string): void {
  const m = /^\$([A-Z0-9,.-]*)\*([0-9A-F]{2})$/.exec(sentence);
  expect(m, `malformed sentence: ${sentence}`).not.toBeNull();
  expect(nmeaChecksum(m![1])).toBe(m![2]);
}

// ─── NMEA builders ────────────────────────────────────────────────────────────

describe('NMEA building blocks', () => {
  it('checksum matches the canonical GPGGA example (0x47)', () => {
    // Textbook sentence: $GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47
    expect(nmeaChecksum('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,')).toBe(
      '47',
    );
    expect(nmeaSentence('GPGGA,x')).toMatch(/^\$GPGGA,x\*[0-9A-F]{2}$/);
  });

  it('encodes decimal degrees as ddmm.mmmmm with the right hemisphere', () => {
    expect(formatNmeaCoord(40.4168, 'lat')).toEqual({ value: '4025.00800', hemisphere: 'N' });
    expect(formatNmeaCoord(-3.7038, 'lon')).toEqual({ value: '00342.22800', hemisphere: 'W' });
    expect(formatNmeaCoord(-33.4489, 'lat').hemisphere).toBe('S');
    expect(formatNmeaCoord(151.2093, 'lon').hemisphere).toBe('E');
    // Longitude uses 3 degree digits, latitude 2.
    expect(formatNmeaCoord(151.2093, 'lon').value).toMatch(/^151/);
    expect(formatNmeaCoord(8.5, 'lat').value).toMatch(/^08/);
  });

  it('GPGGA carries time, position, fix=1, sats and altitude with a valid checksum', () => {
    const gga = buildGpgga(T0, MADRID);
    expectValidSentence(gga);
    const f = gga.split(',');
    expect(f[0]).toBe('$GPGGA');
    expect(f[1]).toBe('123519.00');
    expect(f[2]).toBe('4025.00800');
    expect(f[3]).toBe('N');
    expect(f[4]).toBe('00342.22800');
    expect(f[5]).toBe('W');
    expect(f[6]).toBe('1'); // GPS fix
    expect(f[9]).toBe('667.0'); // altitude
    expect(f[10]).toBe('M');
  });

  it('GPRMC carries status A, position, speed, date with a valid checksum', () => {
    const rmc = buildGprmc(T0, { ...MADRID, speed: 12.5, course: 84.4 });
    expectValidSentence(rmc);
    const f = rmc.split(',');
    expect(f[0]).toBe('$GPRMC');
    expect(f[1]).toBe('123519.00');
    expect(f[2]).toBe('A');
    expect(f[3]).toBe('4025.00800');
    expect(f[7]).toBe('12.5'); // knots
    expect(f[8]).toBe('84.4'); // course
    expect(f[9]).toBe('310726'); // ddmmyy
  });

  it('a cycle is GPGGA + GPRMC, each CRLF-terminated', () => {
    const cycle = buildNmeaCycle(T0, MADRID);
    const lines = cycle.split('\r\n');
    expect(lines).toHaveLength(3); // two sentences + trailing empty
    expect(lines[0]).toMatch(/^\$GPGGA,/);
    expect(lines[1]).toMatch(/^\$GPRMC,/);
    expect(lines[2]).toBe('');
    expectValidSentence(lines[0]);
    expectValidSentence(lines[1]);
  });
});

// ─── The fabric, faked at the contracts ──────────────────────────────────────

/** Board pins: what a part drives through driveInput is all the emitter needs. */
class FakePins implements BoardPins {
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

/** The guest's clock, moved by the test; every scheduled edge is kept. */
class FakeClock implements GuestClock {
  cycles = 0;
  readonly hz = 16_000_000;
  edges: Array<{ pin: number; level: boolean; at: number }> = [];
  now(): number {
    return this.cycles;
  }
  clockHz(): number {
    return this.hz;
  }
  scheduleEdge(pin: number, level: boolean, at: number): void {
    this.edges.push({ pin, level, at });
  }
  at(): () => void {
    return () => {};
  }
}

/** A controller port whose guest is an RX queue; pins from the board's table. */
class FakePort implements UartControllerPort {
  readonly bus = 'uart' as const;
  readonly unit: number;
  readonly name: string;
  rx: number[] = [];
  cfg: UartConfig = { baud: GPS_BAUD, frame: '8N1' };
  /** Fixed by the board's table, or live as an ESP32 port reads its GPIO matrix. */
  route: UartRouting | 'static';
  constructor(unit: number, name: string, route: UartRouting | 'static' = 'static') {
    this.unit = unit;
    this.name = name;
    this.route = route;
  }
  setTxHandler(): void {}
  receive(byte: number): void {
    this.rx.push(byte);
  }
  config(): UartConfig {
    return { ...this.cfg };
  }
  routing(): UartRouting | 'static' {
    return this.route;
  }
  text(): string {
    return String.fromCharCode(...this.rx);
  }
}

class FakeCircuit implements NetResolver {
  nets = new Map<string, ResolvedPin>();
  kinds = new Map<string, string>();
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    return this.nets.get(`${ref.componentId}:${ref.pinName}`) ?? { kind: 'floating' };
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

/**
 * Bytes off the edges an emitter scheduled on `pin`: each frame from its own
 * start edge, bits sampled at their centres, 8N1 at `baud` on `hz`.
 */
function decodeEdges(
  edges: Array<{ pin: number; level: boolean; at: number }>,
  pin: number,
  hz: number,
  baud: number,
): string {
  const es = edges.filter((e) => e.pin === pin).sort((a, b) => a.at - b.at);
  const bit = hz / baud;
  const levelAt = (t: number): boolean => {
    let l = true; // idle high
    for (const e of es) {
      if (e.at <= t) l = e.level;
      else break;
    }
    return l;
  };
  let out = '';
  let i = 0;
  while (i < es.length) {
    while (i < es.length && es[i].level) i++;
    if (i >= es.length) break;
    const t0 = es[i].at;
    expect(levelAt(t0 + 0.5 * bit), 'start bit').toBe(false);
    let byte = 0;
    for (let b = 0; b < 8; b++) if (levelAt(t0 + (1.5 + b) * bit)) byte |= 1 << b;
    expect(levelAt(t0 + 9.5 * bit), 'stop bit').toBe(true);
    out += String.fromCharCode(byte);
    const end = t0 + 9.5 * bit;
    while (i < es.length && es[i].at <= end) i++;
  }
  return out;
}

const GPS_ID = 'gps_neo6m_test_1';
const BOARD = 'board-1';
const boardPin = (pin: number): ResolvedPin => ({ kind: 'board', boardId: BOARD, pin });

interface Rig {
  circuit: FakeCircuit;
  pins: FakePins;
  clock: FakeClock;
  ports: FakePort[];
  port: FakePort;
  diags: BusDiagnostic[];
  el: Record<string, unknown>;
  running: { value: boolean };
  /** Wire the module's TX (and optionally its RX pad) and attach it as the canvas would. */
  attach(tx: ResolvedPin | null, rx?: ResolvedPin): void;
  /** Guest time passes, and the wall clock with it, tick by tick. */
  run(ms: number): void;
  /** Wall time passes while the guest stands still. */
  idle(ms: number): void;
  cleanup(): void;
}

let cleanups: Array<() => void> = [];

function rig(opts: { kind?: string; units?: Array<[number, string, (UartRouting | 'static')?]> } = {}): Rig {
  const circuit = new FakeCircuit();
  circuit.kinds.set(BOARD, opts.kind ?? 'arduino-uno');
  const pins = new FakePins();
  const clock = new FakeClock();
  const ports = (opts.units ?? [[0, 'USART0']]).map(([u, n, route]) => new FakePort(u, n, route));
  const binding: EngineBinding = { pins, spi: [], uart: ports, clock };
  const diags: BusDiagnostic[] = [];
  cleanups.push(busRegistry.onDiagnostic((d) => diags.push(d)));
  busRegistry.setResolver(circuit);
  busRegistry.bindEngine(BOARD, binding);
  const running = { value: true };
  const sim = {
    isRunning: () => running.value,
    getCurrentCycles: () => clock.cycles,
    getClockHz: () => clock.hz,
  };
  const el: Record<string, unknown> = {};
  let off: (() => void) | null = null;
  const r: Rig = {
    circuit,
    pins,
    clock,
    ports,
    port: ports[0],
    diags,
    el,
    running,
    attach(tx, rx) {
      circuit.wire(GPS_ID, 'TX', tx);
      if (rx) circuit.wire(GPS_ID, 'RX', rx);
      busRegistry.netlistChanged();
      const logic = PartSimulationRegistry.get('gps-neo6m')!;
      off = logic.attachEvents!(el as unknown as HTMLElement, sim as never, () => null, GPS_ID);
      cleanups.push(() => off?.());
    },
    run(ms) {
      for (let t = 0; t < ms; t += GPS_TICK_MS) {
        const step = Math.min(GPS_TICK_MS, ms - t);
        clock.cycles += (step / 1000) * clock.hz;
        vi.advanceTimersByTime(step);
      }
    },
    idle(ms) {
      vi.advanceTimersByTime(ms);
    },
    cleanup() {
      off?.();
      off = null;
    },
  };
  return r;
}

const lines = (text: string) => text.split('\r\n').filter((l) => l.length > 0);
/** Guest milliseconds one NMEA cycle takes on the wire. */
const cycleMs = (text: string) => text.length * GPS_BYTE_MS;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  busRegistry.clear();
  vi.useRealTimers();
});

describe('gps-neo6m: registration', () => {
  it('is registered in PartSimulationRegistry', () => {
    expect(PartSimulationRegistry.get('gps-neo6m')).toBeDefined();
  });
});

describe('gps-neo6m on the fabric: a hardware RX pin', () => {
  it("TX on the Uno's D0 (RX): one guest second after attach a valid NMEA cycle reaches USART0, one character time apart", () => {
    const r = rig();
    r.attach(boardPin(0));
    expect(busRegistry.uartPlacement(GPS_ID)).toEqual({
      rx: null,
      tx: { boardId: BOARD, pin: 0, controller: 'USART0' },
    });
    // Nothing before the first second is up.
    r.run(1000);
    expect(r.port.rx).toEqual([]);
    // The cycle opens on the next poll: one character, then one per
    // GPS_BYTE_MS of guest time, so a 20 ms poll carries 19 or 20 more.
    r.run(GPS_TICK_MS);
    expect(r.port.rx.length).toBe(1);
    expect(r.port.text()).toBe('$');
    r.run(GPS_TICK_MS);
    expect(r.port.rx.length).toBeGreaterThanOrEqual(19);
    expect(r.port.rx.length).toBeLessThanOrEqual(21);
    r.run(400);
    const text = r.port.text();
    const ls = lines(text);
    expect(ls).toHaveLength(2);
    expect(ls[0]).toMatch(/^\$GPGGA,/);
    expect(ls[1]).toMatch(/^\$GPRMC,/);
    for (const l of ls) expectValidSentence(l);
    expect(text).toContain('4025.00800,N');
    expect(text).toContain('00342.22800,W');
    expect(text).toContain(',667.0,M,');
    // The whole cycle took its length in character times, not one instant.
    expect(text.length * GPS_BYTE_MS).toBeGreaterThan(100);
  });

  it('the wall clock alone moves nothing: no byte while the guest stands still', () => {
    const r = rig();
    r.attach(boardPin(0));
    r.idle(10_000);
    expect(r.port.rx).toEqual([]);
    r.run(1100);
    expect(r.port.text()).toMatch(/^\$GPGGA,/);
  });

  it("ESP32 devkit: TX on the GPIO Serial2.begin routed U2RXD to (GPIO4) is UART2's RX, and the console (UART0) hears nothing", () => {
    // The ESP32 ports report their pads live from the GPIO matrix, as the
    // engine's ports do; here UART0 sits on its IO_MUX pads and Serial2 has
    // been opened where the current arduino-esp32 core puts it on the classic
    // chip, RX2 = GPIO4 and TX2 = GPIO25 (measured on the real engine in the
    // pro gps-uart-esp32js test).
    const r = rig({
      kind: 'esp32',
      units: [[0, 'UART0', { tx: 1, rx: 3 }], [1, 'UART1', {}], [2, 'UART2', { tx: 25, rx: 4 }]],
    });
    r.attach(boardPin(4));
    expect(busRegistry.uartPlacement(GPS_ID)?.tx).toEqual({ boardId: BOARD, pin: 4, controller: 'UART2' });
    r.run(1300);
    expect(r.ports[2].text()).toMatch(/^\$GPGGA,/);
    expect(r.ports[0].rx).toEqual([]);
    expect(r.ports[1].rx).toEqual([]);
  });

  it('the descriptor carries 9600 baud: a USART the sketch runs at 115200 gets garbage and uart-baud-mismatch', () => {
    const r = rig();
    r.port.cfg = { baud: 115200, frame: '8N1' };
    r.attach(boardPin(0));
    r.run(1300);
    expect(r.diags.map((d) => d.code)).toContain('uart-baud-mismatch');
    expect(r.port.rx.length).toBeGreaterThan(0);
    expect(r.port.text()).not.toContain('$GPGGA');
  });

  it('a receiver never listens: the descriptor has no RX leg, whatever the RX pad is wired to', () => {
    const r = rig();
    r.attach(boardPin(0), boardPin(1));
    expect(busRegistry.uartPlacement(GPS_ID)).toEqual({
      rx: null,
      tx: { boardId: BOARD, pin: 0, controller: 'USART0' },
    });
    expect(r.diags).toEqual([]);
  });
});

describe('gps-neo6m on the fabric: a plain GPIO (SoftwareSerial)', () => {
  it("TX on the Uno's D4: the cycle leaves as 8N1 edges at 9600 baud on the guest clock, and USART0 hears none of it", () => {
    const r = rig();
    r.attach(boardPin(4));
    expect(busRegistry.uartPlacement(GPS_ID)?.tx).toEqual({ boardId: BOARD, pin: 4, controller: null });
    // The wire rests high before anything is sent: a receiver waits for a falling edge.
    expect(r.pins.driven).toContainEqual({ pin: 4, level: true });
    r.run(1400);
    const text = decodeEdges(r.clock.edges, 4, r.clock.hz, GPS_BAUD);
    const ls = lines(text);
    expect(ls).toHaveLength(2);
    expect(ls[0]).toMatch(/^\$GPGGA,/);
    expect(ls[1]).toMatch(/^\$GPRMC,/);
    for (const l of ls) expectValidSentence(l);
    expect(text).toContain('4025.00800,N');
    expect(r.port.rx).toEqual([]);
    // Every edge is on the module's wire and in guest time, after the first second.
    expect(r.clock.edges.every((e) => e.pin === 4)).toBe(true);
    expect(Math.min(...r.clock.edges.map((e) => e.at))).toBeGreaterThanOrEqual(r.clock.hz);
    expect(r.diags).toEqual([]);
  });
});

describe('gps-neo6m on the fabric: the wrong pin, and no pin', () => {
  it("TX on the Uno's D1 (its TX): two drivers on one wire, reported as uart-tx-contention, and USART0's RX hears nothing", () => {
    const r = rig();
    r.attach(boardPin(1));
    expect(busRegistry.uartPlacement(GPS_ID)?.tx).toEqual({ boardId: BOARD, pin: 1, controller: null });
    const contention = r.diags.filter((d) => d.code === 'uart-tx-contention');
    expect(contention).toHaveLength(1);
    expect(contention[0].owners).toEqual([GPS_ID]);
    expect(contention[0].message).toContain('USART0');
    r.run(2500);
    expect(r.port.rx).toEqual([]);
  });

  it('TX wired to nothing: on no wire, no diagnostic, and not a byte on UART0 (the old fallback)', () => {
    const r = rig();
    r.attach(null);
    expect(busRegistry.uartPlacement(GPS_ID)).toEqual({ rx: null, tx: null });
    r.run(2500);
    expect(r.port.rx).toEqual([]);
    expect(r.clock.edges).toEqual([]);
    expect(r.diags).toEqual([]);
    // The receiver still runs: its PPS marks the cycle nobody is wired to hear.
    expect(r.el.pps).toBeDefined();
  });
});

describe('gps-neo6m: time, position, PPS, power', () => {
  it('the UTC field advances one second per cycle, and cycles come one guest second apart', () => {
    const r = rig();
    r.attach(boardPin(0));
    r.run(1040);
    expect(r.port.rx.length).toBeGreaterThan(0);
    r.run(400);
    // The first cycle is complete and nothing else has come: the wire is idle
    // until the next second is up.
    const first = r.port.text();
    expect(lines(first)).toHaveLength(2);
    expect(cycleMs(first)).toBeLessThan(400);
    r.run(600);
    expect(r.port.rx.length).toBeGreaterThan(first.length);
    r.run(400);
    const times = [...r.port.text().matchAll(/\$GPGGA,(\d{6})\.00,/g)].map((m) => m[1]);
    expect(times).toHaveLength(2);
    const toSec = (t: string) =>
      parseInt(t.slice(0, 2), 10) * 3600 + parseInt(t.slice(2, 4), 10) * 60 + parseInt(t.slice(4), 10);
    expect((toSec(times[1]) - toSec(times[0]) + 86400) % 86400).toBe(1);
    expect(lines(r.port.text())).toHaveLength(4);
  });

  it('SensorControlPanel updates change the emitted position live', () => {
    const r = rig();
    r.attach(boardPin(0));
    r.run(1300);
    expect(r.port.text()).toContain('4025.00800,N');
    r.port.rx.length = 0;
    dispatchSensorUpdate(GPS_ID, { lat: -33.4489, lng: -70.6693 }); // Santiago
    r.run(1300);
    expect(r.port.text()).toContain('3326.93400,S');
    expect(r.port.text()).toContain('07040.15800,W');
    expect(r.el.lat).toBe(-33.4489);
  });

  it('the PPS marker lights when a cycle opens and goes out 120 ms of guest time later', () => {
    const r = rig();
    r.attach(boardPin(0));
    r.run(1000);
    expect(r.el.pps).toBeUndefined();
    r.run(GPS_TICK_MS);
    expect(r.el.pps).toBe(true);
    r.run(GPS_PPS_MS - GPS_TICK_MS);
    expect(r.el.pps).toBe(true);
    r.run(GPS_TICK_MS);
    expect(r.el.pps).toBe(false);
  });

  it('a stopped board is an unpowered module: nothing leaves, and the first fix after Run comes a second later', () => {
    const r = rig();
    r.running.value = false;
    r.attach(boardPin(0));
    r.run(3000);
    expect(r.port.rx).toEqual([]);
    expect(r.el.pps).toBeUndefined();
    r.running.value = true;
    r.run(1000);
    expect(r.port.rx).toEqual([]);
    r.run(60);
    expect(r.port.text()).toMatch(/^\$GPGGA,/);
    // Stop mid-cycle: the rest of the sentence never arrives after the next Run.
    const got = r.port.rx.length;
    r.running.value = false;
    r.run(500);
    r.running.value = true;
    r.run(500);
    expect(r.port.rx.length).toBe(got);
  });

  it('cleanup takes the module off the wire', () => {
    const r = rig();
    r.attach(boardPin(0));
    r.run(1300);
    const got = r.port.rx.length;
    expect(got).toBeGreaterThan(0);
    r.cleanup();
    expect(busRegistry.uartPlacement(GPS_ID)).toBeNull();
    r.run(3000);
    expect(r.port.rx.length).toBe(got);
  });
});
