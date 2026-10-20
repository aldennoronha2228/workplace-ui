/**
 * One default per sensor: a sensor the project leaves unset starts where its
 * control definition says, the number the panel's slider and the property
 * dialog's field show for it.
 *
 * The parts used to start from literals of their own: the BMP280 at 25 C with
 * its panel and dialog at 24, the MPU-6050's die at 25 C against 24, the gas
 * sensor at 1.5 V (a gas level of about 307) against 100 and the flame sensor
 * at 4.5 V (an intensity of about 102) against 0. They met the control
 * default only once the panel was opened or Reset replayed the full set. Now
 * the canvas hands every attached sensor its project values WITH the control
 * defaults for what the project leaves unset (replayProjectSensorValuesOnAttach),
 * and those parts read their own start from the control definition too
 * (sensorControlDefault). The real-firmware reading (the sketch prints 24.0 C
 * for an unset BMP280) is in reset-sensor-project-values.test.ts; the part
 * starts themselves are in protocol-parts / sensor-parts.
 *
 * Here: every catalogue part with a sensor control, attached on a real board
 * of the store the way DynamicComponent attaches it, receives its control
 * default for every slider on the first Run, and a value the project sets
 * wins over it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const win = Object.assign(new EventTarget(), {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
vi.stubGlobal('window', win);
vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});

import {
  useSimulatorStore,
  getBoardSimulator,
  replayProjectSensorValuesOnAttach,
} from '../store/useSimulatorStore';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts';
import { getSensorUpdate, registerSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { SENSOR_CONTROLS, type SensorControlDef } from '../simulation/sensorControlConfig';

const BOARD = 'arduino-uno-defaults';

beforeEach(() => {
  useSimulatorStore.setState({ components: [], wires: [] } as never);
  useSimulatorStore.getState().addBoard('arduino-uno', 0, 0, BOARD);
  useSimulatorStore.getState().setActiveBoardId(BOARD);
});
afterEach(() => {
  useSimulatorStore.getState().removeBoard(BOARD);
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});

/**
 * Attach `metadataId` the way DynamicComponent does (properties copied onto
 * the element, attachEvents, then the project replay) and return what the
 * part's sensor-update callback received on the way in, merged; null when
 * the part registered no callback.
 */
function firstRun(
  metadataId: string,
  properties: Record<string, unknown>,
): Record<string, number | boolean> | null {
  const id = `${metadataId}-1`;
  useSimulatorStore.getState().setComponents([
    { id, metadataId, x: 0, y: 0, properties },
  ] as never);
  const el = Object.assign(new EventTarget(), properties) as never;
  const cleanup = PartSimulationRegistry.get(metadataId)!.attachEvents!(
    el,
    boardSimulator() as never,
    // Every pin wired to A0: analog parts inject there, the rest need a pin.
    () => 14,
    id,
  );
  try {
    const partCb = getSensorUpdate(id);
    if (!partCb) return null;
    const got: Record<string, number | boolean> = {};
    registerSensorUpdate(id, (values) => {
      Object.assign(got, values);
      partCb(values);
    });
    replayProjectSensorValuesOnAttach(id);
    return got;
  } finally {
    cleanup?.();
  }
}

const boardSimulator = () => getBoardSimulator(BOARD);

const sliders = (def: SensorControlDef) => def.controls.filter((c) => c.type === 'slider');

describe('a sensor the project leaves unset starts on its control default', () => {
  const ids = Object.keys(SENSOR_CONTROLS).filter((id) => sliders(SENSOR_CONTROLS[id]).length > 0);

  it('covers every catalogue sensor with a slider', () => {
    expect(ids.length).toBeGreaterThanOrEqual(14);
    for (const id of ids) expect(PartSimulationRegistry.get(id), id).toBeDefined();
  });

  it.each(ids)('%s: the first run hands the part every slider at its control default', (id) => {
    const def = SENSOR_CONTROLS[id];
    const got = firstRun(id, {});
    expect(got, `${id} registered no sensor-update callback`).not.toBeNull();
    for (const c of sliders(def)) {
      if (c.type !== 'slider') continue;
      expect(got![c.key], `${id}.${c.key}`).toBe(def.defaultValues[c.key]);
      expect(def.defaultValues[c.key], `${id}.${c.key}: defaultValues vs the slider`).toBe(c.defaultValue);
    }
  });

  it('a value the project sets wins over the default (BMP280 at 31 C, pressure unset)', () => {
    const got = firstRun('bmp280', { temperature: '31' });
    expect(got).toEqual({ temperature: 31, pressure: 1013.25 });
  });

  it('a value stored under another property name wins too (IR remote irCommand)', () => {
    const got = firstRun('ir-receiver', { irCommand: '0x18' });
    expect(got).toEqual({ address: 0, command: 0x18 });
  });
});
