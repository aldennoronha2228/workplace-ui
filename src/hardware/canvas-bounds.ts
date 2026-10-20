import type { HardwareComponent } from '../lib/hardware'

type Size = { width: number; height: number }
export function partBounds(part: HardwareComponent, size: Size) {
  const radians = part.rotation * Math.PI / 180
  const points = [{ x: -8, y: -30 }, { x: Math.max(size.width + 8, part.id.length * 7 + 20), y: -30 }, { x: -8, y: size.height + 8 }, { x: size.width + 8, y: size.height + 8 }].map(point => ({
    x: part.x + point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: part.y + point.x * Math.sin(radians) + point.y * Math.cos(radians),
  }))
  return { left: Math.min(...points.map(point => point.x)), top: Math.min(...points.map(point => point.y)), right: Math.max(...points.map(point => point.x)), bottom: Math.max(...points.map(point => point.y)) }
}
export function canvasBounds(parts: HardwareComponent[], sizes: Record<string, Size>, paths: Iterable<string>) {
  const bounds = parts.map(part => partBounds(part, sizes[part.id] ?? { width: 180, height: 160 }))
  for (const path of paths) {
    const values = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
    const xs = values.filter((_, index) => index % 2 === 0)
    const ys = values.filter((_, index) => index % 2 === 1)
    if (xs.length && ys.length) bounds.push({ left: Math.min(...xs) - 10, top: Math.min(...ys) - 10, right: Math.max(...xs) + 10, bottom: Math.max(...ys) + 10 })
  }
  const offsetX = Math.max(0, 24 - Math.min(24, ...bounds.map(box => box.left)))
  const offsetY = Math.max(0, 24 - Math.min(24, ...bounds.map(box => box.top)))
  return { offsetX, offsetY, width: Math.ceil(Math.max(1000, ...bounds.map(box => box.right + offsetX + 100))), height: Math.ceil(Math.max(650, ...bounds.map(box => box.bottom + offsetY + 100))) }
}
export function containPartPosition(part: HardwareComponent, size: Size, position: { x: number; y: number }) {
  const bounds = partBounds({ ...part, x: 0, y: 0 }, size)
  return { x: Math.max(24 - bounds.left, position.x), y: Math.max(24 - bounds.top, position.y) }
}
