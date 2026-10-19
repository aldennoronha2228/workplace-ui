// Stub hardware API and types for local UI preview
export type WireEndpoint = { component: string; pin: string }
export type HardwareComponent = {
  id: string; type: string; x: number; y: number; rotation: number
  properties?: Record<string, unknown>
}
export type HardwareProject = {
  id: string; name: string; revision: number; board?: string
  components: HardwareComponent[]; wires: any[]; firmware: { source: string; revision: number }
  compiler?: any; runtime_token?: string
}
export type CatalogComponent = {
  id?: string; type?: string; name: string; category?: string; description?: string
  pins?: any[]; connectable?: boolean; tagName?: string; thumbnail?: string
}
export type CompilerResult = any
export type Firmware = any
export type HardwareCommand = any
export type HardwarePin = { name: string }

export class HardwareApiError extends Error {}

export const hardwareApi = {
  getProject: async (_id: string) => ({
    id: 'demo',
    name: 'Demo Prototype',
    revision: 1,
    board: 'arduino-uno',
    components: [
      { id: 'board', type: 'arduino-uno', x: 400, y: 200, rotation: 0 },
      { id: 'led1', type: 'led', x: 600, y: 180, rotation: 0 },
    ],
    wires: [],
    firmware: { source: '// stub firmware', revision: 1 },
  } as HardwareProject),
  catalog: async () => ({
    boards: [],
    components: [
      { type: 'arduino-uno', name: 'Arduino Uno', category: 'boards' },
      { type: 'led', name: 'LED', category: 'output' },
      { type: 'resistor', name: 'Resistor', category: 'passive' },
    ],
  }),
  command: async () => ({ result: {} }),
  nativeGpio: async () => {},
}

export const artifactIsCurrent = () => true
export const catalogPins = (item: any) => item.pins ?? []
export const catalogType = (item: any) => item.type ?? item.id ?? ''
export const isHardwareProject = (v: any): v is HardwareProject => !!v?.id
