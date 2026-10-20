/**
 * Board buses F7: the chip ABI in the BROWSER host (ChipRuntime.ts), against
 * the cross-host table.
 *
 * A custom chip has to behave like the chip it models, the same in every
 * host. This suite is one of three that replay the SAME table
 * (fixtures/chips-abi-parity/expectations.json) against the SAME artifact
 * (abi-probe.wasm). The others are, in Python,
 *   velxio/test/backend/unit/test_wasm_chip_abi_parity.py       (QEMU workers)
 *   pro/backend/tests/unit/test_board_buses_abi_parity_pi.py    (Linux boards)
 * The table is written from velxio-chip.h and the documented contracts, not
 * from any one runtime, so the hosts fail rather than agree on a wrong answer.
 *
 * The chip is driven the way the canvas drives one: through the bus fabric
 * (a fake engine binding with one SPI, one I2C and one UART controller port,
 * the real BusRegistry and the real BoardBusFabric) and a real PinManager for
 * its pins, with the board's own pin table naming which pads carry which
 * controller. A row a host answers differently from the others carries a
 * `hosts.<host>` variant in the table, with the reason: a host difference is
 * stated on its row, never skipped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PinManager } from '../../simulation/PinManager';
import { ChipInstance } from '../../simulation/customChips/ChipRuntime';
import { busRegistry, boardPinsFromPinManager, registerBoardPinFunctions } from '../../simulation/buses';
import { useElectricalStore } from '../../store/useElectricalStore';
import type {
  EngineBinding,
  GuestClock,
  I2cControllerPort,
  I2cRouting,
  I2cTransactionHandler,
  NetResolver,
  PinRef,
  ResolvedPin,
  SpiControllerConfig,
  SpiControllerPort,
  SpiRouting,
  UartConfig,
  UartControllerPort,
  UartRouting,
} from '../../simulation/buses/types';

const fixture = (p: string) =>
  fileURLToPath(new URL(`./fixtures/chips-abi-parity/${p}`, import.meta.url));

const WASM = new Uint8Array(readFileSync(fixture('abi-probe.wasm')));
const TABLE = JSON.parse(readFileSync(fixture('expectations.json'), 'utf-8')) as Table;
const MANIFEST = JSON.parse(readFileSync(fixture('manifest.json'), 'utf-8')) as
  Record<string, { sourceSha256: string }>;

interface Step {
  op: string;
  fn?: string;
  args?: number[];
  ret?: number;
  scratchHex?: string;
  board_rx?: number[];
  pin?: string;
  level?: number;
  pull?: string;
  mosi?: number[];
  miso?: number[];
  seq?: Array<[string, ...Array<number | boolean>]>;
  bytes?: number[];
  expect?: unknown;
  ns?: number;
  name?: string;
  value?: number;
  /** A `volts` row: the solved voltage on the pad wired to `pin`, null for no wire. */
  volts?: number | null;
  hex?: string;
  why?: string;
  /** A host that answers this row differently, and how (the shared fields overridden). */
  hosts?: Record<string, Record<string, unknown>>;
  /** Laid over from a host variant: the row is not this host's to drive. */
  skip?: boolean;
  /** Laid over from a host variant: the host's write phase reports no ACK. */
  acks?: boolean;
}
interface Scenario {
  name: string;
  steps: Step[];
  /** The hosts that can drive this scenario at all (every host when absent). */
  only?: string[];
  why_only?: string;
}
interface Table {
  pins: Record<string, number>;
  blobName: string;
  blobHex: string;
  scenarios: Scenario[];
}

const HOST = 'browser';
const BOARD = 'brd';
const KIND = 'abi-parity-board';
const CHIP = 'abi';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

// The chip's own pin indices (abi-probe.c) and the names it registers.
const PIN_NAMES = ['IN', 'OUT', 'DIR', 'CS', 'CS2'];

