/**
 * Replays the bus vectors of test/fixtures/i2c-vectors against a model in the
 * tab. The format, the steps and the two bus flavours are in the README next
 * to the vectors; the backend twins replay the same files from
 * test/backend/unit/test_i2c_slaves.py.
 */
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface VectorStep {
  op: string;
  data?: string;
  reg?: string;
  n?: number;
  expect?: string;
  rw?: string;
  at?: string;
  values?: Record<string, number>;
  /** `clock`: move the host's clock on by this much... */
  advance_ms?: number;
  /** ...or put it at this date and time. */
  set?: string;
}

export interface BusVector {
  name: string;
  spec: string;
  driver?: string;
  /** Where the host's clock is when the chip powers on, if not where the file says. */
  clock?: string;
  /** The build times of the firmware, if not the file's. */
  build_times?: Array<[string, string]>;
  steps: VectorStep[];
}

export interface BusVectorFile {
  device: string;
  address: string;
  rules: Record<string, unknown>;
  inputs: Record<string, number>;
  clock?: string;
  build_times?: Array<[string, string]>;
  vectors: BusVector[];
}

export function loadVectors(device: string): BusVectorFile {
  return JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../../../../test/fixtures/i2c-vectors/${device}.json`, import.meta.url),
      ),
      'utf8',
    ),
  );
}

/** "6B 00", "00*107 40": bytes in hex, XX*N repeats one. */
export function hexBytes(text: string): number[] {
  const out: number[] = [];
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const [byte, times] = token.split('*');
    for (let i = times === undefined ? 1 : parseInt(times, 10); i > 0; i--)
      out.push(parseInt(byte, 16));
  }
  return out;
}

export const hexText = (bytes: readonly number[]): string =>
  bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/**
 * "2026-09-30T12:34:56.250" as the clock of a model counts it: milliseconds
 * since 00:00 of 1 January 1970 of the same calendar. No time zone comes
 * into it, so a vector reads the same wherever the test runs.
 */
export function wallClock(text: string): number {
  const ms = Date.parse(`${text}Z`);
  if (Number.isNaN(ms)) throw new Error(`not a date and time: "${text}"`);
  return ms;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ["Sep 29 2026", "23:39:41"], the two strings as the compiler writes them. */
export function buildTime([date, time]: [string, string]) {
  const [hour, minute, second] = time.split(':').map((n) => parseInt(n, 10));
  return {
    year: parseInt(date.slice(7), 10),
    month: MONTHS.indexOf(date.slice(0, 3)) + 1,
    day: parseInt(date.slice(4, 6), 10),
    hour,
    minute,
    second,
  };
}

/** A clock a vector moves by hand. */
export class VectorClock {
  now: number;

  constructor(start: string) {
    this.now = wallClock(start);
  }

  read = (): number => this.now;

  step(step: VectorStep): void {
    if (step.set !== undefined) this.now = wallClock(step.set);
    else this.now += step.advance_ms ?? 0;
  }
}

/** What replays a vector: the wire, the panel, the host's clock, and the copy a host would mirror. */
export interface VectorHost {
  start(read: boolean): boolean;
  write(byte: number): boolean;
  read(): number;
  stop(): void;
  inputs(values: Record<string, number>): void;
  /** Null: the model has no dump, and the step is skipped. */
  dump(): Uint8Array | null;
  clock?(step: VectorStep): void;
}

export type BusFlavour = 'repeated-start' | 'stop-start';
export const BUS_FLAVOURS: BusFlavour[] = ['repeated-start', 'stop-start'];

export function replayVector(host: VectorHost, vector: BusVector, flavour: BusFlavour): void {
  let open = false;
  const start = (read: boolean) => {
    // QEMU hands a device model a repeated START as FINISH and then START.
    if (open && flavour === 'stop-start') host.stop();
    open = true;
    expect(host.start(read), 'the address is acknowledged').toBe(true);
  };
  const stop = () => {
    open = false;
    host.stop();
  };
  const send = (bytes: number[]) => {
    for (const b of bytes) expect(host.write(b), `0x${b.toString(16)} is acknowledged`).toBe(true);
  };
  const recv = (n: number) => Array.from({ length: n }, () => host.read() & 0xff);

  vector.steps.forEach((step, i) => {
    let got: number[] | null = null;
    switch (step.op) {
      case 'write':
        start(false);
        send(hexBytes(step.data!));
        stop();
        break;
      case 'read':
        start(false);
        send([parseInt(step.reg!, 16)]);
        start(true);
        got = recv(step.n!);
        stop();
        break;
      case 'get':
        start(true);
        got = recv(step.n!);
        stop();
        break;
      case 'start':
        start(step.rw === 'r');
        break;
      case 'send':
        send(hexBytes(step.data!));
        break;
      case 'recv':
        got = recv(step.n!);
        break;
      case 'stop':
        stop();
        break;
      case 'inputs':
        host.inputs(step.values!);
        break;
      case 'clock':
        if (!host.clock) throw new Error(`step ${i}: this host has no clock to move`);
        host.clock(step);
        break;
      case 'dump': {
        const dump = host.dump();
        if (!dump) break;
        const at = parseInt(step.at!, 16);
        got = Array.from(dump.slice(at, at + hexBytes(step.expect!).length));
        break;
      }
      default:
        throw new Error(`step ${i}: unknown op "${step.op}"`);
    }
    if (got) {
      expect(hexText(got), `step ${i} ${JSON.stringify(step)}`).toBe(
        hexText(hexBytes(step.expect!)),
      );
    }
  });
}
