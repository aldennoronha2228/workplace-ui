/**
 * UART controller-port conformance suite (project board-buses-2026-09, F6;
 * TESTS.md layer 2). The UART twin of i2cPortConformance.ts.
 *
 * ONE suite that every engine adapter's UART ports must pass, run against
 * the REAL engine with a guest that really transmits and reads (a compiled
 * firmware fixture, or the engine's own UART registers written the way the
 * core's Serial driver writes them). The suite owns the expectations; each
 * engine only supplies a rig that knows how to make its guest talk and how to
 * report what the guest read.
 *
 * Not a *.test.ts: an engine's test file calls defineUartPortConformance()
 * with its rig factory.
 */

import { describe, it, expect } from 'vitest';
import type { EngineBinding, UartConfig, UartControllerPort, UartRouting } from '../types';
import { baudsMatch, frameName, parseUartFrame } from '../uartFrame';

/** What an engine test supplies. Every method drives the REAL engine. */
export interface UartConformanceRig {
  /** Controller units the SoC has (every one must be exercised). */
  units: number[];
  /** The simulator's binding (getBusBinding()). Called again after rebuilds. */
  binding(): EngineBinding;
  /**
   * Make the guest transmit `bytes` on `unit` (Serial.write) and return once
   * the last one has left the shift register, as far as the engine can tell.
   */
  transmit(unit: number, bytes: number[]): Promise<void>;
  /**
   * Make the guest read up to `n` bytes from `unit`'s RX (Serial.read in a
   * loop, giving up after the guest's own timeout) and report what it got.
   */
  read(unit: number, n: number): Promise<number[]>;
  /** The MCU reset path the product uses for the Reset button. */
  reset(): Promise<void>;
  /** The product's Stop then Run, WITHOUT recompiling. */
  stopRun(): Promise<void>;
  /** Load the firmware again (a recompile of the same sketch). */
  reload(): Promise<void>;
  /** Board pins the controller is expected to be routed to while the guest runs. */
  expectedRouting?(unit: number): UartRouting;
  /** The rate and frame the guest's firmware configured on `unit`. */
  expectedConfig?(unit: number): UartConfig;
  /** Watch GPIO edges the engine reports on a pin (to prove no echo on routed pads). */
  onPinEdge?(pin: number, cb: () => void): () => void;
  /** Free the engine. */
  dispose?(): void;
}

export interface UartConformanceOptions {
  /** Engines whose routing is fixed and reported as 'static'. */
  staticRouting?: boolean;
}

/** Everything the TX handler was called with, in order. */
export class TxProbe {
  heard: number[] = [];
  readonly handler = (byte: number): void => {
    this.heard.push(byte & 0xff);
  };
}

/**
 * Bind a probe on controller `unit` directly at the port. Deliberately
 * independent of the registry, so an engine can be certified before any part
 * moves over.
 */
export function bindTxProbe(
  binding: EngineBinding,
  unit: number,
): { port: UartControllerPort; probe: TxProbe; release: () => void } {
  const port = portOf(binding, unit);
  const probe = new TxProbe();
  port.setTxHandler(probe.handler);
  return { port, probe, release: () => port.setTxHandler(null) };
}

function portOf(binding: EngineBinding, unit: number): UartControllerPort {
  const port = (binding.uart ?? []).find((p) => p.unit === unit);
  if (!port) throw new Error(`engine exposes no UART controller with unit ${unit}`);
  return port;
}

/** Bytes that catch a shifted, inverted or truncated frame: the edge cases of 8N1 and a walk. */
const PATTERN = [0x00, 0xff, 0x55, 0xaa, 0x01, 0x80, 0x7f, 0xfe, ...Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff)];

