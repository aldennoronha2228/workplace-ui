// @vitest-environment jsdom
/**
 * RaspberryPi3Bridge, the header UART half (project board-buses-2026-09, F6).
 *
 * The bytes the Linux guest writes to /dev/serial0 arrive as `uart_tx` and
 * reach two slots: raw, for the board's UART port on the bus fabric
 * (`onUartTxBytes`, which PiBridgeShim owns), and decoded, for the
 * cross-board fan-out (`onUartTx`, the Interconnect's). What a part answers
 * leaves as `pi_uart_rx`. The shim suites replace this class with a double
 * that fires both slots, so this is the one place the real class is held to
 * it: a fingerprint reader's frames are bytes above 0x7f, and the text slot
 * alone turned them into U+FFFD before any part saw them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

class ScriptedSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last: ScriptedSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  sent: Array<{ type: string; data?: Record<string, unknown> }> = [];
  constructor(_url: string) {
    ScriptedSocket.last = this;
  }
  send(frame: string): void {
    this.sent.push(JSON.parse(frame));
  }
  close(): void {
    this.readyState = ScriptedSocket.CLOSED;
  }
  open(): void {
    this.readyState = ScriptedSocket.OPEN;
    this.onopen?.();
  }
  /** A frame from the backend. */
  push(type: string, data: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
}
vi.stubGlobal('WebSocket', ScriptedSocket);

import { RaspberryPi3Bridge } from '../simulation/RaspberryPi3Bridge';

const b64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes));

function connected(): { bridge: RaspberryPi3Bridge; ws: ScriptedSocket } {
  const bridge = new RaspberryPi3Bridge('pi-1', 'raspberry-pi-4');
  bridge.connect();
  const ws = ScriptedSocket.last!;
  ws.open();
  return { bridge, ws };
}

afterEach(() => {
  ScriptedSocket.last = null;
});

describe('RaspberryPi3Bridge: the header UART', () => {
  it('uart_tx hands the raw bytes to the port slot and the decoded text to the fan-out slot', () => {
    const { bridge, ws } = connected();
    const calls: Array<[string, number[] | string]> = [];
    bridge.onUartTxBytes = (bytes) => calls.push(['bytes', Array.from(bytes)]);
    bridge.onUartTx = (text) => calls.push(['text', text]);
    // "AT\r" and then a fingerprint reader's frame head: bytes above 0x7f.
    ws.push('uart_tx', { data: b64([0x41, 0x54, 0x0d, 0xef, 0x01, 0xff]) });
    expect(calls[0]).toEqual(['bytes', [0x41, 0x54, 0x0d, 0xef, 0x01, 0xff]]);
    expect(calls[1][0]).toBe('text');
    expect(calls[1][1]).toMatch(/^AT\r/);
    // What the text slot made of 0xef 0x01 0xff: replacement characters,
    // which is why a part cannot be fed from it.
    expect(calls[1][1]).toContain('�');
    expect(calls.length).toBe(2);
  });

  it('either slot alone is served, and the raw one comes first', () => {
    const { bridge, ws } = connected();
    const raw: number[][] = [];
    bridge.onUartTxBytes = (bytes) => raw.push(Array.from(bytes));
    ws.push('uart_tx', { data: b64([0x4f, 0x4b]) });
    expect(raw).toEqual([[0x4f, 0x4b]]);
    bridge.onUartTxBytes = null;
    const text: string[] = [];
    bridge.onUartTx = (t) => text.push(t);
    ws.push('uart_tx', { data: b64([0x4f, 0x4b, 0x0a]) });
    expect(text).toEqual(['OK\n']);
    expect(raw).toEqual([[0x4f, 0x4b]]);
  });

  it('a malformed payload is dropped, never thrown, and an empty one fires nothing', () => {
    const { bridge, ws } = connected();
    const raw: number[][] = [];
    const text: string[] = [];
    bridge.onUartTxBytes = (bytes) => raw.push(Array.from(bytes));
    bridge.onUartTx = (t) => text.push(t);
    expect(() => ws.push('uart_tx', { data: '%%not base64%%' })).not.toThrow();
    ws.push('uart_tx', { data: '' });
    ws.push('uart_tx', {});
    expect(raw).toEqual([]);
    expect(text).toEqual([]);
  });

  it('what a part answers leaves as pi_uart_rx with the bytes, and an empty answer sends nothing', () => {
    const { bridge, ws } = connected();
    const before = ws.sent.length;
    bridge.sendUartBytes([0x4f, 0x4b, 0x0d, 0x0a]);
    bridge.sendUartBytes([]);
    expect(ws.sent.slice(before)).toEqual([{ type: 'pi_uart_rx', data: { bytes: [0x4f, 0x4b, 0x0d, 0x0a] } }]);
  });
});
