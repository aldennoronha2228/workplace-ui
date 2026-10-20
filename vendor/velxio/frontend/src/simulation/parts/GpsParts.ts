/**
 * GpsParts.ts: the u-blox NEO-6M GPS module, and the bricks that borrow it
 * (the Grove SIM28 and Air530Z alias this logic).
 *
 * A GNSS receiver is a UART talker: it computes a fix and prints an NMEA-0183
 * cycle (GPGGA + GPRMC, correct checksums, position from the element's
 * lat/lng/altitude/speed/course, UTC that advances one second per cycle) out
 * of its TX pin at 9600 baud, once a second, and never listens. So the module
 * is a UART endpoint of the bus fabric (project board-buses-2026-09, F6) with
 * a TX leg and no RX leg. The fabric walks the wire from the TX pad to
 * whichever board pin it reaches and decides what is there:
 *
 *   - a hardware UART's RX (Uno D0, Mega RX1, ESP32 RX2, the pins a sketch
 *     moved Serial1 to): the bytes go into that controller's port;
 *   - a plain GPIO the sketch samples itself (SoftwareSerial, the wiring of
 *     every NEO-6M tutorial): the fabric's software emitter puts each frame on
 *     the pin as edges at exact guest instants;
 *   - the board's own TX pin: two drivers on one wire, reported as
 *     uart-tx-contention, and the board hears nothing;
 *   - nothing: the module is on no wire, and no byte reaches any UART.
 *
 * Nothing here classifies pins, picks a UART or falls back to UART0: a module
 * on a pin no table knew used to answer on the console, and now it is on
 * whatever wire its TX pad reaches.
 *
 * Time is the GUEST's. The cycle cadence and the byte spacing are measured on
 * the clock the sketch sees (guestMillis: the cycle counter on AVR/RP2040, the
 * engine's virtual clock on the in-browser ESP32s), never on the browser's: an
 * emulated board under load runs a fraction of real time, and a stream paced
 * on the wall clock would flood its FIFO and overrun the sketch's parser. The
 * bytes of a cycle leave one character time apart (10 bits at 9600 baud), as
 * the silicon shifts them out: a 128-byte RX FIFO never sees a whole cycle
 * land in one instant. Only the DATE the receiver reports is taken from the
 * host once, at attach: satellites tell a receiver the real UTC, and the guest
 * has no calendar to ask.
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';
import { attachUartEndpoint } from '../buses';
import { guestMillis } from './partUtils';

export const GPS_BAUD = 9600;

/** Wall-clock poll of the guest clock: one cycle a second at 9600 baud needs no finer step. */
export const GPS_TICK_MS = 20;

/** One 8N1 character at GPS_BAUD, in milliseconds of guest time. */
export const GPS_BYTE_MS = (1000 * 10) / GPS_BAUD;

/** Guest milliseconds between two NMEA cycles (1 Hz, the NEO-6M default). */
export const GPS_CYCLE_MS = 1000;

/** How long the PPS marker stays lit after a cycle, in guest milliseconds. */
export const GPS_PPS_MS = 120;

// ─── NMEA sentence builders (exported for tests) ─────────────────────────────

/** XOR checksum of every char between '$' and '*', as 2-digit uppercase hex. */
export function nmeaChecksum(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i);
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

/** Wrap a sentence body: `$<body>*<checksum>`. */
export function nmeaSentence(body: string): string {
  return `$${body}*${nmeaChecksum(body)}`;
}

const pad2 = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');

/** Decimal degrees to NMEA ddmm.mmmmm (lat) / dddmm.mmmmm (lon) + hemisphere. */
export function formatNmeaCoord(
  decimalDegrees: number,
  axis: 'lat' | 'lon',
): { value: string; hemisphere: string } {
  const hemisphere =
    axis === 'lat' ? (decimalDegrees < 0 ? 'S' : 'N') : (decimalDegrees < 0 ? 'W' : 'E');
  const abs = Math.abs(decimalDegrees);
  const degrees = Math.trunc(abs);
  const minutes = (abs - degrees) * 60;
  const degStr = String(degrees).padStart(axis === 'lat' ? 2 : 3, '0');
  // NEO-6M emits 5 decimal digits of minutes.
  let minStr = minutes.toFixed(5);
  if (minutes < 10) minStr = `0${minStr}`;
  return { value: `${degStr}${minStr}`, hemisphere };
}

