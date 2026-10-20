/**
 * A custom chip on an STM32 board is hosted by the board's worker.
 *
 * The STM32 worker has attached `custom-chip` sensors (I2C slave, pin
 * watches, timers) since it was split from the ESP32 one, but the shim
 * lacked the `sendPinEvent` name detectSimulatorKind keys on, so a user's
 * chip ran in the browser with GPIO alone and the worker never saw it.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../simulation/Stm32Bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../simulation/Stm32Bridge')>()),
  Stm32Bridge: class {
    boardId: string;
    boardKind: string;
    connected = false;
    onSerialData: unknown = null;
    onPinChange: unknown = null;
    onPinDir: unknown = null;
    onError: unknown = null;
    onDisconnected: unknown = null;
    onBooted: unknown = null;
    attached: unknown[] = [];
    constructor(id: string, kind: string) {
      this.boardId = id;
      this.boardKind = kind;
    }
    connect() {}
    disconnect() {}
    sendPinEvent() {}
    sendSensorAttach(sensorType: string, pin: number, properties: Record<string, unknown>) {
      this.attached.push({ sensorType, pin, properties });
    }
    sendSensorUpdate() {}
    sendSensorDetach() {}
  },
}));

import { useSimulatorStore, getBoardSimulator } from '../store/useSimulatorStore';
import { detectSimulatorKind, hostsChipsInWorker } from '../simulation/customChips/simulatorBridges';

describe('a custom chip on an STM32 board', () => {
  it('takes the worker path: esp32-kind simulator that hosts chips', () => {
    const id = useSimulatorStore.getState().addBoard('stm32-bluepill' as never, 100, 100);
    const shim = getBoardSimulator(id) as unknown as {
      registerSensor: (t: string, p: number, props: Record<string, unknown>) => boolean;
      getBridge: () => { attached: Array<{ sensorType: string; pin: number; properties: unknown }> };
    };
    expect(detectSimulatorKind(shim)).toBe('esp32');
    expect(hostsChipsInWorker(shim)).toBe(true);
    // What CustomChipPart does next: the record reaches the worker.
    expect(shim.registerSensor('custom-chip', 0xff, { wasm_b64: 'AA==', pin_map: { IN: 5 } })).toBe(true);
    expect(shim.getBridge().attached).toEqual([
      { sensorType: 'custom-chip', pin: 0xff, properties: { wasm_b64: 'AA==', pin_map: { IN: 5 } } },
    ]);
  });
});
