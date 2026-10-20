/**
 * A membrane keypad: a grid of switches, each one shorting one ROW wire to one
 * COLUMN wire for as long as it is held. That is the whole device. It has no
 * notion of which side is scanned and which is read.
 *
 * The first model did have one. It waited for the guest to pull a ROW low and
 * then pulled the matching COLUMN low, which is the scan a hand-written sketch
 * often does and exactly the opposite of the one everybody actually uses: the
 * Keypad library (Mark Stanley / Alexander Brevig, 3.x) sets the rows to
 * INPUT_PULLUP, drives each COLUMN low in turn and reads the rows. On that
 * sketch the model listened to wires nothing ever drove, and no key was ever
 * seen (issue #327). The QEMU worker and the in-browser ESP32 engines carried
 * the same row-first assumption in their own copies.
 *
 * So this model is the circuit instead of a scan: every wire is equal.
 *
 *   1. The held keys join wires into groups. Two held keys that share a wire
 *      join their groups too, so a real membrane's ghosting (three corners of
 *      a rectangle held make the fourth read as held) is reproduced rather
 *      than hidden.
 *   2. A group is LOW when the guest drives any of its wires low, else HIGH
 *      when the guest drives one high, else nobody drives it. Low beats high:
 *      a push-pull high shorted to a push-pull low through a membrane reads
 *      low on the pull-up side of every real keypad circuit.
 *   3. Every wire of a driven group that the guest has RELEASED (an input) is
 *      held at the group's level. Every other wire is handed back: the guest
 *      drives it, or its own pull sets it.
 *
 * Rule 3 is why "released" matters and why this model listens to pad drive
 * states rather than levels. A wire the guest is driving must never be driven
 * from the host side too; on the in-browser ESP32 engines a host-driven pad
 * outranks the guest's own output, so a forced column would stay forced after
 * the sketch started driving it.
 *
 * A handed-back wire is released AND set to the level the guest itself is
 * holding, and it is refreshed on every event that moves it. Releasing alone
 * would be enough on a host that models pad ownership, but the esp32c3 engine
 * has no release at all: there, the last level the host injected is what the
 * line reads, so it has to keep agreeing with the guest.
 *
 * Levels are applied at the cycle the guest's event happened, which every host
 * lands before the guest's next instruction: the library's `digitalRead` of a
 * row a few instructions after `digitalWrite(col, LOW)` sees the key.
 *
 * The same model runs on every board whose guest is emulated outside the
 * browser (`backend/app/services/matrix_keypad.py`, used by the ESP32 and
 * STM32 workers and by the Raspberry Pi GPIO bridge); a change to the rules
 * above belongs in both.
 */

import type { HostEdgeFrame } from '../LineTimeline';
import type { PadDrive, PadPull } from '../padEvent';
import {
  registerLineModel,
  type LineClock,
  type LineFrames,
  type LineModel,
  type LineSensorRecord,
} from '../lineModels';

/**
 * What the model wants on one wire. `free`: handed back to the guest, at the
 * level the guest itself is holding.
 */
export type WireTarget = 'low' | 'high' | 'free';

/** What the guest is doing to one wire, as its pad last reported it. */
export interface WirePad {
  drive: PadDrive;
  pull: PadPull;
  level: boolean;
}

const RELEASED: Readonly<WirePad> = Object.freeze({ drive: 'z', pull: 0, level: true });

/** A list of board pins off a record field: one entry per row or column, -1 where nothing is wired. */
export function wireList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isInteger(n) && n >= 0 ? n : -1;
  });
}

/** Held keys off a record field, as `[rowIndex, columnIndex]` pairs. Malformed entries are dropped. */
export function heldKeys(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  const out: Array<[number, number]> = [];
  for (const k of value) {
    if (!Array.isArray(k) || k.length < 2) continue;
    const r = Number(k[0]);
    const c = Number(k[1]);
    if (Number.isInteger(r) && Number.isInteger(c) && r >= 0 && c >= 0) out.push([r, c]);
  }
  return out;
}

/**
 * The circuit, solved: what every wired pin should carry for these pads and
 * these held keys. Pure, so the rules can be tested without a board.
 */
