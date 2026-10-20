import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ListChecks, Wifi, Copy, RotateCw, Cable, ArrowLeft, Check, ChevronDown, ChevronRight, CircuitBoard, Code2, Cpu, FolderOpen, Image as ImageIcon, LayoutGrid, LoaderCircle, Maximize, Minus, Play, Plus, RefreshCw, Save, Search, Square, Terminal, Trash2, Undo2, Waves, Wrench, X, Zap } from 'lucide-react'
import { ComponentRegistry } from '../../vendor/velxio/frontend/src/services/ComponentRegistry'
import { artifactIsCurrent, catalogPins, catalogType, hardwareApi, HardwareApiError, isHardwareProject } from '../lib/hardware'
import type { CatalogComponent, CompilerResult, Firmware, HardwareCommand, HardwareComponent, HardwarePin, HardwareProject, WireEndpoint } from '../lib/hardware'
import { HardwareRuntime } from '../hardware/runtime'
import type { RuntimeResults } from '../hardware/runtime'
import { HardwarePart } from '../hardware/part'
import { routeWirePaths } from '../hardware/wire-path'
import { canvasBounds, containPartPosition } from '../hardware/canvas-bounds'
import type { WireBounds, WirePort } from '../hardware/wire-path'
import './hardware-workspace.css'
import { WorkspaceLoading } from './ui/workspace-loading'
import { ProjectDetails } from './project-details'
import { BuildGuide } from './build-guide'
import { compactCatalogName, catalogTooltip } from '../lib/catalog-label'
import { BoardFlashDialog } from './ui/board-flash-dialog'
import { visibleForBuilding } from '../lib/simulation-catalog'
import { EspNetworkDialog } from './ui/esp-network-dialog'
import { ConnectionCheck } from './connection-check'

type WorkspaceTab = 'circuit' | 'agent' | 'parts'
type DockTab = 'compiler' | 'serial' | 'results' | 'tools'
export type HardwareWorkspaceView = 'circuit' | 'schematic'
export type HardwareWorkspaceProps = {
  chatSlot?: ReactNode; children?: ReactNode; onProjectChange?: (project: HardwareProject | null) => void
  schematicSlot?: ReactNode; oscilloscopeSlot?: ReactNode; analysisSlot?: ReactNode
  onRuntimeChange?: (runtime: HardwareRuntime | null) => void
  onResultsChange?: (results: RuntimeResults | null) => void
  view?: HardwareWorkspaceView; onViewChange?: (view: HardwareWorkspaceView) => void
}

const categoryNames: Record<string, string> = {
  boards: 'Microcontrollers', sensors: 'Sensors', displays: 'Displays', input: 'Inputs', output: 'Outputs',
  passive: 'Passives', analog: 'Analog', motors: 'Motors', communication: 'Communication', logic: 'Logic', other: 'Other components',
}

type WorkspaceLayout = { sidebar: number; agent: number; dock: number }
const layoutKey = 'wireup.workspace.layout.v1'
const defaultLayout: WorkspaceLayout = { sidebar: 232, agent: 340, dock: 216 }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const readLayout = (): WorkspaceLayout => {
  try {
    const saved = JSON.parse(localStorage.getItem(layoutKey) || '') as Partial<WorkspaceLayout>
    return {
      sidebar: clamp(Number(saved.sidebar) || defaultLayout.sidebar, 180, 480),
      agent: clamp(Number(saved.agent) || defaultLayout.agent, 260, 680),
      dock: clamp(Number(saved.dock) || defaultLayout.dock, 96, 480),
    }
  } catch { return defaultLayout }
}

const generatedPreviews = new Set(Object.keys(import.meta.glob('/public/component-previews/*.png')).map(path => path.split('/').pop()!.replace('.png', '')))
const NATIVE_ESP32_BOARDS = new Set(['esp32-devkit-v1', 'esp32-devkit-c-v4'])

const STATIC_PROJECT: HardwareProject = {
  id: 'frontend-preview', schema_version: 1, revision: 1,
  name: 'Arduino Uno: SSD1306 OLED (4-pin I2C)', board: 'arduino-uno',
  components: [
    { id: 'board', type: 'arduino-uno', x: 120, y: 105, rotation: 0, properties: {} },
    { id: 'oled', type: 'ssd1306', x: 480, y: 70, rotation: 0, properties: { i2cAddress: '0x3c' } },
  ],
  wires: [
    { id: 'wire-vcc', from: { component: 'board', pin: '5V' }, to: { component: 'oled', pin: 'VIN' }, color: '#ff3b30' },
    { id: 'wire-gnd', from: { component: 'board', pin: 'GND.1' }, to: { component: 'oled', pin: 'GND' }, color: '#161616' },
    { id: 'wire-sda', from: { component: 'board', pin: 'A4' }, to: { component: 'oled', pin: 'DATA' }, color: '#1689ff' },
    { id: 'wire-scl', from: { component: 'board', pin: 'A5' }, to: { component: 'oled', pin: 'CLK' }, color: '#ff8a00' },
  ],
  firmware: { filename: 'sketch.ino', source: '#include <Adafruit_GFX.h>\n#include <Adafruit_SSD1306.h>\n\nvoid setup() {}\nvoid loop() {}', revision: 1 },
  history: [], compiler: null, runtime_token: '', created_at: '', updated_at: '',
}

const STATIC_CATALOG: CatalogComponent[] = [
  { id: 'bmp280', type: 'bmp280', name: 'BMP280', category: 'sensors' },
  { id: 'l293d', type: 'l293d', name: 'L293D', category: 'other' },
  { id: 'relay', type: 'relay', name: 'Relay', category: 'other' },
  { id: 'arduino-uno', type: 'arduino-uno', name: 'Arduino Uno', category: 'boards' },
  { id: 'arduino-nano', type: 'arduino-nano', name: 'Arduino Nano', category: 'boards' },
  { id: 'arduino-mega-2560', type: 'arduino-mega-2560', name: 'Arduino Mega 2560', category: 'boards' },
  { id: 'esp32-devkit-v1', type: 'esp32-devkit-v1', name: 'ESP32 DevKit V1', category: 'boards' },
  { id: 'esp32-devkit-c-v4', type: 'esp32-devkit-c-v4', name: 'ESP32 DevKit C V4', category: 'boards' },
  { id: 'esp32-s3-devkitc-1', type: 'esp32-s3-devkitc-1', name: 'ESP32-S3 DevKitC-1', category: 'boards' },
  { id: 'esp32-c3-devkitm-1', type: 'esp32-c3-devkitm-1', name: 'ESP32-C3 DevKitM-1', category: 'boards' },
  { id: 'ssd1306', type: 'ssd1306', name: 'SSD1306 OLED', category: 'displays' },
]

type NativeEsp32State = {
  running: boolean; runtime: string; artifact_id: string; serial: string; status: string
  run_id: string; gpio_available: boolean
  gpio: Record<string, { level: boolean | null; drive: string }>
  simulation_scope: string; error?: string | null
}

function nativeEsp32Results(state: NativeEsp32State): RuntimeResults {
  return {
    running: state.running,
    engine: state.runtime,
    artifact_id: state.artifact_id,
    cycles: 0,
    simulated_ms: 0,
    serial: state.serial,
    serial_link: null,
    pins: state.gpio,
    limitations: [state.simulation_scope],
    state: state.status,
    error: state.error,
    run_id: state.run_id,
    support_warnings: state.gpio_available ? [] : ['Classic ESP32 GPIO is unavailable in this runtime.'],
  }
}

