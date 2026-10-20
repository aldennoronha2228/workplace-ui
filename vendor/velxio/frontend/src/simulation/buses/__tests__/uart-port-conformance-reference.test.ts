/**
 * The UART port conformance kit run against a REFERENCE port: a fake engine
 * whose guest transmits and reads in plain JS and whose SoC object is rebuilt
 * on every reset, Stop/Run and reload, the way real engines rebuild theirs.
 * It shows the kit passes a port that keeps the contract; the mutation
 * controls recorded in STATUS show it fails ports that break it. Real engines
 * run the same kit from their own port-conformance tests.
 */
import { defineUartPortConformance, type UartConformanceRig } from '../conformance/uartPortConformance';
import type { EngineBinding, UartConfig, UartControllerPort, UartRouting } from '../types';

/** The engine's own peripheral, thrown away on every rebuild. */
class FakeSoc {
  txHandler: ((byte: number) => void) | null = null;
  rx: number[] = [];
  config: UartConfig = { baud: 9600, frame: '8N1' };
}

/** An adapter that keeps its identity and re-attaches to each new SoC. */
class ReferencePort implements UartControllerPort {
  readonly bus = 'uart' as const;
  readonly unit: number;
  readonly name: string;
  private handler: ((byte: number) => void) | null = null;
  private soc: FakeSoc;
  private readonly route: UartRouting;
  constructor(unit: number, soc: FakeSoc, route: UartRouting) {
    this.unit = unit;
    this.name = `UART${unit}`;
    this.soc = soc;
    this.route = route;
    this.attach(soc);
  }
  attach(soc: FakeSoc): void {
    this.soc = soc;
    soc.txHandler = this.handler;
  }
  setTxHandler(h: ((byte: number) => void) | null): void {
    this.handler = h;
    this.soc.txHandler = h;
  }
  receive(byte: number): void {
    this.soc.rx.push(byte & 0xff);
  }
  config(): UartConfig {
    return { ...this.soc.config };
  }
  routing(): UartRouting {
    return { ...this.route };
  }
}

function makeRig(): UartConformanceRig {
  const routes: Record<number, UartRouting> = { 0: { tx: 1, rx: 0 }, 1: { tx: 18, rx: 19 } };
  let socs: FakeSoc[] = [new FakeSoc(), new FakeSoc()];
  const ports = [new ReferencePort(0, socs[0], routes[0]), new ReferencePort(1, socs[1], routes[1])];
  const binding: EngineBinding = {
    pins: { onPinChange: () => () => {}, peekPinState: () => undefined },
    spi: [],
    uart: ports,
  };
  const rebuild = async () => {
    socs = [new FakeSoc(), new FakeSoc()];
    ports.forEach((p, i) => p.attach(socs[i]));
  };
  return {
    units: [0, 1],
    binding: () => binding,
    async transmit(unit, bytes) {
      for (const b of bytes) socs[unit].txHandler?.(b & 0xff);
    },
    async read(unit, n) {
      return socs[unit].rx.splice(0, n);
    },
    reset: rebuild,
    stopRun: rebuild,
    reload: rebuild,
    expectedRouting: (unit) => routes[unit],
    expectedConfig: () => ({ baud: 9600, frame: '8N1' }),
    onPinEdge: () => () => {},
  };
}

defineUartPortConformance('reference port', async () => makeRig());
