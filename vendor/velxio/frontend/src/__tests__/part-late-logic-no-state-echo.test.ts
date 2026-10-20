// @vitest-environment jsdom
/**
 * A part whose logic registers AFTER the canvas subscribed it to a board pin
 * (every overlay part: the pro Grove bricks arrive with a dynamic import, after
 * a project or a restored draft already listed them) must never get the
 * generic pin echo written into its project properties, and one part that
 * cannot draw must not take the editor down.
 *
 * The 2026-09-28 blank editor: a draft with a Grove AS3935 and a BMP280 on the
 * same I2C lines. The BMP280 attached first, its I2C bus put its pull-ups on
 * SDA and SCL (PR #369), the level moved, and the canvas, which had decided at
 * subscription time that the not-yet-registered AS3935 was a plain output,
 * wrote `state: false` into its properties. The canvas then assigned that to
 * the element, whose `state` is its drawing state, and the drawing threw from
 * connectedCallback and from `pinInfo` inside PinOverlay's effect. With no
 * error boundary anywhere, React unmounted the whole page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { pinStateEchoHandler } from '../components/simulator/pinStateEcho';
import { PartErrorBoundary } from '../components/simulator/PartErrorBoundary';
import { readPinInfo } from '../utils/readPinInfo';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LATE = 'test-late-overlay-part';
const PLAIN = 'test-plain-output-part';

/** What SimulatorCanvas subscribes for a wired part, with the app's registries. */
function subscribe(pm: PinManager, id: string, metadataId: string, known: Set<string>, gnd = true) {
  return pm.onPinChange(
    18,
    pinStateEchoHandler({
      componentId: id,
      metadataId,
      componentPinName: 'SDA',
      wireConnected: true,
      hasGndWire: () => gnd,
      isKnownPart: (m) => known.has(m),
      ownsVisualsAnyway: () => false,
      getLogic: (m) => PartSimulationRegistry.get(m),
      updateComponentState: useSimulatorStore.getState().updateComponentState,
    }),
  );
}

const props = (id: string) =>
  useSimulatorStore.getState().components.find((c) => c.id === id)!.properties;

describe('the canvas pin echo decides per change, and skips a part it does not know', () => {
  beforeEach(() => {
    useSimulatorStore.getState().setComponents([
      { id: 'late', metadataId: LATE, x: 0, y: 0, properties: { distance_km: 12 } },
      { id: 'plain', metadataId: PLAIN, x: 0, y: 0, properties: {} },
    ] as never);
  });
  afterEach(() => {
    useSimulatorStore.getState().setComponents([] as never);
    document.body.innerHTML = '';
  });

  it('writes nothing into a part that is neither registered nor has logic yet', () => {
    const pm = new PinManager();
    const known = new Set<string>([PLAIN]);
    const off = subscribe(pm, 'late', LATE, known);
    // An I2C bus attaching puts its pull-up on SDA: the level moves.
    pm.triggerPinChange(18, true);
    pm.triggerPinChange(18, false);
    expect(props('late')).toEqual({ distance_km: 12 });
    expect('state' in props('late')).toBe(false);
    off();
  });

  it('treats a part whose logic registers after the subscription as self-managed from then on', () => {
    const pm = new PinManager();
    const known = new Set<string>([PLAIN]);
    const off = subscribe(pm, 'late', LATE, known);
    const el = document.createElement('div');
    el.id = 'late';
    document.body.appendChild(el);
    const onPin = vi.fn();
    // The overlay lands: metadata and logic.
    known.add(LATE);
    PartSimulationRegistry.register(LATE, {
      attachEvents: () => () => {},
      onPinStateChange: onPin,
    });
    pm.triggerPinChange(18, true);
    expect('state' in props('late')).toBe(false);
    expect(onPin).toHaveBeenCalledWith('SDA', true, el);
    off();
  });

  it('still echoes the level into a known plain output, gated on its GND wire', () => {
    const pm = new PinManager();
    const known = new Set<string>([PLAIN]);
    const off = subscribe(pm, 'plain', PLAIN, known);
    pm.triggerPinChange(18, true);
    expect(props('plain')).toMatchObject({ state: true, value: true });
    off();
    const pm2 = new PinManager();
    const off2 = subscribe(pm2, 'plain', PLAIN, known, false);
    pm2.triggerPinChange(18, true);
    expect(props('plain')).toMatchObject({ state: false, value: false });
    off2();
  });
});

describe('one part that throws costs one part, not the editor', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  it('a part whose pins throw inside an effect draws as a fallback box, its neighbours survive', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // PinOverlay's shape: an effect that reads the element's pinInfo.
    const Broken = () => {
      useEffect(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'event_kind')");
      }, []);
      return createElement('div', { id: 'broken-body' });
    };
    const Healthy = () => createElement('div', { id: 'healthy-body' });
    const part = (id: string, child: () => ReturnType<typeof createElement>, resetKey: unknown) =>
      createElement(PartErrorBoundary, {
        key: id,
        partId: id,
        label: id,
        x: 10,
        y: 20,
        resetKey,
        children: createElement(child),
      });
    act(() => root.render(createElement('div', null, part('a', Broken, 1), part('b', Healthy, 1))));
    expect(host.querySelector('#healthy-body')).not.toBeNull();
    const fallback = host.querySelector<HTMLElement>('[data-part-error="a"]');
    expect(fallback).not.toBeNull();
    expect(fallback!.style.left).toBe('10px');
    errors.mockRestore();
  });

  it('readPinInfo answers undefined for an element whose pinInfo getter throws', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const el = document.createElement('div');
    Object.defineProperty(el, 'pinInfo', {
      get() {
        throw new TypeError("Cannot read properties of undefined (reading 'angle')");
      },
    });
    expect(readPinInfo(el)).toBeUndefined();
    const ok = document.createElement('div');
    Object.defineProperty(ok, 'pinInfo', { value: [{ name: 'SDA', x: 1, y: 2 }] });
    expect(readPinInfo(ok)).toEqual([{ name: 'SDA', x: 1, y: 2 }]);
    errors.mockRestore();
  });
});
