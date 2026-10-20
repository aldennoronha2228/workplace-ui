/**
 * Software I2C: a bit-banged controller on plain GPIOs (SoftWire, a sketch
 * toggling pinMode by hand, MicroPython SoftI2C) decoded from the board's pin
 * edges into the same START / byte / STOP calls a hardware controller makes
 * (DESIGN 5.3). One target model then works on Wire and on a bit-banged bus,
 * like the chip on a real board.
 *
 * The lines are open-drain. A master pulls a line low or lets it go, and a
 * released line reads HIGH through the bus pull-up, so the master's level on a
 * pin is its pad drive when the engine reports one (pinMode(OUTPUT) with the
 * latch at 0 never moves the level channel) and its latch otherwise. The
 * target side answers the same way: an ACK or a 0 bit is SDA pulled low with
 * driveInput, and everything else is SDA released (driven high).
 *
 * The pull-up is on the wire, not only in the decoder: on a board whose pins
 * come with the PinManager (BoardPins.pinHost) the bus puts a pull-up on SDA
 * and on SCL of the board-pin net (busNets.setBoardPinPull), the resistors
 * every I2C breakout carries, and the target's low as a strong driver of SDA.
 * A master that releases a line with pinMode(INPUT) and no INPUT_PULLUP
 * (SoftwareWire with pullups off, a hand-rolled bit-bang reading SCL for
 * clock stretching) then reads HIGH in the guest, where it used to read the
 * LOW it last drove and time out.
 *
 * The target only ever changes SDA while SCL is low, which is also what keeps
 * an engine that echoes driveInput back as a pin change from reading its own
 * answer as a START or a STOP: those are SDA edges with SCL high, and only the
 * master makes them.
 *
 * A byte to read is asked of the bus at drive time, on the SCL falling edge
 * where the target has to put its first bit on the wire, and never earlier: a
 * target updates what it will send after the address phase, and a byte the
 * master NACKs the one before is never taken from the target at all.
 */

import type { I2cBus } from './i2cBus';
import type { BoardPins } from './types';
import { setBoardPinDrive, setBoardPinPull } from '../customChips/busNets';
import { HIGHZ_DRIVE, Strength } from '../customChips/busLogic';

type Phase =
  | 'idle' // no transaction, or one this bus is not part of
  | 'bits-in' // the master shifts an address or data byte in
  | 'ack-wait' // eight bits in, the target answers on the next falling edge
  | 'ack-out' // the target holds its ACK (or NACK) for the ninth clock
  | 'bits-out' // the target shifts a read byte out
  | 'ack-in' // the master answers the read byte on the ninth clock
  | 'ack-in-done'
  | 'ignore'; // NACKed: nothing more until STOP or a repeated START

export class SoftI2cDecoder {
  private phase: Phase = 'idle';
  private isAddress = false;
  private reading = false;
  private acked = false;
  private masterAck = false;
  private inTransaction = false;
  private count = 0;
  private shift = 0;
  private outByte = 0xff;
  /** What the target side drives on SDA: false = pulling low. */
  private holding = true;
  private lastScl: boolean;
  private lastSda: boolean;
  private readonly offs: Array<() => void> = [];

  readonly sdaPin: number;
  readonly sclPin: number;
  private readonly pins: BoardPins;
  private readonly bus: I2cBus;

  constructor(pins: BoardPins, bus: I2cBus, sclPin: number) {
    this.pins = pins;
    this.bus = bus;
    this.sdaPin = bus.sdaPin;
    this.sclPin = sclPin;
    this.lastScl = this.master(sclPin);
    this.lastSda = this.master(this.sdaPin);
    const cb = () => this.onChange();
    for (const pin of [this.sdaPin, sclPin]) {
      this.offs.push(pins.onPinChange(pin, cb));
      if (pins.onPadChange) this.offs.push(pins.onPadChange(pin, cb));
    }
    const host = pins.pinHost;
    if (host && pins.driveInput) {
      for (const pin of [this.sdaPin, sclPin]) {
        const id = this.pullId(pin);
        const sink = (level: boolean) => pins.driveInput?.(pin, level);
        setBoardPinPull(host, pin, id, 'up', sink);
        this.offs.push(() => setBoardPinPull(host, pin, id, null, sink));
      }
    }
  }

