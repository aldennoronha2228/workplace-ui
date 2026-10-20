/**
 * Board buses F6: the AVR engine's UART controller ports (USART0 on the Uno,
 * USART0..3 on the Mega) against the shared UART conformance suite
 * (project/board-buses-2026-09, F5-F6-SPEC, TESTS.md layer 2), plus what the
 * suite cannot see on this engine: the fabric end to end by nets on the
 * Mega's second USART, SoftwareSerial on plain GPIOs followed on the guest
 * clock, the receive pacing and the reset that empties the line.
 *
 * Everything under test is the real thing: avr8js behind AVRSimulator, driven
 * through the store's own lifecycle (addBoard, compileBoardProgram, startBoard,
 * stopBoard, resetBoard) with a real guest. fixtures/conf-uart-console is one
 * sketch built for the Uno and for the Mega with the production toolchain (the
 * .ino says how to rebuild it); the rig types each command into USART0's RX
 * behind an ESC and reads the answer out of the guest's SRAM, since UART0's TX
 * is under test and must carry nothing but what the test asked for.
 * fixtures/avr-mega-serial1-mhz16 and avr-softserial-mhz16 are the Seeed
 * CO2-sensor idioms on Serial1 and on SoftwareSerial(2, 3); the module is a
 * fabric endpoint that answers the read command. fixtures/chips-other-uart-ping
 * is the request/response shape that counts what came back. Only the frame
 * clock is a stand-in: the store's requestAnimationFrame never fires, and the
 * rig steps the CPU itself.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node environment, with the browser globals the store's Run path touches.
vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
let nextFrame = 1;
vi.stubGlobal('requestAnimationFrame', () => nextFrame++);
vi.stubGlobal('cancelAnimationFrame', () => {});

import { useSimulatorStore, getBoardSimulator } from '../../store/useSimulatorStore';
import type { AVRSimulator } from '../../simulation/AVRSimulator';
import { attachUartEndpoint, baudsMatch, busRegistry } from '../../simulation/buses';
import type { BusDiagnostic, EngineBinding, UartEndpoint, UartHandle } from '../../simulation/buses/types';
import {
  defineUartPortConformance,
  bindTxProbe,
  type UartConformanceRig,
} from '../../simulation/buses/conformance/uartPortConformance';

const fixture = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)), 'utf-8');

type AvrKind = 'arduino-uno' | 'arduino-mega' | 'attiny85';

interface Variant {
  hex: string;
  units: number[];
  /** Board pins of each USART: what a module's RX and TX legs land on. */
  pins: Array<{ tx: number; rx: number }>;
}

const VARIANTS: Record<'arduino-uno' | 'arduino-mega', Variant> = {
  'arduino-uno': {
    hex: fixture('conf-uart-console/uno/conf-uart-console.ino.hex'),
    units: [0],
    pins: [{ tx: 1, rx: 0 }],
  },
  'arduino-mega': {
    hex: fixture('conf-uart-console/mega/conf-uart-console.ino.hex'),
    units: [0, 1, 2, 3],
    pins: [
      { tx: 1, rx: 0 },
      { tx: 18, rx: 19 },
      { tx: 16, rx: 17 },
      { tx: 14, rx: 15 },
    ],
  },
};

const hex2 = (b: number) => b.toString(16).padStart(2, '0');
const ESC = '\x1b';

/** The guest's answer buffer (conf-uart-console.ino): magic, seq, ready, len, text. */
const MAGIC = [0x56, 0x58, 0x41, 0x4e]; // "VXAN"
const SEQ = 4;
const READY = 5;
const LEN = 6;
const TEXT = 7;

let rigSeq = 0;
const liveBoards = new Set<Board>();
afterEach(() => {
  for (const b of liveBoards) b.dispose();
  liveBoards.clear();
  busRegistry.resetDiagnostics();
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});

/** One AVR board of the real store, with a loaded sketch, stepped by the test. */
class Board {
  readonly id: string;
  readonly kind: AvrKind;
  out = '';
  private wireSeq = 0;

