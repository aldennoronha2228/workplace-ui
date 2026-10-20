import type { BuildNetlistInput } from '@velxio/simulation/spice/types'

export function buildNetlist(input: BuildNetlistInput): {
  netlist: string
  pinNetMap: Map<string, string>
  nets: string[]
  voltageSources: string[]
  sourcedNets: Set<string>
}
