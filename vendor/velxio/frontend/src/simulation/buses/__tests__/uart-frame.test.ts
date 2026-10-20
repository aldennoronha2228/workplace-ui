/**
 * Layer 1 of project board-buses-2026-09 (TESTS.md), F6: the UART frame codec
 * on its own. No clock, no board: edges in any time unit, bytes out. The
 * software decoder and the baud-mismatch resampler are both built on it, so
 * what is proved here is the corruption both of them produce.
 */
import { describe, it, expect } from 'vitest';
import {
  baudsMatch,
  DEFAULT_UART_FRAME,
  frameBitCount,
  frameBits,
  frameName,
  frameTransitions,
  parseUartFrame,
  resampleUartFrame,
  UartBitDecoder,
  type UartFrameErrors,
  type UartFrameSpec,
} from '../uartFrame';

const F8N1 = DEFAULT_UART_FRAME;
const F7E1: UartFrameSpec = { dataBits: 7, parity: 'E', stopBits: 1 };
const F8N2: UartFrameSpec = { dataBits: 8, parity: 'N', stopBits: 2 };

/** Feed one frame's edges at `bit` per slot from `t0`, then idle, and finalize. */
function decodeOne(byte: number, txSpec: UartFrameSpec, txBit: number, rxSpec: UartFrameSpec, rxBit: number) {
  const out: Array<{ byte: number; errors: UartFrameErrors }> = [];
  const dec = new UartBitDecoder(rxSpec, rxBit, (b, errors) => out.push({ byte: b, errors }));
  for (const tr of frameTransitions(byte, txSpec)) dec.edge(tr.slot * txBit, tr.level);
  dec.edge(frameBitCount(txSpec) * txBit, true);
  if (dec.deadline !== null) dec.finalize();
  return out;
}