  /** The bus's own drivers on the board-pin net, by line. */
  private pullId(pin: number): string {
    return `i2c-bus@${this.sdaPin}::${pin === this.sdaPin ? 'SDA' : 'SCL'}~pull`;
  }

  dispose(): void {
    this.release();
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  /** The MCU was reset: any half-clocked transaction is gone. */
  restart(): void {
    this.phase = 'idle';
    this.inTransaction = false;
    this.release();
    this.lastScl = this.master(this.sclPin);
    this.lastSda = this.master(this.sdaPin);
  }

  /** The level the MASTER puts on a line: low only when it pulls it low. */
  private master(pin: number): boolean {
    const pad = this.pins.peekPad?.(pin);
    if (pad) return pad.drive !== 'low';
    return this.pins.peekPinState(pin) ?? true;
  }

  private drive(high: boolean): void {
    if (this.holding === high) return;
    this.holding = high;
    const host = this.pins.pinHost;
    if (host && this.pins.driveInput) {
      // Open drain: a low is a strong driver of SDA, a 1 lets go and the
      // bus pull-up has the line (or the master, if it holds it low).
      const sda = this.sdaPin;
      setBoardPinDrive(
        host,
        sda,
        `i2c-bus@${sda}::target`,
        high ? HIGHZ_DRIVE : { value: 0, strength: Strength.STRONG },
        (level) => this.pins.driveInput?.(sda, level),
      );
      return;
    }
    this.pins.driveInput?.(this.sdaPin, high);
  }

  private release(): void {
    this.drive(true);
  }

  private onChange(): void {
    const scl = this.master(this.sclPin);
    if (scl !== this.lastScl) {
      this.lastScl = scl;
      if (scl) this.onRise();
      else this.onFall();
    }
    const sda = this.master(this.sdaPin);
    if (sda !== this.lastSda) {
      this.lastSda = sda;
      // Data may only change while SCL is low; an SDA edge with SCL high is a
      // bus condition.
      if (scl) {
        if (sda) this.onStop();
        else this.onStart();
      }
    }
  }

  private onStart(): void {
    // A repeated START is the same thing to the decoder: a new address phase.
    this.inTransaction = true;
    this.phase = 'bits-in';
    this.isAddress = true;
    this.count = 0;
    this.shift = 0;
    this.release();
  }

  private onStop(): void {
    this.release();
    this.phase = 'idle';
    if (!this.inTransaction) return;
    this.inTransaction = false;
    this.bus.stop();
  }

  private onRise(): void {
    switch (this.phase) {
      case 'bits-in':
        this.shift = ((this.shift << 1) | (this.master(this.sdaPin) ? 1 : 0)) & 0xff;
        if (++this.count === 8) this.phase = 'ack-wait';
        break;
      case 'bits-out':
        this.count++;
        break;
      case 'ack-in':
        this.masterAck = !this.master(this.sdaPin);
        this.phase = 'ack-in-done';
        break;
      default:
        break;
    }
  }

  private onFall(): void {
    switch (this.phase) {
      case 'ack-wait': {
        const byte = this.shift;
        if (this.isAddress) {
          this.reading = (byte & 1) === 1;
          this.acked = this.bus.start(byte >> 1, this.reading);
        } else {
          this.acked = this.bus.write(byte);
        }
        this.drive(!this.acked);
        this.phase = 'ack-out';
        break;
      }
      case 'ack-out':
        this.release();
        if (!this.acked) {
          this.phase = 'ignore';
        } else if (this.isAddress && this.reading) {
          this.fetch();
        } else {
          this.phase = 'bits-in';
          this.isAddress = false;
          this.count = 0;
          this.shift = 0;
        }
        break;
      case 'bits-out':
        if (this.count < 8) this.driveBit();
        else {
          this.release();
          this.phase = 'ack-in';
        }
        break;
      case 'ack-in-done':
        if (this.masterAck) this.fetch();
        else this.phase = 'ignore';
        break;
      default:
        break;
    }
  }

  /** Take the next read byte from the bus and put its first bit on SDA. */
  private fetch(): void {
    this.isAddress = false;
    this.outByte = this.bus.read() & 0xff;
    this.count = 0;
    this.phase = 'bits-out';
    this.driveBit();
  }

  private driveBit(): void {
    this.drive(((this.outByte >> (7 - this.count)) & 1) === 1);
  }
}
