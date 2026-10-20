/**
 * The two most used I2C parts under firmware that was compiled, not imitated:
 * real sketches of the drivers the production corpus uses for them, on
 * avr8js, the ATmega's TWI on the bus fabric, each part attached the way the
 * canvas attaches it (project i2c-model-fidelity-2026-09, item "displays").
 *
 * SSD1306 (1,316 projects; Adafruit_SSD1306 in 896, U8g2 in 64). One frame is
 * dozens of I2C transactions: Adafruit_SSD1306 display() sends the 1 KiB
 * buffer in 31-byte chunks on AVR, U8g2 sendBuffer() in short page chunks. The
 * part used to convert and repaint the whole panel at every STOP of them; it
 * now paints once per animation frame, and what it paints is the panel after
 * the last transaction, the picture the per-STOP paint left on screen.
 *
 * LCD with the PCF8574 backpack (2,571 projects; LiquidCrystal_I2C in 2,184,
 * LiquidCrystal_PCF8574 in 22, hd44780 in 5). The backpack's port now reads
 * P3 low, as the backlight transistor's base holds it on the bench. A driver
 * that never reads writes the same bytes as against the old port, which read
 * 0xFF, and shows the same panel; hd44780_I2Cexp reads, and against 0xFF it
 * picked an active-low backlight and turned the panel dark.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { VirtualPCF8574 } from '../simulation/I2CBusManager';
import { HD44780Decoder } from '../simulation/HD44780Decoder';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import { busRegistry } from '../simulation/buses';
import { bareBoard, putI2cDevice, wireI2cPins, clearBench } from './helpers/i2cBench';

const firmware = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}/${name}.ino.hex`, import.meta.url)),
    'utf-8',
  );

// The Uno's TWI pins (A4 / A5) as board pins of the fabric.
const UNO = 'uno';
const SDA = { boardId: UNO, pin: 18 };
const SCL = { boardId: UNO, pin: 19 };
const CYCLES_PER_MS = 16_000;

// Animation frames are queued and run only when a test says so: the CPU is
// stepped by the test, and the panel paints at the frame the test chooses.
let frames: FrameRequestCallback[] = [];
const runFrames = () => {
  for (const cb of frames.splice(0)) cb(0);
};
beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearBench();
});

interface Bench {
  /** Run until the sketch printed a line matching `pattern`, or fail. */
  until(pattern: RegExp, withinMs?: number): string;
  /** Bytes written to `addr` since the bench started, per STOP-bounded write phase. */
  writes: number[][];
  /** STOPs on the bus so far. */
  stops(): number;
  /** Take the bench down: the bus and the registry outlive it. */
  close(): void;
}

/** The sketch on an Uno with `attach` putting the part on its I2C pins. */
function bench(hex: string, watch: number, attach: () => void): Bench {
  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(hex);
  let out = '';
  sim.onSerialData = (ch: string) => {
    out += ch;
  };
  bareBoard(UNO, 'arduino-uno', sim);
  attach();
  return {
    until(pattern, withinMs = 5000) {
      const cycles = () => (sim as unknown as { cpu: { cycles: number } }).cpu.cycles;
      const limit = cycles() + withinMs * CYCLES_PER_MS;
      for (;;) {
        const hit = out.split(/\r?\n/).find((l) => pattern.test(l));
        if (hit) return hit;
        if (cycles() >= limit) {
          throw new Error(`no line matching ${pattern} in ${withinMs} ms; the sketch printed ${JSON.stringify(out)}`);
        }
        for (let i = 0; i < 20_000; i++) sim.step();
      }
    },
    ...tapBus(watch),
  };
}