const nmeaTime = (d: Date) =>
  `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}.00`;

const nmeaDate = (d: Date) =>
  `${pad2(d.getUTCDate())}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCFullYear() % 100)}`;

export interface GpsFix {
  lat: number;
  lng: number;
  /** Metres above mean sea level. */
  altitude: number;
  /** Speed over ground, knots. */
  speed: number;
  /** Course over ground, degrees true. */
  course: number;
}

/** GGA, fix data: time, position, fix quality 1 (GPS), 7 sats, altitude. */
export function buildGpgga(date: Date, fix: GpsFix): string {
  const lat = formatNmeaCoord(fix.lat, 'lat');
  const lon = formatNmeaCoord(fix.lng, 'lon');
  const body =
    `GPGGA,${nmeaTime(date)},${lat.value},${lat.hemisphere},` +
    `${lon.value},${lon.hemisphere},1,07,1.2,${fix.altitude.toFixed(1)},M,0.0,M,,`;
  return nmeaSentence(body);
}

/** RMC, recommended minimum: time, status A, position, speed, course, date. */
export function buildGprmc(date: Date, fix: GpsFix): string {
  const lat = formatNmeaCoord(fix.lat, 'lat');
  const lon = formatNmeaCoord(fix.lng, 'lon');
  const body =
    `GPRMC,${nmeaTime(date)},A,${lat.value},${lat.hemisphere},` +
    `${lon.value},${lon.hemisphere},${fix.speed.toFixed(1)},${fix.course.toFixed(1)},` +
    `${nmeaDate(date)},,,A`;
  return nmeaSentence(body);
}

/** One full per-second emission: GPGGA + GPRMC, each CRLF-terminated. */
export function buildNmeaCycle(date: Date, fix: GpsFix): string {
  return `${buildGpgga(date, fix)}\r\n${buildGprmc(date, fix)}\r\n`;
}

// ─── Part registration ───────────────────────────────────────────────────────

const num = (v: unknown, dflt: number): number => {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : dflt;
};

/**
 * The most bytes one poll may hand the wire. A poll normally owes a handful
 * (20 ms of guest at 9600 baud is 19 characters); the cap only matters when
 * the guest outran the wall clock between polls, and it keeps such a catch-up
 * under the smallest hardware RX FIFO a controller port injects into without
 * pacing of its own (the ESP32 UARTs: 128 bytes). What is left goes next poll.
 */
const BURST_MAX = 64;

/** Guest time a stream may lag its schedule before it is re-based, not caught up. */
const LAG_RESYNC_MS = 500;

