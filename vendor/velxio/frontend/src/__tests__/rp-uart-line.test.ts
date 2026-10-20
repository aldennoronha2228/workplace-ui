import { describe, expect, it } from 'vitest';
import { RP2040 } from 'rp2040js';
import {
  RP2040_CLOCKS_KEY,
  rpUartLink,
  watchRpPeriClock,
  watchRpUartLine,
} from '../simulation/rpUartLine';
import type { SerialLink } from '../store/serialWire';

/**
 * The line a Pico's PL011 clocks, read back off the engine the way pico-sdk writes it:
 * uart_set_baudrate -> IBRD/FBRD, then uart_set_format -> LCR_H, then CR. A link taken
 * at the engine's onBaudRateChange alone would carry the reset LCR_H (5 data bits).
 */
const UARTIBRD = 0x24;
const UARTFBRD = 0x28;
const UARTLCR_H = 0x2c;
const UARTCR = 0x30;
const CLK_PERI = 125_000_000;

/** pico-sdk uart_set_baudrate + uart_set_format(8N1), byte for byte. */
function guestInit(
  uart: RP2040['uart'][0],
  baud: number,
  lcr = 0x70 /* WLEN=8, FEN */,
  clkPeri = CLK_PERI,
): void {
  const div = Math.floor((8 * clkPeri) / baud);
  let ibrd = div >>> 7;
  let fbrd: number;
  if (ibrd === 0) {
    ibrd = 1;
    fbrd = 0;
  } else if (ibrd >= 65535) {
    ibrd = 65535;
    fbrd = 0;
  } else {
    fbrd = ((div & 0x7f) + 1) >>> 1;
  }
  uart.writeUint32(UARTIBRD, ibrd);
  uart.writeUint32(UARTFBRD, fbrd);
  uart.writeUint32(UARTLCR_H, lcr);
  uart.writeUint32(UARTCR, 0x301); // UARTEN | TXE | RXE
}

describe('the line a Pico UART clocks', () => {
  it('decodes the standard rates within the divider error', () => {
    for (const baud of [300, 1200, 9600, 19200, 38400, 57600, 115200, 230400, 921600]) {
      const mcu = new RP2040();
      guestInit(mcu.uart[0], baud);
      const link = rpUartLink(mcu.uart[0]);
      expect(link, `${baud}`).not.toBeNull();
      expect(Math.abs(link!.baud - baud) / baud, `${baud} -> ${link!.baud}`).toBeLessThan(0.005);
      expect(link).toMatchObject({ source: 'uart', dataBits: 8, parity: 'none', stopBits: 1 });
    }
  });

  it('reports the FORMAT the guest wrote after the rate, not the reset one', () => {
    const mcu = new RP2040();
    const seen: SerialLink[] = [];
    watchRpUartLine(mcu.uart[0], (l) => seen.push(l));
    guestInit(mcu.uart[0], 9600, (2 << 5) | 0x8 | 0x4 | 0x2); // 7E2
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toMatchObject({ dataBits: 7, parity: 'even', stopBits: 2 });
    expect(Math.abs(seen[seen.length - 1].baud - 9600) / 9600).toBeLessThan(0.005);
  });

  it('publishes on change only', () => {
    const mcu = new RP2040();
    const seen: SerialLink[] = [];
    watchRpUartLine(mcu.uart[0], (l) => seen.push(l));
    guestInit(mcu.uart[0], 115200);
    const n = seen.length;
    guestInit(mcu.uart[0], 115200); // the driver re-applying its config says nothing new
    expect(seen.length).toBe(n);
    guestInit(mcu.uart[0], 9600);
    expect(seen.length).toBeGreaterThan(n);
  });

  it('has no rate to report before the divisor is programmed', () => {
    expect(rpUartLink(new RP2040().uart[0])).toBeNull();
  });

  it('follows the guest onto the 48 MHz USB PLL, as arduino-pico leaves clk_peri', () => {
    // set_sys_clock_pll parks clk_peri on pll_usb (CLK_PERI_CTRL AUXSRC = 2) and the
    // sketch then computes its divisor for 48 MHz. Read through a fixed 125 MHz that
    // came out as 299,940 baud for a Serial.begin(115200).
    const mcu = new RP2040();
    const seen: SerialLink[] = [];
    const line = watchRpUartLine(mcu.uart[0], (l) => seen.push(l));
    watchRpPeriClock(mcu, RP2040_CLOCKS_KEY, () => line.publish());
    mcu.writeUint32(0x40008000 + 0x48, (2 << 5) | (1 << 11)); // AUXSRC = pll_usb, ENABLE
    guestInit(mcu.uart[0], 115200, 0x70, 48_000_000);
    const last = seen[seen.length - 1];
    expect(Math.abs(last.baud - 115200) / 115200).toBeLessThan(0.005);
    expect(mcu.clkPeri).toBe(48_000_000);
  });

  it('re-reports the line when clk_peri moves under a programmed divisor', () => {
    const mcu = new RP2040();
    const seen: SerialLink[] = [];
    const line = watchRpUartLine(mcu.uart[0], (l) => seen.push(l));
    watchRpPeriClock(mcu, RP2040_CLOCKS_KEY, () => line.publish());
    guestInit(mcu.uart[0], 9600); // divisor for the 125 MHz clk_sys default
    const n = seen.length;
    mcu.writeUint32(0x40008000 + 0x48, (4 << 5) | (1 << 11)); // AUXSRC = xosc 12 MHz
    expect(seen.length).toBe(n + 1);
    const expected = (9600 * 12) / 125;
    expect(Math.abs(seen[n].baud - expected) / expected).toBeLessThan(0.01);
  });
});
