/**
 * The module pulls of a board whose guest runs in a QEMU worker: the `pulls`
 * half of the bus map.
 *
 * A module's resistor on a line (the Grove 4-Digit Display's 10k pull-ups on
 * CLK and DIO) is a PULL-strength driver of the board pin's net in this tab
 * (customChips/busNets.ts, setBoardPinPull), and the net resolves the level
 * channel from it. The guest's input register is not in this tab, though: on
 * the ESP32 and STM32 QEMU boards it is the worker's, and QEMU's injection
 * keeps the last level written, so a line the guest releases with
 * pinMode(INPUT) read the LOW it last drove. The worker has a pad model
 * (backend pad_model.py) that puts the resistor on the pad when nothing
 * strong drives it; this lane tells it where the resistors are.
 *
 * The map is the whole list every time, so a part removed is gone by being
 * absent. It travels with `start_*` (through the bridge's onBusMapRequest)
 * and again whenever the pulls on the board's pins change, which is when a
 * part mounts, is re-wired or is removed; an unchanged list is not resent.
 */

import {
  boardPinPulls,
  onBoardPinPullsChange,
  type BoardPinHost,
  type BoardPinPullEntry,
} from '../customChips/busNets';

export class RemotePullLane {
  private readonly host: BoardPinHost;
  private readonly send: (pulls: BoardPinPullEntry[]) => void;
  private last: string | null = null;

  constructor(host: BoardPinHost, send: (pulls: BoardPinPullEntry[]) => void) {
    this.host = host;
    this.send = send;
  }

  /** The list as it is now, and whether it differs from the last one polled. */
  poll(): { pulls: BoardPinPullEntry[]; changed: boolean } {
    const pulls = boardPinPulls(this.host);
    const key = JSON.stringify(pulls);
    const changed = key !== this.last;
    this.last = key;
    return { pulls, changed };
  }

  /** Send the list when it changed since the last poll. */
  push(): void {
    const { pulls, changed } = this.poll();
    if (!changed) return;
    try {
      this.send(pulls);
    } catch (e) {
      console.warn('[buses] the pulls map could not be sent', e);
    }
  }
}

// One lane per board pin host. A shim is rebuilt whenever the bridge behind
// it is, and the newest one's lane replaces the last: a subscription per lane
// would outlive every one of them.
const lanes = new Map<BoardPinHost, RemotePullLane>();
let unsubscribe: (() => void) | null = null;

/**
 * The lane of `host` (a board's PinManager), sending through `send`. Replaces
 * the lane an earlier shim of the same board registered.
 */
export function remotePullLane(
  host: BoardPinHost,
  send: (pulls: BoardPinPullEntry[]) => void,
): RemotePullLane {
  const lane = new RemotePullLane(host, send);
  lanes.set(host, lane);
  if (!unsubscribe) unsubscribe = onBoardPinPullsChange((h) => lanes.get(h)?.push());
  return lane;
}

/** Test seam: forget every lane. */
export function resetRemotePullLanes(): void {
  lanes.clear();
  unsubscribe?.();
  unsubscribe = null;
}
