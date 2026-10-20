/**
 * Board buses F6, second part: UART between boards goes through the fabric.
 *
 * Two boards of the real store, an Arduino Mega (avr8js) and a Raspberry Pi
 * Pico (rp2040js), each running the UART console of the conformance suite
 * (fixtures/conf-uart-console: commands in through the console UART behind
 * ESC, answers read out of SRAM). The Mega's Serial1 (18 TX / 19 RX) is
 * wired to the Pico's Serial2 (GP9 RX / GP8 TX) the way two boards are on a
 * bench: one wire per direction. The registry links the two boards' nets
 * from the store's own resolver (createStoreNetResolver's resolveAll, from a
 * board pad along the pad-to-pad wires), so the Mega's USART1 and the Pico's
 * UART1 are the two ends of one wire: what one transmits the other reads,
 * once; a rate the two sides disagree on is the garbage silicon reads plus a
 * diagnostic; and a TX wired to a TX is the contention it is on one board.
 *
 * The Interconnect's byte fan-out is still installed for these wires and
 * stays out per byte (busRegistry.servesUartWire); the rows on rates and on
 * contention are what it never gave, so they fail if the link leaves the
 * fabric and the fan-out carries the wire again.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
let nextFrame = 1;
vi.stubGlobal('requestAnimationFrame', () => nextFrame++);
vi.stubGlobal('cancelAnimationFrame', () => {});

import { useSimulatorStore, getBoardSimulator } from '../../store/useSimulatorStore';
import type { AVRSimulator } from '../../simulation/AVRSimulator';
import type { RP2040Simulator } from '../../simulation/RP2040Simulator';
import { busRegistry } from '../../simulation/buses';
import type { BusDiagnostic } from '../../simulation/buses/types';

const here = (rel: string) => fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url));
const MEGA_HEX = readFileSync(here('conf-uart-console/mega/conf-uart-console.ino.hex'), 'utf-8');
const PICO_BIN = readFileSync(here('conf-uart-console/pico/conf-uart-console.ino.bin')).toString('base64');

const hex2 = (b: number) => b.toString(16).padStart(2, '0');
const ESC = '\x1b';

/** The guest's answer buffer (conf-uart-console.ino): magic, seq, ready, len, text. */
const MAGIC = [0x56, 0x58, 0x41, 0x4e]; // "VXAN"
const SEQ = 4;
const READY = 5;
const LEN = 6;
const TEXT = 7;

function findMagic(data: Uint8Array, from: number): number {
  for (let i = from; i + TEXT < data.length; i++) {
    if (data[i] === MAGIC[0] && data[i + 1] === MAGIC[1] && data[i + 2] === MAGIC[2] && data[i + 3] === MAGIC[3]) {
      return i;
    }
  }
  return -1;
}

const bytesOf = (text: string): number[] =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((h) => parseInt(h, 16));

/** The Mega's console: commands into USART0, the CPU stepped instruction by instruction. */
class MegaConsole {
  readonly id: string;
  private answerAt = -1;
  constructor(id: string) {
    this.id = id;
    const st = useSimulatorStore.getState();
    this.sim.onSerialData = () => {};
    // A scope listening: the engine draws every byte's frame on the TX pad
    // through this channel, as it does in the app with the scope open.
    this.sim.onPinChangeWithTime = () => {};
    st.compileBoardProgram(id, MEGA_HEX);
    st.startBoard(id);
  }
  get sim(): AVRSimulator {
    return getBoardSimulator(this.id) as unknown as AVRSimulator;
  }
  private get data(): Uint8Array {
    return (this.sim as unknown as { cpu: { data: Uint8Array } }).cpu.data;
  }
  private step(budget: number, done: () => boolean, every = 0x3f): void {
    const sim = this.sim;
    for (let i = 0; i < budget; i++) {
      sim.step();
      if ((i & every) === 0 && done()) return;
    }
  }
  awaitBoot(): void {
    const ready = () => {
      const data = this.data;
      if (this.answerAt < 0 || !MAGIC.every((b, i) => data[this.answerAt + i] === b)) {
        this.answerAt = findMagic(data, 0x100);
      }
      return this.answerAt >= 0 && data[this.answerAt + READY] === 1;
    };
    this.step(3_000_000, ready, 0x3ff);
    if (!ready()) throw new Error('the Mega never reached the end of setup()');
  }
  cmd(line: string): string {
    this.awaitBoot();
    const data = this.data;
    const before = data[this.answerAt + SEQ];
    this.sim.serialWrite(`${ESC}${line}\n`);
    // A read waits up to 100 ms of guest time (1.6 M cycles) for its bytes.
    this.step(4_000_000, () => data[this.answerAt + SEQ] !== before);
    if (data[this.answerAt + SEQ] === before) throw new Error(`the Mega did not answer "${line}"`);
    const len = data[this.answerAt + LEN];
    let text = '';
    for (let i = 0; i < len; i++) text += String.fromCharCode(data[this.answerAt + TEXT + i]);
    return text;
  }
  transmit(unit: number, bytes: number[]): void {
    expect(this.cmd(`t ${unit} ${bytes.map(hex2).join(' ')}`)).toBe('OK');
  }
  read(unit: number, n: number): number[] {
    return bytesOf(this.cmd(`r ${unit} ${n}`));
  }
}

