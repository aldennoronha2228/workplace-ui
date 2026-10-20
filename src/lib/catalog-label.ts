import type { CatalogComponent } from './hardware'
import { catalogPins } from './hardware'

export function compactCatalogName(name: string): string {
  return name.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
}

export function catalogTooltip(item: CatalogComponent, board: string): string {
  const support = item.category === 'boards'
    ? item.simulation === 'browser' ? 'Browser simulation available.' : 'Simulation requires an additional runtime.'
    : item.simulation_boards?.includes(board) ? item.simulation_scope || 'Peripheral simulation available for this board.'
      : item.spice_model ? 'Electrical model available for DC/transient analysis.'
        : catalogPins(item).length ? 'Connectable pins verified. Simulation is not integrated for this board.' : 'Placement only; connection pins are unavailable.'
  return [item.name, item.description, support].filter(Boolean).join('\n')
}
