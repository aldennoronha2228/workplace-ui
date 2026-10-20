/**
 * A bit-banged I2C master that relies on the breakout's own pull-ups
 * (finding module-pullup-not-modelled, the I2C half).
 *
 * SoftwareWire with `pullups = false`, SlowSoftI2CMaster without its pull-up
 * flag, and every hand-rolled bit-bang release a line with pinMode(INPUT),
 * because the breakout carries 4.7k or 10k to VCC. The software decoder
 * always assumed that pull-up for its own decoding, but the GUEST never saw
 * it: a released line kept the LOW the master last drove, so SoftwareWire's
 * clock-stretch check (wait while digitalRead(SCL) is LOW) timed out on every
 * bit, and a released SDA read LOW before the target had driven it once.
 *
 * Here the board pins are the real PinManager (boardPinsFromPinManager), and
 * the guest's input register is modelled as the AVR's is: what the last
 * injection (driveInput -> setPinState) put there, while the pad is an input.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { BusRegistry } from '../registry';
import { boardPinsFromPinManager } from '../boardPins';
import { PinManager } from '../../PinManager';
import { resetBusNets } from '../../customChips/busNets';
import type { EngineBinding, I2cTarget, NetResolver, PinRef, ResolvedPin } from '../types';
import { registerBoardPinFunctions } from '../pinFunctions';

registerBoardPinFunctions(['test-uno-soft-i2c'], {
  routing: 'fixed',
  source: 'test',
  controllers: [{ bus: 'i2c', unit: 0, name: 'TWI', arduino: ['Wire'], defaultPins: { sda: 18, scl: 19 } }],
  pins: {
    18: [{ bus: 'i2c', unit: 0, signal: 'sda' }],
    19: [{ bus: 'i2c', unit: 0, signal: 'scl' }],
  },
});

class Circuit implements NetResolver {
  nets = new Map<string, ResolvedPin>();
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    return this.nets.get(`${ref.componentId}:${ref.pinName}`) ?? { kind: 'floating' };
  }
  boardKind(): string {
    return 'test-uno-soft-i2c';
  }
  boards(): string[] {
    return ['uno'];
  }
}

/** A one-register-file target: the first written byte is the pointer. */
class Regs implements I2cTarget {
  ptr = 0;
  first = true;
  regs: number[];
  constructor(regs: number[]) {
    this.regs = regs;
  }
  start(_a: number, read: boolean): boolean {
    this.first = !read;
    return true;
  }
  write(b: number): boolean {
    if (this.first) {
      this.ptr = b;
      this.first = false;
    }
    return true;
  }
  read(): number {
    return this.regs[this.ptr++ % this.regs.length];
  }
  stop(): void {}
  boardReset(): void {}
}

const SDA = 2;
const SCL = 3;

/** An AVR-shaped board: pads on the pad channel, an input register fed by
 *  the injection door, and a sketch that releases with pinMode(INPUT). */