/** Log the write phases addressed to `watch`, and count every STOP. */
function tapBus(watch: number): { writes: number[][]; stops(): number; close(): void } {
  const bus = busRegistry.fabric(UNO).i2cBuses.get(SDA.pin)!;
  const writes: number[][] = [];
  let stops = 0;
  let open: number[] | null = null;
  const { start, write, stop } = bus;
  bus.start = (address, read) => {
    if (open) writes.push(open);
    open = address === watch && !read ? [] : null;
    return start.call(bus, address, read);
  };
  bus.write = (byte) => {
    open?.push(byte);
    return write.call(bus, byte);
  };
  bus.stop = () => {
    if (open) writes.push(open);
    open = null;
    stops++;
    stop.call(bus);
  };
  return {
    writes,
    stops: () => stops,
    close: () => {
      Object.assign(bus, { start, write, stop });
      clearBench();
    },
  };
}

// ── SSD1306 ──────────────────────────────────────────────────────────────────

function oledElement() {
  return {
    imageData: new ImageData(128, 64),
    redraw: vi.fn(),
    addEventListener() {},
    removeEventListener() {},
  };
}

/** The lit pixels of the panel, as a set of "x,y". */
function lit(el: { imageData: ImageData }): Set<string> {
  const on = new Set<string>();
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 128; x++) if (el.imageData.data[(y * 128 + x) * 4] !== 0) on.add(`${x},${y}`);
  }
  return on;
}

function quarter(x0: number, y0: number): Set<string> {
  return rows(y0, y0 + 32, x0, x0 + 64);
}

/** Pixels x0 <= x < x1 on the rows y0 <= y < y1. */
function rows(y0: number, y1: number, x0 = 0, x1 = 64): Set<string> {
  const on = new Set<string>();
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) on.add(`${x},${y}`);
  return on;
}

const union = (...sets: Set<string>[]): Set<string> => new Set(sets.flatMap((s) => [...s]));
const allBut = (off: Set<string>): Set<string> => {
  const on = rows(0, 64, 0, 128);
  for (const p of off) on.delete(p);
  return on;
};

/** The distinct colours the panel shows, as "r,g,b". */
function colours(el: { imageData: ImageData }): Set<string> {
  const seen = new Set<string>();
  const d = el.imageData.data;
  for (let i = 0; i < d.length; i += 4) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
  return seen;
}

// The lit colour the panel has always painted, and the one at contrast 0.
const LIT = '200,230,255';
const DIMMED = '60,69,77';
const DARK = '0,0,0';

