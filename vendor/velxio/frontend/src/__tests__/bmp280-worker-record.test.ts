// @vitest-environment jsdom
/**
 * The worker record of a BMP280 on a QEMU board says the address its part
 * answers at (project i2c-model-fidelity-2026-09).
 *
 * A QEMU board gets the record of an I2C sensor twice: from the store, in the
 * start payload, so the worker has the chip before the firmware probes the
 * bus, and from the part when it attaches. Both are keyed by the part's
 * worker slot, so they are one record in the worker, and the address of that
 * record is the address the guest finds the chip at.
 *
 * The part reads `i2cAddress ?? address` and holds the result to the two
 * addresses SDO selects. The store read `address` alone: with `i2cAddress`
 * set to 0x77, which is how a Grove BMP280 says it, the start payload filed
 * the chip at 0x76.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks (same shape as hcsr04-divider-echo.test.ts) ────────────────────────
vi.mock('../simulation/AVRSimulator', () => ({
  AVRSimulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onBaudRateChange = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadHex = vi.fn();
    this.addI2CDevice = vi.fn();
    this.setPinState = vi.fn();
  }),
}));

vi.mock('../simulation/RP2040Simulator', () => ({
  RP2040Simulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadBinary = vi.fn();
    this.addI2CDevice = vi.fn();
    this.attachPioPeripheral = vi.fn();
    this.spi = { onByte: null, completeTransfer: vi.fn() };
  }),
}));

vi.mock('../simulation/PinManager', () => ({
  PinManager: vi.fn(function (this: any) {
    this.updatePort = vi.fn();
    this.onPinChange = vi.fn().mockReturnValue(() => {});
    this.getListenersCount = vi.fn().mockReturnValue(0);
    this.hardResetPinStates = vi.fn();
    this.resetPinStates = vi.fn();
    this.getOutputPins = vi.fn().mockReturnValue(new Set<number>());
  }),
}));

vi.mock('../store/useOscilloscopeStore', () => ({
  useOscilloscopeStore: {
    getState: vi.fn().mockReturnValue({ channels: [], pushSample: vi.fn() }),
  },
}));

class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  get messages(): Array<{ type: string; data: Record<string, unknown> }> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

import { useSimulatorStore, getEsp32Bridge, i2cSensorAddress } from '../store/useSimulatorStore';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import { i2cPartWorkerPin } from '../simulation/parts/i2cPart';
import { busRegistry } from '../simulation/buses';

const BOARD = 'esp32';
const PART = 'bmp280_1';

/** What the part files for the worker when it attaches to a QEMU board. */
function partRecord(properties: Record<string, unknown>): Record<string, unknown> {
  const sim = {
    registerSensor: vi.fn(),
    updateSensor: vi.fn(),
    unregisterSensor: vi.fn(),
    pinManager: { onPinChange: vi.fn().mockReturnValue(() => {}) },
    setPinState: vi.fn(),
  };
  const element = { addEventListener: vi.fn(), removeEventListener: vi.fn(), ...properties };
  const off = PartSimulationRegistry.get('bmp280')!.attachEvents!(
    element as unknown as HTMLElement,
    sim as never,
    () => null,
    PART,
  );
  off();
  expect(sim.registerSensor).toHaveBeenCalledTimes(1);
  const [type, pin, props] = sim.registerSensor.mock.calls[0];
  return { sensor_type: type, pin, ...(props as Record<string, unknown>) };
}

/** What the store files in the start payload of the board. */
function startRecord(properties: Record<string, unknown>): Record<string, unknown> | undefined {
  useSimulatorStore.setState({ boards: [], components: [], wires: [] } as never);
  useSimulatorStore.getState().addBoard(BOARD as never, 0, 0, BOARD);
  useSimulatorStore
    .getState()
    .setComponents([{ id: PART, metadataId: 'bmp280', x: 0, y: 0, properties }] as never);
  const bridge = getEsp32Bridge(BOARD)!;
  useSimulatorStore.getState().startBoard(BOARD);
  const socket = (bridge as unknown as { socket: MockWebSocket }).socket;
  socket.open();
  const start = socket.messages.find((m) => m.type === 'start_esp32');
  expect(start, 'start_esp32 was sent').toBeDefined();
  const sensors = start!.data.sensors as Array<Record<string, unknown>>;
  return sensors.find((s) => s.sensor_type === 'bmp280');
}

