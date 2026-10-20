/**
 * The UART frame at bit level, with no clock of its own: what a byte looks
 * like on the wire, and how a receiver reads one back from edges timed in
 * any unit (guest cycles for the software decoder, microseconds for the
 * baud-mismatch resampler). One decoder for both, so the corruption a wrong
 * baud produces here is the same corruption the bit-banged path produces,
 * and both are the receiver's real behaviour: sample the start bit at its
 * middle, every following bit one bit time later, and give up on a start bit
 * that is gone by the time it is sampled.
 */

export type UartParity = 'N' | 'E' | 'O';

export interface UartFrameSpec {
  dataBits: number;
  parity: UartParity;
  stopBits: number;
}

export const DEFAULT_UART_FRAME: UartFrameSpec = { dataBits: 8, parity: 'N', stopBits: 1 };

/** '8N1', '7E1', '8N2' (Arduino's SERIAL_xxx names without the prefix). Anything else is 8N1. */
export function parseUartFrame(frame: string | undefined): UartFrameSpec {
  if (!frame) return DEFAULT_UART_FRAME;
  const m = /^([5-9])([NEO])([12])$/i.exec(frame.trim());
  if (!m) return DEFAULT_UART_FRAME;
  return { dataBits: Number(m[1]), parity: m[2].toUpperCase() as UartParity, stopBits: Number(m[3]) };
}

export function frameName(spec: UartFrameSpec): string {
  return `${spec.dataBits}${spec.parity}${spec.stopBits}`;
}

export function sameFrame(a: UartFrameSpec, b: UartFrameSpec): boolean {
  return a.dataBits === b.dataBits && a.parity === b.parity && a.stopBits === b.stopBits;
}

/** Bit slots a frame occupies: start, data, parity if any, stop. */
export function frameBitCount(spec: UartFrameSpec): number {
  return 1 + spec.dataBits + (spec.parity === 'N' ? 0 : 1) + spec.stopBits;
}

/**
 * Real receivers tolerate a few percent of rate error (the AVR's 9615 for a
 * requested 9600, a crystal's drift). Above that the sampling point walks out
 * of the bit by the end of the frame, which is the mismatch this reports.
 */
export function baudsMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.03 * Math.max(a, b);
}

/** True for a usable rate: finite and positive. */
export function validBaud(baud: number | undefined): baud is number {
  return typeof baud === 'number' && Number.isFinite(baud) && baud > 0;
}

function parityBit(byte: number, spec: UartFrameSpec): boolean {
  let ones = 0;
  for (let i = 0; i < spec.dataBits; i++) ones += (byte >> i) & 1;
  return spec.parity === 'E' ? ones % 2 === 1 : ones % 2 === 0;
}

/** The level of every bit slot of a frame, start bit first, LSB first. */
export function frameBits(byte: number, spec: UartFrameSpec): boolean[] {
  const bits: boolean[] = [false];
  for (let i = 0; i < spec.dataBits; i++) bits.push(((byte >> i) & 1) === 1);
  if (spec.parity !== 'N') bits.push(parityBit(byte, spec));
  for (let i = 0; i < spec.stopBits; i++) bits.push(true);
  return bits;
}

export interface FrameTransition {
  /** Bit slot the level takes effect at (0 = the start bit's falling edge). */
  slot: number;
  level: boolean;
}

/** The frame as the edges a wire shows, from the idle (high) line: only changes of level. */
export function frameTransitions(byte: number, spec: UartFrameSpec): FrameTransition[] {
  const out: FrameTransition[] = [];
  let level = true;
  frameBits(byte, spec).forEach((bit, slot) => {
    if (bit === level) return;
    level = bit;
    out.push({ slot, level });
  });
  return out;
}

export interface UartFrameErrors {
  /** The stop bit sampled low: the sender's rate or frame is not this one. */
  framing: boolean;
  /** The parity bit did not match the data. */
  parity: boolean;
}

export type UartByteSink = (byte: number, errors: UartFrameErrors) => void;

interface Edge {
  t: number;
  level: boolean;
}

/**
 * A receiver fed with edges: (time, level) pairs in any time unit, with the
 * bit time in that unit. A frame opens on a falling edge from the idle line
 * and is sampled at the middle of every bit slot once the clock reaches the
 * middle of its stop bit (`deadline`): the caller arranges to call
 * finalize() then, or feeds the next edge, which finalizes a frame it comes
 * after. After a frame, the next falling edge opens the next one: if the line
 * is still low at the stop bit (a framing error), the receiver waits for it
 * to rise and fall again, as silicon does.
 */
