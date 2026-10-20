import { AVRSimulator } from '../../vendor/velxio/frontend/src/simulation/AVRSimulator'
import { PinManager } from '../../vendor/velxio/frontend/src/simulation/PinManager'
import { verifyHexChecksum } from '../../vendor/velxio/frontend/src/utils/hexParser'
import { runtimeUrl } from '../lib/hardware'
import { ESP_BOARDS, EspEmulator, espChip, espPinExists, validateEspArtifact } from './espEmulator'
import { VelxioParts } from './velxioParts'
import type { PeripheralState, PicoPeripheralSimulator } from './velxioParts'
import type { HardwareArtifact, HardwareProject, WireEndpoint } from '../lib/hardware'

export type DigitalSample = { pin: string; level: boolean; time_ms: number; cycles: number }
export type RuntimeChannel = { pin: string; level: boolean | null; drive: string }
export type InstrumentationSnapshot = {
  board: string | null; artifact_id: string | null; clock_hz: number; simulated_ms: number
  capacity: number; dropped_samples: number; samples: DigitalSample[]; channels: RuntimeChannel[]
}
export type RuntimeResults = {
  running: boolean; engine: string; artifact_id: string | null; cycles: number; simulated_ms: number
  serial: string; serial_link: unknown; pins: Record<string, { level: boolean | null; drive: string }>
  limitations: string[]; board?: string | null; clock_hz?: number; samples?: DigitalSample[]
  sample_capacity?: number; dropped_samples?: number; state?: string; error?: string | null; run_id?: string
  peripherals?: Record<string, PeripheralState>; support_warnings?: string[]
}
export type RuntimeArtifact = Omit<HardwareArtifact, 'hex'> & {
  hex?: string; program?: string; bin?: string; encoding?: string; load_address?: number; size_bytes?: number
  chip?: string; image_kind?: string; flash_size_bytes?: number
}
type Simulator = Pick<AVRSimulator, 'pinManager' | 'onBaudRateChange' | 'onPinChangeWithTime' | 'stop' | 'isRunning' | 'getClockHz' | 'getCurrentCycles' | 'setPinState'> & {
  start(): void | Promise<void>
  onSerialData: ((char: string, uart?: number) => void) | null
  getBusBinding(): { uart?: { receive(byte: number): void }[] }
}
type PicoSimulator = Simulator & PicoPeripheralSimulator & { loadBinary(base64: string): void }
// Bundle the upstream module without imposing its older rp2040js declarations on the application.
const picoModules = import.meta.glob<{ RP2040Simulator: new (pins: PinManager) => PicoSimulator }>('../../vendor/velxio/frontend/src/simulation/RP2040Simulator.ts', { eager: true })
const RP2040Simulator = picoModules['../../vendor/velxio/frontend/src/simulation/RP2040Simulator.ts'].RP2040Simulator
const SAMPLE_CAPACITY = 8192
const AVR_BOARDS = new Set(['arduino-uno', 'arduino-nano', 'arduino-mega'])
const PICO_BOARDS = new Set(['pi-pico', 'pi-pico-w'])
const CLASSIC_ESP32_BOARDS = new Set(['esp32-devkit-v1', 'esp32-devkit-c-v4'])
const activeRuntimes = new Set<HardwareRuntime>()

export function connectedEndpoints(project: HardwareProject, endpoint: WireEndpoint): WireEndpoint[] {
  const key = (pin: WireEndpoint) => `${pin.component}:${pin.pin}`
  const visited = new Map<string, WireEndpoint>()
  const queue = [endpoint]
  while (queue.length) {
    const next = queue.shift()!
    if (visited.has(key(next))) continue
    visited.set(key(next), next)
    for (const wire of project.wires) {
      if (key(wire.from) === key(next)) queue.push(wire.to)
      if (key(wire.to) === key(next)) queue.push(wire.from)
    }
    const part = project.components.find(component => component.id === next.component)
    if (part?.type === 'resistor') queue.push({ component: part.id, pin: next.pin === '1' ? '2' : '1' })
  }
  return [...visited.values()]
}

