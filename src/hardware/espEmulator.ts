import { PinManager } from '../../vendor/velxio/frontend/src/simulation/PinManager'
import type { AVRSimulator } from '../../vendor/velxio/frontend/src/simulation/AVRSimulator'
import type { RuntimeArtifact } from './runtime'
import { getEspNetwork } from './espNetwork'

export const ESP_BOARDS = new Set(['esp32-c3', 'esp32-s3'])
type Chip = 'esp32c3' | 'esp32s3'
export type EspState = 'idle' | 'loading' | 'ready' | 'running' | 'stopped' | 'error'
const STARTUP_TIMEOUT_MS = 30_000
const FLASH_SIZE = 4 * 1024 * 1024

export function espChip(board: string): Chip {
  if (board === 'esp32-c3') return 'esp32c3'
  if (board === 'esp32-s3') return 'esp32s3'
  throw new Error(`Unsupported esp-emulator board: ${board}. Classic ESP32 is not supported.`)
}

export function espPinExists(chip: Chip, pin: number): boolean {
  return Number.isInteger(pin) && pin >= 0 && (chip === 'esp32c3' ? pin < 22 : pin < 49 && (pin < 22 || pin > 25))
}

function decodeFlash(payload: string): Uint8Array {
  const unpadded = payload.replace(/={1,2}$/, '')
  if (!payload.length || payload.length % 4 || /[^A-Za-z0-9+/]/.test(unpadded) || payload.length > Math.ceil(FLASH_SIZE / 3) * 4) throw new Error('ESP compiler artifact is not valid base64.')
  let decoded: string
  try { decoded = atob(payload) } catch { throw new Error('ESP compiler artifact is not valid base64.') }
  return Uint8Array.from(decoded, char => char.charCodeAt(0))
}

export function validateEspArtifact(artifact: RuntimeArtifact, payload: string): void {
  const chip = espChip(artifact.board)
  if (artifact.format !== 'bin' || artifact.encoding !== 'base64' || artifact.load_address !== 0 || artifact.image_kind !== 'merged-flash' || artifact.chip !== chip) throw new Error(`${artifact.board} requires a chip-matched merged-flash bin artifact with base64 encoding at address 0.`)
  const bytes = decodeFlash(payload)
  if (bytes.length !== FLASH_SIZE || artifact.size_bytes !== FLASH_SIZE || artifact.flash_size_bytes !== FLASH_SIZE) throw new Error('ESP requires a complete 4 MiB merged flash image matching size_bytes and flash_size_bytes.')
  const view = new DataView(bytes.buffer)
  const chipId = chip === 'esp32c3' ? 5 : 9
  const codeRegions = chip === 'esp32c3' ? [[0x42000000, 0x42400000], [0x4037c000, 0x403e0000]] : [[0x42000000, 0x42400000], [0x40370000, 0x403e0000]]
  const dataRegions = chip === 'esp32c3' ? [[0x3c000000, 0x3c400000], [0x3fc80000, 0x3fce0000], [0x50000000, 0x50002000]] : [[0x3c000000, 0x3c400000], [0x3fc88000, 0x3fd00000], [0x50000000, 0x50002000], [0x600fe000, 0x60100000]]
  const image = (base: number, limit: number, application: boolean) => {
    if (base + 24 > limit || bytes[base] !== 0xe9 || view.getUint16(base + 12, true) !== chipId || bytes[base + 1] < 1 || bytes[base + 1] > 16) throw new Error('ESP merged flash contains an invalid image header or chip ID.')
    const entry = view.getUint32(base + 4, true)
    if (!codeRegions.some(([start, end]) => entry >= start && entry < end)) throw new Error('ESP image entry point is outside executable memory.')
    let cursor = base + 24
    let entryLoaded = false
    let checksum = 0xef
    for (let i = 0; i < bytes[base + 1]; i++) {
      if (cursor + 8 > limit) throw new Error('ESP image segment header is truncated.')
      const address = view.getUint32(cursor, true)
      const length = view.getUint32(cursor + 4, true)
      cursor += 8
      if (cursor + length > limit) throw new Error('ESP image segment data is truncated or overlaps another flash region.')
      if (application && address && length && ![...codeRegions, ...dataRegions].some(([start, end]) => address >= start && address + length <= end)) throw new Error('ESP application segment is outside supported memory regions.')
      if (entry >= address && entry < address + length) entryLoaded = true
      for (let j = cursor; j < cursor + length; j++) checksum ^= bytes[j]
      cursor += length
    }
    const checksumOffset = Math.ceil((cursor + 1) / 16) * 16 - 1
    if (checksumOffset >= limit || bytes[checksumOffset] !== checksum || !entryLoaded) throw new Error('ESP image checksum or executable entry segment is invalid.')
  }
  image(0, 0x8000, false)
  if (view.getUint16(0x8000, true) !== 0x50aa) throw new Error('ESP merged flash is missing its partition table.')
  let appLimit = 0
  const partitions: [number, number][] = []
  for (let offset = 0x8000; offset < 0x9000 && view.getUint16(offset, true) === 0x50aa; offset += 32) {
    const start = view.getUint32(offset + 4, true)
    const size = view.getUint32(offset + 8, true)
    const end = start + size
    if (start < 0x9000 || !size || end > FLASH_SIZE || partitions.some(([a, b]) => start < b && end > a)) throw new Error('ESP partition table contains invalid or overlapping flash regions.')
    partitions.push([start, end])
    if (bytes[offset + 2] === 0 && start === 0x10000 && size >= 24) appLimit = end
  }
  if (!appLimit) throw new Error('ESP partition table must contain an application at offset 0x10000.')
  image(0x10000, appLimit, true)
}

