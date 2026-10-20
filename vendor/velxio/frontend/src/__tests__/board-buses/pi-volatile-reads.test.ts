/**
 * The Raspberry Pi relay answers a register-file chip from a copy of its
 * registers (pro pi_bus_relay). Some registers a copy cannot answer for: the
 * MPU-6050's INT_STATUS is cleared by the read and set by every sample, its
 * FIFO_R_W and MEM_R_W hand out the next byte, FIFO_COUNT grows with time. A
 * chip declares them (I2CDevice.volatileReads), and the map the tab publishes
 * carries them per device (`volatile_reads`), so the relay asks this tab for
 * the reads that touch one (FIX-DESIGN section 3, phase 2 of project
 * i2c-model-fidelity-2026-09). The relay learns no rule of any chip.
 */
import { describe, it, expect } from 'vitest';
import { PiBridgeShim } from '../../simulation/PiBridgeShim';
import { PinManager } from '../../simulation/PinManager';
import { busRegistry } from '../../simulation/buses/registry';
import { createStoreNetResolver } from '../../simulation/buses';
import type { I2cTarget, NetResolver, PinRef, ResolvedPin } from '../../simulation/buses/types';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { i2cTargetOf } from '../../simulation/parts/i2cPart';
import { VirtualMPU6050 } from '../../simulation/parts/ProtocolParts';
import { VirtualDS1307, VirtualDS3231, type I2CDevice } from '../../simulation/I2CBusManager';
import { WasmDS1307, WasmDS3231, wasmI2cModule } from '../../simulation/parts/wasmI2cModels';

class Circuit implements NetResolver {
  private readonly nets = new Map<string, ResolvedPin>();
  private readonly boardId: string;
  constructor(boardId: string) {
    this.boardId = boardId;
  }
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    return this.nets.get(`${ref.componentId}:${ref.pinName}`) ?? { kind: 'floating' };
  }
  boardKind(id: string): string | undefined {
    return id === this.boardId ? 'raspberry-pi-4' : undefined;
  }
  boards(): string[] {
    return [this.boardId];
  }
  wireI2c(owner: string, sda: number, scl: number): void {
    this.nets.set(`${owner}:SDA`, { kind: 'board', boardId: this.boardId, pin: sda });
    this.nets.set(`${owner}:SCL`, { kind: 'board', boardId: this.boardId, pin: scl });
  }
}

function onFabric(boardId: string) {
  const sent: unknown[] = [];
  const shim = new PiBridgeShim({
    boardId,
    boardKind: 'raspberry-pi-4',
    bridge: { sendBusTopology: (t: unknown) => sent.push(t) } as never,
    pinManager: new PinManager(),
    boardState: () => undefined,
  });
  const circuit = new Circuit(boardId);
  busRegistry.setResolver(circuit);
  busRegistry.bindEngine(boardId, shim.getBusBinding());
  const handles: Array<{ dispose(): void }> = [];
  return {
    shim,
    sent,
    circuit,
    attach(owner: string, sda: number, scl: number, target: I2cTarget, address: number) {
      circuit.wireI2c(owner, sda, scl);
      const h = busRegistry.attachI2c({ owner, pins: { sda: 'SDA', scl: 'SCL' }, addresses: [address] }, target);
      handles.push(h);
      return h;
    },
    done() {
      shim.stopBusSync();
      for (const h of handles) h.dispose();
      busRegistry.unbindBoard(boardId);
      busRegistry.setResolver(createStoreNetResolver(() => useSimulatorStore.getState()));
    },
  };
}

/** A register file with nothing a read changes. */
function plainRegisters(address: number): I2CDevice {
  return {
    address,
    writeByte: () => true,
    readByte: () => 0,
    dumpRegisters: () => new Uint8Array(256),
  };
}

