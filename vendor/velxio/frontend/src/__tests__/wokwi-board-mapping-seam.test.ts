// @vitest-environment jsdom
/**
 * registerWokwiBoardMappings — the seam that lets a consumer teach the Wokwi
 * importer board part types this file has no table for.
 *
 * Velxio simulates boards Wokwi also draws, under a different spelling
 * (`board-esp32-s3-devkitc-1` there, kind `esp32-s3` here). Which pairs are
 * true is a moving list about boards a given build may not even have, so the
 * table lives with the consumer that owns it and arrives through this seam.
 *
 * What is protected here: the empty registry is the OSS default and behaves
 * exactly as before (the four native boards, plus `board-velxio-<kind>`), and
 * a registered row can never shadow either — registering must not be able to
 * change how a file that already imported correctly imports.
 *
 * The registry is module state, so each case re-imports the module fresh.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import JSZip from 'jszip';

type WokwiZipModule = typeof import('../utils/wokwiZip');

async function freshModule(): Promise<WokwiZipModule> {
  vi.resetModules();
  return import('../utils/wokwiZip');
}

/** A one-board diagram zipped the way a Wokwi export ships it. */
async function zipWithBoard(type: string): Promise<File> {
  const zip = new JSZip();
  zip.file('diagram.json', JSON.stringify({
    version: 1,
    author: 'test',
    editor: 'wokwi',
    parts: [
      { type, id: 'esp', top: 0, left: 0, attrs: {} },
      { type: 'wokwi-led', id: 'led1', top: 100, left: 100, attrs: { color: 'red' } },
    ],
    connections: [['esp:2', 'led1:A', 'green', []]],
  }));
  zip.file('sketch.ino', 'void setup() {}\nvoid loop() {}\n');
  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], 'project.zip');
}

const ESP32_S3_ROWS = [
  { type: 'board-esp32-s3-devkitc-1', kind: 'esp32-s3' },
  { type: 'board-esp32-c6-devkitc-1', kind: 'esp32-c6' },
];

describe('registerWokwiBoardMappings', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('with nothing registered, a Wokwi ESP32 diagram still reports no board', async () => {
    const mod = await freshModule();
    expect(mod.wokwiTypeToBoardKind('board-esp32-s3-devkitc-1')).toBeNull();
    const result = await mod.importFromWokwiZip(await zipWithBoard('board-esp32-s3-devkitc-1'));
    // Null, not a silent Uno (#268): the importer only ever names a board it
    // can actually resolve.
    expect(result.boardType).toBeNull();
  });

  it('with the rows registered, the same diagram imports as that kind', async () => {
    const mod = await freshModule();
    mod.registerWokwiBoardMappings(ESP32_S3_ROWS);
    expect(mod.wokwiTypeToBoardKind('board-esp32-s3-devkitc-1')).toBe('esp32-s3');
    expect(mod.wokwiTypeToBoardKind('board-esp32-c6-devkitc-1')).toBe('esp32-c6');
    const result = await mod.importFromWokwiZip(await zipWithBoard('board-esp32-s3-devkitc-1'));
    expect(result.boardType).toBe('esp32-s3');
    // The board is a board, not one more component on the canvas.
    expect(result.components.some((c) => c.id === 'esp')).toBe(false);
  });

  it('a registered row never overrides a native type or the velxio prefix', async () => {
    const mod = await freshModule();
    mod.registerWokwiBoardMappings([
      { type: 'wokwi-arduino-uno', kind: 'esp32-s3' },
      { type: 'wokwi-raspberry-pi-pico', kind: 'esp32-s3' },
      { type: 'board-velxio-esp32-c6', kind: 'arduino-uno' },
    ]);
    expect(mod.wokwiTypeToBoardKind('wokwi-arduino-uno')).toBe('arduino-uno');
    expect(mod.wokwiTypeToBoardKind('wokwi-raspberry-pi-pico')).toBe('raspberry-pi-pico');
    expect(mod.wokwiTypeToBoardKind('board-velxio-esp32-c6')).toBe('esp32-c6');
    const result = await mod.importFromWokwiZip(await zipWithBoard('wokwi-arduino-uno'));
    expect(result.boardType).toBe('arduino-uno');
  });

  it('leaves the export side alone and ignores malformed rows', async () => {
    const mod = await freshModule();
    mod.registerWokwiBoardMappings([
      ...ESP32_S3_ROWS,
      { type: '', kind: 'esp32-s3' },
      { type: 'board-nonesuch', kind: '' },
    ]);
    // A board still exports under the spelling Velxio owns, never a
    // registered Wokwi one, so the round trip stays exact.
    expect(mod.boardKindToWokwiType('esp32-s3')).toBe('board-velxio-esp32-s3');
    expect(mod.boardKindToWokwiType('arduino-uno')).toBe('wokwi-arduino-uno');
    expect(mod.wokwiTypeToBoardKind('board-nonesuch')).toBeNull();
    expect(mod.wokwiTypeToBoardKind('')).toBeNull();
  });
});