/** One trace record as the table spells it: the same words as the Python decoder. */
function decodeRecord(kind: number, a: number, b: number, c: number): string {
  const h2 = (v: number) => v.toString(16).padStart(2, '0');
  switch (kind) {
    case 1: return `spi_done h=${a} n=${b} buf=${c === a ? 'own' : c === 2 ? 'none' : 'other'}`;
    case 2: return `spi_rx ${a}=${h2(b)}`;
    case 3: return `spi_xchg ${h2(a)}->${h2(b)}`;
    case 4: return `i2c_connect slot=${a} addr=${h2(b)} read=${c}`;
    case 5: return `i2c_write slot=${a} ${h2(b)}`;
    case 6: return `i2c_read slot=${a} ->${h2(b)}`;
    case 7: return `i2c_stop slot=${a}`;
    case 8: return `uart_rx ${h2(a)}`;
    case 9: return 'uart_tx_done';
    case 10: return `pin ${PIN_NAMES[a] ?? a}=${b}`;
    case 11: return `timer now=${b * 4294967296 + a}`;
    default: return `kind${kind} ${a} ${b} ${c}`;
  }
}

// ── The fake engine: one controller of each kind, the real contracts ──────

class FakeSpiPort implements SpiControllerPort {
  readonly bus = 'spi' as const;
  readonly unit = 0;
  readonly name = 'SPI';
  handler: ((mosi: number, bits: number) => number) | null = null;
  cfg: SpiControllerConfig = { enabled: true, mode: 0, bitOrder: 'msb', bits: 8 };
  setFrameHandler(h: ((mosi: number, bits: number) => number) | null): void {
    this.handler = h;
  }
  config(): SpiControllerConfig {
    return this.cfg;
  }
  routing(): SpiRouting | 'static' {
    return 'static';
  }
  /** The engine clocks one frame. */
  xfer(mosi: number): number {
    if (!this.handler) throw new Error('no frame handler bound');
    return this.handler(mosi, 8);
  }
}

class FakeI2cPort implements I2cControllerPort {
  readonly bus = 'i2c' as const;
  readonly unit = 0;
  readonly name = 'I2C0';
  handler: I2cTransactionHandler | null = null;
  setTransactionHandler(h: I2cTransactionHandler | null): void {
    this.handler = h;
  }
  routing(): I2cRouting | 'static' {
    return 'static';
  }
}

class FakeUartPort implements UartControllerPort {
  readonly bus = 'uart' as const;
  readonly unit = 0;
  readonly name = 'USART0';
  handler: ((byte: number) => void) | null = null;
  rx: number[] = [];
  setTxHandler(h: ((byte: number) => void) | null): void {
    this.handler = h;
  }
  receive(byte: number): void {
    this.rx.push(byte);
  }
  config(): UartConfig {
    return { baud: 9600 };
  }
  routing(): UartRouting | 'static' {
    return 'static';
  }
  /** Serial.write. */
  tx(byte: number): void {
    this.handler?.(byte);
  }
}

/**
 * The guest's clock, as the board's engine binding hands it to the fabric and
 * to the chip: nanoseconds ARE cycles here (1 GHz), the events a timer arms
 * with at() fire in cycle order as the clock passes them, and a scheduled
 * input edge only lands on the pins (nothing in this table bit-bangs).
 */
class FakeClock implements GuestClock {
  cycles = 0;
  private events: Array<{ at: number; cb: () => void; live: boolean }> = [];
  now(): number {
    return this.cycles;
  }
  clockHz(): number {
    return 1e9;
  }
  scheduleEdge(): void {
    /* no software bus on this table */
  }
  at(at: number, cb: () => void): () => void {
    const e = { at, cb, live: true };
    this.events.push(e);
    return () => {
      e.live = false;
    };
  }
  /** The guest reaches `to`: every event up to it fires at its own cycle. */
  advance(to: number): void {
    for (;;) {
      let next: (typeof this.events)[number] | null = null;
      for (const e of this.events) if (e.live && e.at <= to && (!next || e.at < next.at)) next = e;
      if (!next) break;
      next.live = false;
      this.cycles = Math.max(this.cycles, next.at);
      next.cb();
    }
    this.events = this.events.filter((e) => e.live);
    this.cycles = Math.max(this.cycles, to);
  }
}

/** A circuit: the chip's pads land on the board pins the table names. */
class Circuit implements NetResolver {
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    const pin = ref.componentId === CHIP ? TABLE.pins[ref.pinName] : undefined;
    return pin === undefined ? { kind: 'floating' } : { kind: 'board', boardId: BOARD, pin };
  }
  boardKind(id: string): string | undefined {
    return id === BOARD ? KIND : undefined;
  }
  boards(): string[] {
    return [BOARD];
  }
}