describe('Raspberry Pi: the map names the registers a copy cannot answer for', () => {
  it('the MPU-6050 publishes its registers and the ones a read changes', () => {
    const f = onFabric('pi-volatile-a');
    try {
      f.attach('imu', 2, 3, i2cTargetOf(new VirtualMPU6050(0x68)), 0x68);
      f.attach('rtc', 2, 3, i2cTargetOf(plainRegisters(0x57)), 0x57);
      const [rtc, imu] = f.shim.busTopology().i2c;
      expect(rtc).toEqual({ bus: 1, addr: 0x57, regs: '00'.repeat(256) });
      expect(imu.regs).toHaveLength(512);
      expect(imu.volatile_reads).toEqual([0x3a, 0x6f, 0x72, 0x73, 0x74]);
      expect(imu.pointer_stays).toEqual([0x6f, 0x74]);
      expect(rtc).not.toHaveProperty('pointer_stays');
    } finally {
      f.done();
    }
  });

  it('the ports the MPU-6050 names are the ones its pointer stays on', () => {
    const imu = new VirtualMPU6050(0x68);
    expect(imu.pointerStays).toEqual([0x6f, 0x74]);
    // Three bytes read at MEM_R_W move MEM_START_ADDR three times: the
    // pointer stayed on the port instead of running on to 0x70 and 0x71.
    imu.writeByte(0x6f);
    imu.readByte();
    imu.readByte();
    imu.readByte();
    imu.stop();
    imu.writeByte(0x6e);
    expect(imu.readByte()).toBe(3);
  });

  it('a chip the relay does not mirror names none: all its reads are asked anyway', () => {
    const f = onFabric('pi-volatile-b');
    try {
      const noCopy: I2cTarget & { volatileReads: number[] } = {
        start: () => true,
        write: () => true,
        read: () => 0,
        stop: () => {},
        volatileReads: [0x10],
      };
      f.attach('chip', 2, 3, noCopy, 0x50);
      expect(f.shim.busTopology().i2c).toEqual([{ bus: 1, addr: 0x50, regs: null }]);
    } finally {
      f.done();
    }
  });

  it('two chips at one address: a register either one changes is asked', () => {
    const f = onFabric('pi-volatile-c');
    try {
      f.attach('plain', 2, 3, i2cTargetOf(plainRegisters(0x68)), 0x68);
      f.attach('imu', 2, 3, i2cTargetOf(new VirtualMPU6050(0x68)), 0x68);
      const [only] = f.shim.busTopology().i2c;
      expect(only.volatile_reads).toEqual([0x3a, 0x6f, 0x72, 0x73, 0x74]);
    } finally {
      f.done();
    }
  });

  it('the line the relay asks for a FIFO read pops the FIFO in the model', () => {
    const f = onFabric('pi-volatile-d');
    try {
      const imu = new VirtualMPU6050(0x68);
      f.attach('imu', 2, 3, i2cTargetOf(imu), 0x68);
      // Awake, ACCEL into the FIFO, FIFO on. With no clock in the tab for a
      // guest in the backend, a sample is taken per register pointer written.
      f.shim.answerBusLine('I2C 1 68 T 6b00 0');
      f.shim.answerBusLine('I2C 1 68 T 2308 0');
      f.shim.answerBusLine('I2C 1 68 T 6a40 0');
      const count = (line: string) => parseInt(line.split(' ')[3], 16);
      const before = count(f.shim.answerBusLine('I2C 1 68 T 72 2') ?? '');
      expect(before).toBeGreaterThanOrEqual(6);
      // The pointer write of this line is a sample too: 6 in, 6 out.
      expect(f.shim.answerBusLine('I2C 1 68 T 74 6')).toBe('I2C_DATA 1 68 000000004000');
      expect(count(f.shim.answerBusLine('I2C 1 68 T 72 2') ?? '')).toBe(before + 6);
    } finally {
      f.done();
    }
  });
});

describe('Raspberry Pi: the map says where a clock chip wraps its pointer', () => {
  // The relay's copy wrapped its pointer after 0xFF for every chip; the
  // DS3231 wraps after 0x12 and the DS1307 after 0x3F, so a read across the
  // last register answered zeros where the chip answers its seconds again.
  const clocks = [
    ['ds3231 (compiled)', () => new WasmDS3231(wasmI2cModule('ds3231')!, { clock: () => 0 }), 0x12],
    ['ds1307 (compiled)', () => new WasmDS1307(wasmI2cModule('ds1307')!, { clock: () => 0 }), 0x3f],
    ['ds3231 (hand-written)', () => new VirtualDS3231({ clock: () => 0 }), 0x12],
    ['ds1307 (hand-written)', () => new VirtualDS1307({ clock: () => 0 }), 0x3f],
  ] as const;

  for (const [name, make, wraps] of clocks) {
    it(`the ${name} publishes pointer_wraps_after ${wraps}`, () => {
      const f = onFabric(`pi-wrap-${name}`);
      try {
        f.attach('rtc', 2, 3, i2cTargetOf(make()), 0x68);
        f.attach('other', 2, 3, i2cTargetOf(plainRegisters(0x57)), 0x57);
        const [other, rtc] = f.shim.busTopology().i2c;
        expect(rtc.pointer_wraps_after).toBe(wraps);
        expect(other).not.toHaveProperty('pointer_wraps_after');
      } finally {
        f.done();
      }
    });
  }

  it('two chips at one address that wrap in different places publish no wrap', () => {
    const f = onFabric('pi-wrap-shared');
    try {
      f.attach('a', 2, 3, i2cTargetOf(new VirtualDS3231({ clock: () => 0 })), 0x68);
      f.attach('b', 2, 3, i2cTargetOf(new VirtualDS1307({ clock: () => 0 })), 0x68);
      const [rtc] = f.shim.busTopology().i2c;
      expect(rtc).not.toHaveProperty('pointer_wraps_after');
    } finally {
      f.done();
    }
  });
});
