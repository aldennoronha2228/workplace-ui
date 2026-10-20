/**
 * Board buses F6: the RP2040 UART controller ports (project board-buses-2026-09,
 * F5-F6-SPEC "Motores": "RP2040 / RP2350: UART0 y UART1 con ruta por funcsel;
 * fuera el 'oye todo' de onSerialData", TESTS.md layer 2).
 *
 * Everything runs the real rp2040js core through RP2040Simulator with guests
 * built by the production toolchain (arduino-pico 6.1.1):
 *   fixtures/conf-uart-console/pico  the UART console of the shared suite,
 *                                    UART0 (Serial1, the sketch's Serial) and
 *                                    UART1 (Serial2), commands in through
 *                                    UART0 behind ESC, answers read out of
 *                                    SRAM so UART0's TX carries only what a
 *                                    test asked for
 *   fixtures/rp2040-uart-chip        the F0 guest: a PING on Serial2 and a
 *                                    debug line on Serial that a module on
 *                                    UART1 must never hear
 *
 * The shared conformance suite (buses/conformance/uartPortConformance.ts)
 * runs twice: both controllers on the arduino-pico default pads, and both
 * moved to another legal F2 pair with setTX/setRX. The cases after it cover
 * what is specific to this SoC: routing that follows funcsel, the fabric
 * deciding by nets which controller a module hears (finding
 * rp2040-uart-lumped-and-uart0-only-rx: a part used to hear every UART through
 * the console callback and could answer on UART0 only), and bytes into a
 * receive FIFO 32 deep.
 *
 * Stand-in, only for what node lacks: a console.log that keeps the guest's
 * chatter out of the report.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RP2040Simulator } from '../../simulation/RP2040Simulator';
import { PinManager } from '../../simulation/PinManager';
import {
  defineUartPortConformance,
  bindTxProbe,
  type UartConformanceRig,
} from '../../simulation/buses/conformance/uartPortConformance';
import { BusRegistry } from '../../simulation/buses/registry';
import type {
  BusDiagnostic,
  NetResolver,
  PinRef,
  ResolvedPin,
  UartEndpoint,
  UartHandle,
  UartRouting,
} from '../../simulation/buses/types';

// ── Firmware ─────────────────────────────────────────────────────────────────

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const bin = (rel: string) => readFileSync(here(`./fixtures/${rel}`)).toString('base64');
const CONSOLE_BIN = bin('conf-uart-console/pico/conf-uart-console.ino.bin');
const CHIP_BIN = bin('rp2040-uart-chip/rp2040-uart-chip.ino.bin');

const realLog = console.log;
beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    if (process.env.RP2040_PORT_VERBOSE) realLog(...args);
  });
});
afterAll(() => {
  vi.restoreAllMocks();
});

// ── The console guest ────────────────────────────────────────────────────────

const hex2 = (b: number) => b.toString(16).padStart(2, '0');
const ESC = '\x1b';

/** The guest's answer buffer (conf-uart-console.ino): magic, seq, ready, len, text. */
const MAGIC = [0x56, 0x58, 0x41, 0x4e]; // "VXAN"
const SEQ = 4;
const READY = 5;
const LEN = 6;
const TEXT = 7;

function findMagic(data: Uint8Array): number {
  for (let i = 0; i + TEXT < data.length; i++) {
    if (data[i] === MAGIC[0] && data[i + 1] === MAGIC[1] && data[i + 2] === MAGIC[2] && data[i + 3] === MAGIC[3]) {
      return i;
    }
  }
  return -1;
}

/**
 * A Pico running the UART console. Time only moves through the production
 * frame body (runFrameForTime); commands go in through UART0 and the answer
 * is read out of the guest's SRAM.
 */
class PicoConsole {
  readonly sim: RP2040Simulator;
  private answerAt = -1;

  constructor(sim: RP2040Simulator) {
    this.sim = sim;
  }

  private get sram(): Uint8Array {
    const mcu = this.sim.getMCU();
    if (!mcu) throw new Error('no SoC');
    return mcu.sram;
  }

  /** Run 1 ms frames until `done` holds, up to `maxMs` of guest time. */
  run(maxMs: number, done: () => boolean): boolean {
    for (let t = 0; t < maxMs; t++) {
      if (done()) return true;
      this.sim.runFrameForTime(1);
    }
    return done();
  }