/** The Pico's console: commands into UART0, time in 1 ms frames of the production frame body. */
class PicoConsole {
  readonly id: string;
  private answerAt = -1;
  constructor(id: string) {
    this.id = id;
    this.sim.onSerialData = () => {};
    useSimulatorStore.getState().compileBoardProgram(id, PICO_BIN);
  }
  get sim(): RP2040Simulator {
    return getBoardSimulator(this.id) as unknown as RP2040Simulator;
  }
  private get sram(): Uint8Array {
    const mcu = this.sim.getMCU();
    if (!mcu) throw new Error('no SoC');
    return mcu.sram;
  }
  run(maxMs: number, done: () => boolean): boolean {
    for (let t = 0; t < maxMs; t++) {
      if (done()) return true;
      this.sim.runFrameForTime(1);
    }
    return done();
  }
  awaitBoot(): void {
    const ready = () => {
      const data = this.sram;
      if (this.answerAt < 0 || !MAGIC.every((b, i) => data[this.answerAt + i] === b)) {
        this.answerAt = findMagic(data, 0);
      }
      return this.answerAt >= 0 && data[this.answerAt + READY] === 1;
    };
    if (!this.run(3000, ready)) throw new Error('the Pico never reached the end of setup()');
  }
  cmd(line: string): string {
    this.awaitBoot();
    const data = this.sram;
    const before = data[this.answerAt + SEQ];
    this.sim.serialWrite(`${ESC}${line}\n`);
    if (!this.run(800, () => data[this.answerAt + SEQ] !== before)) throw new Error(`the Pico did not answer "${line}"`);
    const len = data[this.answerAt + LEN];
    let text = '';
    for (let i = 0; i < len; i++) text += String.fromCharCode(data[this.answerAt + TEXT + i]);
    return text;
  }
  transmit(unit: number, bytes: number[]): void {
    expect(this.cmd(`t ${unit} ${bytes.map(hex2).join(' ')}`)).toBe('OK');
  }
  read(unit: number, n: number): number[] {
    return bytesOf(this.cmd(`r ${unit} ${n}`));
  }
}

let seq = 0;
const live: Array<() => void> = [];
afterEach(() => {
  for (const f of live.splice(0)) f();
  busRegistry.resetDiagnostics();
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});

/** The store recomputes the fabric's membership a microtask after a wire changes. */
const settle = (): Promise<void> => new Promise<void>((r) => queueMicrotask(r));

/** Both boards, Serial1 of the Mega wired to Serial2 of the Pico, one wire per direction. */
async function bench() {
  const st = useSimulatorStore.getState();
  const mega = `mega-xu${++seq}`;
  const pico = `pico-xu${seq}`;
  st.addBoard('arduino-mega', 0, 0, mega);
  st.addBoard('raspberry-pi-pico', 0, 300, pico);
  const diags: BusDiagnostic[] = [];
  const off = busRegistry.onDiagnostic((d) => diags.push(d));
  const wire = (id: string, a: [string, string], b: [string, string]) =>
    useSimulatorStore.getState().addWire({
      id,
      start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
      end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
      waypoints: [],
      color: '#0a0',
    } as never);
  wire(`${mega}-tx`, [mega, '18'], [pico, 'GP9']);
  wire(`${pico}-tx`, [pico, 'GP8'], [mega, '19']);
  live.push(() => {
    off();
    const s = useSimulatorStore.getState();
    s.removeBoard(mega);
    s.removeBoard(pico);
  });
  await settle();
  const unwire = async (id: string): Promise<void> => {
    useSimulatorStore.getState().removeWire(id);
    await settle();
  };
  const rewire = async (id: string, a: [string, string], b: [string, string]): Promise<void> => {
    wire(id, a, b);
    await settle();
  };
  const name = (id: string) => (id === mega ? 'mega' : id === pico ? 'pico' : id);
  const peers = (boardId: string, pin: number) =>
    busRegistry.uartPeers(boardId, pin).map((p) => `${name(p.boardId)}:${p.pin}`);
  const codes = (code: BusDiagnostic['code']) => diags.filter((d) => d.code === code);
  return { mega, pico, diags, codes, peers, unwire, rewire };
}