export function boardPin(board: string, name: string): number | null {
  if (CLASSIC_ESP32_BOARDS.has(board)) {
    if (name === 'TX' || name === 'TX0') return 1
    if (name === 'RX' || name === 'RX0') return 3
    if (name === 'TX2') return 17
    if (name === 'RX2') return 16
    if (name === 'VP') return 36
    if (name === 'VN') return 39
    if (board === 'esp32-devkit-c-v4' && (/^D[0-3]$/.test(name) || name === 'CMD' || name === 'CLK')) return null
    if (/^(?:GPIO|D)?\d+$/.test(name)) {
      const pin = Number(name.replace(/^(?:GPIO|D)/, ''))
      return pin >= 0 && pin < 40 ? pin : null
    }
    return null
  }
  if (ESP_BOARDS.has(board)) {
    const chip = espChip(board)
    if (name === 'TX' || name === 'TX0') return chip === 'esp32c3' ? 21 : 43
    if (name === 'RX' || name === 'RX0') return chip === 'esp32c3' ? 20 : 44
    // Built-in LEDs are addressable RGB devices, not plain digital LEDs.
    if (name === 'LED_BUILTIN') return chip === 'esp32c3' ? 8 : 48
    if (/^(?:GPIO|GP|D)?\d+$/.test(name)) {
      const pin = Number(name.replace(/^(?:GPIO|GP|D)/, ''))
      return espPinExists(chip, pin) ? pin : null
    }
    return null
  }
  if (PICO_BOARDS.has(board)) {
    if (name === 'LED_BUILTIN') return board === 'pi-pico' ? 25 : null
    if (name === 'TX') return 0
    if (name === 'RX') return 1
    if (/^A[0-3]$/.test(name)) return 26 + Number(name.slice(1))
    if (/^(?:GP|GPIO|D)?(?:[0-9]|[12][0-9])$/.test(name)) return Number(name.replace(/^(?:GPIO|GP|D)/, ''))
    return null
  }
  if (!AVR_BOARDS.has(board)) return null
  if (name === 'TX' || name === 'TX0') return 1
  if (name === 'RX' || name === 'RX0') return 0
  const mega = board === 'arduino-mega'
  if (name === 'SDA') return mega ? 20 : 18
  if (name === 'SCL') return mega ? 21 : 19
  if (!mega && /^A[45]\.2$/.test(name)) return 14 + Number(name[1])
  if (/^(?:D)?\d+$/.test(name)) {
    const pin = Number(name.replace('D', ''))
    return pin >= 0 && pin < (mega ? 54 : 14) ? pin : null
  }
  if (/^A\d+$/.test(name)) {
    const pin = Number(name.slice(1))
    return pin >= 0 && pin < (mega ? 16 : 6) ? (mega ? 54 : 14) + pin : null
  }
  return null
}

export function unoPin(name: string): number | null { return boardPin('arduino-uno', name) }

function channelName(board: string, pin: number): string | null {
  if (!Number.isInteger(pin) || pin < 0) return null
  if (CLASSIC_ESP32_BOARDS.has(board)) return pin < 40 ? `GPIO${pin}` : null
  if (ESP_BOARDS.has(board)) return espPinExists(espChip(board), pin) ? `GPIO${pin}` : null
  if (PICO_BOARDS.has(board)) return pin < 30 ? `GP${pin}` : null
  const digital = board === 'arduino-mega' ? 54 : 14
  const analog = board === 'arduino-mega' ? 16 : 6
  return pin < digital ? `D${pin}` : pin < digital + analog ? `A${pin - digital}` : null
}

function artifactPayload(artifact: RuntimeArtifact, legacy: 'hex' | 'bin'): string {
  if (artifact.program !== undefined && typeof artifact.program !== 'string') throw new Error('Compiler artifact program must be text.')
  const current = artifact.program
  const old = artifact[legacy]
  if (current && old && current !== old) throw new Error(`Compiler artifact program conflicts with ${legacy}. Compile again.`)
  const payload = current ?? old
  if (typeof payload !== 'string' || !payload.trim()) throw new Error(`Compiler artifact is missing its ${legacy === 'hex' ? 'Intel HEX' : 'base64 binary'} program.`)
  return payload
}

