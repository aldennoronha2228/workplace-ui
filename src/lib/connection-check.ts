import { createRequestSignal, HardwareApiError } from './hardware'
import type { HardwareProject, WireEndpoint } from './hardware'

export type ConnectionFinding = {
  code: string
  message: string
  evidence: {
    component_id?: string
    component_ids?: string[]
    wire_id?: string
    wire_ids?: string[]
    endpoints?: WireEndpoint[]
    [key: string]: unknown
  }
}
export type ConnectionNet = {
  id: string
  endpoints: WireEndpoint[]
  wire_ids: string[]
  rails?: string[]
}
export type ConnectionValidation = {
  project_id: string
  revision: number
  valid: boolean
  errors: ConnectionFinding[]
  warnings: ConnectionFinding[]
  nets: ConnectionNet[]
  scope: string
}
export type ConnectionRepair = {
  operation: string
  wire_id: string
  wire_index?: number
  retained_wire_id?: string
  from?: WireEndpoint
  to?: WireEndpoint
}
export type ConnectionCheckResult = {
  project: HardwareProject
  validation: ConnectionValidation
  before: ConnectionValidation
  recheck: ConnectionValidation | null
  changed: boolean
  repairs: ConnectionRepair[]
  proposed_repairs: ConnectionRepair[]
  status: string
}

type CheckProject = Pick<HardwareProject, 'id' | 'runtime_token'>

async function command<T>(project: CheckProject, name: 'check_connections', args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const deadline = createRequestSignal(15_000, signal)
  try {
    const response = await fetch(`/api/hardware/project/${encodeURIComponent(project.id)}/command`, {
      method: 'POST', signal: deadline.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args, ...(args.repair ? { runtime_token: project.runtime_token } : {}) }),
    })
    const body = await response.json().catch(() => null)
    deadline.signal.throwIfAborted()
    if (!response.ok) {
      throw new HardwareApiError(typeof body?.detail === 'string' ? body.detail : `Connection request failed (${response.status}).`, response.status)
    }
    if (!body || typeof body !== 'object') throw new HardwareApiError('The connection service returned an invalid response.', response.status)
    return body as T
  } catch (error) {
    if (deadline.timedOut) throw new HardwareApiError('Connection request timed out. Recheck before retrying a repair; the server operation may still be in progress.', 408)
    if (deadline.signal.aborted) throw deadline.signal.reason
    if (error instanceof HardwareApiError) throw error
    throw new HardwareApiError('Unable to reach the connection service. Check your connection and try again.', 0)
  } finally { deadline.dispose() }
}

export const connectionCheckApi = {
  check: (project: CheckProject, signal?: AbortSignal) => command<ConnectionCheckResult>(project, 'check_connections', {}, signal),
  repair: (project: CheckProject, expectedRevision: number, signal?: AbortSignal) =>
    command<ConnectionCheckResult>(project, 'check_connections', { repair: true, expected_revision: expectedRevision }, signal),
}
