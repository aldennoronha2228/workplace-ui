/**
 * The worker-side slot of a custom chip.
 *
 * A chip hosted in a backend worker (ESP32 QEMU, STM32) is registered as a
 * sensor record, and the worker keys those records by pin. A chip has no
 * pin of its own, so every chip used to share one synthetic slot, 0xFF:
 * several chips on one board all loaded, but live attribute updates and a
 * detach reached only the last one registered. Each chip now gets a slot
 * of its own, stable for the life of the page so a part that re-attaches
 * (every Run) lands on the same record.
 *
 * The range starts well above anything else that travels as a pin: board
 * GPIOs (< 200), the I2C-part convention (200 + address, < 320) and the
 * in-browser engines' "real GPIO" test (< 200 forces QEMU).
 */
const FIRST_SLOT = 0x1000;

const slots = new Map<string, number>();

export function chipVirtualPin(componentId: string): number {
  let pin = slots.get(componentId);
  if (pin === undefined) {
    pin = FIRST_SLOT + slots.size;
    slots.set(componentId, pin);
  }
  return pin;
}

/** True for a pin number minted by chipVirtualPin. */
export function isChipVirtualPin(pin: number): boolean {
  return pin >= FIRST_SLOT && pin < FIRST_SLOT + 0x1000;
}

export function resetChipVirtualPinsForTest(): void {
  slots.clear();
}
