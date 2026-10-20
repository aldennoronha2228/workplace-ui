import type { CatalogComponent, HardwareComponent, HardwareProject, WireEndpoint } from './hardware'

export type ErcIssue = { severity: 'error' | 'warning' | 'info'; message: string; ref?: string }
export type NetInfo = { name: string; pins: WireEndpoint[] }
export type SchematicAnalysis = {
  nets: NetInfo[]
  netOfPin: Map<string, NetInfo>
  wiredPins: Set<string>
  issues: ErcIssue[]
}

export function schematicPins(component: HardwareComponent, catalog: CatalogComponent[]): string[] {
  const entry = catalog.find(item => (item.type ?? item.id) === component.type)
  if (entry?.connectable === false) return []
  return (entry?.pins ?? []).map(pin => typeof pin === 'string' ? pin : pin.name)
}

const key = (endpoint: WireEndpoint) => `${endpoint.component}:${endpoint.pin}`

// Nets are connected groups of pins joined by wires (union-find over wire endpoints).
export function analyzeSchematic(project: HardwareProject, catalog: CatalogComponent[]): SchematicAnalysis {
  const parent = new Map<string, string>()
  const find = (value: string): string => {
    const root = parent.get(value)
    if (root === undefined) { parent.set(value, value); return value }
    if (root === value) return value
    const resolved = find(root)
    parent.set(value, resolved)
    return resolved
  }
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }

  const pinSets = new Map(project.components.map(component => [component.id, schematicPins(component, catalog)]))
  const known = (endpoint: WireEndpoint) => (pinSets.get(endpoint.component) ?? []).includes(endpoint.pin)
  for (const wire of project.wires) {
    if (!known(wire.from) || !known(wire.to)) continue
    union(key(wire.from), key(wire.to))
  }
  const groups = new Map<string, WireEndpoint[]>()
  for (const wire of project.wires) {
    if (!known(wire.from) || !known(wire.to)) continue
    for (const endpoint of [wire.from, wire.to]) {
      const root = find(key(endpoint))
      if (!groups.has(root)) groups.set(root, [])
      if (!groups.get(root)!.some(item => key(item) === key(endpoint))) groups.get(root)!.push(endpoint)
    }
  }
  const nets: NetInfo[] = [...groups.values()].map((pins, index) => ({ name: `N-J${String(index + 1).padStart(2, '0')}`, pins }))
  const netOfPin = new Map<string, NetInfo>()
  for (const net of nets) for (const pin of net.pins) netOfPin.set(key(pin), net)
  const wiredPins = new Set(netOfPin.keys())

  const issues: ErcIssue[] = []
  for (const wire of project.wires) {
    if (key(wire.from) === key(wire.to)) issues.push({ severity: 'error', message: `Wire loops back onto the same pin (${wire.from.component}:${wire.from.pin}).`, ref: wire.from.component })
    const missing = [wire.from, wire.to].filter(endpoint => !known(endpoint))
    if (missing.length) issues.push({ severity: 'error', message: `Wire touches an unknown pin: ${missing.map(key).join(', ')}. Check the part's pin schema.`, ref: missing[0].component })
  }
  for (const component of project.components) {
    const pins = pinSets.get(component.id) ?? []
    const loose = pins.filter(pin => !wiredPins.has(`${component.id}:${pin}`))
    if (pins.length && loose.length === pins.length) issues.push({ severity: 'warning', message: `${component.id} (${component.type}) is floating — none of its pins are wired.`, ref: component.id })
    else if (loose.length) issues.push({ severity: 'info', message: `${component.id}: unconnected pin${loose.length > 1 ? 's' : ''} ${loose.join(', ')}.`, ref: component.id })
  }
  if (!project.wires.length && project.components.length) issues.push({ severity: 'info', message: 'No wires yet. Click two pins (or use the Connections panel) to create a net.' })
  const order = { error: 0, warning: 1, info: 2 } as const
  issues.sort((a, b) => order[a.severity] - order[b.severity])
  return { nets, netOfPin, wiredPins, issues }
}

const cell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`

export function buildBomCsv(project: HardwareProject, catalog: CatalogComponent[]): string {
  const rows = ['Reference,Name,Type,Value,X,Y']
  for (const component of project.components) {
    const entry = catalog.find(item => (item.type ?? item.id) === component.type)
    const value = component.properties?.value ?? entry?.defaultValues?.value ?? ''
    rows.push([component.id, entry?.name ?? component.type, component.type, value, component.x, component.y].map(cell).join(','))
  }
  return rows.join('\n')
}

export function downloadText(filename: string, text: string, mime = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
