/**
 * An incremental quadrature encoder's A and B outputs: the hall or optical
 * disc on the back of a gear motor, or a rotary knob turned by hand.
 *
 * The device is two square waves a quarter period apart. Which one leads is
 * the direction, and every edge on either is one count to a x4 decoder (an
 * ESP32 PCNT unit, an ESP32Encoder, Paul Stoffregen's Encoder library on an
 * Uno's pin-change interrupts). A motor at 6000 rpm behind an 11-pulse disc
 * puts 4400 edges a second on the wire, so the edges have to land on the
 * guest's own clock: nothing an animation frame can toggle comes close.
 *
 * The model speaks unprompted, like the IR demodulator: the canvas part owns
 * the physics (how fast the shaft turns) and reports it through `update`
 * with `countsPerSecond`, signed, A leading for positive. The model keeps the
 * shaft's POSITION, in counts, continuous across every change of speed, and
 * answers each update with the edges of the next stretch of guest time.
 *
 * Edges on the wire cannot be taken back, so each update schedules only a
 * short horizon past the current cycle, sized from how much guest time passed
 * since the previous update: twice that, so one late frame never leaves a
 * gap, and a speed change reaches the wire within about two frames of guest
 * time however fast the board runs against the wall clock.
 */

import type { HostEdge, HostEdgeFrame } from '../LineTimeline';
import { numberField, registerLineModel, type LineClock, type LineModel } from '../lineModels';

/** (A, B) for quadrature state s mod 4; A leads B going up. */
const STATE: ReadonlyArray<readonly [boolean, boolean]> = [
  [false, false],
  [true, false],
  [true, true],
  [false, true],
];

const mod4 = (n: number) => ((n % 4) + 4) % 4;

/** Horizon bounds in microseconds of guest time. */
const MIN_HORIZON_US = 2_000;
const MAX_HORIZON_US = 1_000_000;
/** Before two updates have been seen, assume a 60 Hz caller. */
const DEFAULT_INTERVAL_US = 16_667;
/** Hard cap on edges per update: a runaway speed must not flood the engine's heap. */
const MAX_EDGES_PER_UPDATE = 20_000;

/**
 * Edges for the shaft moving from `from` to `to` counts (fractional) between
 * cycles `t0` and `t1` at constant speed. The state is floor(position):
 * crossing integer k upward enters state k, downward state k - 1, and states
 * k - 1 and k differ on A when k - 1 is even, on B when it is odd.
 */
export function quadratureEdges(
  from: number,
  to: number,
  t0: number,
  t1: number,
  maxEdges = MAX_EDGES_PER_UPDATE,
): { a: HostEdge[]; b: HostEdge[] } {
  const a: HostEdge[] = [];
  const b: HostEdge[] = [];
  if (to === from || t1 <= t0) return { a, b };
  const up = to > from;
  // Boundaries crossed: integers in (from, to] going up, in (to, from] going down.
  const ks: number[] = [];
  if (up) {
    for (let k = Math.floor(from) + 1; k <= to && ks.length < maxEdges; k++) ks.push(k);
  } else {
    for (let k = Math.floor(from); k > to && ks.length < maxEdges; k--) ks.push(k);
  }
  let lastCycle = -Infinity;
  for (const k of ks) {
    const frac = (k - from) / (to - from);
    const at = Math.max(Math.round(t0 + frac * (t1 - t0)), lastCycle + 1);
    lastCycle = at;
    const after = up ? k : k - 1;
    const [la, lb] = STATE[mod4(after)];
    if (mod4(k - 1) % 2 === 0) a.push({ level: la, atCycle: at });
    else b.push({ level: lb, atCycle: at });
  }
  return { a, b };
}

registerLineModel('quadrature-encoder', (rec) => {
  const pinA = rec.pin;
  const pinB = numberField(rec.b_pin, -1);
  let cps = numberField(rec.countsPerSecond, 0);
  /** Shaft position in counts at `until`. */
  let position = 0;
  /** Guest cycle up to which edges are on the wire. */
  let until = -Infinity;
  let lastNow = -Infinity;
  let intervalUs = DEFAULT_INTERVAL_US;
  let lastIntervalUs = DEFAULT_INTERVAL_US;

  const level = (): readonly [boolean, boolean] => STATE[mod4(Math.floor(position))];

  const model: LineModel = {
    listens: [],
    drives: pinB >= 0 ? [pinA, pinB] : [pinA],
    rest: () => {
      const [la, lb] = level();
      const out = [{ pin: pinA, level: la, driven: true }];
      if (pinB >= 0) out.push({ pin: pinB, level: lb, driven: true });
      return out;
    },
    onPad: () => null,
    update(props, clock?: LineClock) {
      if ('countsPerSecond' in props) cps = numberField(props.countsPerSecond, cps);
      if (!clock) return null;
      const now = clock.now();
      const cyclesPerUs = clock.us(1_000_000) / 1_000_000;
      if (!(cyclesPerUs > 0)) return null;
      if (now < lastNow) {
        // The guest rebooted under us: whatever was queued belongs to the old uptime.
        until = -Infinity;
      }
      if (lastNow > -Infinity && now > lastNow) {
        lastIntervalUs = (now - lastNow) / cyclesPerUs;
        intervalUs = intervalUs * 0.7 + lastIntervalUs * 0.3;
      }
      lastNow = now;

      // A shaft that stood still (or updates that stopped) resumes from now.
      if (until < now) until = now;
      // The longer of the last interval and the running average: a board that just
      // sped up (an idle skip) is covered at once, and one short frame does not
      // shrink the cover for the next long one.
      const horizonUs = Math.min(
        MAX_HORIZON_US,
        Math.max(MIN_HORIZON_US, 2 * Math.max(intervalUs, lastIntervalUs)),
      );
      const end = now + horizonUs * cyclesPerUs;
      if (end <= until) return null;

      // Never faster than one edge per two cycles: edges on one pin must stay ascending.
      const maxCps = (cyclesPerUs * 1_000_000) / 2;
      const speed = Math.max(-maxCps, Math.min(maxCps, cps));
      const from = position;
      // The position only moves as far as the edges put on the wire can carry it,
      // so the pads and the count never disagree.
      const travel = (speed * (end - until)) / (cyclesPerUs * 1_000_000);
      const limit = MAX_EDGES_PER_UPDATE - 1;
      const to = from + Math.max(-limit, Math.min(limit, travel));
      const { a, b } = quadratureEdges(from, to, until, end);
      position = to;
      until = end;

      const frames: HostEdgeFrame[] = [];
      // selfTimed false: a quadrature decoder resolves edges by interrupt or in
      // hardware, never by counting its own loop iterations, and a floor held for
      // as long as a motor turns would stop every idle skip on the board.
      if (a.length) frames.push({ pin: pinA, edges: a, selfTimed: false });
      if (b.length && pinB >= 0) frames.push({ pin: pinB, edges: b, selfTimed: false });
      return frames.length ? frames : null;
    },
    reset() {
      until = -Infinity;
      lastNow = -Infinity;
      intervalUs = DEFAULT_INTERVAL_US;
      lastIntervalUs = DEFAULT_INTERVAL_US;
    },
  };
  return model;
});