const CASES: Array<[string, Record<string, unknown>, number]> = [
  ['nothing set', {}, 0x76],
  ['address 0x77', { address: '0x77' }, 0x77],
  ['i2cAddress 0x77, the Grove BMP280', { i2cAddress: '0x77' }, 0x77],
  ['i2cAddress as a number', { i2cAddress: 0x77 }, 0x77],
  ['i2cAddress in decimal', { i2cAddress: '119' }, 0x77],
  ['i2cAddress with a capital X', { i2cAddress: '0X77' }, 0x77],
  ['i2cAddress before address', { i2cAddress: '0x77', address: '0x76' }, 0x77],
  ['an address the chip does not have', { i2cAddress: '0x3C' }, 0x76],
  ['an address that is no number', { address: 'high' }, 0x76],
  ['an empty address', { i2cAddress: '', address: '0x77' }, 0x76],
];

describe('bmp280: the address of its worker record', () => {
  beforeEach(() => {
    busRegistry.clear();
  });
  afterEach(() => {
    useSimulatorStore.setState({ boards: [], components: [], wires: [] } as never);
    busRegistry.clear();
  });

  it.each(CASES)('%s: the store and the part say the same', (_name, properties, addr) => {
    expect(partRecord(properties).addr, 'the part').toBe(addr);
    expect(i2cSensorAddress('bmp280', properties), 'the store').toBe(addr);
  });

  it.each(CASES)('%s: the start payload of a QEMU board carries it', (_name, properties, addr) => {
    const rec = startRecord(properties);
    expect(rec).toMatchObject({ sensor_type: 'bmp280', addr, owner: PART });
    expect(rec!.pin, 'the slot of the part, so the two records are one').toBe(
      i2cPartWorkerPin(PART),
    );
  });

  it('the start payload carries the values of the component with the address', () => {
    expect(startRecord({ i2cAddress: '0x77', temperature: '31.5', pressure: '990' })).toMatchObject(
      {
        addr: 0x77,
        temperature: 31.5,
        pressure: 990,
      },
    );
  });
});

describe('the worker records of the other I2C sensors keep their address', () => {
  it('mpu6050: AD0 selects 0x69', () => {
    expect(i2cSensorAddress('mpu6050', {})).toBe(0x68);
    expect(i2cSensorAddress('mpu6050', { ad0: true })).toBe(0x69);
    expect(i2cSensorAddress('mpu6050', { ad0: 'true' })).toBe(0x69);
    expect(i2cSensorAddress('mpu6050', { ad0: '1' })).toBe(0x69);
    expect(i2cSensorAddress('mpu6050', { ad0: false })).toBe(0x68);
    expect(i2cSensorAddress('mpu6050', { ad0: 'false' })).toBe(0x68);
  });

  it('pcf8574: any address the property says', () => {
    expect(i2cSensorAddress('pcf8574', {})).toBe(0x27);
    expect(i2cSensorAddress('pcf8574', { i2cAddress: '0x3F' })).toBe(0x3f);
    expect(i2cSensorAddress('pcf8574', { i2cAddress: '39' })).toBe(0x27);
    expect(i2cSensorAddress('pcf8574', { i2cAddress: 0x20 })).toBe(0x20);
    expect(i2cSensorAddress('pcf8574', { i2cAddress: 'x' })).toBe(0x27);
  });

  it('a chip with one address has it whatever the properties say', () => {
    expect(i2cSensorAddress('ds3231', { address: '0x77', i2cAddress: '0x77' })).toBe(0x68);
    expect(i2cSensorAddress('ssd1306', { i2cAddress: '0x3D' })).toBe(0x3c);
  });

  it('a part with no worker record has none', () => {
    expect(i2cSensorAddress('led', {})).toBeNull();
  });
});