// SPI0 on 13/11/12 with CS0 on 10, I2C0 on 18/19, USART0 on 0 (RX) / 1 (TX).
registerBoardPinFunctions([KIND], {
  routing: 'fixed',
  source: 'test',
  controllers: [
    { bus: 'spi', unit: 0, name: 'SPI', arduino: ['SPI'], defaultPins: { sck: 13, mosi: 11, miso: 12, cs: 10 } },
    { bus: 'i2c', unit: 0, name: 'I2C0', arduino: ['Wire'], defaultPins: { sda: 18, scl: 19 } },
    { bus: 'uart', unit: 0, name: 'USART0', arduino: ['Serial'], defaultPins: { rx: 0, tx: 1 } },
  ],
  pins: {
    13: [{ bus: 'spi', unit: 0, signal: 'sck' }],
    11: [{ bus: 'spi', unit: 0, signal: 'mosi' }],
    12: [{ bus: 'spi', unit: 0, signal: 'miso' }],
    10: [{ bus: 'spi', unit: 0, signal: 'cs', csIndex: 0 }],
    18: [{ bus: 'i2c', unit: 0, signal: 'sda' }],
    19: [{ bus: 'i2c', unit: 0, signal: 'scl' }],
    0: [{ bus: 'uart', unit: 0, signal: 'rx' }],
    1: [{ bus: 'uart', unit: 0, signal: 'tx' }],
  },
});

// ── The host ─────────────────────────────────────────────────────────────

class BrowserHost {
  readonly pm = new PinManager();
  readonly spi = new FakeSpiPort();
  readonly i2c = new FakeI2cPort();
  readonly uart = new FakeUartPort();
  readonly clock = new FakeClock();
  readonly logs: string[] = [];
  chip!: ChipInstance;

  async create(): Promise<void> {
    busRegistry.setResolver(new Circuit());
    const binding: EngineBinding = {
      pins: boardPinsFromPinManager(this.pm, (pin, level) => this.pm.setPinState(pin, level)),
      spi: [this.spi],
      i2c: [this.i2c],
      uart: [this.uart],
      clock: this.clock,
    };
    busRegistry.bindEngine(BOARD, binding);
    this.chip = await ChipInstance.create({
      wasm: WASM,
      componentId: CHIP,
      pinManager: this.pm,
      wires: new Map(Object.entries(TABLE.pins)),
      attrs: new Map(),
      strAttrs: new Map(),
      blobs: new Map([[TABLE.blobName, bytes(TABLE.blobHex)]]),
      // The board's clock, as CustomChipPart hands it over: the chip's timers
      // fire on its events, at their guest instant.
      clock: this.clock,
      log: (s) => this.logs.push(s.replace(/\n$/, '')),
    });
    this.chip.start();
  }

  dispose(): void {
    this.chip?.dispose();
    busRegistry.clear();
    useElectricalStore.getState().reset();
  }

  /**
   * The circuit solve's word on a pad: `volts` on the net the wire from chip
   * pin `pin` reaches, published the way CircuitSimulationService publishes a
   * solve (the pin-to-net map and the node voltages, as one snapshot); null
   * takes the wire away. The runtime reads the store itself (padVolts.ts).
   */
  volts(pin: string, volts: number | null): void {
    const st = useElectricalStore.getState();
    const pinNetMap = new Map(st.pinNetMap);
    const nodeVoltages = { ...st.nodeVoltages };
    const net = `net_${pin}`;
    if (volts === null) {
      pinNetMap.delete(`${CHIP}:${pin}`);
      delete nodeVoltages[net];
    } else {
      pinNetMap.set(`${CHIP}:${pin}`, net);
      nodeVoltages[net] = volts;
    }
    useElectricalStore.setState({ pinNetMap, nodeVoltages } as never);
  }

  private get e() {
    return this.chip.exports as Record<string, (...a: number[]) => number>;
  }

  call(fn: string, ...args: number[]): number {
    const r = this.e[fn](...args);
    this.chip.wasi.flush();
    return r === undefined ? 0 : r >>> 0;
  }

  scratch(n: number): Uint8Array {
    return new Uint8Array(this.chip.memory!.buffer, this.e.scratch_ptr(), n).slice();
  }

  poke(data: Uint8Array): void {
    new Uint8Array(this.chip.memory!.buffer, this.e.scratch_ptr(), data.length).set(data);
  }

