/**
 * EPaperPart: simulation hook for the SSD168x, UltraChip and ACeP e-paper
 * panels.
 *
 * Registers all five Phase-1 panel kinds against a single `attachEvents`
 * factory. Internally the factory:
 *
 *   - Decodes SPI bytes with the controller family's decoder, as a write-only
 *     device of the board's SPI fabric. One path for every engine: the ones
 *     that clock SPI in the tab (AVR, RP2040, RP2350, the XIAOs, the ESP32 JS
 *     engines, the Pi) and the QEMU lane, whose worker relays the guest's
 *     bytes into the board's remote controller port (board-buses-2026-09,
 *     F4). No model of the panel runs anywhere else.
 *   - Tracks DC + RST pins via `pinManager.onPinChange` (CS is the fabric's:
 *     a frame only reaches the panel while its own chip select is active).
 *   - On flush: paints the latched framebuffer to the element's `<canvas>`
 *     via `putImageData()` (RAF-batched) and holds BUSY at the controller's
 *     BUSY level for `refreshMs`, so firmware busy-waits see realistic timing.
 *     Which level that is depends on the vendor (`busyLevels`): HIGH on an
 *     SSD168x, LOW on an UltraChip, whose pad rests HIGH. On the QEMU lane
 *     the pulse reaches the guest a socket round trip after the worker
 *     relayed the refresh command, so a driver polling BUSY there may not
 *     wait at all: the picture is the same, the wait is shorter than a real
 *     panel's.
 *
 * This is the only file that touches the simulator-specific surface: the
 * decoder is pure data and the Web Component is pure presentation.
 */

import { PartSimulationRegistry, type AnySimulator } from './PartSimulationRegistry';
import { SSD168xDecoder, type Frame } from '../displays/SSD168xDecoder';
import {
  UC8159cDecoder,
  type UC8159cFrame,
  ACEP_PALETTE_RGB,
} from '../displays/UC8159cDecoder';
import { Uc8179Decoder, type Uc8179Diagnostic } from '../displays/Uc8179Decoder';
import { PANEL_CONFIGS, getPanelConfig, PANEL_IDS, busyLevels } from '../displays/EPaperPanels';
import { attachSpiDevice } from '../buses';
import { recordPartGap, releaseLineGap } from '../line/requestLine';
import { useSimulatorStore, appendSimulatorNote } from '../../store/useSimulatorStore';

// ── Types ────────────────────────────────────────────────────────────────────

interface PinnedSimulator {
  pinManager?: { onPinChange(pin: number, cb: (p: number, state: boolean) => void): () => void };
}

// Pin name → panel-side label. The Web Component exposes them as
// 'GND', 'VCC', 'SCK', 'SDI', 'CS', 'DC', 'RST', 'BUSY'.
const PIN_SCK = 'SCK';
const PIN_SDI = 'SDI';
const PIN_DC = 'DC';
const PIN_CS = 'CS';
const PIN_RST = 'RST';
const PIN_BUSY = 'BUSY';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The board this panel is wired to, by any of its pins, or null. */
function wiredBoardId(componentId: string): string | null {
  const s = useSimulatorStore.getState();
  for (const w of s.wires) {
    const other =
      w.start.componentId === componentId ? w.end : w.end.componentId === componentId ? w.start : null;
    if (other && s.boards.some((b) => b.id === other.componentId)) return other.componentId;
  }
  return null;
}

/**
 * Render an SSD168x palette frame (0=black, 1=white, 2=red) into RGBA on canvas.
 */
function paintFrame(ctx: CanvasRenderingContext2D, frame: Frame): void {
  const { width, height, pixels } = frame;
  const id = ctx.createImageData(width, height);
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i];
    const o = i * 4;
    if (v === 0) {
      id.data[o] = 0x20;
      id.data[o + 1] = 0x20;
      id.data[o + 2] = 0x20;
    } else if (v === 2) {
      id.data[o] = 0xc0;
      id.data[o + 1] = 0x10;
      id.data[o + 2] = 0x10;
    } else {
      id.data[o] = 0xf4;
      id.data[o + 1] = 0xf1;
      id.data[o + 2] = 0xe8;
    }
    id.data[o + 3] = 0xff;
  }
  ctx.putImageData(id, 0, 0);
}

/**
 * Render a UC8159c ACeP 7-colour frame using the palette table.
 * Palette indices 7+ render as white (clean state).
 */