class EspPins extends PinManager {
  readonly pinLevels = new Map<number, boolean>()
  override peekPinState(pin: number) { return this.pinLevels.get(pin) }
  override getPinState(pin: number) { return this.pinLevels.get(pin) ?? false }
}

type WorkerMessage = {
  type: string; message?: string; data?: string; chip?: string; cycles?: number; cyclesPerUs?: number; gpio?: number[]
}

export class EspEmulator {
  readonly pinManager = new EspPins()
  onSerialData: ((char: string, uart?: number) => void) | null = null
  onBaudRateChange: AVRSimulator['onBaudRateChange'] = null
  onPinChangeWithTime: AVRSimulator['onPinChangeWithTime'] = null
  onError: ((error: Error) => void) | null = null
  state: EspState = 'idle'
  error: string | null = null
  private worker: Worker | null = null
  private generation = 0
  private cycles = 0
  private clockHz = 0
  private inputs = new Map<number, boolean>()
  private pending: { type: string; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null

  constructor(readonly chip: Chip) {}

  private waitFor(type: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`ESP emulator ${type} timed out after 30 seconds.`)), STARTUP_TIMEOUT_MS)
      this.pending = { type, resolve, reject, timer }
    })
  }

  private complete(type: string) {
    if (this.pending?.type !== type) return
    const pending = this.pending
    this.pending = null
    clearTimeout(pending.timer)
    pending.resolve()
  }

  private terminate(error: Error) {
    this.generation++
    this.worker?.terminate()
    this.worker = null
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(error)
      this.pending = null
    }
  }

  private fail(error: Error) {
    this.error = error.message
    this.state = 'error'
    this.terminate(error)
    this.onError?.(error)
  }

  async loadBinary(payload: string, projectId = ''): Promise<void> {
    this.stop()
    this.state = 'loading'
    this.error = null
    this.cycles = 0
    this.clockHz = 0
    this.inputs.clear()
    this.pinManager.pinLevels.clear()
    const generation = this.generation
    try {
      const firmware = decodeFlash(payload)
      // Public assets remain unbundled; wasm-bindgen resolves its sibling WASM.
      const worker = new Worker('/esp-emulator/worker.js', { type: 'module', name: `esp-emulator-${this.chip}` })
      this.worker = worker
      worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
        if (this.worker !== worker || this.generation !== generation) return
        try { this.receive(data) } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
      }
      worker.onerror = event => {
        event.preventDefault()
        if (this.worker === worker) this.fail(new Error(`ESP worker failed: ${event.message}`))
      }
      worker.onmessageerror = () => { if (this.worker === worker) this.fail(new Error('ESP worker returned an unreadable message.')) }
      const ready = this.waitFor('ready')
      worker.postMessage({ type: 'init' })
      await ready
      if (this.worker !== worker || this.generation !== generation) throw new Error('ESP startup was cancelled.')
      const loaded = this.waitFor('loaded')
      worker.postMessage({ type: 'load', chip: this.chip, firmware: firmware.buffer, network: getEspNetwork(projectId), skipRom: false }, [firmware.buffer])
      await loaded
      if (this.worker !== worker || this.generation !== generation) throw new Error('ESP startup was cancelled.')
      this.state = 'ready'
    } catch (error) {
      if (this.generation === generation) this.fail(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  private receive(msg: WorkerMessage) {
    if (msg.type === 'error') { this.fail(new Error(msg.message ?? 'ESP emulator failed.')); return }
    if (msg.type === 'loaded' && msg.chip !== this.chip) throw new Error('ESP worker loaded the wrong chip.')
    if (msg.cyclesPerUs !== undefined) {
      if (!Number.isFinite(msg.cyclesPerUs) || msg.cyclesPerUs <= 0) throw new Error('ESP worker reported an invalid CPU clock.')
      this.clockHz = msg.cyclesPerUs * 1_000_000
    }
    if (msg.cycles !== undefined) {
      if (!Number.isFinite(msg.cycles) || msg.cycles < 0) throw new Error('ESP worker reported invalid cycles.')
      this.cycles = msg.cycles
    }
    if (msg.type === 'snapshot') this.snapshot(msg.gpio)
    if (msg.type === 'uart_output' && typeof msg.data === 'string') this.onSerialData?.(msg.data, 0)
    if (msg.type === 'status' && this.state === 'running' && this.cycles > 0) this.complete('status')
    if (msg.type === 'ready' || msg.type === 'loaded') this.complete(msg.type)
  }

  private snapshot(gpio?: number[]) {
    if (!gpio || gpio.length !== 4 || gpio.some(value => !Number.isInteger(value) || value < 0 || value > 0xffffffff)) throw new Error('ESP worker returned an invalid GPIO snapshot.')
    for (let pin = 0; pin < 49; pin++) {
      if (!espPinExists(this.chip, pin)) continue
      const bank = pin < 32 ? 0 : 1
      const mask = 1 << (pin % 32)
      const output = (gpio[bank + 2] & mask) !== 0
      const high = (gpio[bank] & mask) !== 0
      const level = output ? high : this.inputs.get(pin)
      const previous = this.pinManager.peekPinState(pin)
      this.pinManager.setPinDirection(pin, output ? 1 : 0)
      this.pinManager.reportPad(pin, output ? high ? 'high' : 'low' : 'z', 0, this.cycles)
      if (level === undefined) this.pinManager.pinLevels.delete(pin)
      else {
        this.pinManager.pinLevels.set(pin, level)
        this.pinManager.setPinState(pin, level, output ? 'mcu' : 'external')
        if (previous !== level && this.clockHz) this.onPinChangeWithTime?.(pin, level, this.cycles * 1000 / this.clockHz)
      }
    }
  }

  async start(): Promise<void> {
    if (!this.worker || this.state !== 'ready') throw new Error('ESP firmware is not ready. Load the artifact again.')
    this.state = 'running'
    const started = this.waitFor('status')
    this.worker.postMessage({ type: 'start' })
    await started
    if (!this.isRunning()) throw new Error('ESP startup was cancelled.')
  }

  stop() {
    this.terminate(new Error('ESP startup was cancelled.'))
    if (this.state !== 'error') this.state = 'stopped'
  }
  isRunning() { return this.state === 'running' && this.worker !== null }
  getClockHz() { return this.clockHz }
  getCurrentCycles() { return this.cycles }
  getBusBinding() {
    return { uart: [{ receive: (byte: number) => {
      if (!this.isRunning()) throw new Error('ESP emulator is not running.')
      this.worker!.postMessage({ type: 'uart_input', data: [byte & 0xff] })
    } }] }
  }
  setPinState(pin: number, high: boolean) {
    if (!espPinExists(this.chip, pin)) throw new Error(`Invalid ${this.chip} GPIO ${pin}.`)
    if (!this.worker) return
    this.inputs.set(pin, high)
    this.worker.postMessage({ type: 'gpio_input', pin, high })
  }
}
