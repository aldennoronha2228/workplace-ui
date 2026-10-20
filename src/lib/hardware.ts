export type HardwarePin = { name: string; x?: number; y?: number }
export type HardwareComponent = {
  id: string; type: string; x: number; y: number; rotation: number; properties: Record<string, unknown>
}
export type WireEndpoint = { component: string; pin: string }
export type HardwareWire = { id: string; from: WireEndpoint; to: WireEndpoint; color: string }
export type Firmware = { filename: string; source: string; revision: number }
export type HardwareArtifact = {
  id: string; format: string; board: string; source_revision: number; project_revision: number
  hex?: string; bin?: string; encoding?: string; load_address?: number; size_bytes?: number
  chip?: string; image_kind?: string; flash_size_bytes?: number; url?: string
}
export type CompilerResult = {
  status: string; source_revision?: number; project_revision?: number; stdout?: string; stderr?: string
  errors?: unknown[]; artifact?: HardwareArtifact | null; source?: string
}
export type HardwareProject = {
  id: string; schema_version: number; revision: number; name: string; board: string
  components: HardwareComponent[]; wires: HardwareWire[]; firmware: Firmware
  history: { revision: number; operation: string }[]; compiler: CompilerResult | null
  runtime_token: string; created_at: string; updated_at: string
}
export type HardwareProjectSummary = Pick<HardwareProject, 'id' | 'name' | 'board' | 'revision' | 'created_at' | 'updated_at'>
export type CatalogComponent = {
  id?: string; type?: string; name: string; category?: string; description?: string; thumbnail?: string; tagName?: string
  pins?: (string | HardwarePin)[]; connectable?: boolean; simulation_supported?: boolean; simulation_boards?: string[]; simulation_scope?: string; spice_model?: string
  properties?: unknown; defaultValues?: Record<string, unknown>; supported_board?: boolean; schematic_only?: boolean; compile?: boolean; compile_timeout_seconds?: number; simulation?: string; unavailable_reason?: string
}
export type HardwareCommand = 'route_breadboard' | 'check_connections'
  | 'read_project' | 'search_components' | 'add_component' | 'remove_component' | 'modify_component'
  | 'connect_wire' | 'remove_wire' | 'generate_firmware' | 'read_firmware' | 'edit_firmware'
  | 'compile_firmware' | 'run_simulation' | 'stop_simulation' | 'read_simulation_results'
  | 'read_compiler_errors' | 'calculator' | 'undo'

export class HardwareApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'HardwareApiError'
    this.status = status
  }
}

export type HardwareRequestOptions = { signal?: AbortSignal; compileTimeoutSeconds?: number }

export function createRequestSignal(timeoutMs: number, signal?: AbortSignal | null) {
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return
    timedOut = true
    controller.abort(new DOMException('Hardware request timed out.', 'TimeoutError'))
  }, timeoutMs)
  return {
    signal: controller.signal,
    get timedOut() { return timedOut },
    dispose: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) },
  }
}

