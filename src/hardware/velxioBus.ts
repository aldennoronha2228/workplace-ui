import type { AVRSimulator } from '../../vendor/velxio/frontend/src/simulation/AVRSimulator'
import type { BusHandle, I2cTarget, I2cTargetDescriptor, SpiDevice, SpiDeviceDescriptor, NetResolver, EngineBinding, BusDiagnostic } from '../../vendor/velxio/frontend/src/simulation/buses/types'
import type { TraceSnapshot } from './velxioParts'

type Fabric = {
  onReset(callback: () => void): () => void
  i2cBuses: Map<number, { reindex(): void }>
  spiBuses: Map<number, { selected(): readonly { owner: string }[] }>
}
type Registry = {
  setResolver(resolver: NetResolver | null): void
  bindEngine(boardId: string, binding: EngineBinding | null): void
  unbindBoard(boardId: string): void
  fabric(boardId: string): Fabric
  attachI2c(desc: I2cTargetDescriptor, target: I2cTarget): BusHandle
  attachSpi(desc: SpiDeviceDescriptor, device: SpiDevice): BusHandle
  onDiagnostic(callback: (diagnostic: BusDiagnostic) => void): () => void
  resetDiagnostics(): void
}
type VendorModule = {
  BusRegistry: new () => Registry
  busRegistry: Registry
  createStoreNetResolver(getState: () => TraceSnapshot): NetResolver
  useSimulatorStore: { getState(): TraceSnapshot }
}
const modules = import.meta.glob<VendorModule>([
  '../../vendor/velxio/frontend/src/simulation/buses/registry.ts',
  '../../vendor/velxio/frontend/src/simulation/buses/storeResolver.ts',
  '../../vendor/velxio/frontend/src/store/useSimulatorStore.ts',
], { eager: true })
const root = '../../vendor/velxio/frontend/src/'
const { BusRegistry, busRegistry } = modules[`${root}simulation/buses/registry.ts`]
const { createStoreNetResolver } = modules[`${root}simulation/buses/storeResolver.ts`]
const { useSimulatorStore } = modules[`${root}store/useSimulatorStore.ts`]

export class VelxioBus {
  private registry = new BusRegistry()
  private handles = new Set<BusHandle>()
  private warnings = new Map<string, string>()
  private offDiagnostic: () => void
  private offReset: () => void
  private disposed = false

  constructor(private snapshot: TraceSnapshot, private boardId: string, simulator: AVRSimulator, onReset: () => void) {
    this.registry.setResolver(createStoreNetResolver(() => this.snapshot))
    this.offDiagnostic = this.registry.onDiagnostic(diagnostic => {
      for (const owner of diagnostic.owners) this.warnings.set(owner, diagnostic.message)
    })
    // UART remains owned by the runtime's serial path.
    const binding = simulator.getBusBinding()
    this.registry.bindEngine(boardId, { pins: binding.pins, spi: binding.spi, i2c: binding.i2c, clock: binding.clock, setResetHandler: binding.setResetHandler })
    this.offReset = this.registry.fabric(boardId).onReset(onReset)
  }

  attach(callback: () => () => void): () => void {
    if (this.disposed) throw new Error('The project peripheral bus has been released.')
    const previousAttach = busRegistry.attachI2c
    const previousSpiAttach = busRegistry.attachSpi
    const previousState = useSimulatorStore.getState
    const registered: BusHandle[] = []
    // Original handlers read properties and register synchronously; no global hook survives this call.
    busRegistry.attachI2c = (descriptor, target) => {
      const handle = this.registry.attachI2c(descriptor, target)
      registered.push(handle)
      this.handles.add(handle)
      return handle
    }
    busRegistry.attachSpi = (descriptor, device) => {
      const handle = this.registry.attachSpi(descriptor, device)
      registered.push(handle)
      this.handles.add(handle)
      return handle
    }
    useSimulatorStore.getState = () => ({ ...previousState(), ...this.snapshot })
    let cleanup: () => void
    try { cleanup = callback() }
    catch (error) {
      for (const handle of registered) { handle.dispose(); this.handles.delete(handle) }
      this.refreshWarnings()
      throw error
    } finally {
      busRegistry.attachI2c = previousAttach
      busRegistry.attachSpi = previousSpiAttach
      useSimulatorStore.getState = previousState
    }
    return () => {
      try { cleanup() }
      finally {
        for (const handle of registered) { handle.dispose(); this.handles.delete(handle) }
        this.refreshWarnings()
      }
    }
  }

  private refreshWarnings() {
    this.warnings.clear()
    this.registry.resetDiagnostics()
    if (this.disposed) return
    const fabric = this.registry.fabric(this.boardId)
    for (const bus of fabric.i2cBuses.values()) bus.reindex()
    // SPI has no reindex API; retain collisions among the surviving selections.
    for (const [sck, bus] of fabric.spiBuses) {
      const selected = bus.selected()
      if (selected.length > 1) for (const member of selected) {
        this.warnings.set(member.owner, `${selected.length} SPI devices are selected at the same time on the bus whose SCK is pin ${sck}; each one receives the other's bytes, as on a real board.`)
      }
    }
  }

  warning(id: string) { return this.warnings.get(id) }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.offReset()
    for (const handle of this.handles) handle.dispose()
    this.handles.clear()
    this.offDiagnostic()
    this.registry.unbindBoard(this.boardId)
    this.registry.setResolver(null)
    this.warnings.clear()
  }
}