  constructor(kind: AvrKind, hex: string) {
    this.kind = kind;
    this.id = `${kind}-uart${++rigSeq}`;
    liveBoards.add(this);
    const st = useSimulatorStore.getState();
    st.addBoard(kind, 0, 0, this.id);
    this.sim.onSerialData = (ch: string) => {
      this.out += ch;
    };
    // A scope listening: the engine then draws every byte's frame on the TX
    // pad through this channel and no other (the no-echo row watches the pad).
    this.sim.onPinChangeWithTime = () => {};
    st.compileBoardProgram(this.id, hex);
    st.startBoard(this.id);
  }

  get sim(): AVRSimulator {
    return getBoardSimulator(this.id) as unknown as AVRSimulator;
  }

  /** The CPU's data space: registers, I/O and SRAM, as avr8js lays it out. */
  get data(): Uint8Array {
    return (this.sim as unknown as { cpu: { data: Uint8Array } }).cpu.data;
  }

  /** Wire a component pin to one of this board's pins, as the canvas does. */
  wire(componentId: string, pinName: string, boardPin: number): void {
    useSimulatorStore.getState().addWire({
      id: `${this.id}-w${++this.wireSeq}`,
      start: { componentId, pinName, x: 0, y: 0 },
      end: { componentId: this.id, pinName: String(boardPin), x: 0, y: 0 },
      waypoints: [],
      color: '#0a0',
    } as never);
  }

  /** Run button (the board is stopped after Reset and after Stop). */
  run(): void {
    const board = useSimulatorStore.getState().boards.find((b) => b.id === this.id);
    if (!board?.running) useSimulatorStore.getState().startBoard(this.id);
  }

  /** Execute up to `budget` instructions, stopping once `done` holds. */
  step(budget: number, done: () => boolean, every = 0x3f): void {
    const sim = this.sim;
    for (let i = 0; i < budget; i++) {
      sim.step();
      if ((i & every) === 0 && done()) return;
    }
  }

  dispose(): void {
    if (!liveBoards.delete(this)) return;
    useSimulatorStore.getState().removeBoard(this.id);
  }
}

/** The conformance console: commands in through USART0 RX, answers out of SRAM. */
class AvrUartRig implements UartConformanceRig {
  readonly units: number[];
  readonly board: Board;
  readonly v: Variant;
  private answerAt = -1;

  constructor(kind: 'arduino-uno' | 'arduino-mega') {
    this.v = VARIANTS[kind];
    this.units = this.v.units;
    this.board = new Board(kind, this.v.hex);
  }

  binding(): EngineBinding {
    return this.board.sim.getBusBinding();
  }

  expectedConfig(): { baud: number; frame: string } {
    return { baud: 115200, frame: '8N1' };
  }

  /** Fixed by the chip: the pads the no-echo row watches. */
  expectedRouting(unit: number): { tx: number; rx: number } {
    return this.v.pins[unit];
  }

  onPinEdge(pin: number, cb: () => void): () => void {
    return this.board.sim.pinManager.onPinChange(pin, () => cb());
  }

  async transmit(unit: number, bytes: number[]): Promise<void> {
    expect(this.cmd(`t ${unit} ${bytes.map(hex2).join(' ')}`)).toBe('OK');
  }

  async read(unit: number, n: number): Promise<number[]> {
    const text = this.cmd(`r ${unit} ${n}`);
    return text
      .split(/\s+/)
      .filter(Boolean)
      .map((h) => parseInt(h, 16));
  }

  async reset(): Promise<void> {
    useSimulatorStore.getState().resetBoard(this.board.id);
  }

  async stopRun(): Promise<void> {
    useSimulatorStore.getState().stopBoard(this.board.id);
    useSimulatorStore.getState().startBoard(this.board.id);
  }

  async reload(): Promise<void> {
    useSimulatorStore.getState().compileBoardProgram(this.board.id, this.v.hex);
  }

  dispose(): void {
    this.board.dispose();
  }

  /** Type one command; the guest's answer text. */
  cmd(line: string): string {
    this.board.run();
    this.awaitBoot();
    const data = this.board.data;
    const before = data[this.answerAt + SEQ];
    this.board.sim.serialWrite(`${ESC}${line}\n`);
    // A read waits up to 100 ms of guest time (1.6 M cycles) for its bytes.
    this.board.step(4_000_000, () => data[this.answerAt + SEQ] !== before);
    if (data[this.answerAt + SEQ] === before) throw new Error(`no answer to "${line}"`);
    const len = data[this.answerAt + LEN];
    let text = '';
    for (let i = 0; i < len; i++) text += String.fromCharCode(data[this.answerAt + TEXT + i]);
    return text;
  }