export function hardwareCommandTimeoutMs(board: string | undefined, name: HardwareCommand, compileTimeoutSeconds?: number): number {
  if (name === 'run_simulation' && (board === 'esp32-c3' || board === 'esp32-s3')) return 100_000
  if (name !== 'compile_firmware') return 15_000
  const boardTimeout = board?.startsWith('esp32') || board?.startsWith('xiao-esp32') ? 600
    : board === 'pi-pico' || board === 'pi-pico-w' ? 300 : 90
  const seconds = typeof compileTimeoutSeconds === 'number' && Number.isFinite(compileTimeoutSeconds) && compileTimeoutSeconds > 0 ? compileTimeoutSeconds : boardTimeout
  return Math.min(seconds + 30, 660) * 1000
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 15_000, operation = 'Hardware request'): Promise<T> {
  const deadline = createRequestSignal(timeoutMs, init?.signal)
  try {
    const response = await fetch(`/api/hardware${path}`, {
      ...init, signal: deadline.signal, headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    const body = await response.json().catch(() => null)
    deadline.signal.throwIfAborted()
    if (!response.ok) {
      const detail = typeof body?.detail === 'string' ? body.detail : `Hardware request failed (${response.status}).`
      throw new HardwareApiError(detail, response.status)
    }
    if (body === null) throw new HardwareApiError('Hardware server returned an invalid response.', response.status)
    return body as T
  } catch (error) {
    if (deadline.timedOut) throw new HardwareApiError(`${operation} timed out after ${timeoutMs / 1000} seconds. Check the hardware service and retry. The server operation may still be in progress.`, 408)
    if (deadline.signal.aborted) throw deadline.signal.reason
    if (error instanceof HardwareApiError) throw error
    throw new HardwareApiError('Unable to reach the hardware service. Check your connection and retry.', 0)
  } finally { deadline.dispose() }
}

export const hardwareApi = {
  listProjects: (options: HardwareRequestOptions = {}) => request<{ projects: HardwareProjectSummary[] }>('/projects', { signal: options.signal }),
  createProject: (name: string, options: HardwareRequestOptions = {}) => request<HardwareProject>('/projects', {
    method: 'POST', body: JSON.stringify({ name, board: 'unselected' }), signal: options.signal,
  }),
  deleteProject: (id: string, options: HardwareRequestOptions = {}) => request<{ deleted: string }>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE', signal: options.signal }),
  getProject: (id: string, options: HardwareRequestOptions = {}) => request<HardwareProject>(`/projects/${encodeURIComponent(id)}`, { signal: options.signal }, 15_000, 'Project read'),
  catalog: (query = '', limit = 200, options: HardwareRequestOptions = {}) => request<{ components: CatalogComponent[]; boards: CatalogComponent[] }>(
    `/catalog?q=${encodeURIComponent(query)}&limit=${limit}`, { signal: options.signal },
  ),
  command: <T = HardwareProject>(project: Pick<HardwareProject, 'id' | 'runtime_token'> & Partial<Pick<HardwareProject, 'board'>>, name: HardwareCommand, args: Record<string, unknown> = {}, options: HardwareRequestOptions = {}) =>
    request<T>(`/project/${encodeURIComponent(project.id)}/command`, {
      method: 'POST', body: JSON.stringify({ name, args, runtime_token: project.runtime_token }), signal: options.signal,
    }, hardwareCommandTimeoutMs(project.board, name, options.compileTimeoutSeconds), `Hardware ${name.replaceAll('_', ' ')}`),
  nativeSerial: (project: HardwareProject, runId: string, data: string, options: HardwareRequestOptions = {}) =>
    request<{ bytes_written: number }>(`/projects/${encodeURIComponent(project.id)}/native/serial`, {
      method: 'POST', signal: options.signal, body: JSON.stringify({
        runtime_token: project.runtime_token,
        expected_revision: project.revision,
        source_revision: project.firmware.revision,
        run_id: runId,
        data,
      }),
    }, 15_000, 'Native ESP32 UART write'),
  nativeGpio: (project: HardwareProject, runId: string, pin: number, level: boolean, options: HardwareRequestOptions = {}) =>
    request<{ pin: number; level: boolean }>(`/projects/${encodeURIComponent(project.id)}/native/gpio`, {
      method: 'POST', signal: options.signal, body: JSON.stringify({
        runtime_token: project.runtime_token,
        expected_revision: project.revision,
        source_revision: project.firmware.revision,
        run_id: runId,
        pin,
        level,
      }),
    }, 15_000, 'Native ESP32 GPIO input'),
}

export function catalogType(component: CatalogComponent): string {
  return component.type ?? component.id ?? ''
}

export function catalogPins(component?: CatalogComponent): string[] {
  if (component?.connectable === false) return []
  return (component?.pins ?? []).map(pin => typeof pin === 'string' ? pin : pin.name).filter(Boolean)
}

export function isHardwareProject(value: unknown): value is HardwareProject {
  return !!value && typeof value === 'object' && 'id' in value && 'components' in value && 'firmware' in value && 'revision' in value
}

export function artifactIsCurrent(project: HardwareProject): boolean {
  const artifact = project.compiler?.artifact
  return project.compiler?.status === 'simulation_ready' && !!artifact &&
    artifact.source_revision === project.firmware.revision && artifact.board === project.board
}

export function runtimeUrl(project: Pick<HardwareProject, 'id' | 'runtime_token'>): string {
  const url = new URL(`/api/hardware/project/${encodeURIComponent(project.id)}/runtime`, window.location.href)
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('token', project.runtime_token)
  return url.toString()
}