  trace(): string[] {
    const n = this.e.trace_count();
    const ptr = this.e.trace_ptr();
    const dv = new DataView(this.chip.memory!.buffer);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const at = ptr + i * 16;
      out.push(decodeRecord(dv.getUint32(at, true), dv.getUint32(at + 4, true),
        dv.getUint32(at + 8, true), dv.getUint32(at + 12, true)));
    }
    this.e.trace_clear();
    return out;
  }

  /** The MCU drives the pad a chip input is wired to, as an engine reports a
   *  digitalWrite: the pad channel says it is driving, the level channel
   *  carries the level. */
  drive(name: string, level: number): void {
    const pin = TABLE.pins[name];
    this.pm.reportPad(pin, level !== 0 ? 'high' : 'low', 0, 0);
    this.pm.triggerPinChange(pin, level !== 0, 'mcu');
  }

  /** The MCU configures the pad as an input with a pull (pinMode) and drives nothing. */
  pad(name: string, pull: string): void {
    this.pm.reportPad(TABLE.pins[name], 'z', pull === 'up' ? 1 : pull === 'down' ? 2 : 0, 0);
  }

  spiXfer(mosi: number[]): number[] {
    return mosi.map((b) => this.spi.xfer(b));
  }

  i2cSeq(seq: Array<[string, ...Array<number | boolean>]>): Array<boolean | number | null> {
    const h = this.i2c.handler;
    if (!h) throw new Error('no I2C transaction handler bound');
    return seq.map((el) => {
      switch (el[0]) {
        case 'start': return h.start(Number(el[1]), !!el[2]);
        case 'write': return h.write(Number(el[1]));
        case 'read': return h.read();
        case 'stop': h.stop(); return null;
        default: throw new Error(`not an i2c element: ${JSON.stringify(el)}`);
      }
    });
  }

  /** The level the board reads on the pin: what its digitalRead sees. */
  boardPin(name: string): number | null {
    const s = this.pm.peekPinState(TABLE.pins[name]);
    return s === undefined ? null : s ? 1 : 0;
  }

  /** The guest reaches `ns`: the clock's events (the chip's timers) fire in order. */
  advance(ns: number): void {
    this.clock.advance(ns);
  }
}

/** The row as this host must answer it: the shared fields, with the host's
 *  own variant laid over them when the table names one. */
function expected(step: Step): Step {
  const row: Step = { ...step };
  delete row.hosts;
  const mine = step.hosts?.[HOST];
  if (mine) {
    for (const [k, v] of Object.entries(mine)) if (k !== 'why') (row as unknown as Record<string, unknown>)[k] = v;
  }
  return row;
}

function i2cExpected(seq: Array<[string, ...Array<number | boolean>]>): Array<boolean | number | null> {
  return seq.map((el) => {
    if (el[0] === 'start') return !!el[3];
    if (el[0] === 'write') return !!el[2];
    if (el[0] === 'read') return Number(el[1]);
    return null;
  });
}