  /**
   * Step until setup() has run: the answer buffer carries its magic and the
   * ready flag. The buffer is static, so its address survives every rebuild;
   * a new CPU's SRAM is zero until the sketch fills it again.
   */
  private awaitBoot(): void {
    const ready = () => {
      const data = this.board.data;
      if (this.answerAt < 0 || !MAGIC.every((b, i) => data[this.answerAt + i] === b)) {
        this.answerAt = findMagic(data);
      }
      return this.answerAt >= 0 && data[this.answerAt + READY] === 1;
    };
    this.board.step(3_000_000, ready, 0x3ff);
    if (!ready()) throw new Error('the sketch never reached the end of setup()');
  }
}

function findMagic(data: Uint8Array): number {
  for (let i = 0x100; i + TEXT < data.length; i++) {
    if (data[i] === MAGIC[0] && data[i + 1] === MAGIC[1] && data[i + 2] === MAGIC[2] && data[i + 3] === MAGIC[3]) {
      return i;
    }
  }
  return -1;
}

defineUartPortConformance('AVR USART0 on the Uno', async () => new AvrUartRig('arduino-uno'), {
  staticRouting: true,
});
defineUartPortConformance('AVR USART0..3 on the Mega', async () => new AvrUartRig('arduino-mega'), {
  staticRouting: true,
});

// ── The fabric by nets ──────────────────────────────────────────────────────

/** A module on the wire: keeps what it hears, transmits through its handle. */
class Module implements UartEndpoint {
  heard: number[] = [];
  resets = 0;
  handle: UartHandle | null = null;
  receive(byte: number): void {
    this.heard.push(byte);
  }
  boardReset(): void {
    this.resets++;
  }
  text(): string {
    return String.fromCharCode(...this.heard);
  }
}

let modSeq = 0;
/** A module wired with its RX on `boardTx` and its TX on `boardRx`, registered on the fabric. */
function moduleOn(board: Board, boardTx: number | null, boardRx: number | null, baud?: number): Module {
  const owner = `${board.id}-mod${++modSeq}`;
  const m = new Module();
  if (boardTx !== null) board.wire(owner, 'RX', boardTx);
  if (boardRx !== null) board.wire(owner, 'TX', boardRx);
  m.handle = attachUartEndpoint(
    {
      owner,
      pins: { rx: boardTx !== null ? 'RX' : undefined, tx: boardRx !== null ? 'TX' : undefined },
      ...(baud !== undefined ? { baud } : {}),
    },
    m,
  );
  return m;
}

