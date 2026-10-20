/**
 * The quadrature encoder model, decoded the way the guest decodes it: a x4
 * state machine over the edges the model hands the board, in cycle order.
 */
import { describe, expect, it } from 'vitest';
import { LineSensorHub } from '../LineSensorHub';
import type { LineHostPort } from '../LineHost';
import { quadratureEdges } from '../models/quadrature-encoder';
import '../index';

const HZ = 16_000_000;
const PIN_A = 2;
const PIN_B = 3;

function rig() {
  let now = 0;
  const edges: Array<{ pin: number; level: boolean; at: number }> = [];
  const rests = new Map<number, boolean>();
  const port: LineHostPort = {
    now: () => now,
    clockHz: () => HZ,
    scheduleEdge: (pin, level, at) => edges.push({ pin, level, at }),
    onPad: () => () => {},
    restPad: (pin, level) => rests.set(pin, level),
  };
  const hub = new LineSensorHub(port);
  hub.attach({ sensor_type: 'quadrature-encoder', pin: PIN_A, b_pin: PIN_B, countsPerSecond: 0 });
  /** A software x4 decoder, fed every edge due by `upTo` in cycle order. */
  let a = rests.get(PIN_A) ?? false;
  let b = rests.get(PIN_B) ?? false;
  let count = 0;
  let consumed = 0;
  let lastAt = -Infinity;
  const decode = (upTo: number) => {
    const fresh = edges.slice(consumed);
    consumed = edges.length;
    pending.push(...fresh);
    pending.sort((x, y) => x.at - y.at);
    while (pending.length && pending[0].at <= upTo) {
      const e = pending.shift()!;
      expect(e.at).toBeGreaterThanOrEqual(lastAt);
      lastAt = e.at;
      const prev = (a ? 2 : 0) | (b ? 1 : 0);
      if (e.pin === PIN_A) a = e.level;
      else b = e.level;
      const next = (a ? 2 : 0) | (b ? 1 : 0);
      // Gray order going up: 00 -> 10 -> 11 -> 01 -> 00.
      const order = [0b00, 0b10, 0b11, 0b01];
      const d = (order.indexOf(next) - order.indexOf(prev) + 4) % 4;
      expect(d === 1 || d === 3).toBe(true); // one step at a time, never a skipped state
      count += d === 1 ? 1 : -1;
    }
  };
  const pending: Array<{ pin: number; level: boolean; at: number }> = [];
  /** Advance guest time in `frameUs` steps, updating the model at each. */
  const run = (cps: number, us: number, frameUs = 16_667) => {
    for (let t = 0; t < us; t += frameUs) {
      hub.update(PIN_A, { countsPerSecond: cps });
      now += Math.round((frameUs * HZ) / 1e6);
      decode(now);
    }
  };
  return { hub, run, count: () => count, edges, now: () => now };
}

describe('quadrature encoder line model', () => {
  it('quadratureEdges walks the Gray sequence one pin at a time', () => {
    const up = quadratureEdges(0, 4, 0, 400);
    expect(up.a.map((e) => [e.level, e.atCycle])).toEqual([
      [true, 100],
      [false, 300],
    ]);
    expect(up.b.map((e) => [e.level, e.atCycle])).toEqual([
      [true, 200],
      [false, 400],
    ]);
    const down = quadratureEdges(4, 0, 0, 400);
    // From state 4 (00): B rises first going down (state 3 = 01).
    expect(down.b[0]).toEqual({ level: true, atCycle: 0 });
    expect(quadratureEdges(0.5, 0.9, 0, 100)).toEqual({ a: [], b: [] });
  });

  it('counts what the shaft travelled, forwards and backwards, through speed changes', () => {
    const r = rig();
    r.run(1000, 500_000); // 1000 counts/s for 0.5 s
    expect(Math.abs(r.count() - 500)).toBeLessThanOrEqual(35); // the horizon still ahead
    r.run(4400, 1_000_000);
    r.run(-2000, 1_000_000);
    r.run(0, 200_000); // stop: everything queued lands
    // 0.5*1000 + 1*4400 - 1*2000 = 2900, plus the horizon queued at each change.
    expect(Math.abs(r.count() - 2900)).toBeLessThanOrEqual(150);
    const held = r.count();
    r.run(0, 500_000);
    expect(r.count()).toBe(held); // a stopped shaft puts nothing on the wire
  });

  it('keeps the position continuous: every scheduled count is decoded, none twice', () => {
    const r = rig();
    for (const speed of [300, 1200, 5000, 2500, -800, 40, 0]) r.run(speed, 250_000);
    r.run(0, 2_000_000); // drain everything queued
    // Net edges scheduled on the wire, signed by the decoder, equal the count; and
    // the pads end in the state the count says (state = count mod 4).
    const held = r.count();
    r.run(0, 500_000);
    expect(r.count()).toBe(held);
    // 0.25 s at each speed: 75 + 300 + 1250 + 625 - 200 + 10 = 2060, within the
    // horizons that straddled each change.
    expect(Math.abs(held - 2060)).toBeLessThanOrEqual(80);
  });

  it('adapts the horizon to a board running faster than the frames', () => {
    const r = rig();
    // 200 ms of guest time per update (a board fast-forwarding idle): no gaps.
    r.run(1000, 2_000_000, 200_000);
    // Without an adaptive horizon each 200 ms frame would carry only ~33 ms of edges
    // and the count would come out near 330.
    expect(Math.abs(r.count() - 2000)).toBeLessThanOrEqual(420); // one horizon ahead at most
  });
});
