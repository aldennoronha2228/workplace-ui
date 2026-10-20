import type { PinManager } from '../../vendor/velxio/frontend/src/simulation/PinManager'
import type { RuntimeArtifact } from './runtime'

export const C3_CLOCK_HZ = 160_000_000
const FLASH_SIZE = 4 * 1024 * 1024

// Upstream has no counter/ROM setters; keep its private-field compatibility boundary here.
type VendorC3 = {
  core: { cycles: number; pc: number }; _romData: Uint8Array | null
  pinManager: PinManager
  onSerialData: ((char: string) => void) | null
  onBaudRateChange: ((baud: number) => void) | null
  onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null
  loadFlashImage(base64: string): void
  serialWrite(text: string): void
  setPinState(pin: number, state: boolean): void
  start(): void; stop(): void; isRunning(): boolean
}
const modules = import.meta.glob<{ Esp32C3Simulator: new (pins: PinManager) => VendorC3 }>('../../vendor/velxio/frontend/src/simulation/Esp32C3Simulator.ts', { eager: true })
const Esp32C3Simulator = modules['../../vendor/velxio/frontend/src/simulation/Esp32C3Simulator.ts'].Esp32C3Simulator

export function validateC3Artifact(artifact: RuntimeArtifact, payload: string): void {
  if (artifact.format !== 'bin' || artifact.encoding !== 'base64' || artifact.load_address !== 0 || artifact.image_kind !== 'merged-flash' || artifact.chip !== 'esp32c3') throw new Error('ESP32-C3 requires an esp32c3 merged-flash bin artifact with base64 encoding at address 0.')
  // Repeated base64 groups overflow Chrome's regexp stack on a 4 MiB image.
  const unpadded = payload.replace(/={1,2}$/, '')
  if (payload.length % 4 || /[^A-Za-z0-9+/]/.test(unpadded) || payload.length - unpadded.length > 2) throw new Error('ESP32-C3 compiler artifact is not valid base64.')
  const decoded = atob(payload)
  if (decoded.length !== FLASH_SIZE || artifact.size_bytes !== FLASH_SIZE || artifact.flash_size_bytes !== FLASH_SIZE) throw new Error('ESP32-C3 requires a complete 4 MiB merged flash image matching size_bytes and flash_size_bytes.')
  const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const executable = (address: number) => address >= 0x42000000 && address < 0x42400000 || address >= 0x4037c000 && address < 0x403dc000
  const imageEnd = (base: number, limit: number, application: boolean) => {
    if (bytes[base] !== 0xe9 || view.getUint16(base + 12, true) !== 5 || bytes[base + 1] < 1 || bytes[base + 1] > 16) throw new Error('ESP32-C3 merged flash contains an invalid image header or chip ID.')
    const entry = view.getUint32(base + 4, true)
    if (!executable(entry)) throw new Error('ESP32-C3 image entry point is outside executable memory.')
    let cursor = base + 24
    let entryLoaded = false
    let checksum = 0xef
    for (let i = 0; i < bytes[base + 1]; i++) {
      if (cursor + 8 > limit) throw new Error('ESP32-C3 image segment header is truncated.')
      const address = view.getUint32(cursor, true)
      const length = view.getUint32(cursor + 4, true)
      cursor += 8
      if (cursor + length > limit) throw new Error('ESP32-C3 image segment data is truncated or overlaps another flash region.')
      // ESP image alignment padding uses a zero load address and is not mapped.
      if (application && length && address !== 0) {
        const regions = [[0x42000000, 0x42400000], [0x3c000000, 0x3c400000], [0x3fc80000, 0x3fce0000], [0x4037c000, 0x403dc000], [0x50000000, 0x50002000]]
        if (!regions.some(([start, end]) => address >= start && address + length <= end)) throw new Error(`ESP32-C3 application segment 0x${address.toString(16)} (${length} bytes) is outside supported memory regions.`)
      }
      if (entry >= address && entry < address + length) entryLoaded = true
      for (let j = cursor; j < cursor + length; j++) checksum ^= bytes[j]
      cursor += length
    }
    const checksumOffset = Math.ceil((cursor + 1) / 16) * 16 - 1
    if (checksumOffset >= limit || bytes[checksumOffset] !== checksum || !entryLoaded) throw new Error('ESP32-C3 image checksum or executable entry segment is invalid.')
  }
  imageEnd(0, 0x8000, false)
  if (view.getUint16(0x8000, true) !== 0x50aa) throw new Error('ESP32-C3 merged flash is missing its partition table.')
  let appPartition = false
  for (let offset = 0x8000; offset < 0x9000 && view.getUint16(offset, true) === 0x50aa; offset += 32) {
    if (bytes[offset + 2] === 0 && view.getUint32(offset + 4, true) === 0x10000 && view.getUint32(offset + 8, true) >= 24) appPartition = true
  }
  if (!appPartition) throw new Error('ESP32-C3 partition table must contain an application at offset 0x10000.')
  imageEnd(0x10000, bytes.length, true)
}

export class C3Simulator {
  private vendor: VendorC3
  constructor(pins: PinManager) { this.vendor = new Esp32C3Simulator(pins) }
  get pinManager() { return this.vendor.pinManager }
  get onSerialData() { return this.vendor.onSerialData }
  set onSerialData(callback: ((char: string, uart?: number) => void) | null) { this.vendor.onSerialData = callback }
  get onBaudRateChange() { return this.vendor.onBaudRateChange }
  set onBaudRateChange(callback: ((baud: number, link?: unknown) => void) | null) { this.vendor.onBaudRateChange = callback }
  get onPinChangeWithTime() { return this.vendor.onPinChangeWithTime }
  set onPinChangeWithTime(callback: ((pin: number, state: boolean, timeMs: number) => void) | null) { this.vendor.onPinChangeWithTime = callback }
  async loadBinary(payload: string) {
    const response = await fetch('/boards/esp32c3-rom.bin')
    if (!response.ok) throw new Error(`ESP32-C3 ROM load failed: HTTP ${response.status}.`)
    const rom = new Uint8Array(await response.arrayBuffer())
    if (rom.length !== 0x60000) throw new Error('ESP32-C3 ROM must contain the genuine 384 KiB vendor ROM image.')
    this.vendor._romData = rom
    this.vendor.loadFlashImage(payload)
  }
  getClockHz() { return C3_CLOCK_HZ }
  getCurrentCycles() { return this.vendor.core.cycles }
  getProgramCounter() { return this.vendor.core.pc >>> 0 }
  getBusBinding() { return { uart: [{ receive: (byte: number) => this.vendor.serialWrite(String.fromCharCode(byte & 0xff)) }] } }
  setPinState(pin: number, state: boolean) { this.vendor.setPinState(pin, state) }
  start() {
    this.vendor.start()
    const pc = this.getProgramCounter()
    const executable = [[0x42000000, 0x42400000], [0x4037c000, 0x403dc000], [0x40000000, 0x40060000], [0x40800000, 0x40820000]]
    if (!executable.some(([start, end]) => pc >= start && pc < end)) {
      this.vendor.stop()
      throw new Error(`Experimental ESP32-C3 execution left executable memory at PC 0x${pc.toString(16)} after ${this.getCurrentCycles()} vendor cycles; upstream firmware execution is unavailable.`)
    }
  }
  stop() { this.vendor.stop() }
  isRunning() { return this.vendor.isRunning() }
}
