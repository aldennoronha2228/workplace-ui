import { buildNetlist } from './spice-netlist.js'
import { PASSIVE_PRESETS } from '@velxio/simulation/spice/componentToSpice'
import catalogMetadata from '../../vendor/velxio/frontend/public/components-metadata.json'
import { NgSpiceWorkerAdapter } from '@velxio/simulation/spice/adapters/NgSpiceWorkerAdapter'
import { NgSpiceInteractive } from '@velxio/simulation/spice/wasm/NgSpiceInteractive'
import type { ComponentForSpice, WireForSpice } from '@velxio/simulation/spice/types'
import type { CatalogComponent, HardwareComponent, HardwareProject } from '../lib/hardware'

export type AnalogDiagnostic = { severity: 'info' | 'warning' | 'error'; message: string; componentId?: string }
export type AnalogSolveOptions = { analysis?: 'dc' | 'transient'; step?: number | string; stop?: number | string; timeoutMs?: number }
export type AnalogSolveResult = {
  ok: boolean; analysis: 'dc' | 'transient'; projectRevision: number; netlist: string
  diagnostics: AnalogDiagnostic[]; time: number[]; nodeVoltages: Record<string, number[]>
  branchCurrents: Record<string, number[]>; componentCurrents: Record<string, number[]>
  pinNetMap: Record<string, string>; solveMs: number
}

type AnalogProperty = {
  name: string; type: 'number' | 'string' | 'number-pairs'; label: string; default: unknown
  min?: number; max?: number; unit?: string; format?: string; pattern?: string
  minItems?: number; maxItems?: number; timeMin?: number; timeMax?: number; voltageMin?: number; voltageMax?: number
}
export type AnalogCatalogComponent = CatalogComponent & {
  type: string; pins: string[]; defaultValues: Record<string, unknown>; properties: AnalogProperty[]
  schema_version: 1; schematic_only: true; spice_model: string
}
const sourceBounds: Record<string, [number, number, string]> = {
  voltage: [-1e6, 1e6, 'V'], current: [-1e6, 1e6, 'A'], offset: [-1e6, 1e6, 'V'],
  low: [-1e6, 1e6, 'V'], high: [-1e6, 1e6, 'V'], amplitude: [0, 1e6, 'V'], magnitude: [0, 1e6, 'V'],
  frequency: [1e-6, 1e6, 'Hz'], delay: [0, 1e6, 's'], damping: [0, 1e6, '1/s'], phase: [-360, 360, 'degrees'],
  rise: [1e-12, 1e6, 's'], fall: [1e-12, 1e6, 's'], width: [1e-12, 1e6, 's'], period: [1e-12, 1e6, 's'],
}
const passivePattern = '^(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?(?:[TtGgKkMmUuNnPpFf]|[Mm][Ee][Gg])?$'
function definition(type: string, name: string, pins: string[], defaults: Record<string, unknown>): AnalogCatalogComponent {
  return {
    type, name, category: type.startsWith('source-') || type === 'ground' ? 'analog' : 'passive',
    description: 'Genuine ngspice analog simulation', pins, connectable: true, simulation_supported: true,
    schema_version: 1, schematic_only: true, spice_model: type, defaultValues: defaults,
    properties: Object.entries(defaults).map(([key, value]): AnalogProperty => {
      if (key === 'points') return { name: key, type: 'number-pairs', label: key, default: value, minItems: 2, maxItems: 256, timeMin: 0, timeMax: 1e6, voltageMin: -1e6, voltageMax: 1e6 }
      if (key === 'value') return { name: key, type: 'string', label: key, default: value, format: 'spice-value', pattern: passivePattern, min: type === 'resistor' ? 1e-6 : 1e-15, max: type === 'resistor' ? 1e12 : 1e6 }
      const [min, max, unit] = sourceBounds[key]
      return { name: key, type: 'number', label: key, default: value, min, max, unit }
    }),
  }
}

