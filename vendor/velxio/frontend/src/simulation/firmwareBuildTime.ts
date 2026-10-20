/**
 * When a firmware image was compiled, read from the image itself.
 *
 * A sketch that sets a clock to "now" writes `__DATE__` and `__TIME__`, the
 * two strings the preprocessor puts in at compile time ("Sep 29 2026",
 * "23:39:41"). RTClib parses them when the sketch runs, with
 * `DateTime(F(__DATE__), F(__TIME__))` or without the F(), so both strings are
 * in the flash image as text, whatever the core and the optimiser did with
 * the rest. Measured on builds of the production toolchain for the ATmega328P
 * (Intel HEX), the RP2040 (.bin and .uf2) and the ESP32, ESP32-S3 and
 * ESP32-C3 (merged flash image): project i2c-model-fidelity-2026-09,
 * decision D7.
 *
 * The image is the only thing that says it. The build cache answers a compile
 * request with a build that can be two weeks old, so the time of the request
 * is not the time in the strings, and a project that is opened with its
 * firmware already built has no request at all.
 *
 * An image carries more than one such string: an ESP32 build has the time its
 * bootloader and its application descriptor were compiled next to the
 * sketch's, seconds apart. Nothing in the image says which string the sketch
 * reads, so every date found goes with every time found.
 */

/** A date and a time of day as a calendar shows them, with no time zone. */
export interface BuildTime {
  year: number;
  /** 1 to 12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The strings as C lays them down: each ends its literal, so a NUL follows.
// `__DATE__` pads the day with a space ("Sep  1 2026"). A time is not the
// tail of something longer made of digits and colons (a MAC address). The
// character before it is checked in the loop and not looked behind at, which
// an older Safari cannot parse, nor matched, which would eat the NUL of a
// time literal right before and miss the one after it.
const DATE_LITERAL = new RegExp(`(${MONTHS.join('|')}) ([ 0-3][0-9]) ([0-9]{4})\\x00`, 'g');
const TIME_LITERAL = /([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])\x00/g;
const TIME_PART = /[0-9:]/;

/** Every `__DATE__` paired with every `__TIME__` found in a flash image. */
export function buildTimesInImage(image: Uint8Array): BuildTime[] {
  // The padding behind a flash image holds nothing.
  let end = image.length;
  while (end > 0 && image[end - 1] === 0xff) end--;
  // One character per byte, so the offsets and the NULs are the image's.
  const text = new TextDecoder('latin1').decode(image.subarray(0, end));
  const dates = new Map<string, Pick<BuildTime, 'year' | 'month' | 'day'>>();
  for (const m of text.matchAll(DATE_LITERAL)) {
    const day = parseInt(m[2], 10);
    if (day >= 1 && day <= 31) {
      dates.set(m[0], { year: parseInt(m[3], 10), month: MONTHS.indexOf(m[1]) + 1, day });
    }
  }
  if (dates.size === 0) return [];
  const times = new Map<string, Pick<BuildTime, 'hour' | 'minute' | 'second'>>();
  for (const m of text.matchAll(TIME_LITERAL)) {
    const at = m.index ?? 0;
    if (at > 0 && TIME_PART.test(text[at - 1])) continue;
    times.set(`${m[1]}:${m[2]}:${m[3]}`, {
      hour: parseInt(m[1], 10),
      minute: parseInt(m[2], 10),
      second: parseInt(m[3], 10),
    });
  }
  const out: BuildTime[] = [];
  for (const date of dates.values())
    for (const time of times.values()) out.push({ ...date, ...time });
  return out;
}

/** The bytes an Intel HEX file loads, lowest address first, gaps as 0xFF. */
function intelHexImage(text: string): Uint8Array | null {
  const chunks: Array<{ at: number; bytes: number[] }> = [];
  let base = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line[0] !== ':') continue;
    const count = parseInt(line.slice(1, 3), 16);
    const offset = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    if (Number.isNaN(count) || Number.isNaN(offset) || line.length < 11 + 2 * count) return null;
    const field = (i: number) => parseInt(line.slice(9 + 2 * i, 11 + 2 * i), 16);
    if (type === 0) {
      chunks.push({ at: base + offset, bytes: Array.from({ length: count }, (_, i) => field(i)) });
    } else if (type === 2) {
      base = ((field(0) << 8) | field(1)) << 4;
    } else if (type === 4) {
      base = (((field(0) << 8) | field(1)) << 16) >>> 0;
    }
  }
  if (chunks.length === 0) return null;
  const first = Math.min(...chunks.map((c) => c.at));
  const end = Math.max(...chunks.map((c) => c.at + c.bytes.length));
  // A record far from the rest (fuses, an EEPROM image) is not flash text.
  if (end - first > 64 * 1024 * 1024) return null;
  const image = new Uint8Array(end - first).fill(0xff);
  for (const c of chunks) image.set(c.bytes, c.at - first);
  return image;
}