export function defineUartPortConformance(
  title: string,
  makeRig: () => Promise<UartConformanceRig | null>,
  opts: UartConformanceOptions = {},
): void {
  describe(`UART controller port conformance: ${title}`, () => {
    const withRig = (name: string, body: (rig: UartConformanceRig) => Promise<void>) =>
      it(name, async () => {
        const rig = await makeRig();
        if (!rig) return; // engine not installed here: the rig factory says so
        try {
          await body(rig);
        } finally {
          rig.dispose?.();
        }
      });

    withRig('transmit: every byte the guest sends reaches the TX handler exactly once, in order', async (rig) => {
      for (const unit of rig.units) {
        const { probe, release } = bindTxProbe(rig.binding(), unit);
        await rig.transmit(unit, PATTERN);
        release();
        expect(probe.heard, `unit ${unit}`).toEqual(PATTERN);
      }
    });

    withRig('receive: what is handed to receive() is what the guest reads, in order', async (rig) => {
      for (const unit of rig.units) {
        const port = portOf(rig.binding(), unit);
        for (const b of PATTERN) port.receive(b);
        const got = await rig.read(unit, PATTERN.length);
        expect(got, `unit ${unit}`).toEqual(PATTERN);
      }
    });

    withRig('receive needs no TX handler: bytes land in the guest with none installed', async (rig) => {
      const unit = rig.units[0];
      const port = portOf(rig.binding(), unit);
      port.setTxHandler(null);
      port.receive(0x41);
      port.receive(0x54);
      expect(await rig.read(unit, 2)).toEqual([0x41, 0x54]);
    });

    withRig('one TX handler: installing another replaces the first', async (rig) => {
      const unit = rig.units[0];
      const first = bindTxProbe(rig.binding(), unit);
      const second = bindTxProbe(rig.binding(), unit);
      await rig.transmit(unit, [0x99, 0x42]);
      second.release();
      expect(first.probe.heard).toEqual([]);
      expect(second.probe.heard).toEqual([0x99, 0x42]);
    });

    withRig('unbound: with no TX handler the guest transmits into nothing, and nothing is replayed later', async (rig) => {
      const unit = rig.units[0];
      portOf(rig.binding(), unit).setTxHandler(null);
      await rig.transmit(unit, [0x11, 0x22]);
      const { probe, release } = bindTxProbe(rig.binding(), unit);
      await rig.transmit(unit, [0x33]);
      release();
      expect(probe.heard).toEqual([0x33]);
    });

    withRig('the guest can read its own RX while transmitting: the two directions do not cross', async (rig) => {
      const unit = rig.units[0];
      const port = portOf(rig.binding(), unit);
      const { probe, release } = bindTxProbe(rig.binding(), unit);
      port.receive(0x5a);
      await rig.transmit(unit, [0xa5]);
      const got = await rig.read(unit, 1);
      release();
      // What the guest transmitted never came back as its own RX, and what it
      // received never went out as a TX.
      expect(got).toEqual([0x5a]);
      expect(probe.heard).toEqual([0xa5]);
    });

    withRig('config: the port reports the rate and frame the guest configured', async (rig) => {
      for (const unit of rig.units) {
        const want = rig.expectedConfig?.(unit);
        if (!want) continue;
        await rig.transmit(unit, [0x00]);
        const cfg = portOf(rig.binding(), unit).config();
        if (want.baud !== undefined) {
          expect(cfg.baud, `unit ${unit} baud`).toBeDefined();
          expect(baudsMatch(cfg.baud!, want.baud), `unit ${unit}: ${cfg.baud} vs ${want.baud} baud`).toBe(true);
        }
        if (want.frame !== undefined) {
          expect(cfg.frame, `unit ${unit} frame`).toBeDefined();
          expect(frameName(parseUartFrame(cfg.frame))).toBe(frameName(parseUartFrame(want.frame)));
        }
      }
    });

    const survives = (what: string, step: (rig: UartConformanceRig) => Promise<void>) =>
      withRig(`identity: the same port keeps working after ${what}`, async (rig) => {
        const unit = rig.units[0];
        const portBefore = portOf(rig.binding(), unit);
        const { probe, release } = bindTxProbe(rig.binding(), unit);
        await rig.transmit(unit, [0x11, 0x22]);
        expect(probe.heard).toEqual([0x11, 0x22]);
        await step(rig);
        const portAfter = portOf(rig.binding(), unit);
        expect(portAfter, 'the port object must survive').toBe(portBefore);
        // The handler bound BEFORE must still be the one called, and receive
        // must still reach the (rebuilt) guest.
        await rig.transmit(unit, [0x33]);
        portAfter.receive(0x44);
        const got = await rig.read(unit, 1);
        release();
        expect(probe.heard).toEqual([0x11, 0x22, 0x33]);
        expect(got).toEqual([0x44]);
      });
    survives('an MCU reset', (rig) => rig.reset());
    survives('Stop then Run without recompiling', (rig) => rig.stopRun());
    survives('a firmware reload', (rig) => rig.reload());

    withRig('routing: the port reports where its signals really are', async (rig) => {
      for (const unit of rig.units) {
        const port = portOf(rig.binding(), unit);
        await rig.transmit(unit, [0x00]);
        const r = port.routing();
        if (opts.staticRouting) {
          expect(r).toBe('static');
          continue;
        }
        const want = rig.expectedRouting?.(unit);
        if (!want) continue;
        expect(r).not.toBe('static');
        if (r !== 'static') {
          if (want.tx !== undefined) expect(r.tx, `unit ${unit} tx`).toBe(want.tx);
          if (want.rx !== undefined) expect(r.rx, `unit ${unit} rx`).toBe(want.rx);
        }
      }
    });

    withRig('no echo: pads routed to the controller produce no GPIO edges', async (rig) => {
      if (!rig.onPinEdge) return;
      const unit = rig.units[0];
      const port = portOf(rig.binding(), unit);
      const { release } = bindTxProbe(rig.binding(), unit);
      await rig.transmit(unit, [0x00]);
      const r = port.routing();
      const pins = r === 'static' ? rig.expectedRouting?.(unit) : r;
      const watched = [pins?.tx, pins?.rx].filter((p): p is number => p !== undefined);
      let edges = 0;
      const offs = watched.map((p) => rig.onPinEdge!(p, () => edges++));
      await rig.transmit(unit, PATTERN);
      for (const b of PATTERN) port.receive(b);
      await rig.read(unit, PATTERN.length);
      for (const off of offs) off();
      release();
      // The software decoder would otherwise read the same bytes a second time.
      expect(edges).toBe(0);
    });
  });
}