function CatalogThumbnail({ type, name, thumbnail }: { type: string; name: string; thumbnail?: string }) {
  const host = useRef<HTMLSpanElement>(null)
  const preview = thumbnail?.trim().startsWith('<svg') ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(thumbnail)}` : thumbnail || (generatedPreviews.has(type) ? `/component-previews/${type}.png` : `/component-svgs/${type}.svg`)
  const [imageFailed, setImageFailed] = useState(false)
  useEffect(() => {
    if (!imageFailed) return
    let active = true
    let cleanup: (() => void) | undefined
    const container = host.current
    void ComponentRegistry.getInstance().load().then(() => {
      const metadata = ComponentRegistry.getInstance().getById(type)
      if (!active || !host.current || !metadata || !customElements.get(metadata.tagName)) return
      const element = document.createElement(metadata.tagName)
      Object.assign(element, metadata.defaultValues)
      host.current.replaceChildren(element)
      const fit = () => {
        if (!active || !host.current) return
        const scale = Math.min(1, 65 / Math.max(element.offsetWidth, 1), 49 / Math.max(element.offsetHeight, 1))
        element.style.transform = `translate(-50%, -50%) scale(${scale})`
      }
      requestAnimationFrame(fit)
      const observer = new ResizeObserver(fit)
      observer.observe(element)
      cleanup = () => observer.disconnect()
    }).catch(() => {})
    return () => { active = false; cleanup?.(); container?.replaceChildren() }
  }, [imageFailed, type])
  return <span className="hw-catalog-art" aria-hidden="true">{!imageFailed ? <img src={preview} alt="" loading="lazy" onError={() => setImageFailed(true)} /> : <span ref={host} className="hw-catalog-element"><Cpu size={22} /></span>}<span className="hw-thumbnail-name">{name}</span></span>
}

export function HardwareWorkspace({ chatSlot, children, onProjectChange, schematicSlot, oscilloscopeSlot, analysisSlot, onRuntimeChange, onResultsChange, view, onViewChange }: HardwareWorkspaceProps) {
  const { projectId } = useParams<{ projectId: string }>()
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadError, setLoadError] = useState('')
  const [project, setProject] = useState<HardwareProject | null>(null)
  const projectRef = useRef<HardwareProject | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [source, setSource] = useState('')
  const sourceRef = useRef('')
  const savedSource = useRef('')
  const draftRevision = useRef<number | null>(null)
  const [catalog, setCatalog] = useState<CatalogComponent[]>([])
  const [knownCatalog, setKnownCatalog] = useState<CatalogComponent[]>([])
  const [query, setQuery] = useState('')
  const [componentsOpen, setComponentsOpen] = useState(true)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [connectionCheckOpen, setConnectionCheckOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [canvasTab, setCanvasTab] = useState<'build' | 'wiring'>('build')
  const moreRef = useRef<HTMLDivElement>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  type ProjectSection = 'info' | 'guide' | 'wiring' | 'code'
  const sectionParam = searchParams.get('section')
  const section: ProjectSection = sectionParam === 'info' || sectionParam === 'guide' || sectionParam === 'code' ? sectionParam : 'wiring'
  const setSection = useCallback((next: ProjectSection) => setSearchParams(previous => {
    const params = new URLSearchParams(previous)
    if (next === 'wiring') params.delete('section')
    else params.set('section', next)
    return params
  }, { replace: true }), [setSearchParams])
  const [simulationOpen, setSimulationOpen] = useState(false)
  const [pinLabelsOpen, setPinLabelsOpen] = useState(true)
  const [selected, setSelected] = useState('board')
  const [actionPartId, setActionPartId] = useState<string | null>(null)
  const [actionsPinned, setActionsPinned] = useState(false)
  const actionHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelActionHide = () => { if (actionHideTimer.current) clearTimeout(actionHideTimer.current) }
  const hideActions = () => { cancelActionHide(); setActionPartId(null); setActionsPinned(false) }
  const leaveActions = () => {
    cancelActionHide()
    if (!actionsPinned) actionHideTimer.current = setTimeout(() => setActionPartId(null), 180)
  }
  useEffect(() => () => { if (actionHideTimer.current) clearTimeout(actionHideTimer.current) }, [])
  const [tab, setTab] = useState<WorkspaceTab>('circuit')
  const [dock, setDock] = useState<DockTab>('compiler')
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [sketchOpen, setSketchOpen] = useState(false)
  const [scopeOpen, setScopeOpen] = useState(false)
  const [localView, setLocalView] = useState<HardwareWorkspaceView>('circuit')
  const activeView = view ?? localView
  const canvasViewport = useRef<HTMLDivElement>(null)
  const sketchDialog = useRef<HTMLDialogElement>(null)
  const scopeDialog = useRef<HTMLDialogElement>(null)
  const [connection, setConnection] = useState('Disconnected')
  const [flashOpen, setFlashOpen] = useState(false)
  const [networkOpen, setNetworkOpen] = useState(false)
  const [wireDetails, setWireDetails] = useState<{ id: string; x: number; y: number } | null>(null)
  const [runtime, setRuntime] = useState<HardwareRuntime | null>(null)
  const runtimeRef = useRef<HardwareRuntime | null>(null)
  runtimeRef.current = runtime
  useEffect(() => { onRuntimeChange?.(runtime); return () => onRuntimeChange?.(null) }, [runtime, onRuntimeChange])
  const [results, setResults] = useState<RuntimeResults | null>(null)
  useEffect(() => { onResultsChange?.(results) }, [results, onResultsChange])
  const acceptNativeState = useCallback((state: NativeEsp32State) => {
    const converted = nativeEsp32Results(state)
    setResults(converted)
    const current = projectRef.current
    runtimeRef.current?.applyNativeState(converted.pins, state.running, current && state.run_id ? (pin, level) => {
      void hardwareApi.nativeGpio(current, state.run_id, pin, level).catch(error => {
        setError(error instanceof Error ? error.message : 'Unable to send native ESP32 GPIO input.')
      })
    } : null)
  }, [])
  useEffect(() => {
    if (results?.engine !== 'qemu-native' || !results.running || !results.run_id) return
    let active = true
    let inFlight = false
    const refresh = async () => {
      const current = projectRef.current
      if (!active || inFlight || !current) return
      inFlight = true
      try {
        const response = await hardwareApi.command<{ result: NativeEsp32State }>(current, 'read_simulation_results', {
          expected_revision: current.revision,
          source_revision: current.firmware.revision,
          run_id: results.run_id,
        })
        if (active) acceptNativeState(response.result)
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : 'Unable to read the native ESP32 runtime.')
      } finally { inFlight = false }
    }
    const timer = setInterval(() => void refresh(), 250)
    return () => { active = false; clearInterval(timer) }
  }, [results?.engine, results?.running, results?.run_id, acceptNativeState])
  const [compiler, setCompiler] = useState<CompilerResult | null>(null)
  const [pins, setPins] = useState<Record<string, HardwarePin[]>>({})
  const [partSizes, setPartSizes] = useState<Record<string, { width: number; height: number }>>({})
  const sizeChanged = useCallback((id: string, size: { width: number; height: number }) => {
    setPartSizes(previous => previous[id]?.width === size.width && previous[id]?.height === size.height ? previous : { ...previous, [id]: size })
  }, [])
  const [wireStart, setWireStart] = useState<WireEndpoint | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [wireColor, setWireColor] = useState('#a3e635')
  const [serialInput, setSerialInput] = useState('')
  const [expression, setExpression] = useState('')
  const [toolOutput, setToolOutput] = useState('')
  const [properties, setProperties] = useState('{}')
  const [position, setPosition] = useState({ x: 0, y: 0, rotation: 0 })
  const [zoom, setZoom] = useState(1)
  const wheelZoomAnchor = useRef<{ x: number; y: number; localX: number; localY: number } | null>(null)
  useEffect(() => {
    const viewport = canvasViewport.current
    if (!viewport) return
    const wheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      const localX = event.clientX - rect.left
      const localY = event.clientY - rect.top
      wheelZoomAnchor.current = { x: (viewport.scrollLeft + localX) / zoom, y: (viewport.scrollTop + localY) / zoom, localX, localY }
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1)
      setZoom(value => Math.max(.25, Math.min(2, value * Math.exp(-delta * .002))))
    }
    viewport.addEventListener('wheel', wheel, { passive: false })
    return () => viewport.removeEventListener('wheel', wheel)
  }, [zoom, loading, activeView, section, projectId])
  useEffect(() => {
    const anchor = wheelZoomAnchor.current
    if (!anchor || !canvasViewport.current) return
    canvasViewport.current.scrollLeft = anchor.x * zoom - anchor.localX
    canvasViewport.current.scrollTop = anchor.y * zoom - anchor.localY
    wheelZoomAnchor.current = null
  }, [zoom])
  const [dragPreview, setDragPreview] = useState<{ id: string; x: number; y: number } | null>(null)
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => { dragCleanup.current?.() }, [projectId])
  const [session, setSession] = useState(0)
  const [layout, setLayout] = useState<WorkspaceLayout>(readLayout)
  const [resizing, setResizing] = useState<'sidebar' | 'agent' | 'dock' | null>(null)
  useEffect(() => { try { localStorage.setItem(layoutKey, JSON.stringify(layout)) } catch { /* Layout resets if storage is unavailable. */ } }, [layout])
  const busyRef = useRef(false)

  // Drag a panel edge to resize it; sizes clamp so the canvas always keeps room.
  const startResize = (kind: 'sidebar' | 'agent' | 'dock') => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const horizontal = kind !== 'dock'
    const origin = horizontal ? event.clientX : event.clientY
    const start = layout[kind]
    setResizing(kind)
    document.body.classList.add('hw-resizing', horizontal ? 'hw-resizing-col' : 'hw-resizing-row')
    const move = (moveEvent: PointerEvent) => {
      const delta = horizontal ? moveEvent.clientX - origin : moveEvent.clientY - origin
      setLayout(previous => {
        if (kind === 'sidebar') return { ...previous, sidebar: clamp(start + delta, 180, Math.max(200, Math.min(480, window.innerWidth - previous.agent - 320))) }
        if (kind === 'agent') return { ...previous, agent: clamp(start - delta, 260, Math.max(280, Math.min(680, window.innerWidth - previous.sidebar - 320))) }
        return { ...previous, dock: clamp(start - delta, 96, Math.max(120, Math.min(480, Math.round(window.innerHeight * .7)))) }
      })
    }
    const finish = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish)
      document.body.classList.remove('hw-resizing', 'hw-resizing-col', 'hw-resizing-row')
      setResizing(null)
    }
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish)
  }

  const acceptProject = useCallback((next: HardwareProject, forceSource = false) => {
    const previous = projectRef.current
    if (previous?.id === next.id && (previous.revision > next.revision || (!forceSource && JSON.stringify(previous) === JSON.stringify(next)))) return
    if (!next.runtime_token && previous?.id === next.id) next = { ...next, runtime_token: previous.runtime_token }
    runtimeRef.current?.updateProject(next)
    projectRef.current = next
    setProject(next)
    setCompiler(next.compiler)
    if (forceSource || !previous || previous.id !== next.id || sourceRef.current === savedSource.current) {
      sourceRef.current = next.firmware.source
      setSource(next.firmware.source)
      draftRevision.current = next.revision
    }
    savedSource.current = next.firmware.source
  }, [])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true); setLoadError(''); setError(''); setProject(null); projectRef.current = null
    setSelected('board'); setActionPartId(null); setActionsPinned(false); setPins({}); setResults(null); setWireStart(null)
    if (active) acceptProject(STATIC_PROJECT, true)
    setLoading(false)
    return () => { active = false; controller.abort() }
  }, [acceptProject, loadAttempt])

  useEffect(() => { onProjectChange?.(project) }, [project, onProjectChange])

  useEffect(() => {
    setKnownCatalog(STATIC_CATALOG); setCatalog(STATIC_CATALOG)
  }, [])

  useEffect(() => {
    const value = query.trim().toLowerCase()
    setCatalog(STATIC_CATALOG.filter(part => !value || `${part.name} ${catalogType(part)}`.toLowerCase().includes(value)))
  }, [query])

  useEffect(() => {
    const current = projectRef.current
    if (!current || current.id !== projectId) return
    const bridge = new HardwareRuntime(value => {
      if (!NATIVE_ESP32_BOARDS.has(projectRef.current?.board ?? '')) setResults(value)
    })
    bridge.connect(current, setConnection, acceptProject)
    setRuntime(bridge)
    return () => { bridge.dispose(); setRuntime(null) }
  }, [project?.id, projectId, session, acceptProject])

  useEffect(() => {
    if (!projectId || projectRef.current?.id !== projectId) return
    let active = true
    let inFlight: AbortController | null = null
    const refresh = () => {
      if (!active || inFlight || busyRef.current || document.hidden) return
      const controller = new AbortController()
      inFlight = controller
      void hardwareApi.getProject(projectId, { signal: controller.signal }).then(next => { if (active) acceptProject(next) })
        .catch(error => { if (active && !controller.signal.aborted) setError(error instanceof Error ? error.message : 'Unable to refresh the project.') })
        .finally(() => { if (inFlight === controller) inFlight = null })
    }
    const timer = setInterval(refresh, 2000)
    window.addEventListener('focus', refresh)
    const agentRefresh = (event: Event) => { if ((event as CustomEvent<string>).detail === projectId) refresh() }
    window.addEventListener('wireup-project-updated', agentRefresh)
    return () => { active = false; inFlight?.abort(); clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('wireup-project-updated', agentRefresh) }
  }, [projectId, project?.id, acceptProject])

  const perform = async (label: string, task: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(label); setError(''); setNotice('')
    try { await task() } catch (error) {
      setError(error instanceof Error ? error.message : 'Hardware operation failed.')
      if (error instanceof HardwareApiError && error.status === 409 && projectRef.current) {
        try { acceptProject(await hardwareApi.getProject(projectRef.current.id)) } catch { /* Keep the original conflict visible. */ }
      }
    } finally { busyRef.current = false; setBusy('') }
  }
  const command = async (name: HardwareCommand, args: Record<string, unknown> = {}, mutation = false) => {
    const current = projectRef.current
    if (!current) throw new Error('Open a project first.')
    const value = await hardwareApi.command<unknown>(current, name, { ...args, ...(mutation ? { expected_revision: current.revision } : {}) }, {
      compileTimeoutSeconds: knownCatalog.find(item => catalogType(item) === current.board)?.compile_timeout_seconds,
    })
    if (isHardwareProject(value)) {
      acceptProject(value, name === 'undo')
      if (value.board !== current.board) setNotice(`Selected ${value.board}. ${knownCatalog.find(item => catalogType(item) === value.board)?.unavailable_reason || knownCatalog.find(item => catalogType(item) === value.board)?.description || 'Compile capabilities depend on the selected board; native simulation may require additional setup.'}`)
    }
    return value
  }
  const saveSource = async () => {
    const current = projectRef.current
    const submittedSource = sourceRef.current
    if (current && submittedSource !== current.firmware.source) {
      const next = await hardwareApi.command<HardwareProject>(current, 'edit_firmware', { source: submittedSource, expected_revision: draftRevision.current ?? current.revision })
      acceptProject(next, sourceRef.current === submittedSource)
    }
  }
  const dirty = !!project && source !== project.firmware.source
  const mutationDisabled = !!busy || !!results?.running || dirty
  const selectedPart = project?.components.find(part => part.id === selected)
  const selectedElement = useRef<HTMLDivElement | null>(null)
  const [selectedSize, setSelectedSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = selectedElement.current
    if (!element) return
    const measure = () => setSelectedSize({ width: element.offsetWidth, height: element.offsetHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [selectedPart?.id, selectedPart?.type, loading, activeView])
  useEffect(() => {
    if (!selectedPart) return
    setProperties(JSON.stringify(selectedPart.properties, null, 2))
    setPosition({ x: selectedPart.x, y: selectedPart.y, rotation: selectedPart.rotation })
  }, [selectedPart])

  const pinsChanged = useCallback((id: string, info: HardwarePin[]) => {
    setPins(previous => JSON.stringify(previous[id]) === JSON.stringify(info) ? previous : { ...previous, [id]: info })
  }, [])
  const catalogFor = (part: HardwareComponent) => knownCatalog.find(item => catalogType(item) === part.type)
  const displayedPart = (part: HardwareComponent) => dragPreview?.id === part.id ? { ...part, x: dragPreview.x, y: dragPreview.y } : part
  const selectedIsBoard = selectedPart?.id === 'board' || (selectedPart && catalogFor(selectedPart)?.category === 'boards')
  const actionPart = project?.components.find(part => part.id === actionPartId)
  const actionIsBoard = actionPart?.id === 'board' || (actionPart && catalogFor(actionPart)?.category === 'boards')
  const selectedDisplay = actionPart && displayedPart(actionPart)
  const actionSize = actionPart ? partSizes[actionPart.id] ?? selectedSize : selectedSize
  const selectedRadians = (selectedDisplay?.rotation ?? 0) * Math.PI / 180
  const selectedCorners = [{ x: 0, y: 0 }, { x: actionSize.width, y: 0 }, { x: 0, y: actionSize.height }, { x: actionSize.width, y: actionSize.height }].map(point => ({
    x: point.x * Math.cos(selectedRadians) - point.y * Math.sin(selectedRadians),
    y: point.x * Math.sin(selectedRadians) + point.y * Math.cos(selectedRadians),
  }))
  const selectedActionsPosition = selectedDisplay && {
    left: selectedDisplay.x + (Math.min(...selectedCorners.map(point => point.x)) + Math.max(...selectedCorners.map(point => point.x))) / 2,
    top: selectedDisplay.y + Math.max(...selectedCorners.map(point => point.y)) + 12,
  }
  useEffect(() => {
    if (mutationDisabled || activeView !== 'circuit') dragCleanup.current?.()
  }, [mutationDisabled, activeView])
  const startPartDrag = (part: HardwareComponent, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (mutationDisabled || busyRef.current || event.button !== 0 || dragCleanup.current) return
    event.preventDefault()
    event.stopPropagation()
    setSelected(part.id)
    cancelActionHide(); setActionPartId(part.id); setActionsPinned(true)
    setWireDetails(null)
    const target = event.currentTarget
    const pointerId = event.pointerId
    const viewport = canvasViewport.current
    const startX = event.clientX; const startY = event.clientY
    const scrollLeft = viewport?.scrollLeft ?? 0; const scrollTop = viewport?.scrollTop ?? 0
    target.setPointerCapture(pointerId)
    const coordinates = (pointer: PointerEvent) => containPartPosition(part, partSizes[part.id] ?? { width: 180, height: 160 }, {
      x: part.x + (pointer.clientX - startX + (viewport?.scrollLeft ?? 0) - scrollLeft) / zoom,
      y: part.y + (pointer.clientY - startY + (viewport?.scrollTop ?? 0) - scrollTop) / zoom,
    })
    const cleanup = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', cancel)
      target.removeEventListener('lostpointercapture', cancel)
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      dragCleanup.current = null
    }
    const cancel = () => { cleanup(); setDragPreview(null) }
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return
      setDragPreview({ id: part.id, ...coordinates(pointer) })
    }
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return
      cleanup()
      const point = coordinates(pointer)
      const x = Math.round(point.x); const y = Math.round(point.y)
      if ((x === part.x && y === part.y) || busyRef.current || projectRef.current?.id !== projectId) { setDragPreview(null); return }
      setDragPreview({ id: part.id, x, y })
      void perform('Moving component', async () => {
        try { await command('modify_component', { id: part.id, x, y }, true) }
        finally { setDragPreview(null) }
      })
    }
    dragCleanup.current = cancel
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', cancel)
    target.addEventListener('lostpointercapture', cancel)
  }
  const endpointOptions = project?.components.flatMap(part => catalogPins(catalogFor(part)).map(pin => ({ value: JSON.stringify({ component: part.id, pin }), label: `${part.id} · ${pin}` }))) ?? []
  const routedPaths = useMemo(() => {
    const components = project?.components.map(part => dragPreview?.id === part.id ? { ...part, x: dragPreview.x, y: dragPreview.y } : part) ?? []
    const bounds: WireBounds[] = components.flatMap(part => {
      const size = partSizes[part.id]
      if (!size?.width || !size.height) return []
      const radians = part.rotation * Math.PI / 180
      const corners = [{ x: 0, y: 0 }, { x: size.width, y: 0 }, { x: 0, y: size.height }, { x: size.width, y: size.height }].map(point => ({
        x: part.x + (point.x + 1) * Math.cos(radians) - (point.y + 1) * Math.sin(radians),
        y: part.y + (point.x + 1) * Math.sin(radians) + (point.y + 1) * Math.cos(radians),
      }))
      return [{ id: part.id, left: Math.min(...corners.map(point => point.x)), right: Math.max(...corners.map(point => point.x)), top: Math.min(...corners.map(point => point.y)), bottom: Math.max(...corners.map(point => point.y)) }]
    })
    const port = (endpoint: WireEndpoint): WirePort | null => {
      const part = components.find(part => part.id === endpoint.component)
      const info = pins[endpoint.component] ?? []
      const aliases = [endpoint.pin, endpoint.pin.replace(/^D(?=\d)/, ''), endpoint.pin === 'GND' ? 'GND.1' : endpoint.pin, endpoint.pin === 'TX' ? '1' : endpoint.pin === 'RX' ? '0' : endpoint.pin]
      const pin = aliases.map(name => info.find(pin => pin.name === name)).find(Boolean)
      if (!part || pin?.x === undefined || pin.y === undefined) return null
      const size = partSizes[part.id]
      const edges = [{ distance: pin.x, x: -1, y: 0 }, { distance: (size?.width ?? pin.x * 2) - pin.x, x: 1, y: 0 }, { distance: pin.y, x: 0, y: -1 }, { distance: (size?.height ?? pin.y * 2) - pin.y, x: 0, y: 1 }]
      const edge = edges.sort((a, b) => a.distance - b.distance)[0]
      const radians = part.rotation * Math.PI / 180
      const exitAngle = Math.round((Math.atan2(edge.y, edge.x) + radians) / (Math.PI / 2)) * Math.PI / 2
      return {
        component: part.id,
        x: part.x + (pin.x + 1) * Math.cos(radians) - (pin.y + 1) * Math.sin(radians),
        y: part.y + (pin.x + 1) * Math.sin(radians) + (pin.y + 1) * Math.cos(radians),
        direction: { x: Math.round(Math.cos(exitAngle)), y: Math.round(Math.sin(exitAngle)) },
      }
    }
    return routeWirePaths((project?.wires ?? []).flatMap(wire => {
      const start = port(wire.from)
      const end = port(wire.to)
      return start && end ? [{ id: wire.id, start, end }] : []
    }), bounds)
  }, [project?.components, project?.wires, pins, partSizes, dragPreview])
  const canvasExtent = useMemo(() => canvasBounds(project?.components.map(part => dragPreview?.id === part.id ? { ...part, x: dragPreview.x, y: dragPreview.y } : part) ?? [], partSizes, routedPaths.values()), [project?.components, partSizes, routedPaths, dragPreview])
  const pinPosition = (endpoint: WireEndpoint) => {
    const canonical = project?.components.find(part => part.id === endpoint.component)
    const part = canonical && displayedPart(canonical)
    const info = pins[endpoint.component] ?? []
    const aliases = [endpoint.pin, endpoint.pin.replace(/^D(?=\d)/, ''), endpoint.pin === 'GND' ? 'GND.1' : endpoint.pin, endpoint.pin === 'TX' ? '1' : endpoint.pin === 'RX' ? '0' : endpoint.pin]
    const pin = aliases.map(name => info.find(pin => pin.name === name)).find(Boolean)
    if (!part || pin?.x === undefined || pin.y === undefined) return null
    const radians = part.rotation * Math.PI / 180
    return { x: part.x + (pin.x + 1) * Math.cos(radians) - (pin.y + 1) * Math.sin(radians), y: part.y + (pin.x + 1) * Math.sin(radians) + (pin.y + 1) * Math.cos(radians) }
  }
  const revealPin = (endpoint: WireEndpoint) => {
    const point = pinPosition(endpoint)
    const viewport = canvasViewport.current
    if (!point || !viewport) return
    setSelected(endpoint.component)
    cancelActionHide(); setActionPartId(endpoint.component); setActionsPinned(true)
    viewport.scrollTo({left:Math.max(0,(point.x+canvasExtent.offsetX)*zoom-viewport.clientWidth/2),top:Math.max(0,(point.y+canvasExtent.offsetY)*zoom-viewport.clientHeight/2),behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'})
  }
  const unresolvedWires = project?.wires.filter(wire => !pinPosition(wire.from) || !pinPosition(wire.to)) ?? []
  const choosePin = (endpoint: WireEndpoint) => {
    if (mutationDisabled) return
    if (!wireStart) { setWireStart(endpoint); return }
    if (JSON.stringify(endpoint) === JSON.stringify(wireStart)) { setWireStart(null); return }
    void perform('Connecting wire', async () => {
      await command('connect_wire', { from: wireStart, to: endpoint, color: wireColor }, true)
      setWireStart(null)
    })
  }
  const agent = chatSlot ?? children
  const visibleCatalog = catalog.filter(item => visibleForBuilding(item, project?.board ?? 'unselected'))
  const categories = [...new Set(visibleCatalog.map(item => item.category ?? 'other'))].sort((a, b) => {
    const order = ['boards', 'input', 'output', 'sensors', 'displays', 'passive', 'analog', 'motors', 'communication', 'logic', 'other']
    return order.indexOf(a) - order.indexOf(b)
  })
  const selectedBoard = knownCatalog.find(item => catalogType(item) === project?.board)
  const runBlocker = !project || project.board === 'unselected' ? 'Select a board before running a simulation.'
    : selectedBoard?.simulation === 'unavailable' ? `Simulation is currently unavailable for ${selectedBoard.name}. You can still build the circuit and write source code. ${selectedBoard.unavailable_reason || ''}`
    : dirty ? 'Save and compile your firmware changes before running.'
    : !artifactIsCurrent(project) ? 'Compile the current firmware for this board before running.'
    : selectedBoard?.simulation !== 'native' && connection !== 'Connected' ? `Browser runtime: ${connection}. Close other tabs using this project, then reconnect.`
    : busy ? 'Wait for the current operation to finish.' : ''
  const compileDisabled = !!busy || !!results?.running || !project || project.board === 'unselected' || selectedBoard?.compile === false
  const compileFirmware = () => perform('Compiling firmware', async () => {
    await saveSource()
    const value = await command('compile_firmware', {}, true) as CompilerResult
    setCompiler(value); setDock('compiler'); setConsoleOpen(true); setSketchOpen(false); setTab('circuit')
    if (projectRef.current) acceptProject(await hardwareApi.getProject(projectRef.current.id))
    setNotice(value.status === 'simulation_ready' ? 'Firmware compiled. Ready for browser simulation.' : value.status === 'error' ? 'Compilation failed. Review compiler diagnostics.' : 'Review compiler results and this board’s simulation support before running.')
  })
  const startSimulation = () => perform('Starting simulation', async () => {
    const current = projectRef.current
    const response = await command('run_simulation', current?.board.startsWith('esp32-devkit-') ? {
      expected_revision: current.revision,
      source_revision: current.firmware.revision,
      artifact_id: current.compiler?.artifact?.id,
    } : {}) as { result?: NativeEsp32State }
    if (response.result?.runtime === 'qemu-native') acceptNativeState(response.result)
    setDock('results')
    setConsoleOpen(true)
  })
  const stopSimulation = () => perform('Stopping simulation', async () => {
    const current = projectRef.current
    const response = await command('stop_simulation', results?.engine === 'qemu-native' && current ? {
      expected_revision: current.revision,
      source_revision: current.firmware.revision,
      run_id: results.run_id,
    } : {}) as { result?: NativeEsp32State }
    if (response.result?.runtime === 'qemu-native') acceptNativeState(response.result)
  })
  const changeView = (next: HardwareWorkspaceView) => { setLocalView(next); onViewChange?.(next); setTab('circuit') }
  const fitCanvas = () => {
    const viewport = canvasViewport.current
    if (!viewport) return
    setZoom(Math.min(1.5, Math.max(.25, Math.min((viewport.clientWidth - 24) / canvasExtent.width, (viewport.clientHeight - 24) / canvasExtent.height))))
    viewport.scrollTo({ left: 0, top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  useEffect(() => {
    const dialog = sketchDialog.current
    if (sketchOpen && dialog && !dialog.open) dialog.showModal()
    if (!sketchOpen && dialog?.open) dialog.close()
  }, [sketchOpen])
  useEffect(() => {
    // The schematic studio's Sketch button shares this firmware editor.
    const open = () => {setSection('code');setTab('circuit')}
    window.addEventListener('wireup:open-sketch', open)
    return () => window.removeEventListener('wireup:open-sketch', open)
  }, [setSection])
  useEffect(() => {
    const dialog = scopeDialog.current
    if (scopeOpen && dialog && !dialog.open) dialog.showModal()
    if (!scopeOpen && dialog?.open) dialog.close()
  }, [scopeOpen])
  useEffect(() => {
    if (!moreOpen) return
    const close = (event: MouseEvent) => { if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMoreOpen(false) }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey) }
  }, [moreOpen])

  const showCanvas = (next: 'build' | 'wiring') => { setCanvasTab(next); setSection('wiring'); setTab('circuit'); setSketchOpen(false); setMoreOpen(false); changeView('circuit') }
  const showPreview = () => { setSection('wiring'); setTab('circuit'); setSketchOpen(false); setMoreOpen(false); changeView('schematic') }
  const showCode = () => { setSection('code'); setTab('circuit'); setSketchOpen(false); setMoreOpen(false) }
  const showMoreSection = (next: 'info' | 'guide') => { setSection(next); setTab('circuit'); setSketchOpen(false); setMoreOpen(false) }
  const FirmwareContainer = section === 'code' ? 'section' : 'dialog'
  const buildPressed = section === 'wiring' && activeView === 'circuit' && canvasTab === 'build'
  const previewPressed = section === 'wiring' && activeView === 'schematic'
  const wiringPressed = section === 'wiring' && activeView === 'circuit' && canvasTab === 'wiring'
  return <main className="hardware-workspace" data-mobile-tab={tab} onPointerDownCapture={event => { if (!(event.target as Element).closest('.hw-canvas-part, .hw-part-actions, .hw-wire-details')) hideActions() }} onKeyDownCapture={event => { if (event.key === 'Escape') hideActions() }}>
    <header className="hw-header">
      <div className="hw-header-lead">
        <Link to="/" className="hw-brand" aria-label="WireUp home"><img src="/wireup-logo.png" alt="" /><span>WireUp</span></Link>
        <span className="hw-header-divider" /><Link to="/projects" className="hw-project-link"><FolderOpen size={15} /> Projects</Link>
        {project && <><ChevronRight size={14} className="hw-muted" /><span className="hw-project-title">{project.name}</span><span className="hw-chip">{project.board === 'unselected' ? 'Board not selected' : project.board}</span></>}
      </div>
      {project && <nav className="hw-project-tabs" aria-label="Project sections">
        <div className="hw-tab-scroll">
          <button type="button" aria-pressed={buildPressed} onClick={() => showCanvas('build')}><LayoutGrid size={15} aria-hidden="true" />Build</button>
          <button type="button" aria-pressed={previewPressed} onClick={showPreview}><ImageIcon size={15} aria-hidden="true" />Preview</button>
          <button type="button" aria-pressed={wiringPressed} onClick={() => showCanvas('wiring')}><Cpu size={15} aria-hidden="true" />Wiring/Simulation</button>
          <button type="button" aria-pressed={section === 'code'} onClick={showCode}><Play size={15} aria-hidden="true" />Code</button>
        </div>
        <span className="hw-mode-divider" aria-hidden="true" />
        <div className="hw-more" ref={moreRef}>
          <button type="button" aria-expanded={moreOpen} aria-haspopup="menu" aria-pressed={section === 'info' || section === 'guide'} onClick={() => setMoreOpen(open => !open)}>More<ChevronDown size={14} aria-hidden="true" /></button>
          {moreOpen && <div className="hw-more-menu" role="menu" aria-label="More project sections" onClick={event => event.stopPropagation()}>
            <button type="button" role="menuitem" aria-current={section === 'info' ? 'page' : undefined} onClick={() => showMoreSection('info')}>Info</button>
            <button type="button" role="menuitem" aria-current={section === 'guide' ? 'page' : undefined} onClick={() => showMoreSection('guide')}>Build Guide</button>
          </div>}
        </div>
      </nav>}
      <div className="hw-header-tools">
        <span className="hw-header-spacer" />{project && <button type="button" className="hw-icon-button" aria-label="Project details" title="Project details and instructions" onClick={() => setDetailsOpen(true)}><ListChecks size={16} /></button>}<span className="hw-local"><span /> Local workspace</span>
        <Link to="/" className="hw-icon-button" aria-label="Back to chat"><ArrowLeft size={16} /></Link>
      </div>
    </header>
    {error && <div role="alert" className="hw-alert"><span>{error}</span>{dirty && project && <button onClick={() => { acceptProject(project, true); setError(''); setNotice('Loaded server firmware. Unsaved editor changes discarded.') }}>Load server firmware</button>}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {notice && <div role="status" className="hw-notice">{notice}</div>}
    {loading ? <WorkspaceLoading/> : !project ? <section className="flex min-h-0 flex-1 items-center justify-center p-6"><div className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6"><h1 className="text-lg font-semibold">Unable to open this project</h1><p role="alert" className="mt-3 text-sm leading-6 text-neutral-400">{loadError || 'The project could not be loaded.'}</p><p className="mt-3 text-xs leading-5 text-neutral-500">If the hardware service is unavailable, start the backend and retry. Project creation remains on the WireUp home page.</p><div className="mt-5 flex flex-wrap gap-3">{projectId && <button type="button" onClick={() => setLoadAttempt(value => value + 1)} className="rounded-lg bg-[#4a8fd9] px-4 py-2 text-sm font-medium text-white">Retry loading</button>}<Link to="/" className="rounded-lg border border-neutral-700 px-4 py-2 text-sm">Back to home</Link><Link to="/projects" className="rounded-lg border border-neutral-700 px-4 py-2 text-sm">All projects</Link></div></div></section> : <>
      <nav className="hw-mobile-tabs" aria-label="Workspace panels">{(['circuit', 'parts', 'agent'] as const).map(value => <button key={value} className={tab === value ? 'active' : ''} onClick={() => { setTab(value); if (value === 'parts') { setSection('wiring'); setComponentsOpen(true) } }}>{value === 'circuit' ? 'Canvas' : value === 'parts' ? 'Parts' : 'Agent'}</button>)}</nav>
      <div className={`hw-workbench${activeView === 'schematic' ? ' is-schematic' : ''}${componentsOpen ? '' : ' components-collapsed'}${section !== 'wiring' ? ' section-content' : ''}`} style={{ '--hw-sidebar': `${layout.sidebar}px`, '--hw-agent': `${layout.agent}px` } as CSSProperties}>
        <div className="hw-resizer hw-resizer-col" data-side="left" data-active={resizing === 'sidebar'} role="separator" aria-orientation="vertical" aria-label="Resize components panel" onPointerDown={startResize('sidebar')} />
        <div className="hw-resizer hw-resizer-col" data-side="right" data-active={resizing === 'agent'} role="separator" aria-orientation="vertical" aria-label="Resize agent panel" onPointerDown={startResize('agent')} />
        <aside id="workspace-components" className="hw-sidebar hw-parts-panel">
          <div className="hw-panel-heading"><Cpu size={15} /> Components <span>{project.components.length}</span><button aria-label="Close components panel" onClick={() => { setComponentsOpen(false); if (tab === 'parts') setTab('circuit') }}><X size={14}/></button></div>
          <label className="hw-search"><Search size={14} /><input aria-label="Search components" placeholder="Search catalog…" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <div className="hw-catalog">{categories.map(category => <details className="hw-category" key={category} open><summary>{categoryNames[category] ?? category}<span>{visibleCatalog.filter(item => (item.category ?? 'other') === category).length}</span><ChevronDown size={12} /></summary><div className="hw-category-grid">{visibleCatalog.filter(item => (item.category ?? 'other') === category).map(item => <button key={catalogType(item)} className="hw-catalog-card" aria-label={`Add ${item.name} ${item.category ?? 'component'}`} title={catalogTooltip(item, project.board)} disabled={mutationDisabled || (item.category === 'boards' && item.supported_board === false) || catalogType(item) === project.board} onClick={() => void perform('Adding component', async () => { const count = projectRef.current?.components.length ?? 0; await command('add_component', { type: catalogType(item), x: 380 + count % 3 * 110, y: 100 + Math.floor(count / 3) * 110 }, true) })}><CatalogThumbnail type={catalogType(item)} name={item.name} thumbnail={item.thumbnail} /><strong>{compactCatalogName(item.name)}</strong><Plus className="hw-card-add" size={12} /></button>)}</div></details>)}{!visibleCatalog.length && <p className="hw-catalog-empty">No components match this search.</p>}</div>
          <div className="hw-panel-heading">In this circuit</div>
          <div className="hw-component-list">{project.components.map(part => <button key={part.id} className={selected === part.id ? 'active' : ''} onClick={() => setSelected(part.id)}><Cpu size={14} /><span>{part.id}<small>{part.type}</small></span></button>)}</div>
          {selectedPart && <section className="hw-inspector"><div className="hw-panel-heading">Properties <button aria-label={`Remove ${selectedPart.id}`} disabled={mutationDisabled || selectedPart.id === 'board'} onClick={() => void perform('Removing component', async () => { await command('remove_component', { id: selectedPart.id }, true); setSelected('') })}><Trash2 size={13} /></button></div>
            <div className="hw-position">{(['x', 'y', 'rotation'] as const).map(key => <label key={key}>{key}<input aria-label={`Component ${key}`} type="number" value={position[key]} onChange={event => setPosition({ ...position, [key]: Number(event.target.value) })} /></label>)}</div>
            <textarea aria-label="Component properties JSON" value={properties} onChange={event => setProperties(event.target.value)} rows={4} spellCheck={false} />
            <button disabled={mutationDisabled} onClick={() => void perform('Updating component', async () => { const value: unknown = JSON.parse(properties); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Properties must be a JSON object.'); await command('modify_component', { id: selectedPart.id, ...position, ...containPartPosition({ ...selectedPart, rotation: position.rotation }, partSizes[selectedPart.id] ?? { width: 180, height: 160 }, position), properties: value }, true) })}><Check size={14} /> Apply properties</button>
          </section>}
          <section className="hw-wiring"><div className="hw-panel-heading">Connections <span>{project.wires.length}</span></div>
            <select aria-label="Wire from pin" value={from} onChange={event => setFrom(event.target.value)}><option value="">From pin…</option>{endpointOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            <select aria-label="Wire to pin" value={to} onChange={event => setTo(event.target.value)}><option value="">To pin…</option>{endpointOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            <div className="hw-wire-add"><input type="color" aria-label="Wire color" value={wireColor} onChange={event => setWireColor(event.target.value)} /><button disabled={mutationDisabled || !from || !to || from === to} onClick={() => void perform('Connecting wire', async () => { await command('connect_wire', { from: JSON.parse(from), to: JSON.parse(to), color: wireColor }, true); setFrom(''); setTo('') })}><Plus size={13} /> Connect</button></div>
            {project.wires.map(wire => <div className="hw-wire-row" key={wire.id}><i style={{ background: wire.color }} /><span>{wire.from.component}.{wire.from.pin}<small>→ {wire.to.component}.{wire.to.pin}</small></span><button aria-label={`Delete wire ${wire.id}`} disabled={mutationDisabled} onClick={() => void perform('Deleting wire', async () => { await command('remove_wire', { id: wire.id }, true) })}><Trash2 size={12} /></button></div>)}
          </section>
        </aside>
        <section className="hw-center" data-section={section}>
          {section === 'info' && <ProjectDetails embedded initialTab="Info" project={project} catalog={knownCatalog} onClose={() => setSection('wiring')}/>}
          {section === 'guide' && <BuildGuide project={project} dirty={dirty} busy={busy} results={results} running={!!results?.running} compileDisabled={compileDisabled} runDisabled={!!runBlocker} onOpenWiring={() => showCanvas('wiring')} onOpenCode={() => { setSection('code'); setTab('circuit') }} onCompile={compileFirmware} onRun={startSimulation} onStop={stopSimulation}/> }
          <FirmwareContainer ref={section === 'code' ? undefined : sketchDialog} className={`hw-sketch-dialog${section === 'code' ? ' hw-code-inline' : ''}`} open={section === 'code' ? undefined : false} aria-label="Sketch firmware editor" onCancel={() => setSketchOpen(false)} onClose={() => setSketchOpen(false)}><section className="hw-firmware-panel"><div className="hw-panel-heading"><Code2 size={15} /> {project.firmware.filename}<span>{dirty ? 'Unsaved edits' : `Saved · r${project.firmware.revision}`}</span><button hidden={section === 'code'} aria-label="Close Sketch" onClick={() => setSketchOpen(false)}><X size={16} /></button></div><div className="hw-code-editor"><div aria-hidden="true" className="hw-line-numbers">{source.split('\n').map((_, index) => <div key={index}>{index + 1}</div>)}</div><textarea aria-label="Firmware source" value={source} spellCheck={false} disabled={!!results?.running} onChange={event => { if (sourceRef.current === savedSource.current) draftRevision.current = projectRef.current?.revision ?? null; const next = event.currentTarget.value; sourceRef.current = next; setSource(next) }} onKeyDown={event => { if (event.key === 'Tab') { event.preventDefault(); const start = event.currentTarget.selectionStart; const end = event.currentTarget.selectionEnd; const next = source.slice(0, start) + '  ' + source.slice(end); if (sourceRef.current === savedSource.current) draftRevision.current = projectRef.current?.revision ?? null; sourceRef.current = next; setSource(next); const textarea = event.currentTarget; requestAnimationFrame(() => { textarea.setSelectionRange(start + 2, start + 2) }) } }} /></div><footer className="hw-sketch-footer"><span>Arduino C++ · Canonical server firmware</span><button aria-label="Save sketch" disabled={!!busy || !!results?.running} onClick={() => void perform('Saving firmware', async () => { await saveSource(); setSketchOpen(false); setTab('circuit'); setNotice('Firmware saved to the canonical project.') })}><Save size={14} /> Save sketch</button></footer></section></FirmwareContainer>
      <nav className="hw-toolbar" hidden={section !== 'wiring'} aria-label="Hardware actions">
        {activeView === 'circuit' && <button type="button" aria-label={componentsOpen ? 'Hide components panel' : 'Open components panel'} aria-expanded={componentsOpen} aria-controls="workspace-components" onClick={() => setComponentsOpen(open => !open)}><Cpu size={14}/>Components</button>}
        <div className="hw-view-tabs" role="tablist" aria-label="Design view"><button role="tab" aria-selected={activeView === 'circuit'} onClick={() => changeView('circuit')}><CircuitBoard size={15} /> Circuit</button><button role="tab" aria-selected={activeView === 'schematic'} onClick={() => changeView('schematic')}><Zap size={15} /> Schematic</button></div>
        <button type="button" onClick={() => setConnectionCheckOpen(true)}><Cable size={14} />Check connections</button>
        <button type="button" aria-pressed={pinLabelsOpen} onClick={() => setPinLabelsOpen(value => !value)}>Connected pins</button>
        <div className="hw-actions">
          <button type="button" aria-expanded={simulationOpen} aria-controls="workspace-simulation-tools" onClick={() => setSimulationOpen(open => !open)}><Play size={14}/>Simulation</button>
          <div id="workspace-simulation-tools" className="hw-simulation-tools" hidden={!simulationOpen}>
          {activeView === 'circuit' && analysisSlot}
          {activeView === 'circuit' && <button className="hw-sketch-button" aria-haspopup="dialog" onClick={() => { setSection('code'); setTab('circuit'); setSketchOpen(false) }}><Code2 size={15} /><span>Sketch</span>{dirty && <i className="hw-unsaved" />}</button>}
          {activeView === 'circuit' && <button className="hw-scope-button" aria-haspopup="dialog" onClick={() => { setTab('circuit'); setScopeOpen(true) }}><Waves size={15} /><span>Oscilloscope</span></button>}
          <button aria-label="Save" disabled={!!busy || !!results?.running} onClick={() => void perform('Saving firmware', async () => { await saveSource(); setNotice('Firmware saved to the canonical project.') })}><Save size={15} /><span>Save</span>{dirty && <i className="hw-unsaved" />}</button>
          <button aria-label="Undo last change" disabled={mutationDisabled || !project.history.length} onClick={() => void perform('Undoing', async () => { await command('undo', {}, true) })}><Undo2 size={15} /></button>
          <button disabled={compileDisabled} onClick={() => void compileFirmware()}><Wrench size={15} /><span>{busy === 'Compiling firmware' ? 'Compiling…' : 'Compile'}</span></button>
          {results?.running ? <button className="hw-stop" disabled={!!busy || (results.engine !== 'qemu-native' && connection !== 'Connected')} onClick={() => void stopSimulation()}><Square size={14} fill="currentColor" /> Stop</button> : <button className="hw-primary" title={runBlocker || (selectedBoard?.simulation === 'native' ? 'Run compiled firmware in native ESP32 QEMU' : 'Run compiled firmware in the browser emulator')} disabled={!!runBlocker} onClick={() => void startSimulation()}><Play size={14} fill="currentColor" /> Run</button>}
          </div>
        </div>
      </nav>
      {!results?.running && runBlocker && <div role="status" className="hw-notice">{runBlocker}{connection !== 'Connected' && project?.board !== 'unselected' && selectedBoard?.simulation === 'browser' && <button className="ml-3 underline" onClick={() => setSession(value => value + 1)}>Reconnect runtime</button>}</div>}

          <div className="hw-design-surface" hidden={section !== 'wiring'}>
          <div className="hw-circuit-panel" hidden={activeView !== 'circuit'}>
            {!project.components.length && <p className="p-4 text-center text-xs text-neutral-400">Your canvas is empty. Describe your project and answer the questions; the agent will select and place the board after confirmation.</p>}
            {unresolvedWires.length > 0 && <p className="hw-notice" role="status">{unresolvedWires.length} connection(s) are saved but their component pin layout is not ready. {unresolvedWires.map(wire => `${wire.from.component}.${wire.from.pin} → ${wire.to.component}.${wire.to.pin}`).join('; ')}</p>}
            <div className="hw-canvas-viewport" ref={canvasViewport} role="region" tabIndex={0} aria-label="Circuit canvas" onPointerDown={event => { if (!(event.target as Element).closest('.hw-canvas-part, .hw-part-actions')) hideActions() }} onKeyDown={event => { if (event.key === 'Escape') hideActions() }}><div className="hw-canvas" style={{ width: canvasExtent.width * zoom, height: canvasExtent.height * zoom }}><div className="hw-canvas-world" style={{ width: canvasExtent.width, height: canvasExtent.height, transform: `scale(${zoom})` }}><div className="hw-canvas-content" style={{ left: canvasExtent.offsetX, top: canvasExtent.offsetY }}>
              <svg className="hw-wires" width={canvasExtent.width} height={canvasExtent.height} aria-label="Circuit wires">{project.wires.map(wire => { const start = pinPosition(wire.from); const end = pinPosition(wire.to); if (!start || !end) return null; const path = routedPaths.get(wire.id); if (!path) return null; return <g key={wire.id}><path d={path} stroke={wire.color} fill="none" strokeWidth={wireDetails?.id === wire.id ? 5 : 3} pointerEvents="none"/><path className="hw-wire-hit" d={path} stroke="transparent" fill="none" strokeWidth="14" tabIndex={0} role="button" aria-label={`Inspect wire ${wire.from.component}.${wire.from.pin} to ${wire.to.component}.${wire.to.pin}`} onClick={event => { event.stopPropagation(); setWireDetails({id:wire.id,x:(start.x+end.x)/2,y:(start.y+end.y)/2}) }} onKeyDown={event => { if(event.key==='Enter'||event.key===' '){event.preventDefault();setWireDetails({id:wire.id,x:(start.x+end.x)/2,y:(start.y+end.y)/2})} }}/>{wireDetails?.id === wire.id && [wire.from,wire.to].map((_,index) => {const point=index===0?start:end;return <g key={index} pointerEvents="none"><circle cx={point.x} cy={point.y} r="8" fill="#0e1722" stroke="#c0e2ff" strokeWidth="2"/><circle cx={point.x} cy={point.y} r="3" fill={wire.color}/></g>})}</g> })}
                {pinLabelsOpen && selectedIsBoard && [...new Map(project.wires.flatMap(wire => [wire.from, wire.to]).filter(endpoint => endpoint.component === selected).map(endpoint => [`${endpoint.component}.${endpoint.pin}`, endpoint])).values()].map(endpoint => {
                  const point = pinPosition(endpoint);
                  return point ? <circle key={endpoint.pin} className="hw-connected-pin-dot" cx={point.x} cy={point.y} r="5.5" fill="#f5c84b" stroke="#171717" strokeWidth="2"><title>{endpoint.component} · Pin {endpoint.pin}</title></circle> : null;
                })}
              </svg>
              {wireDetails && project.wires.some(wire => wire.id === wireDetails.id) && <div className="hw-wire-details" role="dialog" aria-label="Wire connection details" style={{left:Math.min(730,Math.max(10,wireDetails.x)),top:Math.min(490,Math.max(35,wireDetails.y))}}><header><strong>Wire connection</strong><button aria-label="Close wire details" onClick={() => setWireDetails(null)}><X size={14}/></button></header>{project.wires.filter(wire=>wire.id===wireDetails.id).map(wire=><div key={wire.id}><p><small>From</small><strong>{wire.from.component}</strong><span>Pin {wire.from.pin}</span><button onClick={() => revealPin(wire.from)} aria-label={`Show ${wire.from.component} pin ${wire.from.pin}`}>Show pin</button></p><p><small>To</small><strong>{wire.to.component}</strong><span>Pin {wire.to.pin}</span><button onClick={() => revealPin(wire.to)} aria-label={`Show ${wire.to.component} pin ${wire.to.pin}`}>Show pin</button></p><small>{wire.id}</small></div>)}</div>}
              {project.components.map(part => <div key={part.id} ref={selected === part.id ? selectedElement : undefined} className={`hw-canvas-part ${selected === part.id ? 'selected' : ''}${dragPreview?.id === part.id ? ' is-dragging' : ''}`} style={{ left: displayedPart(part).x, top: displayedPart(part).y, transform: `rotate(${part.rotation}deg)` }} onPointerEnter={event => { if (event.pointerType === 'mouse') { cancelActionHide(); setActionPartId(part.id); setActionsPinned(false) } }} onPointerLeave={leaveActions} onClick={() => { cancelActionHide(); setSelected(part.id); setActionPartId(part.id); setActionsPinned(true) }}>
                <button className="hw-part-handle" aria-label={`Select ${part.id}`} onFocus={() => { cancelActionHide(); setActionPartId(part.id) }} onPointerDown={event => startPartDrag(part, event)}>{part.id}</button>
                <HardwarePart part={part} runtime={runtime} pinsChanged={pinsChanged} sizeChanged={sizeChanged} />
                {(pins[part.id] ?? []).filter(pin => catalogPins(catalogFor(part)).includes(pin.name) && pin.x !== undefined && pin.y !== undefined).map(pin => <button key={pin.name} title={`${part.id}.${pin.name}`} aria-label={`Connect ${part.id} pin ${pin.name}`} className={`hw-pin ${wireStart?.component === part.id && wireStart.pin === pin.name ? 'active' : ''}`} style={{ left: pin.x, top: pin.y }} disabled={mutationDisabled} onClick={event => { event.stopPropagation(); choosePin({ component: part.id, pin: pin.name }) }} />)}
              </div>)}
              {actionPart && selectedActionsPosition && <div className="hw-part-actions" role="toolbar" aria-label={`Actions for ${actionPart.id}`} style={selectedActionsPosition} onPointerEnter={cancelActionHide} onPointerLeave={leaveActions} onFocus={cancelActionHide} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) leaveActions() }}>
                {actionPart.id === 'board' && project.board.startsWith('esp32') && <button aria-label="Simulated Wi-Fi settings" onClick={() => setNetworkOpen(true)}><Wifi size={14}/></button>}
                <button aria-label={`Rotate ${actionPart.id}`} title="Rotate 90°" disabled={mutationDisabled || !!dragPreview} onClick={() => void perform('Rotating component', async () => { await command('modify_component', { id: actionPart.id, rotation: (actionPart.rotation + 90) % 360, ...containPartPosition({ ...actionPart, rotation: (actionPart.rotation + 90) % 360 }, partSizes[actionPart.id] ?? { width: 180, height: 160 }, actionPart) }, true) })}><RotateCw size={14} /></button>
                <button aria-label={`Duplicate ${actionPart.id}`} title={actionIsBoard ? 'The backend supports one project board only' : 'Duplicate component'} disabled={mutationDisabled || !!dragPreview || !!actionIsBoard} onClick={() => void perform('Duplicating component', async () => { const value = await command('add_component', { type: actionPart.type, x: actionPart.x + 30, y: actionPart.y + 30, rotation: actionPart.rotation, properties: actionPart.properties }, true); if (isHardwareProject(value)) { const added = value.components.find(part => !project.components.some(previous => previous.id === part.id)); if (added) setSelected(added.id) } })}><Copy size={14} /></button>
                <button aria-label={`Delete ${actionPart.id}`} title={actionPart.id === 'board' ? 'The project board cannot be removed' : 'Delete component'} disabled={mutationDisabled || !!dragPreview || actionPart.id === 'board'} onClick={() => void perform('Removing component', async () => { await command('remove_component', { id: actionPart.id }, true); setSelected(''); hideActions() })}><Trash2 size={14} /></button>
                <button aria-label={`Properties for ${actionPart.id}`} title="Edit properties" onClick={() => { setSelected(actionPart.id); setTab('parts'); requestAnimationFrame(() => { document.querySelector<HTMLElement>('.hw-inspector')?.scrollIntoView({ block: 'nearest' }); document.querySelector<HTMLTextAreaElement>('.hw-inspector textarea')?.focus({ preventScroll: true }) }) }}><Wrench size={14} /></button>
              </div>}
            </div></div></div></div>
            <div className="hw-canvas-hint">{wireStart ? <><Zap size={12} /> Select a second pin to connect <button onClick={() => setWireStart(null)}>Cancel</button></> : <><Zap size={12} /> Drag component labels to move · Click verified pins to wire</>}<span>Uno · 16 MHz</span></div>
          </div>
          <section className="hw-schematic-panel" hidden={activeView !== 'schematic'} aria-label="Schematic view">{schematicSlot ?? <div className="hw-schematic-empty"><CircuitBoard size={30} /><h2>Schematic view</h2><p>The schematic renderer is supplied by the host application. Your canonical circuit and connections are unchanged.</p></div>}</section>
          {activeView === 'circuit' && <div className="hw-floating-tools" aria-label="Canvas controls"><button aria-label="Zoom out" onClick={() => setZoom(value => Math.max(.25, value - .1))}><Minus size={15} /></button><button aria-label="Reset zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button aria-label="Zoom in" onClick={() => setZoom(value => Math.min(2, value + .1))}><Plus size={15} /></button><i /><button aria-label="Fit circuit" onClick={fitCanvas}><Maximize size={15} /></button><button aria-label="Reset canvas view" onClick={() => { setZoom(1); canvasViewport.current?.scrollTo({ left: 0, top: 0 }) }}><RefreshCw size={15} /></button><span className={results?.running ? 'hw-running' : ''}>{results?.running ? '● Running' : '○ Stopped'}</span></div>}
          </div>

          <dialog ref={scopeDialog} className="hw-scope-dialog" aria-label="Oscilloscope" onCancel={() => setScopeOpen(false)} onClose={() => setScopeOpen(false)}><div className="hw-panel-heading"><Waves size={16} /> Oscilloscope<button aria-label="Close Oscilloscope" onClick={() => setScopeOpen(false)}><X size={16} /></button></div>{oscilloscopeSlot ?? <div className="hw-schematic-empty"><Waves size={30} /><h2>Runtime instruments</h2><p>The host application provides the oscilloscope instrument. Real GPIO snapshots are available in Results.</p></div>}</dialog>
          <section className="hw-dock" data-open={consoleOpen} style={{ '--hw-dock': `${layout.dock}px` } as CSSProperties}>{consoleOpen && <div className="hw-resizer hw-resizer-row" data-active={resizing === 'dock'} role="separator" aria-orientation="horizontal" aria-label="Resize console height" onPointerDown={startResize('dock')} />}<nav aria-label="Output panels">{(['compiler', 'serial', 'results', 'tools'] as const).map(value => <button key={value} aria-expanded={consoleOpen && dock === value} className={consoleOpen && dock === value ? 'active' : ''} onClick={() => { setDock(value); setConsoleOpen(true) }}>{value === 'serial' ? <Terminal size={13} /> : value === 'compiler' ? <Wrench size={13} /> : value === 'results' ? <Zap size={13} /> : <Cpu size={13} />}{value === 'compiler' ? 'Compiler' : value === 'serial' ? 'Serial monitor' : value === 'results' ? 'Results' : 'Tools'}</button>)}<button className="hw-connect-board" disabled={!!busy || project.board === 'unselected' || project.board.startsWith('raspberry-pi-') || project.board === 'pi-pico' || project.board === 'pi-pico-w'} onClick={() => setFlashOpen(true)}><Cable size={13}/>Connect board &amp; flash</button>{connection !== 'Connected' && <button onClick={() => setSession(value => value + 1)} disabled={!!busy}>Reconnect</button>}<span className="hw-dock-status"><span title={`Project r${project.revision} · ${dirty ? 'Unsaved editor changes' : 'Server saved'}`}>Runtime: {connection}</span>{busy && <LoaderCircle size={12} className="hw-spin" />}{busy || compiler?.status?.replaceAll('_', ' ') || 'Not compiled'}</span><button className="hw-console-collapse" aria-label={consoleOpen ? 'Collapse console' : 'Expand console'} aria-expanded={consoleOpen} onClick={() => setConsoleOpen(!consoleOpen)}><ChevronDown size={14} /></button></nav>
            {consoleOpen && dock === 'compiler' && <div className="hw-dock-body"><div className="hw-output-actions"><button disabled={!!busy} onClick={() => void perform('Reading compiler errors', async () => { setCompiler(await command('read_compiler_errors') as CompilerResult) })}><RefreshCw size={12} /> Read diagnostics</button>{compiler?.artifact?.url && <a href={compiler.artifact.url} download>Download {compiler.artifact.format === 'hex' ? 'HEX' : 'BIN'}</a>}</div><pre>{compiler ? [compiler.stdout, compiler.stderr, ...(compiler.errors ?? []).map(value => typeof value === 'string' ? value : JSON.stringify(value))].filter(Boolean).join('\n') || compiler.status : 'Ready when you are. Compile your sketch to create real Arduino firmware.\nCompilation does not start the simulator.'}</pre></div>}
            {consoleOpen && dock === 'serial' && <div className="hw-dock-body"><pre aria-label="Serial output">{results?.serial || 'No serial output yet. Your sketch must call Serial.begin() and Serial.print().'}</pre><form className="hw-serial-send" onSubmit={event => { event.preventDefault(); const data = serialInput + '\n'; if (results?.engine === 'qemu-native' && results.run_id && projectRef.current) { void perform('Sending UART input', async () => { await hardwareApi.nativeSerial(projectRef.current!, results.run_id!, data); setSerialInput('') }) } else { try { runtime?.sendSerial(data); setSerialInput('') } catch (error) { setError((error as Error).message) } } }}><input aria-label="Serial input" value={serialInput} placeholder="Send to UART…" onChange={event => setSerialInput(event.target.value)} /><button disabled={!results?.running || !serialInput}>Send</button></form></div>}
            {consoleOpen && dock === 'results' && <div className="hw-dock-body"><div className="hw-output-actions"><button disabled={!!busy || (selectedBoard?.simulation !== 'native' && connection !== 'Connected')} onClick={() => void perform('Reading simulation results', async () => { const value = await command('read_simulation_results', results?.engine === 'qemu-native' ? { run_id: results.run_id } : {}) as { result: RuntimeResults | NativeEsp32State }; if (value.result) { if ('runtime' in value.result && value.result.runtime === 'qemu-native') acceptNativeState(value.result); else setResults(value.result as RuntimeResults) } })}><RefreshCw size={12} /> Read runtime</button><span>{results?.cycles.toLocaleString() ?? '0'} cycles · {(results?.simulated_ms ?? 0).toFixed(1)} ms simulated</span></div><div className="hw-pin-results">{Object.entries(results?.pins ?? {}).map(([pin, value]) => <span key={pin} data-level={value.level === true ? 'high' : value.level === false ? 'low' : 'floating'}>{pin}<b>{value.level === null ? '—' : value.level ? 'HIGH' : 'LOW'}</b></span>)}</div><p className="hw-runtime-limit">{results?.limitations.join(' ') ?? 'Real Velxio board CPU / UART / GPIO. Runtime-specific peripheral support is reported after simulation starts. No analog-current measurements are claimed.'}</p>{results?.support_warnings?.map(warning => <p className="hw-runtime-limit" key={warning}>{warning}</p>)}</div>}
            {consoleOpen && dock === 'tools' && <div className="hw-dock-body"><div className="hw-manual-tools"><button disabled={!!busy} onClick={() => void perform('Reading project', async () => { const value = await command('read_project'); setToolOutput(JSON.stringify(value, null, 2)) })}>Read project</button><button disabled={!!busy} onClick={() => void perform('Reading firmware', async () => { const value = await command('read_firmware') as Firmware; setToolOutput(JSON.stringify(value, null, 2)) })}>Read firmware</button><button disabled={!!busy || !!results?.running} onClick={() => void perform('Generating firmware', async () => { const current = projectRef.current!; const next = await hardwareApi.command<HardwareProject>(current, 'generate_firmware', { source: sourceRef.current, expected_revision: dirty ? draftRevision.current ?? current.revision : current.revision }); acceptProject(next, true); setNotice('Current editor source stored through generate_firmware.') })}>Generate from editor</button><button disabled={!!busy} onClick={() => void perform('Searching components', async () => { const value = await command('search_components', { query, limit: 50 }); setToolOutput(JSON.stringify(value, null, 2)) })}>Search catalog</button></div><form className="hw-calculator" onSubmit={event => { event.preventDefault(); void perform('Calculating', async () => { const value = await command('calculator', { expression }); setToolOutput(JSON.stringify(value, null, 2)) }) }}><input aria-label="Calculator expression" value={expression} onChange={event => setExpression(event.target.value)} placeholder="(5 - 2) / 0.02" /><button disabled={!!busy || !expression}>Calculate</button></form><pre aria-label="Tool result">{toolOutput || 'All manual tools use the same canonical backend service as the agent.'}</pre></div>}
          </section>
        </section>
        <aside className="hw-agent-panel">{!agent && <div className="hw-panel-heading"><Zap size={15} /> WireUp agent</div>}{agent ?? <div className="hw-agent-empty"><div className="hw-agent-symbol"><Zap size={24} /></div><h2>A collaborator for your circuit.</h2><p>Ask the project agent to add parts, write firmware, and inspect the real compiler and simulator.</p><div className="hw-agent-context"><Cpu size={14} /> {project.name}<small>Canonical project · revision {project.revision}</small></div><p className="hw-muted">The agent panel is supplied by the host application. Manual tools remain available below the editor.</p></div>}</aside>
      </div>
      {connectionCheckOpen && <ConnectionCheck key={project.id} project={project} dirty={dirty} repairDisabled={mutationDisabled} onProjectChange={acceptProject} onClose={() => setConnectionCheckOpen(false)} onShowPart={id => { setConnectionCheckOpen(false); setSection('wiring'); setTab('circuit'); setSelected(id); const endpoint = project.wires.flatMap(wire => [wire.from, wire.to]).find(endpoint => endpoint.component === id); if (endpoint) revealPin(endpoint) }}/>}
      {detailsOpen && <ProjectDetails project={project} catalog={knownCatalog} onClose={() => setDetailsOpen(false)} onOpenPart={id => { setDetailsOpen(false); setSection('wiring'); setTab('parts'); setComponentsOpen(true); setSelected(id); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.hw-inspector textarea')?.focus()) }} onOpenWiring={() => { setDetailsOpen(false); showCanvas('wiring') }} onOpenCode={() => { setDetailsOpen(false); setSection('code'); setTab('circuit') }}/>}
      {networkOpen && <EspNetworkDialog projectId={project.id} board={project.board} running={!!results?.running} onClose={() => setNetworkOpen(false)}/>}
      {flashOpen && <BoardFlashDialog project={project} dirty={dirty} running={!!results?.running} onClose={() => setFlashOpen(false)}/>}

    </>}
  </main>
}
