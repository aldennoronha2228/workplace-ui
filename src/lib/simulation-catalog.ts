import { catalogType, type CatalogComponent } from './hardware'

export function isBuildBoard(id: string): boolean {
  return id.startsWith('arduino-') || id.startsWith('esp32')
}

/** Keep the full component library; only new board choices are restricted. */
export function visibleForBuilding(item: CatalogComponent, _board: string): boolean {
  if (item.category === 'boards') return isBuildBoard(catalogType(item)) && item.supported_board !== false
  return true
}
