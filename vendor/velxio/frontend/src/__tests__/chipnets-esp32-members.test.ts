/**
 * Chip-to-chip nets as the ESP32 backend sees them.
 *
 * A chip on an ESP32 board runs in that board's QEMU worker, which knows only
 * what the frontend sends it. `resolveChipNetKey` cannot serve that path: it
 * answers with a PinManager key, which is meaningless across a process, and it
 * deliberately returns null for a net that carries a board pin. The worker
 * needs the net identity itself, and needs to know whether the other end of
 * the net is in another worker.
 *
 * The wiring under test is the xKoin two-board LoRa proof: one SX1262 per
 * board with its SPI pins on that board's GPIOs, and the two ANT pins wired to
 * each other and to nothing else.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveChipNetMembers,
  resolveChipOwnerBoardId,
  setChipBusEnabledForTest,
  resetChipNetIndexForTest,
  type ChipNetState,
} from '../simulation/customChips/chipNets';

const chip = (id: string) => ({ id, metadataId: 'custom-chip' });
const wire = (aId: string, aPin: string, bId: string, bPin: string) => ({
  start: { componentId: aId, pinName: aPin },
  end: { componentId: bId, pinName: bPin },
});

/** Two ESP32-S3 boards, one radio each, ANT to ANT. */
function twoBoardRadioState(): ChipNetState {
  const spi = (chipId: string, boardId: string) => [
    wire(chipId, 'SCK', boardId, '12'),
    wire(chipId, 'MISO', boardId, '13'),
    wire(chipId, 'MOSI', boardId, '11'),
    wire(chipId, 'NSS', boardId, '10'),
    wire(chipId, 'DIO1', boardId, '14'),
    wire(chipId, 'BUSY', boardId, '21'),
  ];
  return {
    wires: [
      ...spi('radioA', 'boardA'),
      ...spi('radioB', 'boardB'),
      wire('radioA', 'ANT', 'radioB', 'ANT'),
    ],
    components: [chip('radioA'), chip('radioB')],
    boards: [
      { id: 'boardA', boardKind: 'esp32-s3' },
      { id: 'boardB', boardKind: 'esp32-s3' },
    ],
  };
}

/** Both radios on one board, each on its own GPIOs: the same net, one worker. */
function oneBoardRadioState(): ChipNetState {
  return {
    wires: [
      wire('radioA', 'SCK', 'boardA', '12'),
      wire('radioA', 'MISO', 'boardA', '13'),
      wire('radioA', 'MOSI', 'boardA', '11'),
      wire('radioA', 'NSS', 'boardA', '10'),
      wire('radioB', 'SCK', 'boardA', '36'),
      wire('radioB', 'MISO', 'boardA', '37'),
      wire('radioB', 'MOSI', 'boardA', '35'),
      wire('radioB', 'NSS', 'boardA', '34'),
      wire('radioA', 'ANT', 'radioB', 'ANT'),
    ],
    components: [chip('radioA'), chip('radioB')],
    boards: [{ id: 'boardA', boardKind: 'esp32-s3' }],
  };
}

describe('chip nets on the ESP32 backend', () => {
  beforeEach(() => {
    setChipBusEnabledForTest(true);
    resetChipNetIndexForTest();
  });
  afterEach(() => {
    setChipBusEnabledForTest(null);
    resetChipNetIndexForTest();
  });

  it('reports the ANT pin, and only the ANT pin, as a chip net member', () => {
    const members = resolveChipNetMembers(twoBoardRadioState(), 'radioA');
    expect(members.map((m) => m.pin)).toEqual(['ANT']);
  });

  it('gives both ends of the net the same id', () => {
    const state = twoBoardRadioState();
    const a = resolveChipNetMembers(state, 'radioA');
    const b = resolveChipNetMembers(state, 'radioB');
    expect(a[0].net).toBe(b[0].net);
  });

  it('marks the net remote when the two chips are on different boards', () => {
    const members = resolveChipNetMembers(twoBoardRadioState(), 'radioA');
    expect(members[0].remote).toBe(true);
  });

  it('does not mark it remote when both chips are on one board', () => {
    const members = resolveChipNetMembers(oneBoardRadioState(), 'radioA');
    expect(members).toHaveLength(1);
    expect(members[0].remote).toBe(false);
  });

  it('resolves each chip to the board its other pins reach', () => {
    const state = twoBoardRadioState();
    expect(resolveChipOwnerBoardId(state, 'radioA')).toBe('boardA');
    expect(resolveChipOwnerBoardId(state, 'radioB')).toBe('boardB');
  });

  it('keeps a net that carries a board pin, unlike resolveChipNetKey', () => {
    // Two chips and a board GPIO on one line: the GPIO behaviour stays on the
    // backend and the chip members are driven as well, so the net must still
    // be described. resolveChipNetKey returns null here by design.
    const state: ChipNetState = {
      wires: [
        wire('chipA', 'IO', 'chipB', 'IO'),
        wire('chipA', 'IO', 'boardA', '5'),
      ],
      components: [chip('chipA'), chip('chipB')],
      boards: [{ id: 'boardA', boardKind: 'esp32-s3' }],
    };
    const members = resolveChipNetMembers(state, 'chipA');
    expect(members.map((m) => m.pin)).toEqual(['IO']);
    expect(members[0].remote).toBe(false);
  });

  it('treats a shared board bus as a chip net too', () => {
    // Two chips whose SCK pins land on one board GPIO really are on one net,
    // so the members list says so. The GPIO keeps driving them both; the
    // addition is that a write by one chip also reaches the other.
    const state: ChipNetState = {
      wires: [
        wire('chipA', 'SCK', 'boardA', '12'),
        wire('chipB', 'SCK', 'boardA', '12'),
        wire('chipA', 'ANT', 'chipB', 'ANT'),
      ],
      components: [chip('chipA'), chip('chipB')],
      boards: [{ id: 'boardA', boardKind: 'esp32-s3' }],
    };
    expect(resolveChipNetMembers(state, 'chipA').map((m) => m.pin)).toEqual([
      'ANT',
      'SCK',
    ]);
  });

  it('says nothing about a chip pin with no second chip on it', () => {
    const state: ChipNetState = {
      wires: [wire('chipA', 'OUT', 'boardA', '5')],
      components: [chip('chipA')],
      boards: [{ id: 'boardA', boardKind: 'esp32-s3' }],
    };
    expect(resolveChipNetMembers(state, 'chipA')).toEqual([]);
  });

  it('returns nothing when the chip bus is switched off', () => {
    setChipBusEnabledForTest(false);
    expect(resolveChipNetMembers(twoBoardRadioState(), 'radioA')).toEqual([]);
  });
});