function board() {
  const pm = new PinManager();
  const inputReg = new Map<number, boolean>();
  const pads = new Map<number, 'low' | 'z'>();
  let cycle = 0;
  const setPinState = (pin: number, level: boolean) => {
    inputReg.set(pin, level);
    if (pads.get(pin) === 'low') return; // the pad is driven: not on the wire
    pm.setPinState(pin, level, 'external');
  };
  const binding: EngineBinding = { pins: boardPinsFromPinManager(pm, setPinState), spi: [], i2c: [] };
  const reg = new BusRegistry();
  const circuit = new Circuit();
  reg.setResolver(circuit);
  reg.bindEngine('uno', binding);
  circuit.nets.set('t:SDA', { kind: 'board', boardId: 'uno', pin: SDA });
  circuit.nets.set('t:SCL', { kind: 'board', boardId: 'uno', pin: SCL });
  let clockStretchTimeouts = 0;
  const mcu = {
    low(pin: number) {
      pads.set(pin, 'low');
      pm.reportPad(pin, 'low', 0, cycle++);
      pm.setPinState(pin, false, 'mcu');
    },
    release(pin: number) {
      pads.set(pin, 'z');
      pm.reportPad(pin, 'z', 0, cycle++);
    },
    read(pin: number): boolean {
      return pads.get(pin) === 'low' ? false : (inputReg.get(pin) ?? false);
    },
  };
  /** SoftwareWire 1.6 (pullups = false), in pin order. */
  const sw = {
    sclHigh() {
      mcu.release(SCL);
      // detectClockStretch: wait while the slave holds SCL low.
      if (!mcu.read(SCL)) clockStretchTimeouts++;
    },
    start() {
      mcu.release(SDA);
      sw.sclHigh();
      mcu.low(SDA);
      mcu.low(SCL);
    },
    stop() {
      mcu.low(SDA);
      sw.sclHigh();
      mcu.release(SDA);
    },
    writeByte(b: number): boolean {
      for (let i = 7; i >= 0; i--) {
        if ((b >> i) & 1) mcu.release(SDA);
        else mcu.low(SDA);
        sw.sclHigh();
        mcu.low(SCL);
      }
      mcu.release(SDA);
      sw.sclHigh();
      const ack = !mcu.read(SDA);
      mcu.low(SCL);
      return ack;
    },
    readByte(ack: boolean): number {
      mcu.release(SDA);
      let v = 0;
      for (let i = 0; i < 8; i++) {
        sw.sclHigh();
        v = (v << 1) | (mcu.read(SDA) ? 1 : 0);
        mcu.low(SCL);
      }
      if (ack) mcu.low(SDA);
      else mcu.release(SDA);
      sw.sclHigh();
      mcu.low(SCL);
      mcu.release(SDA);
      return v;
    },
    /** requestFrom after a register write, with a repeated START. */
    readRegs(addr: number, ptr: number, n: number): { acks: boolean[]; out: number[] } {
      const acks: boolean[] = [];
      sw.start();
      acks.push(sw.writeByte(addr << 1), sw.writeByte(ptr));
      sw.start();
      acks.push(sw.writeByte((addr << 1) | 1));
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push(sw.readByte(i < n - 1));
      sw.stop();
      return { acks, out };
    },
  };
  return { pm, reg, mcu, sw, timeouts: () => clockStretchTimeouts };
}

afterEach(() => resetBusNets());

describe('software I2C: the breakout pull-ups reach the guest', () => {
  it('SoftwareWire with pullups off reads a register block, with no clock-stretch timeout', () => {
    const b = board();
    const t = new Regs([0x11, 0xa5, 0xff, 0x00, 0x7e]);
    b.reg.attachI2c({ owner: 't', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x48] }, t);
    // begin(): both lines released, and they read HIGH straight away.
    b.mcu.release(SDA);
    b.mcu.release(SCL);
    expect(b.mcu.read(SDA)).toBe(true);
    expect(b.mcu.read(SCL)).toBe(true);
    const { acks, out } = b.sw.readRegs(0x48, 1, 4);
    expect(acks).toEqual([true, true, true]);
    // 0xFF and 0x00 are the bytes a missing pull-up gets wrong in each way.
    expect(out).toEqual([0xa5, 0xff, 0x00, 0x7e]);
    expect(b.timeouts()).toBe(0);
  });

  it('an address nobody has reads as NACK: the released SDA is HIGH', () => {
    const b = board();
    b.reg.attachI2c({ owner: 't', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x48] }, new Regs([0]));
    b.mcu.release(SDA);
    b.mcu.release(SCL);
    b.sw.start();
    expect(b.sw.writeByte(0x49 << 1)).toBe(false);
    b.sw.stop();
    expect(b.timeouts()).toBe(0);
  });

  it('no part on the lines: no bus, no pull-up (the sketch reads what it left)', () => {
    const b = board();
    b.mcu.low(SCL);
    b.mcu.release(SCL);
    expect(b.mcu.read(SCL)).toBe(false);
  });

  it('the pull-ups leave with the last target', () => {
    const b = board();
    const h = b.reg.attachI2c({ owner: 't', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x48] }, new Regs([0]));
    b.mcu.low(SCL);
    b.mcu.release(SCL);
    expect(b.pm.getPinState(SCL)).toBe(true);
    h.dispose();
    b.mcu.low(SCL);
    b.mcu.release(SCL);
    expect(b.pm.getPinState(SCL)).toBe(false);
  });
});
