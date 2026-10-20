import { useEffect, useRef, useState } from 'react'
import { ComponentRegistry } from '../../vendor/velxio/frontend/src/services/ComponentRegistry'
import { readPinInfo } from '../../vendor/velxio/frontend/src/utils/readPinInfo'
import '../../vendor/velxio/frontend/src/elements-register'
import type { HardwareComponent, HardwarePin } from '../lib/hardware'
import type { HardwareRuntime } from './runtime'
import { applyElementProperties } from './element-properties'

export function HardwarePart({ part, runtime, pinsChanged, sizeChanged }: {
  part: HardwareComponent; runtime: HardwareRuntime | null; pinsChanged: (id: string, pins: HardwarePin[]) => void
  sizeChanged?: (id: string, size: { width: number; height: number }) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const element = useRef<HTMLElement | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const properties = useRef(part.properties)
  const defaults = useRef<Record<string, unknown>>({})
  useEffect(() => {
    const container = host.current
    if (!container || !sizeChanged) return
    const measure = () => sizeChanged(part.id, { width: container.offsetWidth, height: container.offsetHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    measure()
    return () => observer.disconnect()
  }, [part.id, sizeChanged])
  useEffect(() => { properties.current = part.properties }, [part.properties])
  useEffect(() => {
    const sources = new Set(['source-dc-voltage', 'source-dc-current', 'source-sine-voltage', 'source-pulse-voltage', 'source-pwl-voltage', 'source-ac-voltage', 'ground'])
    if (sources.has(part.type) && host.current) {
      const image = document.createElement('img')
      image.src = `/component-svgs/${part.type}.svg`
      image.alt = part.type === 'ground' ? 'Ground symbol' : 'Electrical source symbol'
      image.width = 64
      image.height = 64
      host.current.replaceChildren(image)
      setUnavailable(false)
      const locations = part.type === 'ground' ? [{ name: 'GND', x: 32, y: 8 }] : [{ name: '+', x: 2, y: 32 }, { name: '-', x: 62, y: 32 }]
      pinsChanged(part.id, locations.map((pin, index) => ({ ...pin, number: index + 1, signals: [] })))
      return () => image.remove()
    }
    let active = true
    let timer: ReturnType<typeof setInterval> | undefined
    let current: HTMLElement | null = null
    const registry = ComponentRegistry.getInstance()
    void registry.load().then(() => {
      if (!active || !host.current) return
      const alias = part.type === 'pi-pico' ? 'raspberry-pi-pico' : part.type === 'pi-pico-w' ? 'raspberry-pi-pico-w' : part.type
      const metadata = registry.getById(part.type) || registry.getById(alias)
      const espVariant = part.type === 'esp32-c3' ? 'esp32-c3' : part.type === 'esp32-s3' ? 'esp32-s3' : null
      const tag = espVariant ? 'velxio-esp32' : part.type === 'pi-pico-w' ? 'velxio-pi-pico-w' : metadata?.tagName
      if (!tag || !customElements.get(tag)) { setUnavailable(true); return }
      setUnavailable(false)
      current = document.createElement(tag)
      if (espVariant) current.setAttribute('board-kind', espVariant)
      element.current = current
      defaults.current = metadata?.defaultValues ?? {}
      applyElementProperties(current, { ...defaults.current, ...properties.current }, defaults.current)
      host.current.replaceChildren(current)
      runtime?.registerElement(part.id, current)
      const read = () => {
        if (!active) return
        const info = readPinInfo<HardwarePin>(current)
        if (info?.length) pinsChanged(part.id, info)
      }
      current.addEventListener('pininfo-change', read)
      timer = setInterval(read, 400)
      read()
    }).catch(() => { if (active) setUnavailable(true) })
    return () => {
      active = false
      if (timer) clearInterval(timer)
      runtime?.registerElement(part.id, null)
      current?.remove()
      element.current = null
    }
  }, [part.id, part.type, runtime, pinsChanged])
  useEffect(() => {
    if (element.current) {
      const applied = applyElementProperties(element.current, part.properties, defaults.current)
      runtime?.updateComponentProperties(part.id, applied)
    }
  }, [part.id, part.properties, runtime])
  return <div className="hw-part-element" ref={host}>{unavailable && <div className="hw-unavailable">{part.type}<small>Element unavailable · placement only</small></div>}</div>
}