describe('AVR: a module is on the USART its pins are wired to', () => {
  it('on the Mega, a module on 18/19 hears Serial1 and answers into it; one on 16/17 hears Serial2 only', async () => {
    const rig = new AvrUartRig('arduino-mega');
    const on1 = moduleOn(rig.board, 18, 19);
    const on2 = moduleOn(rig.board, 16, 17);
    expect(busRegistry.uartPlacement(`${rig.board.id}-mod${modSeq - 1}`)).toEqual({
      rx: { boardId: rig.board.id, pin: 18, controller: 'USART1' },
      tx: { boardId: rig.board.id, pin: 19, controller: 'USART1' },
    });
    expect(busRegistry.uartPlacement(`${rig.board.id}-mod${modSeq}`)).toEqual({
      rx: { boardId: rig.board.id, pin: 16, controller: 'USART2' },
      tx: { boardId: rig.board.id, pin: 17, controller: 'USART2' },
    });

    await rig.transmit(1, [0x48, 0x69]);
    await rig.transmit(2, [0x21]);
    expect(on1.heard).toEqual([0x48, 0x69]);
    expect(on2.heard).toEqual([0x21]);

    on1.handle!.transmit(0x4f);
    on1.handle!.transmit(0x4b);
    on2.handle!.transmit(0x3f);
    expect(await rig.read(1, 2)).toEqual([0x4f, 0x4b]);
    expect(await rig.read(2, 1)).toEqual([0x3f]);
    // Nothing crossed: Serial3 heard nobody, and USART0 only the rig's own commands.
    expect(await rig.read(3, 1)).toEqual([]);

    on1.handle!.dispose();
    on2.handle!.dispose();
    await rig.transmit(1, [0x55]);
    expect(on1.heard).toEqual([0x48, 0x69]);
    rig.dispose();
  });

  it('the monitor is USART0 and no other: a byte on Serial1 reaches its port, not the console', async () => {
    const rig = new AvrUartRig('arduino-mega');
    const { probe, release } = bindTxProbe(rig.binding(), 1);
    rig.board.out = '';
    await rig.transmit(1, [0x41]);
    release();
    expect(probe.heard).toEqual([0x41]);
    expect(rig.board.out).toBe('');
    rig.dispose();
  });

  it('a module wired the wrong way round (RX to RX) is reported and hears nothing', async () => {
    const rig = new AvrUartRig('arduino-mega');
    const seen: BusDiagnostic[] = [];
    const off = busRegistry.onDiagnostic((d) => seen.push(d));
    const crossed = moduleOn(rig.board, 19, 18);
    await rig.transmit(1, [0x41]);
    expect(crossed.heard).toEqual([]);
    expect(seen.map((d) => d.code)).toContain('uart-wiring');
    expect(seen.map((d) => d.code)).toContain('uart-tx-contention');
    off();
    crossed.handle!.dispose();
    rig.dispose();
  });

  it('the module survives Stop/Run and Reset on the same handle, and is told about each reboot', async () => {
    const rig = new AvrUartRig('arduino-mega');
    const m = moduleOn(rig.board, 18, 19);
    await rig.transmit(1, [0x01]);
    await rig.stopRun();
    await rig.transmit(1, [0x02]);
    await rig.reset();
    await rig.transmit(1, [0x03]);
    await rig.reload();
    await rig.transmit(1, [0x04]);
    expect(m.heard).toEqual([0x01, 0x02, 0x03, 0x04]);
    expect(m.resets).toBeGreaterThanOrEqual(3);
    m.handle!.dispose();
    rig.dispose();
  });

  it('a module at 9600 on a USART the sketch runs at 115200 gets garbage, and the mismatch is reported once', async () => {
    const rig = new AvrUartRig('arduino-uno');
    const seen: BusDiagnostic[] = [];
    const off = busRegistry.onDiagnostic((d) => seen.push(d));
    const slow = moduleOn(rig.board, 1, null, 9600);
    await rig.transmit(0, [0x55, 0x55]);
    // What a 9600 receiver reads of a 115200 frame is not the byte sent.
    expect(slow.heard.length).toBeGreaterThan(0);
    expect(slow.heard).not.toEqual([0x55, 0x55]);
    expect(seen.filter((d) => d.code === 'uart-baud-mismatch')).toHaveLength(1);
    off();
    slow.handle!.dispose();
    rig.dispose();
  });
});

// ── Real sketches: the Seeed CO2 sensor idioms ──────────────────────────────

/** The MH-Z16's read command and a reply that decodes to 600 ppm. */
const MHZ16_READ = [0xff, 0x01, 0x86, 0x00, 0x00, 0x00, 0x00, 0x00, 0x79];
const MHZ16_REPLY = [0xff, 0x86, 0x02, 0x58, 0x00, 0x00, 0x00, 0x00, 0x20];

/** A CO2 module: answers the read command with 600 ppm, ignores anything else. */
class Mhz16 extends Module {
  private cmd: number[] = [];
  receive(byte: number): void {
    super.receive(byte);
    this.cmd.push(byte);
    if (this.cmd.length > 9) this.cmd.shift();
    if (this.cmd.length === 9 && this.cmd.every((b, i) => b === MHZ16_READ[i])) {
      this.cmd = [];
      for (const b of MHZ16_REPLY) this.handle!.transmit(b);
    }
  }
}

function mhz16On(board: Board, boardTx: number, boardRx: number): Mhz16 {
  const owner = `${board.id}-co2`;
  const m = new Mhz16();
  board.wire(owner, 'RX', boardTx);
  board.wire(owner, 'TX', boardRx);
  m.handle = attachUartEndpoint({ owner, pins: { rx: 'RX', tx: 'TX' }, baud: 9600 }, m);
  return m;
}

/**
 * Step until the sketch printed three results; what they were. Whole lines
 * only: the poll runs between instructions, and a match on a line still
 * being printed reads "CO2=6" off a "CO2=600" the USART has not finished.
 */