export class UartBitDecoder {
  /** Time at which the open frame must be finalized, or null with none open. */
  deadline: number | null = null;
  private open = false;
  private t0 = 0;
  private edges: Edge[] = [];
  private lastLevel: boolean;
  private readonly spec: UartFrameSpec;
  /** The bit time of the open frame, fixed when it opened. */
  private bitTime: number;
  /** The bit time the next frame opens with (retime() moves it). */
  private nextBitTime: number;
  private readonly sink: UartByteSink;

  constructor(spec: UartFrameSpec, bitTime: number, sink: UartByteSink, initialLevel = true) {
    this.spec = spec;
    this.bitTime = bitTime;
    this.nextBitTime = bitTime;
    this.sink = sink;
    this.lastLevel = initialLevel;
  }

  /**
   * The bit time for the frames that open from now on. A guest clock is not a
   * constant: the ESP32 engines boot at the ROM rate and the app raises it,
   * and a board between runs has no clock at all, so a receiver built then
   * would keep a bit time that is wrong by the ratio. The frame in progress
   * keeps the one it opened with.
   */
  retime(bitTime: number): void {
    this.nextBitTime = bitTime;
  }

  /** The line changed (or was seen) at `t`. A level equal to the last one is nothing. */
  edge(t: number, level: boolean): void {
    if (this.open && this.deadline !== null && t >= this.deadline) this.finalize();
    if (level === this.lastLevel) return;
    this.lastLevel = level;
    if (!this.open) {
      if (!level) this.start(t);
      return;
    }
    this.edges.push({ t, level });
  }

  /** Forget any open frame. `level` is the line now. */
  reset(level = true): void {
    this.open = false;
    this.deadline = null;
    this.edges = [];
    this.lastLevel = level;
  }

  private start(t: number): void {
    this.open = true;
    this.bitTime = this.nextBitTime;
    this.t0 = t;
    this.edges = [];
    const slots = 1 + this.spec.dataBits + (this.spec.parity === 'N' ? 0 : 1);
    // The middle of the (first) stop bit: the last sample the frame needs.
    this.deadline = t + (slots + 0.5) * this.bitTime;
  }

  /** Sample the recorded frame; hands the byte to the sink (a false start hands nothing). */
  finalize(): void {
    if (!this.open) return;
    this.open = false;
    this.deadline = null;
    const edges = this.edges;
    this.edges = [];
    let i = 0;
    let level = false;
    const sampleAt = (t: number): boolean => {
      while (i < edges.length && edges[i].t <= t) level = edges[i++].level;
      return level;
    };
    const bit = this.bitTime;
    // A start bit that is gone by its middle was a glitch, not a frame.
    if (sampleAt(this.t0 + 0.5 * bit)) return;
    let byte = 0;
    for (let k = 0; k < this.spec.dataBits; k++) {
      if (sampleAt(this.t0 + (1.5 + k) * bit)) byte |= 1 << k;
    }
    let slot = 1 + this.spec.dataBits;
    let parity = false;
    if (this.spec.parity !== 'N') {
      parity = sampleAt(this.t0 + (slot + 0.5) * bit) !== parityBit(byte, this.spec);
      slot++;
    }
    const framing = !sampleAt(this.t0 + (slot + 0.5) * bit);
    this.sink(byte, { framing, parity });
  }
}

/**
 * What a receiver clocked at `rxBaud` with frame `rxSpec` reads from one
 * frame sent at `txBaud` with `txSpec`: the same byte when the rates agree,
 * and otherwise the garbage silicon reads (fewer, more or different bytes).
 * A byte with a parity error is dropped, as Arduino's HardwareSerial drops
 * it; one with only a framing error is delivered, as the AVR delivers it.
 */
export function resampleUartFrame(
  byte: number,
  txSpec: UartFrameSpec,
  txBaud: number,
  rxSpec: UartFrameSpec,
  rxBaud: number,
): number[] {
  if (baudsMatch(txBaud, rxBaud) && sameFrame(txSpec, rxSpec)) return [byte & 0xff];
  const txBit = 1e6 / txBaud;
  const out: number[] = [];
  const dec = new UartBitDecoder(rxSpec, 1e6 / rxBaud, (b, e) => {
    if (!e.parity) out.push(b);
  });
  for (const tr of frameTransitions(byte & 0xff, txSpec)) dec.edge(tr.slot * txBit, tr.level);
  // The line idles high after the stop bit, for as long as the receiver needs.
  dec.edge(frameBitCount(txSpec) * txBit, true);
  if (dec.deadline !== null) dec.finalize();
  return out;
}