  /**
   * Step until setup() has run: the answer buffer carries its magic and the
   * ready flag. The buffer is static, so its address survives every rebuild;
   * a new SoC's SRAM is zero until the sketch fills it again.
   */
  awaitBoot(): void {
    const ready = () => {
      const data = this.sram;
      if (this.answerAt < 0 || !MAGIC.every((b, i) => data[this.answerAt + i] === b)) {
        this.answerAt = findMagic(data);
      }
      return this.answerAt >= 0 && data[this.answerAt + READY] === 1;
    };
    if (!this.run(3000, ready)) throw new Error('the sketch never reached the end of setup()');
  }

  /**
   * Type one command and return the wait for its answer, so a test can put
   * bytes on the wire while the guest is already reading for them.
   */
  ask(line: string): () => string {
    this.awaitBoot();
    const data = this.sram;
    const before = data[this.answerAt + SEQ];
    this.sim.serialWrite(`${ESC}${line}\n`);
    return () => {
      // A read waits up to 100 ms of guest time for its bytes.
      if (!this.run(800, () => data[this.answerAt + SEQ] !== before)) throw new Error(`no answer to "${line}"`);
      const len = data[this.answerAt + LEN];
      let text = '';
      for (let i = 0; i < len; i++) text += String.fromCharCode(data[this.answerAt + TEXT + i]);
      return text;
    };
  }

  /** Type one command; the guest's answer text. */
  cmd(line: string): string {
    return this.ask(line)();
  }

  transmit(unit: number, bytes: number[]): void {
    expect(this.cmd(`t ${unit} ${bytes.map(hex2).join(' ')}`)).toBe('OK');
  }

  read(unit: number, n: number): number[] {
    return PicoConsole.bytes(this.cmd(`r ${unit} ${n}`));
  }

  static bytes(text: string): number[] {
    return text
      .split(/\s+/)
      .filter(Boolean)
      .map((h) => parseInt(h, 16));
  }
}

function boot(firmware: string, sim = new RP2040Simulator(new PinManager())): PicoConsole {
  // A scope listening: the engine then draws every byte's frame on the TX pad
  // through this channel and no other (the no-echo row watches the pad).
  sim.onPinChangeWithTime = () => {};
  sim.loadBinary(firmware);
  const con = new PicoConsole(sim);
  con.awaitBoot();
  return con;
}

interface PinPair {
  tx: number;
  rx: number;
}

/** arduino-pico rpipico defaults (pins_arduino.h): Serial1 on GP0/GP1, Serial2 on GP8/GP9. */
const DEFAULT_PINS: [PinPair, PinPair] = [
  { tx: 0, rx: 1 },
  { tx: 8, rx: 9 },
];
/** Another legal F2 pair for each controller: UART0 on GP12/GP13, UART1 on GP4/GP5. */
const ALT_PINS: [PinPair, PinPair] = [
  { tx: 12, rx: 13 },
  { tx: 4, rx: 5 },
];

function movePins(con: PicoConsole, unit: 0 | 1, p: PinPair): void {
  expect(con.cmd(`p ${unit} ${p.tx} ${p.rx}`)).toBe('OK');
}

/** What the store's Stop and Reset do to an RP2040: reset() and a hard pin reset. */
function storeReset(sim: RP2040Simulator): void {
  sim.reset();
  sim.pinManager.hardResetPinStates();
}

/** The rig the shared suite drives. The guest boots on the defaults, so a
 *  moved rig moves the controllers again after every boot. */
function consoleRig(pins: [PinPair, PinPair]): UartConformanceRig {
  const con = boot(CONSOLE_BIN);
  const sim = con.sim;
  const atDefaults = pins === DEFAULT_PINS;
  let moved = atDefaults;
  const place = () => {
    if (moved) return;
    movePins(con, 0, pins[0]);
    movePins(con, 1, pins[1]);
    moved = true;
  };
  const reboot = (step: () => void) => {
    step();
    con.awaitBoot();
    moved = atDefaults;
  };
  return {
    units: [0, 1],
    binding: () => sim.getBusBinding(),
    transmit: async (unit, bytes) => {
      place();
      con.transmit(unit, bytes);
    },
    read: async (unit, n) => {
      place();
      return con.read(unit, n);
    },
    reset: async () => reboot(() => storeReset(sim)),
    stopRun: async () => reboot(() => storeReset(sim)),
    reload: async () => reboot(() => sim.loadBinary(CONSOLE_BIN)),
    expectedRouting: (unit) => pins[unit],
    expectedConfig: () => ({ baud: 115200, frame: '8N1' }),
    onPinEdge: (pin, cb) => sim.pinManager.onPinChange(pin, () => cb()),
    dispose: () => sim.stop(),
  };
}

defineUartPortConformance('RP2040 UART0 and UART1 on the default pads', async () => consoleRig(DEFAULT_PINS));
defineUartPortConformance('RP2040 UART0 and UART1 moved to GP12/GP13 and GP4/GP5', async () => consoleRig(ALT_PINS));