export const defaultPulse = { low: 0, high: 5, delay: 0, rise: 1e-6, fall: 1e-6, width: 0.0005, period: 0.001 } as const
export const sourceCatalog: AnalogCatalogComponent[] = [
  definition('source-dc-voltage', 'DC voltage source', ['+', '-'], { voltage: 5 }),
  definition('source-dc-current', 'DC current source', ['+', '-'], { current: 0.001 }),
  definition('source-sine-voltage', 'Sine voltage source', ['+', '-'], { offset: 0, amplitude: 5, frequency: 1000, delay: 0, damping: 0, phase: 0 }),
  definition('source-pulse-voltage', 'Pulse voltage source', ['+', '-'], { ...defaultPulse }),
  definition('source-ac-voltage', 'AC voltage source', ['+', '-'], { voltage: 0, magnitude: 1, phase: 0 }),
  definition('source-pwl-voltage', 'Piecewise linear voltage source', ['+', '-'], { points: [[0, 0], [0.001, 5], [0.002, 0]] }),
  definition('ground', 'Analog ground', ['GND'], {}),
  definition('resistor', 'Resistor', ['1', '2'], { value: '1000' }),
  definition('capacitor', 'Capacitor', ['1', '2'], { value: '1u' }),
  definition('inductor', 'Inductor', ['1', '2'], { value: '1m' }),
]

const catalogByType = new Map(sourceCatalog.map(entry => [entry.type, entry]))
const sourceAliases: Record<string, string> = {
  'voltage-source': 'source-dc-voltage', 'current-source': 'source-dc-current', 'sine-source': 'source-sine-voltage',
  'pulse-source': 'source-pulse-voltage', 'pwl-source': 'source-pwl-voltage', 'ac-source': 'source-ac-voltage',
}
const legacyPins: Record<string, string[]> = { 'analog-resistor': ['A', 'B'], 'analog-capacitor': ['A', 'B'], 'analog-inductor': ['A', 'B'], 'resistor-us': ['1', '2'], 'capacitor-electrolytic': ['+', '−'] }
const passiveKind = (type: string) => PASSIVE_PRESETS[type] ?? type
const passiveTypes = new Set(['resistor', 'capacitor', 'inductor', ...Object.keys(legacyPins), ...Object.keys(PASSIVE_PRESETS)])
type PassiveMetadata = {
  id: string; defaultValues: Record<string, unknown>
  properties: { name: string; type: string; options?: unknown[] }[]
}
const passiveMetadata = new Map((catalogMetadata.components as PassiveMetadata[])
  .filter(entry => passiveTypes.has(entry.id)).map(entry => [entry.id, entry]))
const sourceKind = (type: string) => sourceAliases[type] ?? type

export function analogPins(component: Pick<HardwareComponent, 'type'>): string[] {
  const type = passiveKind(component.type)
  return catalogByType.get(sourceKind(type))?.pins ?? legacyPins[type] ?? []
}

export class AnalogValidationError extends Error {
  diagnostics: AnalogDiagnostic[]
  constructor(diagnostics: AnalogDiagnostic[]) {
    super(diagnostics.map(item => item.message).join('\n'))
    this.name = 'AnalogValidationError'
    this.diagnostics = diagnostics
  }
}

const multipliers: Record<string, number> = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 }

export function parseAnalogValue(value: unknown, label = 'Value'): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(meg|[tgkmunpfµμ])?\s*(?:ohms?|Ω|Hz|[vafs]|henr(?:y|ies)|farads?)?$/i)
    if (match) {
      const suffix = (match[2] ?? '').toLowerCase().replace(/[µμ]/g, 'u')
      const parsed = Number(match[1]) * (suffix ? multipliers[suffix] : 1)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  throw new Error(`${label} must be a finite number or SPICE engineering value (for example 1k or 10u).`)
}

function numeric(component: HardwareComponent, key: string, fallback: unknown, minimum?: number, exclusive = false): number {
  const raw = component.properties[key] === undefined ? fallback : component.properties[key]
  if (component.type.startsWith('source-') && (typeof raw !== 'number' || !Number.isFinite(raw))) throw new Error(`${component.id}.${key} must be a finite JSON number.`)
  const value = parseAnalogValue(raw, `${component.id}.${key}`)
  const bounds = sourceBounds[key]
  if (component.type.startsWith('source-') && bounds && (value < bounds[0] || value > bounds[1])) throw new Error(`${component.id}.${key} must be between ${bounds[0]} and ${bounds[1]}.`)
  if (minimum !== undefined && (exclusive ? value <= minimum : value < minimum)) {
    throw new Error(`${component.id}.${key} must be ${exclusive ? 'greater than' : 'at least'} ${minimum}.`)
  }
  return value
}

