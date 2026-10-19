export class HardwareApiError extends Error {}
export const hardwareApi = {
  getProject: async () => null,
  saveProject: async (p: any) => p,
  compile: async () => ({}),
  run: async () => ({}),
  stop: async () => {},
}
export const artifactIsCurrent = () => true
export const catalogPins = () => []
export const catalogType = (c: any) => c?.type || 'other'
export const isHardwareProject = () => true
export type CatalogComponent = any
export type CompilerResult = any
export type Firmware = any
export type HardwareCommand = any
export type HardwareComponent = any
export type HardwarePin = any
export type HardwareProject = any
export type WireEndpoint = any