function results(board: Board, budget = 40_000_000): string[] {
  const found = () => [...board.out.matchAll(/(CO2=\d+|NOFRAME n=\d+)\r?\n/g)].map((m) => m[1]);
  board.step(budget, () => found().length >= 3, 0x3ff);
  return found();
}

describe('AVR: the Seeed CO2 sensor idioms, with the module on the fabric', () => {
  it('grove-uart-softwareserial-and-mega-uarts (engine side): an MH-Z16 on the Mega\'s TX1/RX1 (18/19) answers Serial1', () => {
    const board = new Board('arduino-mega', fixture('avr-mega-serial1-mhz16/avr-mega-serial1-mhz16.ino.hex'));
    const co2 = mhz16On(board, 18, 19);
    expect(results(board)).toEqual(['CO2=600', 'CO2=600', 'CO2=600']);
    expect(board.out).toMatch(/^READY\r?\n/);
    co2.handle!.dispose();
  });

  it('grove-uart-softwareserial-and-mega-uarts (engine side): an MH-Z16 on D2/D3 answers SoftwareSerial co2(2, 3)', () => {
    const board = new Board('arduino-uno', fixture('avr-softserial-mhz16/avr-softserial-mhz16.ino.hex'));
    // Module RX on D3 (the sketch's SoftwareSerial TX), module TX on D2.
    const co2 = mhz16On(board, 3, 2);
    expect(busRegistry.uartPlacement(`${board.id}-co2`)).toEqual({
      rx: { boardId: board.id, pin: 3, controller: null },
      tx: { boardId: board.id, pin: 2, controller: null },
    });
    expect(results(board)).toEqual(['CO2=600', 'CO2=600', 'CO2=600']);
    // The whole exchange went over plain GPIOs: nothing reached USART0's port.
    expect(co2.heard.slice(0, 9)).toEqual(MHZ16_READ);
    co2.handle!.dispose();
  });

  it('a module on D2/D3 without a rate cannot sit on a software UART, and the board says so', () => {
    const board = new Board('arduino-uno', fixture('avr-softserial-mhz16/avr-softserial-mhz16.ino.hex'));
    const seen: BusDiagnostic[] = [];
    const off = busRegistry.onDiagnostic((d) => seen.push(d));
    const mute = moduleOn(board, 3, 2);
    expect(seen.map((d) => d.code)).toContain('uart-no-baud');
    results(board, 4_000_000);
    expect(mute.heard).toEqual([]);
    off();
    mute.handle!.dispose();
  });
});

// ── Receive pacing and the reset that empties the line ──────────────────────

const PING_HEX = fixture('chips-other-uart-ping/uart-ping.ino.hex');
const BURST = Array.from({ length: 96 }, (_, i) => 0x30 + (i % 10));

/** A module that answers a burst of 96 bytes to 'G' (the uart-ping shape). */
class Burster extends Module {
  receive(byte: number): void {
    super.receive(byte);
    if (byte === 0x47) for (const b of BURST) this.handle!.transmit(b);
  }
}

/** The sketch's report, once its line is complete (see results()). */
function report(out: string): { n: number; f: number } | null {
  const m = /n=(\d+) f=(-?\d+)\n/.exec(out);
  return m ? { n: Number(m[1]), f: Number(m[2]) } : null;
}