describe('UART frame: the spec', () => {
  it('parses Arduino frame names and falls back to 8N1', () => {
    expect(parseUartFrame('8N1')).toEqual(F8N1);
    expect(parseUartFrame('7e1')).toEqual(F7E1);
    expect(parseUartFrame('8N2')).toEqual(F8N2);
    expect(parseUartFrame(undefined)).toEqual(F8N1);
    expect(parseUartFrame('SERIAL_8N1')).toEqual(F8N1);
    expect(parseUartFrame('9X3')).toEqual(F8N1);
    expect(frameName(F7E1)).toBe('7E1');
  });

  it('lays a frame out start bit first, data LSB first, parity, stop bits', () => {
    expect(frameBits(0x41, F8N1)).toEqual([false, true, false, false, false, false, false, true, false, true]);
    expect(frameBitCount(F8N1)).toBe(10);
    expect(frameBitCount(F7E1)).toBe(10);
    expect(frameBitCount(F8N2)).toBe(11);
    // 0x41 has two ones: even parity bit is 0; 0x43 has three: 1.
    expect(frameBits(0x41, F7E1)[8]).toBe(false);
    expect(frameBits(0x43, F7E1)[8]).toBe(true);
    expect(frameBits(0x41, { ...F7E1, parity: 'O' })[8]).toBe(true);
  });

  it('transitions are only the level changes, from the idle line', () => {
    expect(frameTransitions(0xff, F8N1)).toEqual([
      { slot: 0, level: false },
      { slot: 1, level: true },
    ]);
    expect(frameTransitions(0x00, F8N1)).toEqual([
      { slot: 0, level: false },
      { slot: 9, level: true },
    ]);
    expect(frameTransitions(0x55, F8N1).map((t) => t.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('rates within a receiver tolerance match, others do not', () => {
    expect(baudsMatch(9600, 9615)).toBe(true);
    expect(baudsMatch(115200, 115942)).toBe(true);
    expect(baudsMatch(9600, 19200)).toBe(false);
    expect(baudsMatch(115200, 74880)).toBe(false);
    expect(baudsMatch(9600, 10000)).toBe(false);
  });
});

describe('UART frame: the receiver', () => {
  it('reads every byte back from its own exact edges, in every frame', () => {
    for (const spec of [F8N1, F7E1, F8N2]) {
      const max = spec.dataBits === 7 ? 0x7f : 0xff;
      for (let b = 0; b <= max; b++) {
        const out = decodeOne(b, spec, 100, spec, 100);
        expect(out, `${frameName(spec)} ${b}`).toEqual([{ byte: b, errors: { framing: false, parity: false } }]);
      }
    }
  });

  it('the deadline is the middle of the stop bit, and finalize before it is what a caller must not do', () => {
    const out: number[] = [];
    const dec = new UartBitDecoder(F8N1, 100, (b) => out.push(b));
    dec.edge(1000, false);
    expect(dec.deadline).toBe(1000 + 950);
    dec.edge(1100, true);
    // Nothing until the stop bit is sampled.
    expect(out).toEqual([]);
    dec.finalize();
    expect(out).toEqual([0xff]);
    expect(dec.deadline).toBeNull();
  });

  it('an edge after the deadline finalizes the open frame first, then opens the next', () => {
    const out: number[] = [];
    const dec = new UartBitDecoder(F8N1, 100, (b) => out.push(b));
    // 0x0f: start, 1111 0000, stop -> edges: 0 low, 1 high, 5 low, 9 high.
    dec.edge(0, false);
    dec.edge(100, true);
    dec.edge(500, false);
    dec.edge(900, true);
    // Next byte's start bit, with no finalize call in between.
    dec.edge(1000, false);
    expect(out).toEqual([0x0f]);
    dec.edge(1100, true);
    dec.finalize();
    expect(out).toEqual([0x0f, 0xff]);
  });

  it('a start bit gone by its middle is a glitch: no byte', () => {
    const out: number[] = [];
    const dec = new UartBitDecoder(F8N1, 100, (b) => out.push(b));
    dec.edge(0, false);
    dec.edge(20, true);
    dec.finalize();
    expect(out).toEqual([]);
    // And the decoder is idle again: a real frame after it decodes.
    dec.edge(500, false);
    dec.edge(1400, true);
    dec.finalize();
    expect(out).toEqual([0x00]);
  });

  it('a stop bit sampled low is a framing error, still delivered; a wrong parity bit is flagged', () => {
    const out: Array<{ byte: number; errors: UartFrameErrors }> = [];
    const dec = new UartBitDecoder(F7E1, 100, (b, errors) => out.push({ byte: b, errors }));
    // 0x41 in 7E1: start, 1000001, parity 0, stop. Send parity 1 and a low stop.
    dec.edge(0, false);
    dec.edge(100, true);
    dec.edge(200, false);
    dec.edge(700, true);
    dec.edge(800, true); // parity slot: sender puts 1 (wrong)
    dec.edge(900, false); // stop slot low
    dec.edge(1000, true);
    dec.finalize();
    expect(out).toEqual([{ byte: 0x41, errors: { framing: true, parity: true } }]);
  });

  it('samples at bit middles, so edges jittered by a fifth of a bit each still read right', () => {
    // Two edges a fifth of a bit off in opposite directions move a sample by
    // two fifths: still inside the bit. A third each would not be, and a real
    // receiver reads that wrong too.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (let b = 0; b < 256; b++) {
      const out: number[] = [];
      const dec = new UartBitDecoder(F8N1, 300, (v) => out.push(v));
      for (const tr of frameTransitions(b, F8N1)) dec.edge(tr.slot * 300 + rnd() * 60, tr.level);
      dec.edge(3300, true);
      dec.finalize();
      expect(out, `byte ${b}`).toEqual([b]);
    }
  });

  it('a level equal to the last one is not an edge', () => {
    const out: number[] = [];
    const dec = new UartBitDecoder(F8N1, 100, (b) => out.push(b));
    dec.edge(0, true);
    dec.edge(10, true);
    expect(dec.deadline).toBeNull();
    dec.edge(20, false);
    dec.edge(30, false);
    expect(dec.deadline).toBe(20 + 950);
  });
});

describe('UART frame: what a receiver at another rate reads', () => {
  it('the same rate and frame is the byte itself, within the tolerance silicon has', () => {
    for (let b = 0; b < 256; b++) {
      expect(resampleUartFrame(b, F8N1, 9600, F8N1, 9600)).toEqual([b]);
      expect(resampleUartFrame(b, F8N1, 9600, F8N1, 9615)).toEqual([b]);
    }
  });

  it('a 9600 frame read at 115200 is garbage: not the byte, and deterministic', () => {
    const got = resampleUartFrame(0x55, F8N1, 9600, F8N1, 115200);
    expect(got).not.toEqual([0x55]);
    expect(got).toEqual(resampleUartFrame(0x55, F8N1, 9600, F8N1, 115200));
    // The start bit alone spans twelve of the receiver's bits: it reads a 0x00
    // with a framing error first, and then whatever the other level runs give.
    expect(got[0]).toBe(0x00);
  });

  it('a 115200 frame read at 9600 is at most one byte of garbage, never the byte', () => {
    for (const b of [0x55, 0x41, 0x0d, 0xa5]) {
      const got = resampleUartFrame(b, F8N1, 115200, F8N1, 9600);
      expect(got.length).toBeLessThanOrEqual(1);
      expect(got).not.toEqual([b]);
    }
  });

  it('the same rate with another frame is read through that frame', () => {
    // 0x41 sent 8N1 read as 7E1: data bits 1..7 of the 8N1 frame, parity slot
    // is the 8N1 MSB (0), and the stop bit lands on the 8N1 stop: parity ok.
    expect(resampleUartFrame(0x41, F8N1, 9600, F7E1, 9600)).toEqual([0x41]);
    // 0xc3 sent 8N1 read as 7E1: 1100001 has three ones, parity must be 1,
    // the slot carries the 8N1 MSB (1): passes. 0x43 has three ones and its
    // MSB is 0: parity error, dropped as HardwareSerial drops it.
    expect(resampleUartFrame(0xc3, F8N1, 9600, F7E1, 9600)).toEqual([0x43]);
    expect(resampleUartFrame(0x43, F8N1, 9600, F7E1, 9600)).toEqual([]);
  });

  it('a wrong rate loses most of a message, as a terminal at the wrong speed does', () => {
    const text = Array.from('AT+CGMI\r\n', (c) => c.charCodeAt(0));
    const heard = text.flatMap((b) => resampleUartFrame(b, F8N1, 9600, F8N1, 38400));
    const intact = heard.filter((b) => text.includes(b)).length;
    expect(intact).toBeLessThan(text.length / 2);
  });
});
