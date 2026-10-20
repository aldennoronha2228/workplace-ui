/**
 * serialTap — a seam for consumers that need every board's RAW serial
 * bytes as they arrive, not the annotated text the store keeps.
 *
 * The serial batcher calls emitSerialTap once per board per flush, BEFORE
 * annotateSerialChunk adds its one-line explanations (issue #270), so a
 * consumer matching on what the firmware actually printed can never be
 * satisfied by our own commentary. Nothing in OSS installs a tap; the pro
 * overlay's CI runner does. A null tap is a no-op.
 */

export type SerialTap = (boardId: string, chunk: string) => void;

let tap: SerialTap | null = null;
let warned = false;

/** Install (or clear with null) the single raw-serial consumer. */
export function installSerialTap(fn: SerialTap | null): void {
  tap = fn;
}

/**
 * Called by the store's serial batcher; a no-op until a tap is installed.
 * A tap that throws must never cost the serial monitor its frame of output,
 * so the error stops here.
 */
export function emitSerialTap(boardId: string, chunk: string): void {
  if (!tap) return;
  try {
    tap(boardId, chunk);
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('[serialTap] tap threw; further errors are silent:', err);
    }
  }
}
