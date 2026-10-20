/**
 * Inflate a zlib (RFC 1950) stream with the browser's own DecompressionStream —
 * no library, and async, which is fine for frames that arrive at most 20 times a
 * second. Python's zlib.compress produces exactly this format, so a worker-hosted
 * chip's framebuffer rows (esp32_worker `chip_framebuffer`) decode here as-is.
 */
export async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** base64 → bytes, for the WS payloads (atob is fine at this size and rate). */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Copy rows y0..y1 (inclusive) of an RGBA image into `dst`, ignoring anything the
 * frame claims beyond the buffer — a frame is data from a worker, not a promise.
 */
export function spliceFramebufferRows(
  dst: Uint8Array,
  width: number,
  y0: number,
  y1: number,
  rows: Uint8Array,
): void {
  const stride = width * 4;
  const start = Math.max(0, y0) * stride;
  const wanted = (Math.max(y0, y1) - Math.max(0, y0) + 1) * stride;
  const n = Math.max(0, Math.min(wanted, rows.length, dst.length - start));
  if (n > 0) dst.set(rows.subarray(0, n), start);
}