const UF2_BLOCK = 512;
const UF2_MAGIC = [0x55, 0x46, 0x32, 0x0a]; // "UF2\n"

/**
 * The payload of a UF2 file in address order. Each 512-byte block carries up
 * to 476 bytes of the image, so a string can straddle two blocks and is only
 * whole once the headers between them are gone.
 */
function uf2Image(file: Uint8Array): Uint8Array | null {
  if (file.length < UF2_BLOCK || UF2_MAGIC.some((b, i) => file[i] !== b)) return null;
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const blocks: Array<{ at: number; bytes: Uint8Array }> = [];
  for (let off = 0; off + UF2_BLOCK <= file.length; off += UF2_BLOCK) {
    if (UF2_MAGIC.some((b, i) => file[off + i] !== b)) continue;
    const size = view.getUint32(off + 16, true);
    if (size > 476) continue;
    blocks.push({
      at: view.getUint32(off + 12, true),
      bytes: file.subarray(off + 32, off + 32 + size),
    });
  }
  if (blocks.length === 0) return null;
  blocks.sort((a, b) => a.at - b.at);
  const first = blocks[0].at;
  const last = blocks[blocks.length - 1];
  const length = last.at + last.bytes.length - first;
  if (length > 64 * 1024 * 1024) return null;
  const image = new Uint8Array(length).fill(0xff);
  for (const b of blocks) image.set(b.bytes, b.at - first);
  return image;
}

/**
 * The flash image behind a compiled program as the store keeps it: the text
 * of an Intel HEX file (AVR), or base64 of a .bin, a .uf2, a merged ESP32
 * image or an ELF. Null for what is neither (the 'micropython-loaded' mark).
 */
export function firmwareImageOf(program: string): Uint8Array | null {
  if (program.startsWith(':')) return intelHexImage(program);
  if (program.length < 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(program)) return null;
  let file: Uint8Array;
  try {
    const binary = atob(program);
    file = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) file[i] = binary.charCodeAt(i);
  } catch {
    return null;
  }
  return uf2Image(file) ?? file;
}

// A sketch that sets the clock in loop() asks again on every pass, and an
// ESP32 image is megabytes of base64. Keyed by the program itself: a rebuild
// is another string, and one that differs in nothing but the two strings.
const scanned = new Map<string, readonly BuildTime[]>();

/**
 * The build times of the compiled programs the store holds, each as it keeps
 * it; none for what holds no image. What was scanned for a program that is
 * no longer among them is let go, so no image outlives its build here.
 */
export function buildTimesOfPrograms(programs: Iterable<string | null | undefined>): BuildTime[] {
  const held = new Set<string>();
  for (const program of programs) if (program) held.add(program);
  for (const program of scanned.keys()) if (!held.has(program)) scanned.delete(program);
  const out: BuildTime[] = [];
  for (const program of held) {
    let found = scanned.get(program);
    if (!found) {
      const image = firmwareImageOf(program);
      found = image ? buildTimesInImage(image) : [];
      scanned.set(program, found);
    }
    out.push(...found);
  }
  return out;
}

/** The build times of one compiled program. */
export function buildTimesOfProgram(program: string | null | undefined): BuildTime[] {
  return buildTimesOfPrograms([program]);
}
