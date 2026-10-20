/**
 * The hosted line-sensor channel on a Linux-guest board.
 *
 * This class deliberately had no `registerSensor` for a long time, so the I2C
 * parts would take their `addI2CDevice` branch and no device was fed twice.
 * These cases are what keeps that true now that it has one: what it takes,
 * what it declines, where the record goes, and that it knows nothing about any
 * particular sensor — the model runs in the backend, or in a
 * {@link PiLineHost} whoever runs the script in the browser installs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PiBridgeShim, type PiLineHost } from '../simulation/PiBridgeShim';
import { PinManager } from '../simulation/PinManager';
import type { RaspberryPi3Bridge } from '../simulation/RaspberryPi3Bridge';
import { clearLineGaps, lineGaps } from '../simulation/line/requestLine';

const RECORD = {
  line_request: true,
  component_id: 'keypad-1',
  rows: [17, 27, 22, 5],
  cols: [6, 13, 19, 26],
  pressed: [],
};

function makeShim() {
  const bridge = {
    sendPinEvent: vi.fn(),
    setSensorState: vi.fn(),
    sendSensorAttach: vi.fn(),
    sendSensorUpdate: vi.fn(),
    sendSensorDetach: vi.fn(),
    sendBusTopology: vi.fn(),
  };
  const host: PiLineHost & {
    attach: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  } = {
    attach: vi.fn(),
    update: vi.fn(),
    detach: vi.fn(),
    ownsPin: (pin: number) => pin === 17,
  };
  const shim = new PiBridgeShim({
    boardId: 'pi-1',
    boardKind: 'raspberry-pi-4',
    bridge: bridge as unknown as RaspberryPi3Bridge,
    pinManager: new PinManager(),
    boardState: () => ({ running: true, engineMode: 'linux' }),
  });
  return { shim, bridge, host };
}

describe('Pi line-sensor channel', () => {
  beforeEach(() => clearLineGaps());

  it('takes a line record, tells the backend, and hands it to a browser host too', () => {
    const { shim, bridge, host } = makeShim();
    shim.lineHost = host;
    expect(shim.registerSensor('matrix-keypad', 17, RECORD)).toBe(true);
    expect(bridge.sendSensorAttach).toHaveBeenCalledWith(
      'matrix-keypad',
      17,
      expect.objectContaining({ rows: RECORD.rows, cols: RECORD.cols }),
    );
    expect(host.attach).toHaveBeenCalledWith(
      expect.objectContaining({ sensor_type: 'matrix-keypad', pin: 17 }),
    );

    shim.updateSensor(17, { pressed: [[1, 2]] });
    expect(bridge.sendSensorUpdate).toHaveBeenCalledWith(
      17,
      expect.objectContaining({ pressed: [[1, 2]] }),
    );
    expect(host.update).toHaveBeenCalledWith(17, { pressed: [[1, 2]] });

    shim.unregisterSensor(17);
    expect(bridge.sendSensorDetach).toHaveBeenCalledWith(17);
    expect(host.detach).toHaveBeenCalledWith(17);
  });

  it('works with no browser host at all: under QEMU the model is the backend\'s', () => {
    const { shim, bridge } = makeShim();
    expect(shim.registerSensor('matrix-keypad', 17, RECORD)).toBe(true);
    expect(bridge.sendSensorAttach).toHaveBeenCalled();
    expect(shim.ownsPin(17)).toBe(false);
    expect(() => {
      shim.updateSensor(17, { pressed: [] });
      shim.unregisterSensor(17);
    }).not.toThrow();
  });

  it('declines anything that is not a line request, so the I2C parts keep their own branch', () => {
    const { shim, bridge, host } = makeShim();
    shim.lineHost = host;
    // What ProtocolParts passes when it probes for a backend sensor channel.
    expect(shim.registerSensor('ssd1306', 200 + 0x3c, { addr: 0x3c })).toBe(false);
    expect(bridge.sendSensorAttach).not.toHaveBeenCalled();
    expect(host.attach).not.toHaveBeenCalled();
    // And an update for a pin it never took touches nothing.
    shim.updateSensor(200 + 0x3c, { addr: 0x3c });
    expect(bridge.sendSensorUpdate).not.toHaveBeenCalled();
  });

  it('a host installed after the part mounted still hears about it', () => {
    // A part attaches when it MOUNTS; the script, and with it the engine that
    // installs the host, starts later.
    const { shim, host } = makeShim();
    shim.registerSensor('matrix-keypad', 17, RECORD);
    expect(host.attach).not.toHaveBeenCalled();
    shim.lineHost = host;
    expect(host.attach).toHaveBeenCalledWith(
      expect.objectContaining({ sensor_type: 'matrix-keypad', pin: 17 }),
    );
  });

  it('a pin the browser host drives is off limits to every other layer', () => {
    const { shim, host } = makeShim();
    shim.lineHost = host;
    shim.registerSensor('matrix-keypad', 17, RECORD);
    expect(shim.ownsPin(17)).toBe(true);
    expect(shim.ownsPin(4)).toBe(false);
  });

  it('says the records again when the guest is fresh', () => {
    const { shim, bridge } = makeShim();
    shim.registerSensor('matrix-keypad', 17, RECORD);
    bridge.sendSensorAttach.mockClear();
    // The backend announces `bus_relay` right after it spawns QEMU; a part
    // that mounted before then sent its attach into a socket that dropped it.
    shim.startBusSync();
    expect(bridge.sendSensorAttach).toHaveBeenCalledWith(
      'matrix-keypad',
      17,
      expect.objectContaining({ rows: RECORD.rows }),
    );
    shim.stopBusSync();
  });

  it('a refusal from the host lands on the component that asked', () => {
    const { shim } = makeShim();
    shim.noteSensorRefused({
      sensor_type: 'dht22',
      pin: 4,
      component_id: 'dht-1',
      why: 'a level, not a timed waveform',
    });
    expect(lineGaps()).toEqual([
      { sensorType: 'dht22', pin: 4, why: 'a level, not a timed waveform', componentId: 'dht-1' },
    ]);
  });
});