function paintAcePFrame(ctx: CanvasRenderingContext2D, frame: UC8159cFrame): void {
  const { width, height, pixels } = frame;
  const id = ctx.createImageData(width, height);
  for (let i = 0; i < pixels.length; i++) {
    const idx = pixels[i];
    const rgb = ACEP_PALETTE_RGB[idx] ?? ACEP_PALETTE_RGB[1];
    const o = i * 4;
    id.data[o] = rgb[0];
    id.data[o + 1] = rgb[1];
    id.data[o + 2] = rgb[2];
    id.data[o + 3] = 0xff;
  }
  ctx.putImageData(id, 0, 0);
}

// ── Hook factory ─────────────────────────────────────────────────────────────

const epaperSimulation = {
  attachEvents: (
    element: HTMLElement,
    simulator: AnySimulator,
    getArduinoPinHelper: (componentPinName: string) => number | null,
    componentId: string,
  ) => {
    const cleanups: Array<() => void> = [];

    // ── Resolve panel config from the Web Component's panel-kind attr ─────
    const panelKind =
      (element.getAttribute && element.getAttribute('panel-kind')) ?? 'epaper-1in54-bw';
    const cfg = getPanelConfig(panelKind);
    const explicitRefreshMs = parseFloat(element.getAttribute('refresh-ms') ?? '');
    const refreshMs = !isNaN(explicitRefreshMs) && explicitRefreshMs > 0
      ? explicitRefreshMs
      : cfg.refreshMs;

    // ── Canvas plumbing ──────────────────────────────────────────────────
    const initCanvas = (): CanvasRenderingContext2D | null => {
      const cv = (element as any).canvas as HTMLCanvasElement | null;
      if (!cv) return null;
      // Paint the idle "paper" colour so a freshly-mounted panel doesn't
      // show as a transparent rectangle before the first refresh.
      const ctx = cv.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#f4f1e8';
        ctx.fillRect(0, 0, cfg.width, cfg.height);
      }
      return ctx;
    };
    let ctx = initCanvas();
    const onCanvasReady = () => {
      ctx = initCanvas();
    };
    element.addEventListener('canvas-ready', onCanvasReady);
    cleanups.push(() => element.removeEventListener('canvas-ready', onCanvasReady));

    // ── BUSY pulse plumbing ──────────────────────────────────────────────
    const levels = busyLevels(cfg.controllerFamily);
    let busyTimer: ReturnType<typeof setTimeout> | null = null;
    // The panel here is the one writer of BUSY on every engine. A second
    // writer in a worker disagreed with this one on an UltraChip pad (HIGH
    // meant busy here and idle there), which is one reason no worker holds a
    // panel model.
    const setBusy = (state: boolean) => {
      (element as any).busy = state;
      const busyPin = getArduinoPinHelper(PIN_BUSY);
      // Unwired, or wired to a rail (a rail resolves to -1, not null).
      if (busyPin === null || busyPin < 0) return;
      // Every board takes an external level through setPinState: the AVR and
      // the RP2040 directly, the Raspberry Pi and the QEMU shims by forwarding
      // it to the guest. One call, not a branch per board.
      (simulator as any).setPinState?.(busyPin, state ? levels.busy : levels.idle);
    };

    const pulseBusy = (ms: number) => {
      setBusy(true);
      if (busyTimer) clearTimeout(busyTimer);
      busyTimer = setTimeout(() => {
        busyTimer = null;
        setBusy(false);
      }, ms);
    };
    cleanups.push(() => {
      if (busyTimer) clearTimeout(busyTimer);
    });
    // The pad rests at the idle level from the moment the panel is wired, not
    // from its first refresh: a driver's first act is to wait for "not busy",
    // and on an UltraChip panel an undriven input reads 0, which means busy.
    setBusy(false);

    // ── What the refresh was made of (Circuit check + serial monitor) ────
    let saidIt = false;
    const onDiagnostic = (diagnostic: Uc8179Diagnostic) => {
      if (!diagnostic) {
        releaseLineGap(componentId);
        saidIt = false;
        return;
      }
      if (!saidIt) {
        // Once, not per refresh: a driver that redraws in a loop would
        // otherwise bury its own output under the same sentence.
        saidIt = true;
        const boardId = wiredBoardId(componentId);
        if (boardId) {
          appendSimulatorNote(
            boardId,
            `e-paper: the panel refreshed blank because the image was sent to command 0x10 only. ` +
              `This controller (${cfg.controllerIc}) displays what is sent to 0x13; a real panel does the same.`,
          );
        }
      }
      recordPartGap({
        sensorType: 'epaper',
        pin: getArduinoPinHelper(PIN_CS) ?? -1,
        componentId,
        code: 'epaper-old-plane-only',
        why:
          `the panel refreshed blank: the ${diagnostic.oldPlaneBytes} image bytes went to command ` +
          `0x10 only. On this controller (${cfg.controllerIc}) 0x10 is the PREVIOUS image and 0x13 ` +
          `is the one it displays, so send the picture to 0x13 before 0x12 (Waveshare's driver ` +
          `writes both). A real panel does the same.`,
      });
    };
    cleanups.push(() => releaseLineGap(componentId));

    // ── RAF-batched flush ────────────────────────────────────────────────
    // Both decoder families produce {width, height, pixels: Uint8Array}.
    // The palette interpretation differs (B/W/R vs ACeP 7-colour), so we
    // dispatch on `cfg.palette` rather than the structural type.
    type AnyFrame = Frame | UC8159cFrame;
    let pendingFrame: AnyFrame | null = null;
    let rafId: number | null = null;
    const scheduleFlush = (frame: AnyFrame) => {
      pendingFrame = frame;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!pendingFrame) return;
        if (!ctx) ctx = initCanvas();
        if (ctx) {
          if (cfg.palette === 'acep') paintAcePFrame(ctx, pendingFrame as UC8159cFrame);
          else paintFrame(ctx, pendingFrame as Frame);
        }
        pendingFrame = null;
      });
    };
    cleanups.push(() => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    });

    // ── The decoder, on the board's SPI fabric ───────────────────────────
    {
      // Pick the decoder that matches the panel's controller family. All
      // three expose .feed(byte, dcHigh) + .reset(), so the device below
      // stays family-agnostic.
      const onDecoderFlush = (frame: Frame | UC8159cFrame) => {
        scheduleFlush(frame);
        pulseBusy(refreshMs);
      };
      const decoder =
        cfg.controllerFamily === 'uc8159c'
          ? new UC8159cDecoder({ width: cfg.width, height: cfg.height, onFlush: onDecoderFlush })
          : cfg.controllerFamily === 'uc8179'
            ? new Uc8179Decoder({
                width: cfg.width,
                height: cfg.height,
                onFlush: onDecoderFlush,
                onDiagnostic,
              })
            : new SSD168xDecoder({
                width: cfg.width,
                height: cfg.height,
                palette: cfg.palette,
                onFlush: onDecoderFlush,
              });

      // DC and RST are plain pins the driver toggles; CS is not ours to read,
      // because the fabric only clocks the panel while it is selected.
      let dcHigh = false;
      const dcPin = getArduinoPinHelper(PIN_DC);
      const rstPin = getArduinoPinHelper(PIN_RST);

      const pm = (simulator as PinnedSimulator).pinManager;
      if (pm) {
        if (dcPin !== null) {
          cleanups.push(
            pm.onPinChange(dcPin, (_p: number, s: boolean) => {
              dcHigh = s;
            }),
          );
        }
        if (rstPin !== null) {
          cleanups.push(
            pm.onPinChange(rstPin, (_p: number, s: boolean) => {
              // RST is active LOW: a falling edge resets the controller.
              if (!s) decoder.reset();
            }),
          );
        }
      }

      // The panel is a write-only sink: it reports status on BUSY, never on
      // MISO, so it answers null and the fabric resolves the line. No
      // boardReset(): the MCU's reset pin is not the panel's, and the image
      // in its RAM is data, which a reset of the MCU does not clear. Only a
      // falling edge on RST clears the controller, above.
      const handle = attachSpiDevice(
        { owner: componentId, pins: { sck: PIN_SCK, mosi: PIN_SDI, cs: PIN_CS } },
        {
          transfer: (value: number) => {
            decoder.feed(value, dcHigh);
            return null;
          },
          transferBlock: (bytes: Uint8Array) => {
            for (let i = 0; i < bytes.length; i++) decoder.feed(bytes[i], dcHigh);
          },
        },
      );
      cleanups.push(() => handle.dispose());
    }
    // A board whose engine has no hardware controller on the panel's pins (an
    // ATtiny85, whose USI gives avr8js no frame) registers it all the same:
    // what reaches it is the fabric's business, a controller port or the
    // software decoder on plain pins, and until a frame comes the canvas
    // stays in its idle paper colour.

    // ── Cleanup ──────────────────────────────────────────────────────────
    return () => {
      while (cleanups.length) {
        try {
          cleanups.pop()?.();
        } catch {
          /* ignore individual handler errors */
        }
      }
    };
  },
};

// ── Register all five panel variants under the same factory ──────────────────

for (const id of PANEL_IDS) {
  PartSimulationRegistry.register(id, epaperSimulation);
}

// Re-export so callers can introspect the supported set.
export const EPAPER_PANEL_IDS = PANEL_IDS;
export { PANEL_CONFIGS };