export function validateRuntimeArtifact(project: HardwareProject, artifact: RuntimeArtifact): string {
  if (!AVR_BOARDS.has(project.board) && !PICO_BOARDS.has(project.board) && !ESP_BOARDS.has(project.board)) throw new Error(`Unsupported browser simulation board: ${project.board}.`)
  if (artifact.board !== project.board) throw new Error('Firmware artifact board does not match the selected board.')
  if (artifact.source_revision !== project.firmware.revision) throw new Error('Firmware artifact is stale. Compile the current project first.')
  if (AVR_BOARDS.has(project.board)) {
    if (artifact.format !== 'hex') throw new Error(`${project.board} requires an Intel HEX artifact, not ${artifact.format}.`)
    const payload = artifactPayload(artifact, 'hex')
    const lines = payload.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (!lines.length || !lines.every(line => /^:[0-9a-f]+$/i.test(line) && line.length === 11 + Number.parseInt(line.slice(1, 3), 16) * 2 && verifyHexChecksum(line)) || !lines.some(line => line.slice(7, 9) === '00') || lines.at(-1)?.toUpperCase() !== ':00000001FF') throw new Error('Compiler artifact is not valid Intel HEX.')
    return payload
  }
  if (ESP_BOARDS.has(project.board)) {
    const payload = artifactPayload(artifact, 'bin')
    validateEspArtifact(artifact, payload)
    return payload
  }
  if (artifact.format !== 'bin') throw new Error(`${project.board} requires a raw flash bin artifact, not ${artifact.format}; UF2 is not supported by this loader.`)
  if (artifact.encoding !== 'base64' || artifact.load_address !== 0x10000000) throw new Error('Pico binary must use base64 encoding at flash address 0x10000000.')
  const payload = artifactPayload(artifact, 'bin')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) throw new Error('Pico compiler artifact is not valid base64.')
  const decoded = atob(payload)
  if (decoded.length < 264 || decoded.length > 2 * 1024 * 1024 || artifact.size_bytes !== decoded.length) throw new Error('Pico binary size is invalid or does not match size_bytes.')
  const word = (offset: number) => (decoded.charCodeAt(offset) | decoded.charCodeAt(offset + 1) << 8 | decoded.charCodeAt(offset + 2) << 16 | decoded.charCodeAt(offset + 3) << 24) >>> 0
  const stack = word(256)
  const entry = word(260)
  if (stack < 0x20000000 || stack > 0x20042000 || !(entry & 1) || entry < 0x10000100 || entry >= 0x10200000) throw new Error('Pico binary contains an invalid RP2040 flash vector table.')
  return payload
}

export class HardwareRuntime {
  private simulator: Simulator | null = null
  private nativePins: RuntimeResults['pins'] | null = null
  private nativeRunning = false
  private nativeInput: ((pin: number, level: boolean) => void) | null = null
  private project: HardwareProject | null = null
  private socket: WebSocket | null = null
  private artifactId: string | null = null
  private artifact: RuntimeArtifact | null = null
  private serial = ''
  private serialLink: unknown = null
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private startupVersion = 0
  private queue: Promise<void> = Promise.resolve()
  private elements = new Map<string, HTMLElement>()
  private cleanups: (() => void)[] = []
  private peripheralParts: VelxioParts | null = null
  private inputCleanups = new Map<string, () => void>()
  private samples: (DigitalSample | undefined)[] = new Array(SAMPLE_CAPACITY)
  private sampleStart = 0
  private sampleCount = 0
  private droppedSamples = 0
  private listeners = new Set<(snapshot: InstrumentationSnapshot) => void>()
  private onResults: (results: RuntimeResults) => void

  constructor(onResults: (results: RuntimeResults) => void) { this.onResults = onResults }

  private publish() {
    this.updateElements()
    this.onResults(this.results())
    if (this.listeners.size) {
      const snapshot = this.getInstrumentation()
      for (const listener of this.listeners) listener(snapshot)
    }
  }

  connect(project: HardwareProject, onConnection: (status: string) => void, onProject: (project: HardwareProject) => void) {
    if (this.disposed) throw new Error('Runtime has been disposed.')
    if (this.project && this.project.id !== project.id) this.stop()
    this.project = project
    this.socket = new WebSocket(runtimeUrl(project))
    const socket = this.socket
    onConnection('Connecting')
    socket.onmessage = event => {
      let message: { type: string; project_id?: string; id: string; name: string; args?: { project?: HardwareProject; artifact?: RuntimeArtifact } }
      try { message = JSON.parse(event.data) } catch { return }
      if (message.type === 'runtime_connected') { onConnection('Connected'); return }
      if (message.type !== 'command' || !message.id || message.project_id !== project.id) return
      // A stop must cancel a worker startup before its queued acknowledgement.
      if (message.name === 'stop_simulation' && this.simulator instanceof EspEmulator) this.stop()
      this.queue = this.queue.then(async () => {
        if (this.disposed) return
        try {
          if (message.name === 'run_simulation') {
            if (!message.args?.project || !message.args.artifact) throw new Error('Runtime command is missing its canonical project or compiled program.')
            const snapshot = { ...message.args.project, runtime_token: project.runtime_token }
            onProject(snapshot)
            await this.run(snapshot, message.args.artifact)
          } else if (message.name === 'stop_simulation') this.stop()
          else if (message.name !== 'read_simulation_results') throw new Error(`Unsupported runtime command: ${message.name}`)
          const result = this.results()
          this.publish()
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', id: message.id, ok: true, result }))
        } catch (error) {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', id: message.id, ok: false, error: error instanceof Error ? error.message : 'Emulator failed.' }))
        }
      })
    }
    socket.onclose = event => {
      this.startupVersion++
      this.simulator?.stop()
      this.releaseAttachments()
      if (!this.disposed) {
        onConnection(event.code === 4409 ? 'Owned by another browser' : event.code === 4403 ? 'Runtime authorization failed' : 'Disconnected')
        this.publish()
      }
    }
    socket.onerror = () => { if (!this.disposed) onConnection('Connection failed') }
    this.ensureTimer()
  }