// ── Routing follows funcsel ──────────────────────────────────────────────────

describe('RP2040 UART ports: routing is the pads whose funcsel is UART', () => {
  it('both controllers are ports named for the datasheet, and a pin move is reported as it happens', () => {
    const con = boot(CONSOLE_BIN);
    const ports = con.sim.getBusBinding().uart ?? [];
    expect(ports.map((p) => [p.bus, p.unit, p.name])).toEqual([
      ['uart', 0, 'UART0'],
      ['uart', 1, 'UART1'],
    ]);
    const [p0, p1] = ports;
    expect(p0.routing()).toEqual({ tx: 0, rx: 1 });
    expect(p1.routing()).toEqual({ tx: 8, rx: 9 });

    let changes = 0;
    p1.setRoutingChangeHandler!(() => changes++);
    movePins(con, 1, ALT_PINS[1]);
    expect(changes).toBeGreaterThan(0);
    expect(p1.routing()).toEqual({ tx: 4, rx: 5 });
    // The other controller never moved.
    expect(p0.routing()).toEqual({ tx: 0, rx: 1 });
    p1.setRoutingChangeHandler!(null);
    con.sim.stop();
  });

  it('a reset starts routing over from the new SoC (no pad is UART until the sketch says so again)', () => {
    const con = boot(CONSOLE_BIN);
    const port = (con.sim.getBusBinding().uart ?? [])[1];
    const seen: Array<UartRouting | 'static'> = [];
    port.setRoutingChangeHandler!(() => seen.push(port.routing()));
    con.sim.reset();
    expect(seen[0]).toEqual({});
    con.awaitBoot();
    expect(port.routing()).toEqual({ tx: 8, rx: 9 });
    port.setRoutingChangeHandler!(null);
    con.sim.stop();
  });

  it('config() says nothing for a controller the sketch never opened, and the line once it did', () => {
    const sim = new RP2040Simulator(new PinManager());
    const [p0, p1] = sim.getBusBinding().uart ?? [];
    expect(p0.config()).toEqual({});
    expect(p1.config()).toEqual({});
    const con = boot(CONSOLE_BIN, sim);
    expect(p1.config().frame).toBe('8N1');
    expect(p1.config().baud).toBeGreaterThan(111_000);
    expect(p1.config().baud).toBeLessThan(119_000);
    expect(con.cmd('b 1 9600')).toBe('OK');
    expect(p1.config().baud).toBeGreaterThan(9300);
    expect(p1.config().baud).toBeLessThan(9900);
    sim.stop();
  });
});

// ── Under the fabric: a module hears the controller its wires reach ─────────

/** The circuit, as a plain NetResolver: component pins wired to GPIOs of one Pico. */
class Circuit implements NetResolver {
  private readonly nets = new Map<string, ResolvedPin>();
  wire(comp: string, pins: Record<string, number>): void {
    for (const [name, pin] of Object.entries(pins)) {
      this.nets.set(`${comp}:${name}`, { kind: 'board', boardId: 'pico', pin });
    }
  }
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    return this.nets.get(`${ref.componentId}:${ref.pinName}`) ?? { kind: 'floating' };
  }
  boardKind(): string {
    return 'raspberry-pi-pico';
  }
  boards(): string[] {
    return ['pico'];
  }
}

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

function fabricBoard(firmware: string): { con: PicoConsole; registry: BusRegistry; circuit: Circuit } {
  const sim = new RP2040Simulator(new PinManager());
  sim.onPinChangeWithTime = () => {};
  const registry = new BusRegistry();
  const circuit = new Circuit();
  registry.setResolver(circuit);
  // On the canvas the board and its wires exist before the sketch runs.
  registry.bindBoard('pico', sim);
  const con = new PicoConsole(sim);
  sim.loadBinary(firmware);
  return { con, registry, circuit };
}

/** A module wired with its RX on the board's `tx` pad and its TX on the board's `rx` pad. */
function moduleOn(registry: BusRegistry, circuit: Circuit, owner: string, at: PinPair, baud = 115200): Module {
  const m = new Module();
  circuit.wire(owner, { RX: at.tx, TX: at.rx });
  registry.netlistChanged();
  m.handle = registry.attachUart({ owner, pins: { rx: 'RX', tx: 'TX' }, baud }, m);
  return m;
}

const UART_PINS = { rx: 'RX', tx: 'TX' };

