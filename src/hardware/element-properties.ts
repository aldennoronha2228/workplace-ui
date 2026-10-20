export function applyElementProperties(element: HTMLElement, values: Record<string, unknown>, defaults: Record<string, unknown> = {}): Record<string, unknown> {
  const applied: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (key === 'imageData' && (typeof ImageData === 'undefined' || !(value instanceof ImageData))) continue
    let normalized = value
    if (typeof value === 'string') {
      if (typeof defaults[key] === 'number' && value.trim() && Number.isFinite(Number(value))) normalized = Number(value)
      else if (typeof defaults[key] === 'boolean') normalized = value === 'true' || value === '1'
    }
    Reflect.set(element, key, normalized)
    applied[key] = normalized
  }
  return applied
}
