/**
 * i2c-esp32-real-firmware.test.ts
 *
 * Full-fidelity ESP32 I2C end-to-end test.  Unlike AVR/RP2040 which
 * run entirely in JS (avr8js / rp2040js), ESP32 emulation lives in
 * the backend FastAPI process which calls into Espressif QEMU via
 * the lcgamboa `libqemu-xtensa.dll` shared library.  So a faithful
 * test must:
 *
 *   1. Connect to a running backend FastAPI instance over HTTP.
 *   2. Submit the sketch source to `/api/compile/start` which routes
 *      to `espidf_compiler.py` (when ESP-IDF is installed) and
 *      builds a QEMU-compatible 4 MB merged flash image.
 *   3. Poll `/api/compile/status/{job_id}` until done.
 *   4. Open a WebSocket to `/api/simulation/ws/{client_id}` —
 *      exactly what `Esp32Bridge` does in production.
 *   5. Send `start_esp32` with the firmware_b64; the backend boots
 *      QEMU under the libqemu DLL via `esp_lib_manager`.
 *   6. Listen for `i2c_event` / `i2c_transaction` messages and
 *      verify the sketch's I2C traffic arrives intact at the
 *      frontend bridge.
 *
 * Prerequisites (auto-skipped when missing — same convention as the
 * pong/mega/ili9341 emulation suites that came before):
 *   - Backend reachable at `${VELXIO_BACKEND}/api` (default
 *     http://127.0.0.1:8001/api).
 *   - The backend has ESP-IDF wired up (espidf_compiler.available
 *     returns true server-side) AND libqemu-xtensa with ROM files
 *     beside it.  Verified indirectly by the compile call
 *     succeeding and a `system: booted` event appearing.
 *
 * To run locally:
 *
 *     cd backend && .venv/Scripts/uvicorn app.main:app --port 8001
 *     # in another shell:
 *     cd frontend && npx vitest run src/__tests__/i2c-esp32-real-firmware.test.ts
 *
 * The first run compiles the sketch (~75 s with cold ESP-IDF
 * cache); subsequent runs hit the OS tmpdir hex cache and complete
 * in a few seconds.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ─── Configuration ───────────────────────────────────────────────────────────

const BACKEND_URL =
  process.env.VELXIO_BACKEND ?? 'http://127.0.0.1:8001';
const FQBN = 'esp32:esp32:esp32';

const SKETCH_PATH = resolve(
  __dirname,
  '../../../test/test_custom_chips/sketches/esp32_i2c_writer/esp32_i2c_writer.ino',
);

// ─── Availability probe (must be synchronous so describe.runIf works) ────────

const SKETCH_AVAILABLE = existsSync(SKETCH_PATH);

const BACKEND_AVAILABLE = (() => {
  // node 22's fetch can't be awaited at the top level synchronously,
  // but a 2 s curl probe is fast enough and works on every dev box.
  // Root path always returns the version banner JSON when alive.
  const r = spawnSync(
    'curl',
    ['-s', '-m', '2', '-o', '-', `${BACKEND_URL}/`],
    { encoding: 'utf-8' },
  );
  return r.status === 0 && (r.stdout ?? '').includes('Arduino Emulator API');
})();

// ─── Compile-via-backend helper ──────────────────────────────────────────────
//
// Mirrors what the frontend does in `services/compilation.ts`:
// POST the files + board_fqbn, get back binary_content (b64 of the
// merged 4 MB flash image).  Routes to espidf_compiler on the
// backend when ESP-IDF is available — that's the only path that
// produces a QEMU-bootable image.

interface CompileResult {
  success: boolean;
  binary_content?: string;
  error?: string;
}

async function compileViaBackend(source: string): Promise<CompileResult> {
  // Cache by source + fqbn hash so repeat runs are instant.
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  const cachePath = join(
    tmpdir(),
    `velxio-esp32-fw-${FQBN.replace(/[^a-z0-9]/gi, '_')}-${hash >>> 0}.b64`,
  );
  if (existsSync(cachePath)) {
    return { success: true, binary_content: readFileSync(cachePath, 'utf-8') };
  }

  // Submit the async compile job.
  const startRes = await fetch(`${BACKEND_URL}/api/compile/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ name: 'sketch.ino', content: source }],
      board_fqbn: FQBN,
    }),
    redirect: 'follow',
  });
  if (!startRes.ok) {
    return { success: false, error: `compile/start ${startRes.status}` };
  }
  const { job_id } = (await startRes.json()) as { job_id: string };

  // Poll the status endpoint.  ESP-IDF cold build takes ~75 s.
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const sr = await fetch(`${BACKEND_URL}/api/compile/status/${job_id}`);
    if (!sr.ok) continue;
    const s = (await sr.json()) as {
      state: string;
      result?: { success?: boolean; binary_content?: string; error?: string };
    };
    if (s.state === 'done') {
      const b64 = s.result?.binary_content;
      if (b64) writeFileSync(cachePath, b64);
      return { success: true, binary_content: b64 };
    }
    if (s.state === 'error') {
      return { success: false, error: s.result?.error ?? 'unknown' };
    }
  }
  return { success: false, error: 'compile timeout' };
}

// ─── WebSocket helper — same protocol as Esp32Bridge ─────────────────────────

interface WsEvent {
  type: string;
  data?: unknown;
}

interface RunResult {
  i2cEvents: Array<{ bus?: number; addr: number; event?: number; data?: number | number[] }>;
  serial: string[];
  systemEvents: string[];
  errors: string[];
}

async function runFirmware(
  firmwareB64: string,
  timeoutMs: number,
  stopWhen?: (r: RunResult) => boolean,
): Promise<RunResult> {
  const url = BACKEND_URL.replace(/^http/, 'ws') + `/api/simulation/ws/test-${Date.now()}`;
  const ws = new WebSocket(url);
  const result: RunResult = {
    i2cEvents: [],
    serial: [],
    systemEvents: [],
    errors: [],
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e: any) => reject(new Error(`ws open failed: ${e?.message ?? e}`));
    setTimeout(() => reject(new Error('ws open timeout')), 5000);
  });

  ws.send(
    JSON.stringify({
      type: 'start_esp32',
      data: { board: 'esp32', firmware_b64: firmwareB64 },
    }),
  );

  await new Promise<void>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = setInterval(() => {
      if (Date.now() >= deadline || (stopWhen && stopWhen(result))) {
        clearInterval(tick);
        try {
          ws.send(JSON.stringify({ type: 'stop_esp32' }));
        } catch {
          /* ignore */
        }
        ws.close();
        resolve();
      }
    }, 100);

    ws.onmessage = (ev) => {
      let msg: WsEvent;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case 'i2c_event':
        case 'i2c_transaction':
          result.i2cEvents.push(msg.data as any);
          break;
        case 'serial_output': {
          const line = (msg.data as { data?: string })?.data ?? '';
          if (line) result.serial.push(line);
          break;
        }
        case 'system': {
          const event = (msg.data as { event?: string })?.event;
          if (event) result.systemEvents.push(event);
          break;
        }
        case 'error':
          result.errors.push(JSON.stringify(msg.data));
          break;
      }
    };
    ws.onclose = () => {
      clearInterval(tick);
      resolve();
    };
  });

  return result;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ESP32 I2C — backend + WebSocket + QEMU end-to-end', () => {
  it.runIf(SKETCH_AVAILABLE && BACKEND_AVAILABLE)(
    'compiles ESP32 sketch with ESP-IDF via backend',
    async () => {
      const source = readFileSync(SKETCH_PATH, 'utf-8');
      const r = await compileViaBackend(source);
      if (!r.success) {
        // Backend may not have ESP-IDF wired up; fail loudly with
        // the actual error so the user knows what to fix.
        throw new Error(`compile failed: ${r.error}`);
      }
      expect(r.binary_content).toBeTruthy();
      // Merged flash image is around 370 KB for a minimal sketch.
      expect(r.binary_content!.length).toBeGreaterThan(50_000);
    },
    900_000,
  );

  it.runIf(SKETCH_AVAILABLE && BACKEND_AVAILABLE)(
    'boots in QEMU and emits I2C events for Wire.beginTransmission(0x27)',
    async () => {
      const source = readFileSync(SKETCH_PATH, 'utf-8');
      const compiled = await compileViaBackend(source);
      expect(compiled.success).toBe(true);

      // Run until BOTH at least 6 I2C events targeting 0x27 AND
      // the "DONE" serial marker arrived.  The sketch loops 5×
      // (3 events each = 15 total) and then prints "DONE".
      // Closing on the I2C count alone is racy — the serial
      // flush may lag the I2C events by a few hundred ms.
      const result = await runFirmware(compiled.binary_content!, 25_000, (r) => {
        const i2cOk = r.i2cEvents.filter((e) => e.addr === 0x27).length >= 6;
        const doneOk = r.serial.join('').toUpperCase().includes('DONE');
        return i2cOk && doneOk;
      });

      // System lifecycle observed
      expect(result.systemEvents).toContain('booting');
      // booted is fired by lib_manager after the worker confirms QEMU started
      expect(result.systemEvents).toContain('booted');

      // No backend errors
      expect(result.errors).toEqual([]);

      // I2C activity on 0x27 from real Wire.h calls
      const writes = result.i2cEvents.filter((e) => e.addr === 0x27);
      expect(writes.length).toBeGreaterThan(0);

      // Serial confirms setup() ran to completion
      const serial = result.serial.join('').toUpperCase();
      expect(serial).toContain('DONE');
    },
    900_000,
  );

  it.runIf(SKETCH_AVAILABLE && BACKEND_AVAILABLE)(
    'system event sequence reflects boot → run → reboot/stop',
    async () => {
      const source = readFileSync(SKETCH_PATH, 'utf-8');
      const compiled = await compileViaBackend(source);
      const result = await runFirmware(compiled.binary_content!, 15_000);

      expect(result.systemEvents[0]).toBe('booting');
      expect(result.systemEvents).toContain('booted');
    },
    900_000,
  );
});

describe.skipIf(BACKEND_AVAILABLE)(
  'ESP32 I2C — skipped (backend not reachable at ' + BACKEND_URL + ')',
  () => {
    it('start backend: cd backend && .venv/Scripts/uvicorn app.main:app --port 8001', () => {
      expect(true).toBe(true);
    });
  },
);

describe.skipIf(SKETCH_AVAILABLE)(
  'ESP32 I2C — skipped (sketch fixture missing)',
  () => {
    it('expected ' + SKETCH_PATH, () => {
      expect(true).toBe(true);
    });
  },
);