describe('AVR: bytes into the guest are paced by the USART, and Stop empties the line', () => {
  function bursting(): { board: Board; mod: Burster } {
    const board = new Board('arduino-uno', PING_HEX);
    const owner = `${board.id}-burst`;
    const mod = new Burster();
    board.wire(owner, 'RX', 1);
    board.wire(owner, 'TX', 0);
    mod.handle = attachUartEndpoint({ owner, pins: { rx: 'RX', tx: 'TX' }, baud: 9600 }, mod);
    return { board, mod };
  }

  it('avr-rx-queue-stale-and-throttled (engine side): a 96-byte answer at 9600 baud reaches the sketch within 300 ms of guest time', () => {
    const { board, mod } = bursting();
    // D2 LOW: the sketch asks for the burst.
    board.step(8_000_000, () => report(board.out) !== null, 0x3ff);
    expect(mod.text()).toContain('G');
    expect(report(board.out)).toEqual({ n: 96, f: 0x30 });
    mod.handle!.dispose();
  });

  it('avr-rx-queue-stale-and-throttled (engine side): after Stop, the next Run does not receive bytes the previous run never read', () => {
    const { board, mod } = bursting();
    // Stop in the middle of the answer: the sketch has asked, the module has
    // answered, the USART is still shifting the burst in.
    board.step(8_000_000, () => mod.text().includes('G'), 0x3f);
    board.step(20_000, () => false);
    useSimulatorStore.getState().stopBoard(board.id);
    // This run only listens (D2 HIGH), so any byte it counts is a leftover.
    board.sim.setPinState(2, true);
    board.out = '';
    board.run();
    board.step(8_000_000, () => report(board.out) !== null, 0x3ff);
    expect(board.out).toContain('ready\n');
    expect(report(board.out)).toEqual({ n: 0, f: -1 });
    mod.handle!.dispose();
  });
});

describe('AVR: a stopped board is an unpowered board', () => {
  it('bytes that arrive while the board is stopped are lost: a Reset and the next Run do not replay them', async () => {
    const rig = new AvrUartRig('arduino-uno');
    await rig.transmit(0, [0x01]);
    useSimulatorStore.getState().stopBoard(rig.board.id);
    // With the CPU halted the first byte is accepted and never lands; the
    // rest wait at the port. Reset rebuilds the CPU without a Run between.
    const port = rig.binding().uart![0];
    for (const b of [0x41, 0x42, 0x43]) port.receive(b);
    useSimulatorStore.getState().resetBoard(rig.board.id);
    expect(await rig.read(0, 3)).toEqual([]);
    rig.dispose();
  });
});

// ── The port alone ──────────────────────────────────────────────────────────

describe('AVR: the ports are the variant\'s USARTs, made once', () => {
  it('the Uno has USART0, the Mega USART0..3 and the ATtiny85 none; the objects survive a reload', () => {
    const uno = new Board('arduino-uno', VARIANTS['arduino-uno'].hex);
    const mega = new Board('arduino-mega', VARIANTS['arduino-mega'].hex);
    expect((uno.sim.getBusBinding().uart ?? []).map((p) => [p.unit, p.name])).toEqual([[0, 'USART0']]);
    expect((mega.sim.getBusBinding().uart ?? []).map((p) => [p.unit, p.name])).toEqual([
      [0, 'USART0'],
      [1, 'USART1'],
      [2, 'USART2'],
      [3, 'USART3'],
    ]);
    const before = mega.sim.getBusBinding().uart;
    useSimulatorStore.getState().compileBoardProgram(mega.id, VARIANTS['arduino-mega'].hex);
    expect(mega.sim.getBusBinding().uart).toBe(before);
    expect(mega.sim.getBusBinding().clock).toBeDefined();

    const tiny = new Board('attiny85', fixture('avr-tiny-oled/avr-tiny-oled.ino.hex'));
    expect(tiny.sim.getBusBinding().uart).toEqual([]);
  });

  it('config() says nothing before Serial.begin and the line afterwards; a probe hears the console bytes too', () => {
    const rig = new AvrUartRig('arduino-uno');
    const port = rig.binding().uart![0];
    // The sketch has begun USART0 by the time it answers anything.
    const { probe, release } = bindTxProbe(rig.binding(), 0);
    expect(rig.cmd('t 0 41')).toBe('OK');
    release();
    expect(probe.heard).toEqual([0x41]);
    // What the port reports is the rate the USART really runs from its
    // divisor, 117647 for a requested 115200 (16 MHz, UBRR 8): the same 2%
    // error the silicon has, inside what a receiver tolerates, so the fabric
    // raises no mismatch against a module at 115200.
    const cfg = port.config();
    expect(cfg.frame).toBe('8N1');
    expect(cfg.baud).toBeDefined();
    expect(baudsMatch(cfg.baud!, 115200), `${cfg.baud} vs 115200`).toBe(true);
    expect(rig.cmd('b 0 9600')).toBe('OK');
    expect(baudsMatch(port.config().baud!, 9600)).toBe(true);
    useSimulatorStore.getState().stopBoard(rig.board.id);
    expect(port.config()).toEqual({});
    rig.dispose();
  });
});