  private ensureTimer() {
    if (!this.timer) this.timer = setInterval(() => this.publish(), 150)
  }

  registerElement(id: string, element: HTMLElement | null) {
    if (this.elements.get(id) === element) return
    const simulator = this.simulator
    const part = this.project?.components.find(part => part.id === id)
    // Upstream leases cannot cancel edges already queued or release a held matrix pad.
    if (this.elements.has(id) && simulator instanceof AVRSimulator && simulator.isRunning()
      && (part?.type === 'membrane-keypad' || ((part?.type === 'hc-sr04' || part?.type === 'dht22')
        && Number.isFinite(simulator.lineHub().cyclesUntilNextEdge(simulator.getCurrentCycles()))))) this.stop()
    this.peripheralParts?.release(id)
    this.inputCleanups.get(id)?.()
    this.inputCleanups.delete(id)
    if (element) {
      this.elements.set(id, element)
      if (this.simulator?.isRunning()) {
        const part = this.project?.components.find(part => part.id === id)
        if (part) this.peripheralParts?.attach(part, element)
        this.attachInputs(id)
      }
    } else this.elements.delete(id)
  }

  updateProject(project: HardwareProject) {
    const previous = this.project
    const structure = (snapshot: HardwareProject) => JSON.stringify({
      id: snapshot.id, board: snapshot.board, firmware: snapshot.firmware,
      components: snapshot.components.map(part => ({ id: part.id, type: part.type, x: part.x, y: part.y, rotation: part.rotation })),
      wires: snapshot.wires.map(wire => ({ id: wire.id, from: wire.from, to: wire.to })),
    })
    if (previous && structure(previous) !== structure(project)) this.stop()
    this.project = project
    for (const part of project.components) {
      const old = previous?.components.find(component => component.id === part.id)
      if (!old || JSON.stringify(old.properties) !== JSON.stringify(part.properties)) this.updateComponentProperties(part.id, part.properties)
    }
  }

  updateComponentProperties(id: string, properties: Record<string, unknown>) {
    const element = this.elements.get(id)
    if (this.project?.components.find(part => part.id === id)?.type === 'membrane-keypad'
      && String(properties.columns ?? '4') !== String((element as HTMLElement & { columns?: string } | undefined)?.columns ?? '4')) this.stop()
    if (element) Object.assign(element, properties)
    this.peripheralParts?.update(id, properties, element)
  }

  private releaseAttachments() {
    this.peripheralParts?.releaseAll()
    for (const cleanup of this.inputCleanups.values()) cleanup()
    this.inputCleanups.clear()
    this.cleanups.forEach(cleanup => cleanup())
    this.cleanups = []
    activeRuntimes.delete(this)
  }