PartSimulationRegistry.register('gps-neo6m', {
  attachEvents: (element, simulator, _getPin, componentId) => {
    const el = element as unknown as Record<string, unknown> & HTMLElement;
    const sim = simulator as unknown as { isRunning?: () => boolean };

    // The fabric identifies the module by its component id; a part without
    // one has no pins the netlist can name, so it can be on no wire.
    if (!componentId) return () => {};

    const fix: GpsFix = {
      lat: num(el.lat, 40.4168),
      lng: num(el.lng, -3.7038),
      altitude: num(el.altitude, 667),
      speed: num(el.speed, 0),
      course: num(el.course, 0),
    };

    // The date and time of day the receiver reports (see the file header).
    // Every later cycle is one GUEST second after the previous one.
    const baseTime = Date.now();
    let cycles = 0;

    // Only a TX leg: the descriptor says a receiver never listens, so the
    // fabric never places an RX leg for it, whatever its RX pad is wired to.
    // receive() exists because the endpoint contract has it; with no RX leg
    // on any wire the fabric has nothing to hand it.
    const handle = attachUartEndpoint(
      { owner: componentId, pins: { tx: 'TX' }, baud: GPS_BAUD },
      { receive: () => {} },
    );

    // ── The stream, on the guest clock ────────────────────────────────────
    // `pending` is the cycle being shifted out, one character every
    // GPS_BYTE_MS of guest time from `byteDueAt`; a new cycle opens at
    // `nextCycleAt`, once the previous one is out. All in guest milliseconds
    // from guestMillis(); a board whose clock lives in another process (the
    // QEMU lanes) has none readable here and gets the wall clock, which is
    // the rate such a guest runs at anyway.
    let pending: number[] = [];
    let byteDueAt = 0;
    let nextCycleAt: number | null = null;
    let ppsOffAt: number | null = null;
    let onGuestClock: boolean | null = null;

    const now = (): number => {
      const guest = guestMillis(simulator);
      const useGuest = guest !== null;
      // Switching clocks (the engine came up, or went away) restarts the
      // schedule rather than measuring across two unrelated timebases.
      if (onGuestClock !== null && useGuest !== onGuestClock) nextCycleAt = null;
      onGuestClock = useGuest;
      return useGuest ? (guest as number) : performance.now();
    };

    const setPps = (lit: boolean) => {
      try {
        (el as { pps?: boolean }).pps = lit;
      } catch {
        /* headless element */
      }
    };

    const openCycle = (t: number) => {
      const date = new Date(baseTime + cycles * 1000);
      cycles++;
      const text = buildNmeaCycle(date, fix);
      pending = Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
      byteDueAt = t;
      // The marker is the receiver's own 1PPS: it goes with the cycle whether
      // or not anything is wired to hear the sentences.
      setPps(true);
      ppsOffAt = t + GPS_PPS_MS;
    };

    const tick = () => {
      if (typeof sim.isRunning === 'function' && !sim.isRunning()) {
        // The board is the module's supply: stopped, the module is dark. Its
        // first fix after the next Run comes a second later, as after power-on.
        pending = [];
        nextCycleAt = null;
        if (ppsOffAt !== null) {
          setPps(false);
          ppsOffAt = null;
        }
        return;
      }
      const t = now();
      if (nextCycleAt === null) nextCycleAt = t + GPS_CYCLE_MS;
      if (ppsOffAt !== null && t >= ppsOffAt) {
        setPps(false);
        ppsOffAt = null;
      }
      if (pending.length === 0 && t >= nextCycleAt) {
        openCycle(t);
        nextCycleAt += GPS_CYCLE_MS;
        // The guest jumped, or the tab slept: the cadence resumes from now
        // instead of firing the missed cycles back to back.
        if (nextCycleAt <= t) nextCycleAt = t + GPS_CYCLE_MS;
      }
      if (pending.length === 0) return;
      if (t - byteDueAt > LAG_RESYNC_MS) byteDueAt = t;
      let sent = 0;
      while (pending.length > 0 && t >= byteDueAt && sent < BURST_MAX) {
        handle.transmit(pending.shift()!);
        byteDueAt += GPS_BYTE_MS;
        sent++;
      }
    };

    const timer = setInterval(tick, GPS_TICK_MS);

    registerSensorUpdate(componentId, (values) => {
      if ('lat' in values) fix.lat = values.lat as number;
      if ('lng' in values) fix.lng = values.lng as number;
      if ('altitude' in values) fix.altitude = values.altitude as number;
      if ('speed' in values) fix.speed = values.speed as number;
      if ('course' in values) fix.course = values.course as number;
      // Mirror onto the element so the property dialog shows live values.
      for (const k of ['lat', 'lng', 'altitude', 'speed', 'course'] as const) {
        if (k in values) (el as Record<string, unknown>)[k] = values[k];
      }
    });

    return () => {
      clearInterval(timer);
      handle.dispose();
      unregisterSensorUpdate(componentId);
    };
  },
});