if (typeof globalThis.ImageData === 'undefined') {
  (globalThis as { ImageData?: unknown }).ImageData = class {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
}

function oledBench(fixture: string) {
  const el = oledElement();
  let detach = () => {};
  const b = bench(firmware(fixture), 0x3c, () => {
    wireI2cPins('oled', SDA, SCL);
    detach = PartSimulationRegistry.get('ssd1306-i2c-4pin')!.attachEvents!(
      el as unknown as HTMLElement,
      {} as never,
      () => null,
      'oled',
    );
  });
  return { b, el, detach: () => detach() };
}

describe.each([
  ['Adafruit_SSD1306', 'avr-ssd1306-adafruit'],
  ['U8g2 full buffer', 'avr-ssd1306-u8g2'],
])('SSD1306 over I2C under %s on an Arduino Uno, compiled', (_driver, fixture) => {
  it('paints one frame once, after its last transaction, with the picture that transaction left', () => {
    const { b, el } = oledBench(fixture);
    b.until(/^READY$|^BEGIN$/);
    // begin() and the first display(): nothing painted until the frame.
    b.until(/^FRAME 0$/);
    expect(el.redraw).toHaveBeenCalledTimes(0);
    runFrames();
    expect(el.redraw).toHaveBeenCalledTimes(1);
    expect(lit(el)).toEqual(quarter(0, 0));
    // begin() sends its re-map (0xA1), scan direction (0xC8) and contrast:
    // the same picture, in the same colours, as before they were modelled.
    expect(colours(el)).toEqual(new Set([LIT, DARK]));

    // Exactly one display() / sendBuffer(): many transactions, one paint.
    const stopsBefore = b.stops();
    b.until(/^DONE$/);
    expect(b.stops() - stopsBefore).toBeGreaterThan(30);
    expect(el.redraw).toHaveBeenCalledTimes(1);
    runFrames();
    expect(el.redraw).toHaveBeenCalledTimes(2);
    expect(lit(el)).toEqual(quarter(64, 32));
    expect(colours(el)).toEqual(new Set([LIT, DARK]));
  }, 120_000);

  it('keeps the last picture when the part goes before the next animation frame', () => {
    const { b, el, detach } = oledBench(fixture);
    b.until(/^DONE$/);
    detach();
    expect(lit(el)).toEqual(quarter(64, 32));
  }, 120_000);
});

/**
 * The commands that change the glass without a new frame (project
 * i2c-model-fidelity-2026-09, item "ssd1306cmd"). The panel ignored all of
 * them: 56 projects of the production corpus send invert, contrast or display
 * off, and ThingPulse and U8g2 R2 / setFlipMode(1) flip the picture with
 * 0xA0 / 0xC0. Each step of the sketch is looked at on the frame after it.
 */
describe('SSD1306 over I2C under Adafruit_SSD1306 on an Arduino Uno, compiled: the panel commands', () => {
  it('invert, dim, display off, entire display on, scan direction, start line, offset and segment re-map', () => {
    const { b, el } = oledBench('avr-ssd1306-adafruit-commands');
    const at = (step: string) => {
      b.until(new RegExp(`^${step}$`));
      runFrames();
      return { lit: lit(el), colours: colours(el) };
    };
    expect(at('SHOWN')).toEqual({ lit: quarter(0, 0), colours: new Set([LIT, DARK]) });
    // 0xA7: the zeros light up.
    expect(at('INVERTED').lit).toEqual(allBut(quarter(0, 0)));
    // 0x81 0x00: the same picture, dimmer.
    expect(at('DIM')).toEqual({ lit: quarter(0, 0), colours: new Set([DIMMED, DARK]) });
    // 0xAE: a dark panel.
    expect(at('OFF').lit).toEqual(new Set());
    // 0xAF then 0xA5: on again, every pixel lit whatever the RAM holds.
    expect(at('ALLON')).toEqual({ lit: rows(0, 64, 0, 128), colours: new Set([LIT]) });
    // 0xA4 then 0xC0: the RAM again, the rows scanned the other way at once.
    expect(at('COMUP').lit).toEqual(quarter(0, 32));
    // 0xC8, start line 8: RAM row 8 on the top row, rows wrap round.
    expect(at('STARTLINE').lit).toEqual(union(rows(0, 24), rows(56, 64)));
    // Start line 0, offset 16: COM16 moves to the top.
    expect(at('OFFSET').lit).toEqual(union(rows(0, 16), rows(48, 64)));
    // 0xA0 leaves what is in the RAM alone ...
    expect(at('SEGSAME').lit).toEqual(quarter(0, 0));
    // ... and mirrors what is written after it.
    expect(at('MIRRORED').lit).toEqual(quarter(64, 0));
    expect(at('RESTORED')).toEqual({ lit: quarter(0, 0), colours: new Set([LIT, DARK]) });
  }, 120_000);
});

describe('SSD1306 over I2C under U8g2 page buffer on an Arduino Uno, compiled: the panel calls', () => {
  it('setContrast, setPowerSave and setFlipMode', () => {
    const { b, el } = oledBench('avr-ssd1306-u8g2-commands');
    const at = (step: string) => {
      b.until(new RegExp(`^${step}$`));
      runFrames();
      return { lit: lit(el), colours: colours(el) };
    };
    // Eight page transfers in page addressing: the picture as it always was.
    expect(at('SHOWN')).toEqual({ lit: quarter(0, 0), colours: new Set([LIT, DARK]) });
    expect(at('DIM')).toEqual({ lit: quarter(0, 0), colours: new Set([DIMMED, DARK]) });
    expect(at('ASLEEP').lit).toEqual(new Set());
    expect(at('AWAKE')).toEqual({ lit: quarter(0, 0), colours: new Set([LIT, DARK]) });
    // 0xA0 0xC0 and a redraw: the picture turned 180 degrees, as the
    // module shows it the other way up.
    expect(at('FLIPPED').lit).toEqual(quarter(64, 32));
  }, 120_000);
});

// ── LCD with the PCF8574 backpack ────────────────────────────────────────────

function lcdElement() {
  return {
    pins: 'full',
    characters: new Uint8Array(32),
    backlight: true,
    i2cAddress: '0x27',
    addEventListener() {},
    removeEventListener() {},
  } as { characters: Uint8Array; backlight: boolean; pins: string };
}

const row = (c: Uint8Array, r: number) => String.fromCharCode(...c.slice(r * 16, r * 16 + 16)).trimEnd();

/** The sketch against the lcd1602-i2c part, as the canvas attaches it. */
function runOnPart(fixture: string) {
  const el = lcdElement();
  let detach = () => {};
  const b = bench(firmware(fixture), 0x27, () => {
    wireI2cPins('lcd', SDA, SCL);
    detach = PartSimulationRegistry.get('lcd1602-i2c')!.attachEvents!(
      el as unknown as HTMLElement,
      {} as never,
      () => null,
      'lcd',
    );
  });
  const done = b.until(/^(DONE|BEGIN FAILED.*)$/);
  detach();
  b.close();
  return { done, writes: b.writes, rows: [row(el.characters, 0), row(el.characters, 1)], backlight: el.backlight };
}

/** The same sketch against the backpack as it was: an expander whose port read 0xFF. */
function runOnOldBackpack(fixture: string) {
  const pcf = new VirtualPCF8574(0x27);
  const decoder = new HD44780Decoder({ cols: 16, rows: 2 });
  pcf.onWrite = (v) => decoder.feedPCF8574Byte(v);
  const b = bench(firmware(fixture), 0x27, () => putI2cDevice(pcf, SDA, SCL));
  const done = b.until(/^(DONE|BEGIN FAILED.*)$/);
  b.close();
  const snap = decoder.snapshot();
  const chars = Uint8Array.from(snap.characters);
  return { done, writes: b.writes, rows: [row(chars, 0), row(chars, 1)], backlight: snap.backlight };
}

describe.each([
  ['LiquidCrystal_I2C', 'avr-lcd-liquidcrystal-i2c'],
  ['LiquidCrystal_PCF8574', 'avr-lcd-pcf8574'],
  ['LCD_I2C', 'avr-lcd-lcd-i2c'],
])('LCD 16x2 I2C under %s on an Arduino Uno, compiled', (_driver, fixture) => {
  it('shows Hello / World with the backlight on, from the very bytes it wrote to the old backpack', () => {
    const now = runOnPart(fixture);
    expect(now.done).toBe('DONE');
    expect(now.rows).toEqual(['Hello', 'World']);
    expect(now.backlight).toBe(true);
    const before = runOnOldBackpack(fixture);
    expect(before.rows).toEqual(now.rows);
    expect(before.backlight).toBe(now.backlight);
    expect(now.writes.length).toBeGreaterThan(20);
    expect(now.writes).toEqual(before.writes);
  }, 120_000);
});

describe('LCD 16x2 I2C under hd44780_I2Cexp on an Arduino Uno, compiled', () => {
  it('auto-configures an active-high backlight and shows Hello / World lit', () => {
    const now = runOnPart('avr-lcd-hd44780');
    expect(now.done).toBe('DONE');
    expect(now.rows).toEqual(['Hello', 'World']);
    expect(now.backlight).toBe(true);
  }, 120_000);

  it('setup: against a port that reads 0xFF it picked active low, and the panel went dark', () => {
    const before = runOnOldBackpack('avr-lcd-hd44780');
    expect(before.done).toBe('DONE');
    expect(before.rows).toEqual(['Hello', 'World']);
    expect(before.backlight).toBe(false);
  }, 120_000);
});