  async run(project: HardwareProject, artifact: RuntimeArtifact) {
    if (this.disposed) throw new Error('Runtime has been disposed.')
    const payload = validateRuntimeArtifact(project, artifact)
    for (const runtime of activeRuntimes) if (runtime !== this) runtime.stop()
    const startupVersion = ++this.startupVersion
    this.simulator?.stop()
    this.releaseAttachments()
    this.peripheralParts = null
    this.project = project
    this.serial = ''
    this.serialLink = null
    this.artifactId = artifact.id
    this.artifact = { ...artifact }
    this.resetSamples()
    const simulator: Simulator = ESP_BOARDS.has(project.board) ? new EspEmulator(espChip(project.board)) : PICO_BOARDS.has(project.board) ? new RP2040Simulator(new PinManager()) : new AVRSimulator(new PinManager(), project.board === 'arduino-mega' ? 'mega' : 'uno')
    this.simulator = simulator
    activeRuntimes.add(this)
    const previousSerial = simulator.onSerialData
    const captureSerial = (char: string, uart?: number) => {
      previousSerial?.(char, uart)
      if (this.simulator === simulator && !this.disposed && (uart === undefined || uart === 0)) this.serial = (this.serial + char).slice(-65536)
    }
    simulator.onSerialData = captureSerial
    const previousBaud = simulator.onBaudRateChange
    const captureBaud: Simulator['onBaudRateChange'] = (baud, link) => {
      previousBaud?.(baud, link)
      if (this.simulator === simulator && !this.disposed) this.serialLink = link
    }
    simulator.onBaudRateChange = captureBaud
    this.cleanups.push(() => {
      if (simulator.onSerialData === captureSerial) simulator.onSerialData = previousSerial
      if (simulator.onBaudRateChange === captureBaud) simulator.onBaudRateChange = previousBaud
    })
    const previousEdge = simulator.onPinChangeWithTime
    const capture = (pin: number, level: boolean, timeMs: number) => {
      previousEdge?.(pin, level, timeMs)
      if (this.simulator !== simulator || this.disposed) return
      const name = channelName(project.board, pin)
      if (!name || !Number.isFinite(timeMs) || timeMs < 0) return
      const sample = { pin: name, level, time_ms: timeMs, cycles: Math.round(timeMs * simulator.getClockHz() / 1000) }
      const index = (this.sampleStart + this.sampleCount) % SAMPLE_CAPACITY
      this.samples[index] = sample
      if (this.sampleCount < SAMPLE_CAPACITY) this.sampleCount++
      else { this.sampleStart = (this.sampleStart + 1) % SAMPLE_CAPACITY; this.droppedSamples++ }
    }
    simulator.onPinChangeWithTime = capture
    this.cleanups.push(() => { if (simulator.onPinChangeWithTime === capture) simulator.onPinChangeWithTime = previousEdge })
    try {
      if (simulator instanceof EspEmulator) {
        simulator.onError = () => {
          if (this.disposed || this.simulator !== simulator || this.startupVersion !== startupVersion) return
          this.releaseAttachments()
          this.publish()
        }
        this.cleanups.push(() => { simulator.onError = null })
        const loading = simulator.loadBinary(payload, this.project.id)
        this.ensureTimer()
        this.publish()
        await loading
        if (this.disposed || this.simulator !== simulator || this.startupVersion !== startupVersion) throw new Error('ESP startup was cancelled.')
        this.publish()
      } else if (simulator instanceof RP2040Simulator) simulator.loadBinary(payload)
      else if (simulator instanceof AVRSimulator) simulator.loadHex(payload)
      if (simulator instanceof AVRSimulator || simulator instanceof RP2040Simulator) {
        this.peripheralParts = new VelxioParts(project, simulator, () => this.stop())
        for (const part of project.components) {
          const element = this.elements.get(part.id)
          if (element) this.peripheralParts.attach(part, element)
        }
      }
      this.attachInputs()
      if (simulator instanceof EspEmulator) await simulator.start()
      else simulator.start()
      this.ensureTimer()
      if (!(simulator instanceof EspEmulator)) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      if (this.disposed || this.simulator !== simulator || this.startupVersion !== startupVersion || !simulator.isRunning() || simulator.getCurrentCycles() <= 0) throw new Error('Emulator did not start executing firmware. Keep this browser tab visible.')
      this.publish()
    } catch (error) {
      simulator.stop()
      if (this.simulator === simulator && this.startupVersion === startupVersion) {
        this.releaseAttachments()
        this.publish()
      }
      throw error
    }
  }

  applyNativeState(pins: RuntimeResults['pins'], running: boolean, input: ((pin: number, level: boolean) => void) | null) {
    if (!CLASSIC_ESP32_BOARDS.has(this.project?.board ?? '')) return
    const wasRunning = this.nativeRunning
    this.nativePins = { ...pins }
    this.nativeRunning = running
    this.nativeInput = running ? input : null
    if (wasRunning && !running) {
      for (const cleanup of this.inputCleanups.values()) cleanup()
      this.inputCleanups.clear()
    }
    if (running) this.attachInputs()
    this.updateElements()
  }

  async reset(): Promise<void> {
    if (!this.project || !this.artifact) throw new Error('Compile and load firmware before resetting the simulation.')
    await this.run(this.project, this.artifact)
  }

  stop() { this.startupVersion++; this.simulator?.stop(); this.nativePins = null; this.nativeRunning = false; this.nativeInput = null; this.releaseAttachments(); this.publish() }

  getChannels(): string[] {
    if (!this.project || (!AVR_BOARDS.has(this.project.board) && !PICO_BOARDS.has(this.project.board) && !ESP_BOARDS.has(this.project.board) && !CLASSIC_ESP32_BOARDS.has(this.project.board))) return []
    const count = CLASSIC_ESP32_BOARDS.has(this.project.board) ? 40 : this.project.board === 'esp32-s3' ? 49 : this.project.board === 'esp32-c3' ? 22 : PICO_BOARDS.has(this.project.board) ? 30 : this.project.board === 'arduino-mega' ? 70 : 20
    return Array.from({ length: count }, (_, pin) => channelName(this.project!.board, pin)).filter((pin): pin is string => pin !== null)
  }

