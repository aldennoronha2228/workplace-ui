/**
 * Displays and expanders on a board whose firmware runs in a QEMU worker
 * (project i2c-model-fidelity-2026-09, item "displays").
 *
 * The worker answers the guest from a write sink and echoes every write phase
 * (`i2c_transaction`); the part in the tab draws from the echo. The echo now
 * names the part it came from, and the board's shim hands it to that part
 * only: keyed by address, two panels at 0x3C on Wire and Wire1 were one
 * listener, the last to attach drew both streams, and detaching either
 * silenced both. The worker's record of an expander carries the outside of its
 * pins, which its latch reads back through (test_i2c_write_sink.py).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import { busRegistry } from '../simulation/buses';
import { I2cEchoListeners } from '../simulation/buses/i2cEchoListeners';
import { Esp32BridgeShim } from '../store/useSimulatorStore';
import type { Esp32Bridge } from '../simulation/Esp32Bridge';

if (typeof globalThis.ImageData === 'undefined') {
  (globalThis as { ImageData?: unknown }).ImageData = class {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  busRegistry.clear();
});

/** An ESP32 bridge with no socket: what the shim sends, and the echo hook. */
function fakeBridge() {
  const attached: Array<{ type: string; pin: number; props: Record<string, unknown> }> = [];
  const bridge = {
    boardId: 'esp',
    boardKind: 'esp32',
    sendSerialBytes: () => {},
    sendSensorAttach: (type: string, pin: number, props: Record<string, unknown>) =>
      attached.push({ type, pin, props }),
    sendSensorDetach: () => {},
    sendSensorUpdate: () => {},
    onI2cTransaction: null as ((addr: number, data: number[], owner?: string) => void) | null,
  };
  const shim = new Esp32BridgeShim(bridge as unknown as Esp32Bridge, new PinManager());
  return { bridge, shim, attached };
}

function oled() {
  return {
    imageData: new ImageData(128, 64),
    redraw: vi.fn(),
    addEventListener() {},
    removeEventListener() {},
  };
}

const litCount = (el: { imageData: ImageData }) => {
  let n = 0;
  for (let i = 0; i < el.imageData.data.length; i += 4) if (el.imageData.data[i] !== 0) n++;
  return n;
};

/** One column of eight pixels at the cursor (page mode, column 0, page 0). */
const PIXELS = [0x40, 0xff];
/** Display on, upright: what every driver's init sends; the panel powers up off. */
const PANEL_ON = [0x00, 0xaf, 0xa1, 0xc8];

describe('two SSD1306 at 0x3C on one QEMU board', () => {
  it('each draws the write phases the worker names it for', () => {
    const { bridge, shim } = fakeBridge();
    const a = oled();
    const b = oled();
    const logic = PartSimulationRegistry.get('ssd1306-i2c-4pin')!;
    logic.attachEvents!(a as unknown as HTMLElement, shim as never, () => null, 'oledA');
    logic.attachEvents!(b as unknown as HTMLElement, shim as never, () => null, 'oledB');

    bridge.onI2cTransaction!(0x3c, PANEL_ON, 'oledA');
    bridge.onI2cTransaction!(0x3c, PANEL_ON, 'oledB');
    bridge.onI2cTransaction!(0x3c, PIXELS, 'oledA');
    expect([litCount(a), litCount(b)]).toEqual([8, 0]);
  });

  it('detaching one leaves the other drawing', () => {
    const { bridge, shim } = fakeBridge();
    const a = oled();
    const b = oled();
    const logic = PartSimulationRegistry.get('ssd1306-i2c-4pin')!;
    const detachA = logic.attachEvents!(a as unknown as HTMLElement, shim as never, () => null, 'oledA')!;
    logic.attachEvents!(b as unknown as HTMLElement, shim as never, () => null, 'oledB');
    detachA();

    bridge.onI2cTransaction!(0x3c, PANEL_ON, 'oledB');
    bridge.onI2cTransaction!(0x3c, PIXELS, 'oledB');
    expect(litCount(b)).toBe(8);
  });

  it('an echo that names nobody still reaches the parts at its address', () => {
    const { bridge, shim } = fakeBridge();
    const a = oled();
    PartSimulationRegistry.get('ssd1306-i2c-4pin')!.attachEvents!(
      a as unknown as HTMLElement,
      shim as never,
      () => null,
      'oledA',
    );
    bridge.onI2cTransaction!(0x3c, PANEL_ON);
    bridge.onI2cTransaction!(0x3c, PIXELS);
    expect(litCount(a)).toBe(8);
  });
});

describe('the worker record of an I2C LCD', () => {
  it('carries the backpack port the latch reads through: P3 held low by the backlight transistor', () => {
    const { shim, attached } = fakeBridge();
    const el = { characters: new Uint8Array(32), addEventListener() {}, removeEventListener() {} };
    PartSimulationRegistry.get('lcd1602-i2c')!.attachEvents!(
      el as unknown as HTMLElement,
      shim as never,
      () => null,
      'lcd1',
    );
    expect(attached).toEqual([
      { type: 'pcf8574', pin: expect.any(Number), props: { portState: 0xf7, addr: 0x27, owner: 'lcd1' } },
    ]);
  });

  it('draws every byte of an echoed write phase', () => {
    const { bridge, shim } = fakeBridge();
    const el: { value?: number; addEventListener(): void; removeEventListener(): void } = {
      addEventListener() {},
      removeEventListener() {},
    };
    PartSimulationRegistry.get('pcf8574')!.attachEvents!(
      el as unknown as HTMLElement,
      shim as never,
      () => null,
      'io1',
    );
    bridge.onI2cTransaction!(0x27, [0x00, 0xff, 0x3c], 'io1');
    expect(el.value).toBe(0x3c);
  });
});

describe('I2cEchoListeners', () => {
  it('an echo for a part nobody listens for reaches no other part at the address', () => {
    const l = new I2cEchoListeners();
    const a = vi.fn();
    l.add(0x3c, a, 'oledA');
    l.deliver(0x3c, [1], 'gone');
    expect(a).not.toHaveBeenCalled();
  });

  it('a listener by address alone (a Grove chip) hears its address whoever the echo names', () => {
    const l = new I2cEchoListeners();
    const chip = vi.fn();
    l.add(0x3e, chip);
    l.deliver(0x3e, [1], 'grove1');
    l.deliver(0x3e, [2]);
    expect(chip.mock.calls).toEqual([[[1]], [[2]]]);
    l.remove(0x3e);
    expect(l.size).toBe(0);
  });
});
