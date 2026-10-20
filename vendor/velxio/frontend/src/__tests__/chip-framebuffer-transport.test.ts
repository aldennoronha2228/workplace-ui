// @vitest-environment node
/**
 * A worker-hosted custom chip's framebuffer reaching its element (issue #338).
 *
 * The QEMU ESP32 path runs the chip's WASM in the backend worker, so the pixels
 * have to cross the WebSocket: the worker emits `chip_framebuffer` with the RGBA
 * rows the chip touched, zlib-deflated. This covers the browser end of that:
 * the bridge routes the event by component id, the rows inflate with the
 * platform's DecompressionStream (no library), and a partial frame lands on the
 * right rows of the full image without trusting the frame's claims.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Esp32Bridge, type ChipFramebufferFrame } from '../simulation/Esp32Bridge';
import { b64ToBytes, inflateZlib, spliceFramebufferRows } from '../simulation/customChips/inflateZlib';

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.onopen?.();
  }
  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe('chip_framebuffer over the ESP32 bridge', () => {
  let bridge: Esp32Bridge;
  let ws: MockWebSocket;

  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    bridge = new Esp32Bridge('fb-esp32', 'esp32');
    bridge.connect();
    ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws.open();
  });

  afterEach(() => {
    bridge.disconnect();
    vi.unstubAllGlobals();
  });

  it('routes the frame to the handler with the worker fields renamed', () => {
    const seen: Array<[string, ChipFramebufferFrame]> = [];
    bridge.onChipFramebuffer = (id, frame) => seen.push([id, frame]);
    ws.receive({
      type: 'chip_framebuffer',
      data: { component_id: 'chip-7', width: 480, height: 320, y0: 12, y1: 40, rows_zlib_b64: 'eJw=' },
    });
    expect(seen).toEqual([
      ['chip-7', { width: 480, height: 320, y0: 12, y1: 40, rowsZlibB64: 'eJw=' }],
    ]);
  });

  it('drops a frame that carries no component id (an older worker)', () => {
    const handler = vi.fn();
    bridge.onChipFramebuffer = handler;
    ws.receive({ type: 'chip_framebuffer', data: { width: 8, height: 8, y0: 0, y1: 7, rows_zlib_b64: 'eJw=' } });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('inflating and placing the rows', () => {
  it('inflates what Python zlib.compress produced', async () => {
    const rows = new Uint8Array(4 * 4 * 4).map((_, i) => i & 0xff);
    const packed = deflateSync(rows); // zlib framing, the same bytes zlib.compress emits
    const out = await inflateZlib(b64ToBytes(Buffer.from(packed).toString('base64')));
    expect(Array.from(out)).toEqual(Array.from(rows));
  });

  it('lands a partial frame on its rows and leaves the rest untouched', () => {
    const width = 4;
    const image = new Uint8Array(width * 3 * 4).fill(7);
    const rows = new Uint8Array(width * 4).fill(200); // one row: y0 = y1 = 1
    spliceFramebufferRows(image, width, 1, 1, rows);
    expect(image.subarray(0, 16).every((v) => v === 7)).toBe(true);
    expect(image.subarray(16, 32).every((v) => v === 200)).toBe(true);
    expect(image.subarray(32).every((v) => v === 7)).toBe(true);
  });

  it('never writes past the image whatever the frame claims', () => {
    const width = 4;
    const image = new Uint8Array(width * 2 * 4);
    const rows = new Uint8Array(width * 4 * 10).fill(9); // ten rows for a two-row image
    expect(() => spliceFramebufferRows(image, width, 1, 10, rows)).not.toThrow();
    expect(image.subarray(0, 16).every((v) => v === 0)).toBe(true);
    expect(image.subarray(16).every((v) => v === 9)).toBe(true);
  });
});