  readChannel(pin: string): RuntimeChannel {
    const number = this.project ? boardPin(this.project.board, pin) : null
    const manager = this.simulator?.pinManager
    if (number !== null && this.nativePins) return { pin, ...(this.nativePins[`GPIO${number}`] ?? { level: null, drive: 'z' }) }
    return { pin, level: number !== null && manager ? manager.peekPinState(number) ?? null : null, drive: number !== null && manager ? manager.getPad(number).drive : 'z' }
  }

  getSamples(pin?: string, sinceMs = -Infinity): DigitalSample[] {
    const canonical = pin && this.project ? channelName(this.project.board, boardPin(this.project.board, pin) ?? -1) : pin
    const output: DigitalSample[] = []
    for (let i = 0; i < this.sampleCount; i++) {
      const sample = this.samples[(this.sampleStart + i) % SAMPLE_CAPACITY]!
      if ((!pin || sample.pin === canonical) && sample.time_ms >= sinceMs) output.push({ ...sample })
    }
    // UART edges may be reported ahead of the next GPIO callback.
    return output.sort((a, b) => a.time_ms - b.time_ms)
  }

  private resetSamples() {
    this.samples = new Array(SAMPLE_CAPACITY)
    this.sampleStart = 0
    this.sampleCount = 0
    this.droppedSamples = 0
  }

  clearSamples() { this.resetSamples(); this.publish() }

  getInstrumentation(): InstrumentationSnapshot {
    const clock = this.simulator?.getClockHz() ?? 0
    return {
      board: this.project?.board ?? null, artifact_id: this.artifactId, clock_hz: clock,
      simulated_ms: clock ? (this.simulator?.getCurrentCycles() ?? 0) * 1000 / clock : 0,
      capacity: SAMPLE_CAPACITY, dropped_samples: this.droppedSamples, samples: this.getSamples(),
      channels: this.getChannels().map(pin => this.readChannel(pin)),
    }
  }

  subscribeInstrumentation(listener: (snapshot: InstrumentationSnapshot) => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    listener(this.getInstrumentation())
    return () => { this.listeners.delete(listener) }
  }

  private boardEndpoints(endpoint: WireEndpoint): WireEndpoint[] {
    if (!this.project) return []
    const boards = new Set(this.project.components.filter(part => part.type === this.project!.board).map(part => part.id))
    return connectedEndpoints(this.project, endpoint).filter(pin => boards.has(pin.component))
  }

  private level(endpoint: WireEndpoint): boolean | null {
    for (const pin of this.boardEndpoints(endpoint)) {
      if (/^GND(?:\.[0-9]+)?$/i.test(pin.pin)) return false
      if (['5V', '3.3V', '3V3', 'VBUS'].includes(pin.pin)) return true
      const number = this.project ? boardPin(this.project.board, pin.pin) : null
      if (number !== null) {
        if (this.nativePins) return this.nativePins[`GPIO${number}`]?.level ?? null
        return this.simulator?.pinManager.peekPinState(number) ?? null
      }
    }
    return null
  }

  private attachInputs(id?: string) {
    if (!this.project || (!this.simulator && !this.nativeRunning)) return
    for (const part of this.project.components.filter(part => (!id || part.id === id) && (part.type === 'pushbutton' || part.type === 'pushbutton-6mm'))) {
      if (this.inputCleanups.has(part.id)) continue
      const element = this.elements.get(part.id)
      if (!element) continue
      const update = (pressed: boolean) => {
        const first = this.boardEndpoints({ component: part.id, pin: '1.l' }).concat(this.boardEndpoints({ component: part.id, pin: '1.r' }))
        const second = this.boardEndpoints({ component: part.id, pin: '2.l' }).concat(this.boardEndpoints({ component: part.id, pin: '2.r' }))
        for (const [signal, rail] of [[first, second], [second, first]]) {
          const ground = rail.some(pin => /^GND(?:\.[0-9]+)?$/i.test(pin.pin))
          const power = rail.some(pin => ['5V', '3.3V', '3V3', 'VBUS'].includes(pin.pin))
          if (!ground && !power) continue
          for (const pin of signal) {
            const number = boardPin(this.project!.board, pin.pin)
            if (number === null) continue
            if (this.nativeRunning) {
              this.nativeInput?.(number, pressed ? power : ground)
              continue
            }
            if (this.simulator?.pinManager.getPad(number).drive !== 'z') continue
            const pull = this.simulator?.pinManager.getPad(number).pull
            const released = this.simulator instanceof EspEmulator ? ground : pull === 1
            this.simulator?.setPinState(number, pressed ? power : released)
          }
        }
      }
      const press = () => update(true)
      const release = () => update(false)
      element.addEventListener('button-press', press)
      element.addEventListener('button-release', release)
      if (this.simulator instanceof EspEmulator || this.nativeRunning) update(false)
      this.inputCleanups.set(part.id, () => { element.removeEventListener('button-press', press); element.removeEventListener('button-release', release) })
    }
  }

