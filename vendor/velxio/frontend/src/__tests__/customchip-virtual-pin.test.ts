/**
 * Each custom chip hosted in a backend worker gets its own sensor slot.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { chipVirtualPin, isChipVirtualPin, resetChipVirtualPinsForTest } from '../simulation/customChips/chipVirtualPin';

describe('chipVirtualPin', () => {
  beforeEach(() => resetChipVirtualPinsForTest());

  it('gives two chips two slots and the same chip the same slot', () => {
    const a = chipVirtualPin('chip-a');
    const b = chipVirtualPin('chip-b');
    expect(a).not.toBe(b);
    expect(chipVirtualPin('chip-a')).toBe(a);
  });

  it('stays clear of GPIO numbers and the I2C-part convention', () => {
    const p = chipVirtualPin('chip-a');
    expect(p).toBeGreaterThanOrEqual(0x1000);
    expect(isChipVirtualPin(p)).toBe(true);
    expect(isChipVirtualPin(0xff)).toBe(false);
    expect(isChipVirtualPin(200 + 0x50)).toBe(false);
  });
});
