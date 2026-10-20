/**
 * A runner for the shared I2C bus vectors (test/fixtures/i2c-vectors, format
 * in the README there). One file per chip, replayed by every model of that
 * chip: a test hands this runner the file and a host, which is the model on
 * whatever bus it is tested on.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export interface VectorStep {
  op: string;
  data?: string;
  reg?: string;
  n?: number;
  expect?: string;
  rw?: string;
  at?: string;
  values?: Record<string, number>;
  /** `advance`: microseconds of guest time (decimal). */
  us?: number;
}

export interface BusVector {
  name: string;
  spec: string;
  driver?: string;
  /** False: the host keeps no guest time. Otherwise it stands at 0 until `advance`. */
  clock?: boolean;
  /** The die the model is built as (the MPU-6050's `variant`). */
  variant?: string;
  steps: VectorStep[];
}

export interface BusVectorFile {
  format: number;
  device: string;
  address: string;
  rules: Record<string, unknown>;
  inputs: Record<string, number>;
  vectors: BusVector[];
}

/** How a repeated START reaches the model (README, "Bus flavours"). */
export type BusFlavour = 'repeated-start' | 'stop-start';
export const BUS_FLAVOURS: BusFlavour[] = ['repeated-start', 'stop-start'];

/** What replays a vector: the wire, the panel, and the copy a host would mirror. */
export interface VectorHost {
  start(read: boolean): boolean;
  write(byte: number): boolean;
  read(): number;
  stop(): void;
  inputs(values: Record<string, number>): void;
  /** Absent on a model with no dump: its `dump` steps are skipped. */
  dump?(): Uint8Array;
  /** Move the guest's time on; a vector that does is refused without it. */
  advanceUs?(us: number): void;
  /** What the INT pad does; a host that cannot see it skips the step. */
  intPad?(): string;
}

/** A file of test/fixtures/i2c-vectors, by name. */
export function loadBusVectors(file: string): BusVectorFile {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../../test/fixtures/i2c-vectors/${file}`, import.meta.url)),
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
      case 'dump': {
        if (!host.dump) break;
        const at = parseInt(step.at!, 16);
        got = Array.from(host.dump().slice(at, at + hexBytes(step.expect!).length));
        break;
      }
      case 'advance':
        expect(host.advanceUs, `step ${i}: time moves in a vector with no clock`).toBeDefined();
        host.advanceUs!(step.us!);
        break;
      case 'int':
        if (host.intPad)
          expect(host.intPad(), `step ${i} ${JSON.stringify(step)}`).toBe(step.expect);
        break;
      default:
        throw new Error(`step ${i}: unknown op "${step.op}"`);
    }
    if (got)
      expect(hexText(got), `step ${i} ${JSON.stringify(step)}`).toBe(
        hexText(hexBytes(step.expect!)),
      );
  });
}