describe('UART between boards through the fabric: the Mega\'s Serial1 wired to the Pico\'s Serial2', () => {
  it('the wire between the headers is one net: each UART1 pin has the other board\'s as its peer', async () => {
    const b = await bench();
    expect(b.peers(b.mega, 18)).toEqual(['pico:9']);
    expect(b.peers(b.pico, 8)).toEqual(['mega:19']);
    expect(b.peers(b.mega, 0), 'the console UART is on no wire').toEqual([]);
    // No pad of the Pico is a UART's until its sketch says so: the fabric
    // has nothing listening on GP9 yet, and the Interconnect's fan-out would
    // still carry the wire.
    expect(busRegistry.servesUartWire(b.mega, 18, b.pico, 9)).toBe(false);
    const pico = new PicoConsole(b.pico);
    pico.awaitBoot();
    expect(busRegistry.servesUartWire(b.mega, 18, b.pico, 9)).toBe(true);
    expect(busRegistry.servesUartWire(b.pico, 8, b.mega, 19)).toBe(true);
    expect(busRegistry.servesUartWire(b.pico, 9, b.mega, 18), 'RX to TX is not a served direction').toBe(false);
  });

  it('what the Mega writes on Serial1 the Pico reads on Serial2 once, and what the Pico answers the Mega reads once', async () => {
    const b = await bench();
    const mega = new MegaConsole(b.mega);
    const pico = new PicoConsole(b.pico);
    pico.awaitBoot();
    mega.transmit(1, [0x48, 0x69]);
    expect(pico.read(1, 4)).toEqual([0x48, 0x69]);
    pico.transmit(1, [0x4f, 0x4b]);
    expect(mega.read(1, 4)).toEqual([0x4f, 0x4b]);
    // Nothing reached the console UARTs, and nothing is left over.
    expect(pico.read(1, 4)).toEqual([]);
    expect(mega.read(1, 4)).toEqual([]);
    expect(b.diags).toEqual([]);
  });

  it('rates that disagree: the Pico at 9600 does not read the Mega\'s byte at 115200, and the fabric says why', async () => {
    const b = await bench();
    const mega = new MegaConsole(b.mega);
    const pico = new PicoConsole(b.pico);
    expect(pico.cmd('b 1 9600')).toBe('OK');
    mega.transmit(1, [0x55]);
    expect(pico.read(1, 4)).not.toEqual([0x55]);
    const m = b.codes('uart-baud-mismatch');
    expect(m).toHaveLength(1);
    expect(m[0].message).toContain('UART1');
    expect(m[0].message).toContain('USART1');
    // Back at the same rate: the byte.
    expect(pico.cmd('b 1 115200')).toBe('OK');
    mega.transmit(1, [0x55]);
    expect(pico.read(1, 4)).toEqual([0x55]);
  });

  it('a TX wired to a TX between the boards is contention the fabric reports', async () => {
    const b = await bench();
    const pico = new PicoConsole(b.pico);
    pico.awaitBoot();
    await b.unwire(`${b.mega}-tx`);
    await b.rewire(`${b.mega}-txtx`, [b.mega, '18'], [b.pico, 'GP8']);
    const c = b.codes('uart-tx-contention');
    expect(c).toHaveLength(1);
    expect(c[0].message).toContain('USART1');
    expect(c[0].message).toContain('UART1');
  });

  it('lifting the wire between the headers ends the link', async () => {
    const b = await bench();
    const mega = new MegaConsole(b.mega);
    const pico = new PicoConsole(b.pico);
    pico.awaitBoot();
    mega.transmit(1, [0x01]);
    expect(pico.read(1, 1)).toEqual([0x01]);
    await b.unwire(`${b.mega}-tx`);
    expect(b.peers(b.mega, 18)).toEqual([]);
    expect(busRegistry.servesUartWire(b.mega, 18, b.pico, 9)).toBe(false);
    mega.transmit(1, [0x02]);
    expect(pico.read(1, 1)).toEqual([]);
    // The other direction is its own wire and still there.
    pico.transmit(1, [0x03]);
    expect(mega.read(1, 1)).toEqual([0x03]);
  });
});