describe('RP2040 UART under the fabric: a module hears the controller its pads are wired to, and answers into it', () => {
  it('rp2040-uart-lumped-and-uart0-only-rx: a module on GP8/GP9 hears Serial2 and not Serial, and its answer lands in Serial2', () => {
    const { con, registry, circuit } = fabricBoard(CONSOLE_BIN);
    con.awaitBoot();
    const on1 = moduleOn(registry, circuit, 'm1', DEFAULT_PINS[1]);
    const on0 = moduleOn(registry, circuit, 'm0', DEFAULT_PINS[0]);
    expect(registry.uartPlacement('m1')).toEqual({
      rx: { boardId: 'pico', pin: 8, controller: 'UART1' },
      tx: { boardId: 'pico', pin: 9, controller: 'UART1' },
    });
    con.transmit(1, [0x48, 0x69]);
    con.transmit(0, [0x21]);
    expect(on1.heard).toEqual([0x48, 0x69]);
    expect(on0.heard).toEqual([0x21]);

    on1.handle!.transmit(0x4f);
    on1.handle!.transmit(0x4b);
    expect(con.read(1, 2)).toEqual([0x4f, 0x4b]);
    // Nothing crossed into UART0's RX: the console's data capture is empty.
    expect(con.read(0, 1)).toEqual([]);

    on1.handle!.dispose();
    con.transmit(1, [0x55]);
    expect(on1.heard).toEqual([0x48, 0x69]);
    on0.handle!.dispose();
    registry.clear();
    con.sim.stop();
  });

  it('when the sketch moves Serial2 the controller follows: the module on the new pads starts hearing, the old one stops', () => {
    const { con, registry, circuit } = fabricBoard(CONSOLE_BIN);
    con.awaitBoot();
    const old = moduleOn(registry, circuit, 'old', DEFAULT_PINS[1]);
    const moved = moduleOn(registry, circuit, 'moved', ALT_PINS[1]);
    expect(registry.uartPlacement('moved')!.rx!.controller).toBeNull();
    con.transmit(1, [0x01]);
    expect(old.heard).toEqual([0x01]);
    expect(moved.heard).toEqual([]);
    movePins(con, 1, ALT_PINS[1]);
    expect(registry.uartPlacement('moved')!.rx!.controller).toBe('UART1');
    expect(registry.uartPlacement('old')!.rx!.controller).toBeNull();
    con.transmit(1, [0x02]);
    expect(old.heard).toEqual([0x01]);
    expect(moved.heard).toEqual([0x02]);
    moved.handle!.transmit(0x33);
    expect(con.read(1, 1)).toEqual([0x33]);
    registry.clear();
    con.sim.stop();
  });

  it('Stop and Run keep the module on its controller, on the same handle, and tell it about the reset', () => {
    const { con, registry, circuit } = fabricBoard(CONSOLE_BIN);
    con.awaitBoot();
    const m = moduleOn(registry, circuit, 'm', DEFAULT_PINS[1]);
    con.transmit(1, [0x01]);
    storeReset(con.sim);
    con.awaitBoot();
    expect(m.resets).toBe(1);
    con.transmit(1, [0x02]);
    m.handle!.transmit(0x44);
    expect(con.read(1, 1)).toEqual([0x44]);
    expect(m.heard).toEqual([0x01, 0x02]);
    registry.clear();
    con.sim.stop();
  });

  it('a module wired the wrong way round (RX to RX) is reported and hears nothing', () => {
    const { con, registry, circuit } = fabricBoard(CONSOLE_BIN);
    con.awaitBoot();
    const seen: BusDiagnostic[] = [];
    registry.onDiagnostic((d) => seen.push(d));
    const crossed = new Module();
    circuit.wire('crossed', { RX: 9, TX: 8 });
    registry.netlistChanged();
    crossed.handle = registry.attachUart({ owner: 'crossed', pins: UART_PINS, baud: 115200 }, crossed);
    con.transmit(1, [0x41]);
    expect(crossed.heard).toEqual([]);
    expect(seen.map((d) => d.code)).toContain('uart-wiring');
    expect(seen.map((d) => d.code)).toContain('uart-tx-contention');
    registry.clear();
    con.sim.stop();
  });

  it('a module at 9600 on a controller the sketch runs at 115200 gets garbage, and the mismatch is reported once', () => {
    const { con, registry, circuit } = fabricBoard(CONSOLE_BIN);
    con.awaitBoot();
    const seen: BusDiagnostic[] = [];
    registry.onDiagnostic((d) => seen.push(d));
    const slow = moduleOn(registry, circuit, 'slow', DEFAULT_PINS[1], 9600);
    // 0x00: nine bit times low, which a receiver twelve times slower reads as
    // a start bit and then an idle line (0xff). A byte that alternates every
    // bit can land its start-bit sample on a transition at this exact rate
    // and be dropped as a glitch, which is garbage too, but says less.
    con.transmit(1, [0x00, 0x00]);
    expect(slow.heard.length).toBeGreaterThan(0);
    expect(slow.heard).not.toEqual([0x00, 0x00]);
    expect(seen.filter((d) => d.code === 'uart-baud-mismatch')).toHaveLength(1);
    registry.clear();
    con.sim.stop();
  });

  it('rp2040-uart-lumped-and-uart0-only-rx (F0 guest): a pong module on GP8/GP9 answers PONG1 to the PING on Serial2 and never hears the debug line on Serial', () => {
    const { con, registry, circuit } = fabricBoard(CHIP_BIN);
    let out = '';
    con.sim.onSerialData = (ch, uart) => {
      if (!uart) out += ch;
    };
    let line = '';
    let lines = 0;
    const pong = new Module();
    pong.receive = (byte) => {
      pong.heard.push(byte);
      const ch = String.fromCharCode(byte);
      if (ch === '\r') return;
      if (ch !== '\n') {
        line += ch;
        return;
      }
      lines++;
      if (line === 'PING') for (const b of `PONG${lines}\n`) pong.handle!.transmit(b.charCodeAt(0));
      line = '';
    };
    circuit.wire('pong', { RX: 8, TX: 9 });
    registry.netlistChanged();
    pong.handle = registry.attachUart({ owner: 'pong', pins: UART_PINS, baud: 115200 }, pong);
    con.run(1500, () => out.includes('DONE'));
    expect(out).toContain('READY');
    expect(out).toContain('REPLY:PONG1');
    expect(out).toContain('U0RX:NONE');
    expect(pong.text()).toBe('PING\n');
    registry.clear();
    con.sim.stop();
  });
});