/** Walk one scenario; one line per row that answered differently. */
function replay(host: BrowserHost, scenario: Scenario): string[] {
  const bad: string[] = [];
  scenario.steps.forEach((raw, i) => {
    const st = expected(raw);
    const shown = { ...raw } as Record<string, unknown>;
    delete shown.why;
    delete shown.hosts;
    const label = `step ${i} ${JSON.stringify(shown)}`;
    if (st.skip) return;
    switch (st.op) {
      case 'call': {
        const got = host.call(st.fn!, ...(st.args ?? []));
        if (st.ret !== undefined && got !== st.ret) bad.push(`${label}: returned ${got}, table says ${st.ret}`);
        if (st.scratchHex !== undefined) {
          const seen = hex(host.scratch(st.scratchHex.length / 2));
          if (seen !== st.scratchHex) bad.push(`${label}: scratch ${seen}, table says ${st.scratchHex}`);
        }
        if (st.board_rx !== undefined) {
          const seen = host.uart.rx.splice(0);
          if (JSON.stringify(seen) !== JSON.stringify(st.board_rx)) {
            bad.push(`${label}: the board heard ${JSON.stringify(seen)}, table says ${JSON.stringify(st.board_rx)}`);
          }
        }
        break;
      }
      case 'drive':
        host.drive(st.pin!, st.level!);
        break;
      case 'pad':
        host.pad(st.pin!, st.pull!);
        break;
      case 'spi': {
        const got = host.spiXfer(st.mosi!);
        if (JSON.stringify(got) !== JSON.stringify(st.miso)) bad.push(`${label}: miso ${JSON.stringify(got)}, table says ${JSON.stringify(st.miso)}`);
        break;
      }
      case 'i2c': {
        const got = host.i2cSeq(st.seq!);
        const want = i2cExpected(st.seq!);
        if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${label}: the controller saw ${JSON.stringify(got)}, table says ${JSON.stringify(want)}`);
        break;
      }
      case 'uart_rx':
        for (const b of st.bytes!) host.uart.tx(b);
        break;
      case 'board_pin': {
        const got = host.boardPin(st.pin!);
        if (got !== st.expect) bad.push(`${label}: the board sees ${JSON.stringify(got)}, table says ${JSON.stringify(st.expect)}`);
        break;
      }
      case 'clock':
        host.advance(st.ns!);
        break;
      case 'attr':
        host.chip.setAttr(st.name!, st.value!);
        break;
      case 'volts':
        host.volts(st.pin!, st.volts ?? null);
        break;
      case 'poke':
        host.poke(bytes(st.hex!));
        break;
      case 'trace': {
        const got = host.trace();
        if (JSON.stringify(got) !== JSON.stringify(st.expect)) bad.push(`${label}: trace ${JSON.stringify(got)}, table says ${JSON.stringify(st.expect)}`);
        break;
      }
      default:
        throw new Error(`unknown op ${st.op} in ${label}`);
    }
  });
  return bad;
}

// ── The suite ────────────────────────────────────────────────────────────

let host: BrowserHost | null = null;

afterEach(() => {
  host?.dispose();
  host = null;
});

async function makeHost(): Promise<BrowserHost> {
  host = new BrowserHost();
  await host.create();
  return host;
}

describe('the chip ABI in the browser runtime', () => {
  it('the committed wasm was built from the committed source', () => {
    const sha = createHash('sha256').update(readFileSync(fixture('abi-probe.c'))).digest('hex');
    expect(sha).toBe(MANIFEST['abi-probe'].sourceSha256);
  });

  it('setup: the chip loads on the fabric and declares everything', async () => {
    const h = await makeHost();
    expect(h.logs).toContain('[chip] abi probe ready');
    expect(h.spi.handler).not.toBeNull();
    expect(h.i2c.handler).not.toBeNull();
    expect(h.uart.handler).not.toBeNull();
    expect(h.chip.hasUart).toBe(true);
  });

  const mine = TABLE.scenarios.filter((s) => !s.only || s.only.includes(HOST));

  for (const scenario of mine) {
    it(`answers every row: ${scenario.name}`, async () => {
      const h = await makeHost();
      const bad = replay(h, scenario);
      expect(bad).toEqual([]);
    });
  }

  it('every host difference the table names is stated, and this host drives every scenario but the Pi form', () => {
    // The rows with a `hosts` variant are the ones where a host legitimately
    // answers differently (the worker has no pad model, the Pi relay speaks
    // whole transactions). Each is asserted in its scenario above; this lists
    // them so the ledger can see the set, and checks each says why.
    const split = TABLE.scenarios.flatMap((s) =>
      s.steps.filter((st) => st.hosts).map((st) => `${st.op}:${st.pin ?? st.fn ?? st.op}:${Object.keys(st.hosts!).join('+')}`),
    );
    // No row names this host as the odd one out: what the browser answers is
    // what the table says for everyone. The worker differs on the one pin
    // row (no pad model), the Pi on its I2C transaction shape.
    expect(split.filter((x) => x.endsWith(':browser'))).toEqual([]);
    expect(split.filter((x) => x.endsWith(':worker'))).toEqual(['board_pin:DIR:worker']);
    expect(split.filter((x) => x.endsWith(':pi')).length).toBeGreaterThan(0);
    for (const s of TABLE.scenarios) {
      for (const st of s.steps) for (const v of Object.values(st.hosts ?? {})) expect(typeof v.why).toBe('string');
      if (s.only) expect(typeof s.why_only).toBe('string');
    }
    expect(TABLE.scenarios.filter((s) => s.only && !s.only.includes(HOST)).map((s) => s.name.split(':')[0])).toEqual(['spi (pi)']);
  });
});