  private updateElements() {
    if (!this.project || (!this.simulator && !this.nativePins)) return
    for (const part of this.project.components) {
      const element = this.elements.get(part.id) as (HTMLElement & { led13?: boolean; led?: boolean; value?: boolean; brightness?: number }) | undefined
      if (!element) continue
      if (AVR_BOARDS.has(part.type) && this.simulator) element.led13 = this.simulator.pinManager.getPinState(13)
      if (part.type === 'pi-pico' && this.simulator) element.led = this.simulator.pinManager.getPinState(25)
      if (part.type === 'led') {
        const lit = this.level({ component: part.id, pin: 'A' }) === true && this.level({ component: part.id, pin: 'C' }) === false
        element.value = lit
        element.brightness = lit ? 1 : 0
      }
    }
  }

  results(): RuntimeResults {
    const simulator = this.simulator
    const cycles = simulator?.getCurrentCycles() ?? 0
    const clock = simulator?.getClockHz() ?? 0
    const pins: RuntimeResults['pins'] = {}
    if (simulator) for (const pin of this.getChannels()) {
      const channel = this.readChannel(pin)
      pins[pin] = { level: channel.level, drive: channel.drive }
    }
    const pico = PICO_BOARDS.has(this.project?.board ?? '')
    const esp = ESP_BOARDS.has(this.project?.board ?? '')
    const espSimulator = simulator instanceof EspEmulator ? simulator : null
    const peripherals = this.peripheralParts?.results(this.elements) ?? {}
    const supportWarnings = Object.entries(peripherals).flatMap(([id, state]) => state.warning ? [`${id}: ${state.warning}`] : [])
    return {
      running: simulator?.isRunning() ?? false, engine: esp ? 'esp-emulator v0.48.0 / WASM' : pico ? 'Velxio RP2040Simulator / rp2040js' : 'Velxio AVRSimulator / avr8js', artifact_id: this.artifactId,
      ...(esp ? { state: espSimulator?.state ?? 'idle', error: espSimulator?.error ?? null } : {}),
      cycles, simulated_ms: clock ? cycles * 1000 / clock : 0, serial: this.serial, serial_link: simulator instanceof AVRSimulator ? simulator.serialLink() : this.serialLink, pins,
      board: this.project?.board ?? null, clock_hz: clock, samples: this.getSamples().slice(-256), sample_capacity: SAMPLE_CAPACITY, dropped_samples: this.droppedSamples,
      peripherals, support_warnings: supportWarnings,
      limitations: [
        esp ? 'Official esp-emulator v0.48.0 WASM executes ESP32-C3 RISC-V or ESP32-S3 Xtensa firmware from a complete merged flash image, booting its embedded ROM. CPU cycles and clock are reported by the worker. Classic ESP32 is not supported. UART text/input is connected; USB CDC is not integrated. Simulated WiFi access-point credentials can be configured before startup. No Bluetooth bridge or host/internet network access is provided.' : pico ? 'RP2040 GPIO, UART0, timers and ADC use the real single-core emulator at 125 MHz; USB CDC, second core and wireless are not supported.' : 'Uno/Nano ATmega328P or Mega ATmega2560 GPIO, UART0, timers and ADC use the real AVR emulator at 16 MHz; Nano A6/A7 are analog-only, not digital channels.',
        ...(this.project?.board === 'pi-pico-w' ? ['Pico W compatibility is RP2040 CPU and external GPIO/UART0 only. CYW43 radio, WiFi, Bluetooth and the CYW43-controlled onboard LED are not emulated; firmware that initializes CYW43 may stall. GP25 is not the Pico W onboard LED.'] : []),
        esp ? 'ESP GPIO observations are coarse 150 ms snapshots of output and output-enable registers, not edge-accurate capture. Input readback and pull configuration are unavailable in the pinned WASM API; input levels reflect host button injection only and otherwise remain unknown. Button release drives the opposite rail as a logical approximation. PWM, addressable onboard LEDs and external sensor/bus models are not integrated.' : 'Digital edge capture uses simulator timestamps; the bounded shared ring drops oldest edges on overrun. Unobserved levels are unknown.',
        'LED wiring is digital continuity only; resistor current and analog/SPICE measurements are not modeled by this runtime.',
        'LEDs and rail-connected pushbuttons retain digital behavior. The scoped Uno/Nano/Mega adapter reuses upstream rotary and slide potentiometer ADC, servo pulse decoding and HC-SR04 timed echo behavior only with valid board-specific signals and the selected board’s 5V/ground wiring. Nano A6/A7 accept potentiometer ADC input only. Common-cathode RGB digital/PWM channels and DHT22 temperature/humidity are connected through the original upstream models. Common-anode RGB and these Pico peripheral paths are not enabled.',
        ...(pico ? ['The Pico/Pico W adapter is limited to upstream rotary and slide potentiometer ADC input on external GP26–GP28 with the selected board’s 3V3/ground wiring. GP29, servo and HC-SR04 are not enabled. Rotary potentiometer behavior is verified with real Pico/Pico W firmware; slider behavior is verified on Uno only.'] : []),
        'Photoresistor AO and NTC OUT reuse the original upstream voltage-generating models on Uno A0–A5 only, with VCC on Uno 5V and GND on its ground net. Controls are lux (0–1000, default 500) and temperature in Celsius (−40–125, default 25). Photoresistor DO only observes GPIO for its indicator; no comparator output or physical light curve is modeled.',
        'Gas, flame, big-sound-sensor and small-sound-sensor reuse the original upstream ADC handlers on Uno only: VCC requires 5V, GND requires ground and AOUT requires A0–A5. Original control keys are gasLevel (0–1023, default 100), intensity (0–1023, default 0) and soundLevel (0–1023, default 512). Gas and sound map linearly to 0–5V; flame intensity maps inversely from 5V to 0V. DOUT only observes GPIO for the indicator; no threshold/comparator output, calibrated concentration or microphone waveform is generated. The elements have no built-in value control; absent properties use these defaults.',
        'Analog joystick reuses the original upstream Uno handler with VCC on 5V, GND on ground and VERT/HORZ on distinct A0–A5 pins. Optional SEL must use a separate digital-capable GPIO; button events drive active-low input. Element xValue/yValue directions (−1–1) map to 0–5V, default center 2.5V; original panel xAxis/yAxis controls (−512–512) use the upstream (axis + 512)/1023 scaling. Other boards and buzzer/audio integration are not enabled by this batch.',
        'PIR reuses the original upstream digital model on Uno only: VCC requires 5V, GND requires ground and OUT requires a digital-capable GPIO. Click or trigger: true starts/restarts a three-second browser-wall-clock HIGH pulse; it is not timed in guest cycles. Slide switches use the original rail-selected digital handler on Uno/Nano/Mega: pin 1 requires ground, pin 3 requires 5V and pin 2 requires a digital-capable GPIO. Open contacts and contact bounce are not modeled.',
        'The passive 4×4 membrane keypad reuses the original upstream matrix-keypad line engine on Uno only. R1–R4 and C1–C4 require eight distinct D2–D13 GPIOs (D0/D1 reserved for Serial), with no VCC/GND. Guest-cycle pad changes support row-first and column-first scanning with INPUT_PULLUP and released inactive outputs. The matrix model includes ghosting; contact bounce and electrical current are not modeled. Removing/replacing the element or changing its column count stops the runtime to clear queued edges and held pads.',
        'SSD1306 OLED, I2C LCD1602/LCD2004, MPU6050, DS1307 and DS3231 use their original upstream I2C models and scoped bus fabric on Uno A4/A5 only. VCC/VIN accepts Uno 3V3 or 5V; the 8-pin 3V3 pad requires Uno 3V3. Other boards and unwired displays are not enabled.',
        'Only the 8-pin SSD1306 SPI path is enabled, using the original upstream model and existing Uno AVR SPI controller: CLK/SCK requires D13, DATA/MOSI requires D11, and CS/DC require distinct GPIOs. Protocol is selected by the actual protocol property or, when absent, a GPIO-connected CS. RST is optional and must use a separate GPIO when wired; the upstream SPI model does not emulate the RST pad. SD and MFRC522 SPI integration remain deferred.',
        ...supportWarnings,
      ],
    }
  }

  sendSerial(text: string) {
    if (!this.simulator?.isRunning()) throw new Error('Start the simulation before sending serial input.')
    const uart = this.simulator.getBusBinding().uart?.[0]
    if (!uart) throw new Error('UART input is not available.')
    for (const byte of new TextEncoder().encode(text)) uart.receive(byte)
  }

  dispose() {
    this.disposed = true
    this.startupVersion++
    this.simulator?.stop()
    this.nativePins = null
    this.nativeRunning = false
    this.nativeInput = null
    this.releaseAttachments()
    if (this.timer) clearInterval(this.timer)
    this.socket?.close()
    this.elements.clear()
    this.listeners.clear()
  }
}