// ── The receive side: a FIFO 32 deep, fed as the guest reads ─────────────────

describe('RP2040 UART ports: bytes into the guest', () => {
  // 64 bytes: twice the PL011 FIFO and arduino-pico's ring, and the most the
  // console's answer buffer carries in hex (conf-uart-console.ino, text[200]).
  const BURST = Array.from({ length: 64 }, (_, i) => 0x30 + (i % 10));

  it('a 64-byte answer on UART1 reaches a sketch that is reading for it, whole, though the PL011 FIFO holds 32', () => {
    const con = boot(CONSOLE_BIN);
    const port = (con.sim.getBusBinding().uart ?? [])[1];
    // The guest reads Serial2 for up to 100 ms once the command is in; the
    // burst lands at the line's rate (5.5 ms at 115200) while it does.
    const answer = con.ask('r 1 64');
    con.run(3, () => false);
    for (const b of BURST) port.receive(b);
    expect(PicoConsole.bytes(answer())).toEqual(BURST);
    con.sim.stop();
  });

  it('a burst into a sketch that is not reading keeps what its ring holds, the first 32, as on hardware', () => {
    const con = boot(CONSOLE_BIN);
    const port = (con.sim.getBusBinding().uart ?? [])[1];
    for (const b of BURST) port.receive(b);
    // 64 character times, so the whole burst has landed before the guest reads.
    con.run(8, () => false);
    const got = con.read(1, 64);
    expect(got.length).toBeGreaterThanOrEqual(31);
    expect(got.length).toBeLessThan(64);
    expect(got.slice(0, 31)).toEqual(BURST.slice(0, 31));
    con.sim.stop();
  });

  it("the console callback hears each UART tagged with its unit: the monitor keeps unit 0, the peer boards' fan-out routes by it", () => {
    const con = boot(CONSOLE_BIN);
    const seen: Array<[string, number | undefined]> = [];
    con.sim.onSerialData = (ch, uart) => seen.push([ch, uart]);
    con.transmit(0, [0x41]);
    con.transmit(1, [0x42]);
    expect(seen).toEqual([
      ['A', 0],
      ['B', 1],
    ]);
    con.sim.stop();
  });

  it('a probe on UART0 hears the guest and not the bytes typed into it; UART1 hears nothing of either', () => {
    const con = boot(CONSOLE_BIN);
    const p0 = bindTxProbe(con.sim.getBusBinding(), 0);
    const p1 = bindTxProbe(con.sim.getBusBinding(), 1);
    con.transmit(0, [0x41]);
    expect(con.read(0, 4)).toEqual([]);
    expect(p0.probe.heard).toEqual([0x41]);
    expect(p1.probe.heard).toEqual([]);
    p0.release();
    p1.release();
    con.sim.stop();
  });
});