function sourceCard(component: HardwareComponent, name: string, a: string, b: string): string {
  const n = (key: string, fallback: unknown, min?: number, exclusive = false) => numeric(component, key, fallback, min, exclusive)
  const head = `${name} ${a} ${b}`
  switch (sourceKind(component.type)) {
    case 'source-dc-voltage': return `${head} DC ${n('voltage', 5)}`
    case 'source-dc-current': return `${head} DC ${n('current', 0.001)}`
    case 'source-ac-voltage': return `${head} DC ${n('voltage', 0)} AC ${n('magnitude', 1, 0)} ${n('phase', 0)}`
    case 'source-sine-voltage': {
      const offset = n('offset', 0), amplitude = n('amplitude', 5, 0), frequency = n('frequency', 1000, 0, true)
      const delay = n('delay', 0, 0), damping = n('damping', 0, 0), phase = n('phase', 0)
      return `${head} SIN(${offset} ${amplitude} ${frequency} ${delay} ${damping} ${phase})`
    }
    case 'source-pulse-voltage': {
      const low = n('low', 0), high = n('high', 5), delay = n('delay', 0, 0)
      const rise = n('rise', 1e-6, 0, true), fall = n('fall', 1e-6, 0, true)
      const width = n('width', 0.0005, 0, true), period = n('period', 0.001, 0, true)
      if (rise + width + fall > period) throw new Error(`${component.id}: pulse rise + width + fall must not exceed period.`)
      return `${head} PULSE(${low} ${high} ${delay} ${rise} ${fall} ${width} ${period})`
    }
    case 'source-pwl-voltage': {
      const points = component.properties.points === undefined ? catalogByType.get('source-pwl-voltage')!.defaultValues.points : component.properties.points
      if (!Array.isArray(points) || points.length < 2 || points.length > 256) throw new Error(`${component.id}.points must contain 2–256 [time, voltage] pairs.`)
      let previous = -1
      const pairs = points.map((point, index) => {
        if (!Array.isArray(point) || point.length !== 2) throw new Error(`${component.id}.points[${index}] must be [time, voltage].`)
        if (component.type.startsWith('source-') && point.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${component.id}.points[${index}] must contain finite JSON numbers.`)
        const time = parseAnalogValue(point[0], `${component.id}.points[${index}].time`)
        const voltage = parseAnalogValue(point[1], `${component.id}.points[${index}].voltage`)
        if (time < 0 || time > 1e6 || time <= previous) throw new Error(`${component.id}: PWL times must be between 0 and 1000000 and strictly increasing.`)
        if (Math.abs(voltage) > 1e6) throw new Error(`${component.id}: PWL voltage must be between -1000000 and 1000000.`)
        previous = time
        return `${time} ${voltage}`
      })
      return `${head} PWL(${pairs.join(' ')})`
    }
    default: throw new Error(`Unsupported source ${component.type}.`)
  }
}

export type AnalogNetlist = {
  netlist: string; pinNetMap: Record<string, string>; nets: string[]; currentVectors: Record<string, string>
  analysis: 'dc' | 'transient'; diagnostics: AnalogDiagnostic[]
}

export function buildAnalogNetlist(project: HardwareProject, options: AnalogSolveOptions = {}): AnalogNetlist {
  const analysis = options.analysis ?? 'dc'
  const diagnostics: AnalogDiagnostic[] = []
  const fail = (message: string, componentId?: string) => diagnostics.push({ severity: 'error', message, componentId })
  if (analysis !== 'dc' && analysis !== 'transient') fail('Analysis must be dc or transient.')
  let step = 0, stop = 0
  if (analysis === 'transient') {
    try {
      step = parseAnalogValue(options.step ?? '10u', 'Transient step')
      stop = parseAnalogValue(options.stop ?? '10m', 'Transient stop')
      if (step <= 0 || stop <= 0 || step > stop || stop / step > 100000) fail('Transient step and stop must be positive, step ≤ stop, and at most 100000 requested intervals.')
    } catch (error) { fail((error as Error).message) }
  }
  const ids = new Set<string>()
  const supported = new Map<string, HardwareComponent>()
  const converted: ComponentForSpice[] = []
  const spiceIds = new Map<string, string>()
  const pinLists = new Map<string, string[]>()
  for (const [index, component] of project.components.entries()) {
    if (!component.id || ids.has(component.id) || component.id.includes(':')) fail(`Component ID must be nonempty, unique, and contain no colon: ${component.id}.`, component.id)
    ids.add(component.id)
    const pins = analogPins(component)
    if (!pins.length) {
      diagnostics.push({ severity: 'warning', message: `${component.id} (${component.type}) has no supported analog model and is omitted.`, componentId: component.id })
      continue
    }
    supported.set(component.id, component)
    pinLists.set(component.id, pins)
    const id = `part_${index}`
    spiceIds.set(component.id, id)
    let properties = component.properties
    const canonicalDefinition = catalogByType.get(component.type)
    if (canonicalDefinition) {
      for (const key of Object.keys(properties)) if (!(key in canonicalDefinition.defaultValues)) fail(`${component.id}: unknown property ${key}.`, component.id)
    }
    if (passiveTypes.has(component.type)) {
      try {
        const kind = passiveKind(component.type)
        const metadata = passiveMetadata.get(component.type)
        const fallback = metadata?.defaultValues.value ?? (/resistor/.test(kind) ? '1000' : /capacitor/.test(kind) ? '1u' : '1m')
        const raw = properties.value === undefined ? fallback : properties.value
        if ((canonicalDefinition || metadata) && (typeof raw !== 'string' || raw.length > 48 || !new RegExp(passivePattern).test(raw))) throw new Error(`${component.id}.value must be a strict positive SPICE string, at most 48 characters.`)
        if (metadata) {
          for (const [key, supplied] of Object.entries(properties)) {
            const descriptor = metadata.properties.find(field => field.name === key)
            if (!descriptor) throw new Error(`${component.id}: unknown property ${key}.`)
            if (typeof supplied !== descriptor.type || (descriptor.options && !descriptor.options.includes(supplied))) throw new Error(`${component.id}.${key} must match its catalog type and allowed values.`)
          }
        }
        const value = numeric(component, 'value', fallback, 0, true)
        const min = /resistor/.test(kind) ? 1e-6 : 1e-15, max = /resistor/.test(kind) ? 1e12 : 1e6
        if (value < min || value > max) throw new Error(`${component.id}.value must evaluate between ${min} and ${max}.`)
        properties = { ...metadata?.defaultValues, ...properties, value }
      } catch (error) { fail((error as Error).message, component.id) }
    }
    // Instrument-prefixed placeholders prevent implicit VCC/GND source canonicalization.
    converted.push({ id, metadataId: passiveTypes.has(component.type) ? passiveKind(component.type) : component.type === 'ground' ? 'ground' : 'instr-analog-source', properties })
  }
  if (![...supported.values()].some(component => component.type !== 'ground')) fail('Add a supported analog source or passive before solving.')
  const wires: WireForSpice[] = []
  for (const wire of project.wires) {
    let valid = true
    for (const endpoint of [wire.from, wire.to]) {
      if (!supported.has(endpoint.component)) {
        fail(`Wire ${wire.id} references unsupported or missing component ${endpoint.component}.`, endpoint.component)
        valid = false
      } else if (!pinLists.get(endpoint.component)!.includes(endpoint.pin)) {
        fail(`Wire ${wire.id} references invalid pin ${endpoint.component}:${endpoint.pin}.`, endpoint.component)
        valid = false
      }
    }
    if (valid) wires.push({ id: wire.id, start: { componentId: spiceIds.get(wire.from.component)!, pinName: wire.from.pin }, end: { componentId: spiceIds.get(wire.to.component)!, pinName: wire.to.pin } })
  }
  // Seed unwired pins too; an unconnected terminal must not silently disappear.
  for (const [id, pins] of pinLists) for (const pin of pins) {
    const endpoint = { componentId: spiceIds.get(id)!, pinName: pin }
    wires.push({ id: `seed_${wires.length}`, start: endpoint, end: endpoint })
  }
  if (diagnostics.some(item => item.severity === 'error')) throw new AnalogValidationError(diagnostics)
  const built = buildNetlist({ components: converted, wires, boards: [], analysis: analysis === 'dc' ? { kind: 'op' } : { kind: 'tran', step: String(step), stop: String(stop) } })
  const pinNetMap: Record<string, string> = {}
  for (const [id, pins] of pinLists) for (const pin of pins) pinNetMap[`${id}:${pin}`] = built.pinNetMap.get(`${spiceIds.get(id)}:${pin}`)!
  // Upstream mixed-mode auto-pulls mask singular circuits; standalone analog never adds them.
  const cards = built.netlist.split('\n').filter(line => !line.startsWith('R_autopull_') && !line.startsWith('.') && !line.startsWith('*'))
  const currentVectors: Record<string, string> = {}
  for (const component of supported.values()) {
    if (component.type === 'ground') continue
    const pins = pinLists.get(component.id)!
    const a = pinNetMap[`${component.id}:${pins[0]}`], b = pinNetMap[`${component.id}:${pins[1]}`]
    const id = spiceIds.get(component.id)!
    const sense = `V_${id}_sense`
    const middle = `${id}_sense_node`
    try {
      if (passiveTypes.has(component.type)) {
        const index = cards.findIndex(card => /^[RCL]_/.test(card) && card.split(' ')[0].slice(2) === id)
        if (index < 0) throw new Error(`${component.id}: upstream passive mapper emitted no element.`)
        const tokens = cards[index].split(/\s+/)
        tokens[1] = middle
        cards[index] = tokens.join(' ')
        cards.push(`${sense} ${a} ${middle} DC 0`)
        currentVectors[component.id] = sense.toLowerCase()
      } else if (sourceKind(component.type) === 'source-dc-current') {
        cards.push(sourceCard(component, `I_${id}`, middle, b), `${sense} ${a} ${middle} DC 0`)
        currentVectors[component.id] = sense.toLowerCase()
      } else {
        const name = `V_${id}`
        cards.push(sourceCard(component, name, a, b))
        currentVectors[component.id] = name.toLowerCase()
      }
    } catch (error) { fail((error as Error).message, component.id) }
  }
  const adjacency = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set())
    if (!adjacency.has(b)) adjacency.set(b, new Set())
    adjacency.get(a)!.add(b); adjacency.get(b)!.add(a)
  }
  for (const card of cards) {
    const [name, a, b] = card.split(/\s+/)
    if (/^[RVL]/i.test(name)) link(a, b)
  }
  const reached = new Set<string>(), queue = ['0']
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]
    if (reached.has(node)) continue
    reached.add(node)
    for (const next of adjacency.get(node) ?? []) queue.push(next)
  }
  const floating = built.nets.filter(net => !reached.has(net))
  if (!Object.values(pinNetMap).includes('0')) fail('Singular circuit: connect an explicit ground (GND) reference.')
  if (floating.length) fail(`Singular circuit: nodes ${floating.join(', ')} have no DC path to ground. No automatic pull-downs were added.`)
  if (diagnostics.some(item => item.severity === 'error')) throw new AnalogValidationError(diagnostics)
  if ([...supported.values()].some(component => sourceKind(component.type) === 'source-ac-voltage')) diagnostics.push({ severity: 'info', message: 'AC source magnitude/phase are small-signal parameters; DC/transient uses its DC voltage. This solve does not perform an AC sweep.' })
  return {
    netlist: ['* WireUp analog circuit — Velxio/ngspice', ...cards, analysis === 'dc' ? '.op' : `.tran ${step} ${stop}`, '.end'].join('\n'),
    pinNetMap, nets: built.nets, currentVectors, analysis, diagnostics,
  }
}

export async function solveAnalog(project: HardwareProject, options: AnalogSolveOptions = {}): Promise<AnalogSolveResult> {
  const started = performance.now()
  const result: AnalogSolveResult = {
    ok: false, analysis: options.analysis ?? 'dc', projectRevision: project.revision, netlist: '', diagnostics: [],
    time: [], nodeVoltages: {}, branchCurrents: {}, componentCurrents: {}, pinNetMap: {}, solveMs: 0,
  }
  let adapter: NgSpiceWorkerAdapter | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const built = buildAnalogNetlist(project, options)
    result.netlist = built.netlist; result.pinNetMap = built.pinNetMap; result.diagnostics = [...built.diagnostics]
    const timeoutMs = options.timeoutMs ?? 30000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Solver timeout must be a positive finite number.')
    if (typeof Worker === 'undefined') throw new Error('Analog solve requires a browser with Web Workers and WebAssembly.')
    const client = new NgSpiceInteractive({ assetBaseUrl: `${import.meta.env.BASE_URL}wasm/ngspice-interactive/` })
    const solverMessages: string[] = []
    client.setSubscribers({ onStderr: line => { if (line.trim()) solverMessages.push(line) } })
    adapter = new NgSpiceWorkerAdapter(client)
    const activeAdapter = adapter
    const task = async () => {
      await activeAdapter.init()
      solverMessages.length = 0
      await activeAdapter.loadCircuit(built.netlist)
      // A fresh worker has no previous circuit for the adapter's remcirc command.
      for (let index = solverMessages.length - 1; index >= 0; index--) {
        if (/^(?:Error: no circuit loaded|Warning: there is no circuit loaded\.|Command 'remcirc' is ignored\.)$/.test(solverMessages[index].trim())) solverMessages.splice(index, 1)
      }
      const vectors = [...built.nets.map(net => `v(${net})`), ...Object.values(built.currentVectors).map(name => `i(${name})`)]
      return activeAdapter.solve(built.analysis === 'dc' ? { kind: 'op' } : {
        kind: 'tran', step: String(parseAnalogValue(options.step ?? '10u')), stop: String(parseAnalogValue(options.stop ?? '10m')),
      }, { vectorsOfInterest: vectors })
    }
    const solved = await Promise.race([task(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { activeAdapter.dispose(); reject(new Error(`ngspice timed out after ${timeoutMs} ms.`)) }, timeoutMs)
    })])
    const messages = [...new Set([...solverMessages, ...(solved.warnings ?? [])])]
    const fatal = messages.filter(message => /singular matrix|analysis.*(?:failed|aborted)|(?:fatal|error)\b|timestep too small|no convergence|doanalyses/i.test(message))
    result.diagnostics.push(...messages.map(message => ({ severity: fatal.includes(message) ? 'error' as const : 'warning' as const, message })))
    if (fatal.length) throw new Error('ngspice analysis failed; see solver diagnostics.')
    const read = (name: string): number[] => {
      const vector = solved.vectors.get(name.toLowerCase())
      if (!vector || !vector.real.length || vector.imag || Array.from(vector.real).some(value => !Number.isFinite(value))) throw new Error(`ngspice did not return a finite real vector for ${name}.`)
      return Array.from(vector.real)
    }
    const time = built.analysis === 'transient' ? Array.from(solved.timeAxis) : []
    if (built.analysis === 'transient' && (!time.length || time.some((value, index) => !Number.isFinite(value) || value < 0 || (index > 0 && value < time[index - 1])))) throw new Error('ngspice returned no valid transient time axis.')
    const length = built.analysis === 'transient' ? time.length : 1
    const nodeVoltages: Record<string, number[]> = { '0': Array(length).fill(0) }
    const branchCurrents: Record<string, number[]> = {}, componentCurrents: Record<string, number[]> = {}
    for (const net of built.nets) nodeVoltages[net] = read(`v(${net})`)
    for (const [componentId, name] of Object.entries(built.currentVectors)) {
      const values = read(`i(${name})`)
      branchCurrents[name] = values; componentCurrents[componentId] = values
    }
    if ([...Object.values(nodeVoltages), ...Object.values(branchCurrents)].some(values => values.length !== length)) throw new Error('ngspice vectors do not align with the analysis axis.')
    result.time = time; result.nodeVoltages = nodeVoltages; result.branchCurrents = branchCurrents; result.componentCurrents = componentCurrents
    result.ok = true
  } catch (error) {
    if (error instanceof AnalogValidationError) result.diagnostics = error.diagnostics
    else result.diagnostics.push({ severity: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    adapter?.dispose()
    result.solveMs = performance.now() - started
  }
  return result
}
