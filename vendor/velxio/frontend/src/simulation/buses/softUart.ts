/**
 * Software UART: a serial line on plain GPIOs (SoftwareSerial, a bit-banged
 * TX, a MicroPython loop wiggling a pin) followed on the guest's clock
 * (DESIGN 5.3). One endpoint model then works on Serial1 and on
 * SoftwareSerial alike, as the module on a real board does.
 *
 * Two directions, two objects:
 *  - the DECODER watches a pin the MCU drives as an output and turns its
 *    edges, timestamped with the guest's cycle counter, into bytes at the
 *    listener's rate (the codec is uartFrame.ts);
 *  - the EMITTER puts a byte an endpoint transmits on a pin the MCU reads
 *    as an input, as edges scheduled at exact guest instants.
 *
 * Guest time throughout, never the wall clock: an engine under load runs a
 * fraction of real time, and a bit measured in wall time is nowhere near a
 * bit to the sketch.
 */

import type { BoardPins, GuestClock } from './types';
import {
  frameBitCount,
  frameTransitions,
  UartBitDecoder,
  type UartByteSink,
  type UartFrameSpec,
} from './uartFrame';

export class SoftUartDecoder {
  /**
   * Edges before this guest instant are not the MCU's: the net's own emitter
   * holds the wire (its input edges come back as pin changes on engines that
   * echo an injected input). Installed by the fabric when the pin has both.
   */
  mutedUntil: () => number = () => 0;
  private readonly dec: UartBitDecoder;
  private cancel: (() => void) | null = null;
  private armedAt: number | null = null;
  private readonly offs: Array<() => void> = [];
  private readonly pins: BoardPins;
  private readonly clock: GuestClock;
  readonly pin: number;
  readonly baud: number;

  constructor(
    pins: BoardPins,
    clock: GuestClock,
    pin: number,
    baud: number,
    spec: UartFrameSpec,
    sink: UartByteSink,
  ) {
    this.pins = pins;
    this.clock = clock;
    this.pin = pin;
    this.baud = baud;
    this.dec = new UartBitDecoder(spec, clock.clockHz() / baud, sink, this.line());
    const cb = () => this.onChange();
    this.offs.push(pins.onPinChange(pin, cb));
    if (pins.onPadChange) this.offs.push(pins.onPadChange(pin, cb));
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.disarm();
  }

  /** The MCU was reset: whatever frame was open is gone. */
  restart(): void {
    this.disarm();
    this.dec.reset(this.line());
  }

  /**
   * Cycles per bit at the guest's clock NOW. The decoder is built when the
   * engine binds, which on the ESP32 engines is before the app raises the CPU
   * clock from the ROM rate, and on a board between runs is with no clock at
   * all; so the rate is taken again before every edge, and the frame that
   * opens on it is timed by the clock the guest is really running at.
   */
  private bitTime(): number {
    return this.clock.clockHz() / this.baud;
  }

  /**
   * The level the MCU puts on the wire: its pad drive when the engine
   * reports one (a released pad is the idle line, not a bit), its latch
   * otherwise. A never-written pin is idle.
   */
  private line(): boolean {
    const pad = this.pins.peekPad?.(this.pin);
    if (pad) return pad.drive !== 'low';
    return this.pins.peekPinState(this.pin) ?? true;
  }

  private onChange(): void {
    const t = this.clock.now();
    if (t < this.mutedUntil()) return;
    this.dec.retime(this.bitTime());
    this.dec.edge(t, this.line());
    this.arm();
  }

  /** Keep one timer at the open frame's deadline, on a whole cycle (a clock event takes integers). */
  private arm(): void {
    const at = this.dec.deadline === null ? null : Math.ceil(this.dec.deadline);
    if (at === this.armedAt) return;
    this.disarm();
    if (at === null) return;
    this.armedAt = at;
    this.cancel = this.clock.at(at, () => {
      this.cancel = null;
      this.armedAt = null;
      this.dec.finalize();
    });
  }

  private disarm(): void {
    this.cancel?.();
    this.cancel = null;
    this.armedAt = null;
  }
}

export class SoftUartEmitter {
  /** Guest cycle the wire is busy until: the next frame starts no earlier. */
  busyUntil = 0;
  private readonly pins: BoardPins;
  private readonly clock: GuestClock;
  readonly pin: number;

  constructor(pins: BoardPins, clock: GuestClock, pin: number) {
    this.pins = pins;
    this.clock = clock;
    this.pin = pin;
  }

  /** Put the wire at its idle level now (a receiver waits for a falling edge). */
  rest(): void {
    this.pins.driveInput?.(this.pin, true);
  }

  /** One frame of `byte` at `baud`, right after whatever is already on the wire. */
  emit(byte: number, baud: number, spec: UartFrameSpec): void {
    const bit = this.clock.clockHz() / baud;
    const t0 = Math.max(this.clock.now(), this.busyUntil);
    for (const tr of frameTransitions(byte, spec)) {
      this.clock.scheduleEdge(this.pin, tr.level, Math.round(t0 + tr.slot * bit));
    }
    this.busyUntil = t0 + frameBitCount(spec) * bit;
  }

  /** The MCU was reset: the engine dropped its scheduled edges, so does the wire. */
  reset(): void {
    this.busyUntil = 0;
    this.rest();
  }
}
