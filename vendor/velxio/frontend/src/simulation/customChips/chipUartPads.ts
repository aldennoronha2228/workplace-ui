/**
 * The UART pads a chip names in its vx_uart_config, read off the WASM without
 * hosting the chip (project board-buses-2026-09, F6).
 *
 * A chip on a QEMU board runs in the backend worker, and the worker has no
 * circuit: which of the guest's UARTs the chip is on is decided in this tab,
 * by the bus fabric, from the pads the chip attaches and the wires on the
 * canvas, and travels to the worker as the UART half of the bus map
 * (CustomChipPart, RemoteUartLane, uart_bus_table.py). The pads are only
 * known once chip_setup has called vx_uart_attach, so the same WASM is set up
 * here on an inert instance: no canvas identity (it joins no bus and drives no
 * SPICE net), no wires (every pin is unwired, so nothing reaches the
 * PinManager it is given), no clock (its timers never fire) and no log (the
 * worker's copy speaks). Then it is disposed. What it saw is the chip's own
 * word on its pads, the same word the worker's copy gives its table.
 *
 * The attributes and ROM go in because a chip may pick its pads or its rate
 * from them, exactly as the worker's copy does.
 */
import { ChipInstance } from './ChipRuntime';
import { PinManager } from '../PinManager';

export interface ChipUartPads {
  /** Pad names of `vx_uart_config.rx` / `.tx`; null for a NO_PIN side. */
  rxPad: string | null;
  txPad: string | null;
  /** `vx_uart_config.baud_rate`, 9600 when the chip left it at 0. */
  baud: number;
}

export interface ChipUartPadsOptions {
  attrs?: Record<string, number>;
  strAttrs?: Record<string, string>;
  romBytes?: Uint8Array | null;
}

/**
 * Every UART the chip attaches in chip_setup, in handle order. Empty for a
 * chip with no UART, and for a chip whose setup fails here (it has failed in
 * the worker too, and that copy reports it).
 */
export async function readChipUartPads(
  wasm: Uint8Array | ArrayBuffer | WebAssembly.Module,
  opts: ChipUartPadsOptions = {},
): Promise<ChipUartPads[]> {
  let inst: ChipInstance | null = null;
  try {
    inst = await ChipInstance.create({
      wasm,
      pinManager: new PinManager(),
      wires: new Map(),
      attrs: new Map(Object.entries(opts.attrs ?? {})),
      strAttrs: new Map(Object.entries(opts.strAttrs ?? {})),
      romBytes: opts.romBytes ?? null,
      log: () => {},
    });
    inst.start();
    const out: ChipUartPads[] = [];
    for (let handle = 0; ; handle++) {
      const pads = inst.getUartPads(handle);
      const route = inst.getUartTxRoute(handle);
      if (!pads || !route) break;
      out.push({ rxPad: pads.rxPad, txPad: pads.txPad, baud: route.baud });
    }
    return out;
  } catch (e) {
    console.warn('[custom-chip] the chip could not be set up to read its UART pads:', e);
    return [];
  } finally {
    inst?.dispose();
  }
}
