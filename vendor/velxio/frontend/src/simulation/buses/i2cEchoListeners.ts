/**
 * Who draws a write phase a QEMU worker echoes.
 *
 * A display or an expander on an ESP32 or STM32 worker is answered there by a
 * write sink, and the part in the tab draws from the bytes the sink echoes
 * (`i2c_transaction`). The echo names the address and, from a worker that
 * knows it, the part (`owner`, the component id its record carries). Keyed by
 * address alone, two panels at 0x3C on the two controllers of one board were
 * one listener: the part that attached last drew both streams, the other stayed
 * blank, and detaching either silenced both.
 *
 * So a part listens under its own id, and an echo that names an owner reaches
 * that part only. A listener that gives no owner (the pro Grove chips) and an
 * echo that names none (a worker from before owners) still meet by address.
 *
 * Leaf module: no imports.
 */
export type I2cEchoListener = (data: number[]) => void;

export class I2cEchoListeners {
  private readonly byOwner = new Map<string, { addr: number; fn: I2cEchoListener }>();
  private readonly byAddr = new Map<number, I2cEchoListener>();

  add(addr: number, fn: I2cEchoListener, owner?: string): void {
    if (owner) this.byOwner.set(owner, { addr, fn });
    else this.byAddr.set(addr, fn);
  }

  remove(addr: number, owner?: string): void {
    if (owner) this.byOwner.delete(owner);
    else this.byAddr.delete(addr);
  }

  get size(): number {
    return this.byOwner.size + this.byAddr.size;
  }

  /** Hand one echoed write phase to the part (or parts) it belongs to. */
  deliver(addr: number, data: number[], owner?: string): void {
    if (owner) {
      const own = this.byOwner.get(owner);
      if (own) {
        own.fn(data);
        return;
      }
    } else {
      // A worker that does not name the part: every part at the address.
      for (const l of this.byOwner.values()) if (l.addr === addr) l.fn(data);
    }
    this.byAddr.get(addr)?.(data);
  }
}