export function solveKeypad(
  rows: readonly number[],
  cols: readonly number[],
  held: ReadonlyArray<readonly [number, number]>,
  padOf: (pin: number) => Readonly<WirePad>,
): Map<number, WireTarget> {
  const wires = [...new Set([...rows, ...cols].filter((p) => p >= 0))];
  const parent = new Map<number, number>(wires.map((p) => [p, p]));
  const find = (p: number): number => {
    let root = p;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    parent.set(p, root);
    return root;
  };
  for (const [r, c] of held) {
    const a = rows[r] ?? -1;
    const b = cols[c] ?? -1;
    if (a < 0 || b < 0) continue;
    parent.set(find(a), find(b));
  }

  const groupLevel = new Map<number, 'low' | 'high'>();
  for (const pin of wires) {
    const drive = padOf(pin).drive;
    if (drive === 'z') continue;
    const root = find(pin);
    if (drive === 'low' || groupLevel.get(root) === undefined) groupLevel.set(root, drive);
  }

  const out = new Map<number, WireTarget>();
  for (const pin of wires) {
    const level = groupLevel.get(find(pin));
    out.set(pin, padOf(pin).drive === 'z' && level ? level : 'free');
  }
  return out;
}

registerLineModel('matrix-keypad', (rec: LineSensorRecord) => {
  const rows = wireList(rec.rows);
  const cols = wireList(rec.cols);
  const wires = [...new Set([...rows, ...cols].filter((p) => p >= 0))];
  let held = heldKeys(rec.pressed);
  const pads = new Map<number, WirePad>();
  /**
   * What each wire was last put at ("<level>|<released>"), so nothing costs a
   * repeat edge. Seeded with what `rest()` applies at attach — released, on the
   * pull-up — because the alternative is a storm: with the map empty, the first
   * pad event of a run makes all eight wires look changed and emits eight
   * no-op frames at one cycle. The engines' edge heaps are not stable for equal
   * cycles, so the real decision that follows in the same cycle could be
   * applied BEFORE one of those no-ops and be overwritten by it. That is
   * exactly what made the first pass of a scan miss the key on all six
   * in-browser ESP32 engines while the second pass saw it.
   */
  const applied = new Map<number, string>(wires.map((pin) => [pin, `${true}|${true}`]));
  /** Last cycle an edge was placed on each wire — see `at` below. */
  const lastAt = new Map<number, number>();

  const padOf = (pin: number): Readonly<WirePad> => pads.get(pin) ?? RELEASED;

  const settle = (clock: LineClock): HostEdgeFrame[] => {
    const now = clock.now();
    const frames: HostEdgeFrame[] = [];
    for (const [pin, target] of solveKeypad(rows, cols, held, padOf)) {
      const free = target === 'free';
      const level = free ? padOf(pin).level : target === 'high';
      const key = `${level}|${free}`;
      if (applied.get(pin) === key) continue;
      applied.set(pin, key);
      // Strictly after anything already placed on THIS wire. Two guest events
      // can land in the same cycle (a pinMode and the digitalWrite after it,
      // on an engine whose clock does not move between two register writes),
      // and the second decision has to win. A host that keeps its edges in
      // insertion order gets the same answer; one that keeps a heap keyed on
      // the cycle would otherwise be free to apply them the wrong way round.
      const last = lastAt.get(pin);
      const at = last === undefined ? now : Math.max(now, last + 1);
      lastAt.set(pin, free ? at + 1 : at);
      frames.push(
        // The release is one cycle AFTER the level, for the same reason: a
        // release applied before its own inject would leave the pad held by
        // the host at that level on every engine that models pad ownership.
        free
          ? { pin, edges: [{ level, atCycle: at }], releaseAtCycle: at + 1 }
          : { pin, edges: [{ level, atCycle: at }] },
      );
    }
    return frames;
  };

  const model: LineModel = {
    listens: wires,
    drives: wires,
    // Idle on the pull-up every keypad circuit relies on, and not held: a
    // released rest never makes the host the owner of a pad.
    rest: () => wires.map((pin) => ({ pin, level: true, driven: false })),
    onPad(e, clock): LineFrames {
      pads.set(e.pin, { drive: e.drive, pull: e.pull, level: e.level });
      return settle(clock);
    },
    update(props, clock): LineFrames {
      // The hosted path merges every update into the registered record, so
      // `rows` / `cols` arrive again unchanged; a rewire re-attaches instead.
      if (!('pressed' in props)) return null;
      held = heldKeys(props.pressed);
      return settle(clock);
    },
    reset() {
      pads.clear();
      lastAt.clear();
      // Back to what rest() is about to re-apply, not to "unknown": the same
      // reason the map is seeded at construction.
      applied.clear();
      for (const pin of wires) applied.set(pin, `${true}|${true}`);
    },
  };
  return model;
});
