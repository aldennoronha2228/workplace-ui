import { createRequestSignal, HardwareApiError } from './hardware'
import type { HardwareProject } from './hardware'

export type BuildGuideCheck = { id: string; label: string; display_label?: string }
export type BuildGuideItem = string | Record<string, unknown>
export type BuildGuideSection = { title: string; paragraphs: string[]; actions: string[] }
export type BuildGuideStep = {
  id: string
  stage: string | number
  title: string
  objective: string
  instructions: string[]
  sections?: BuildGuideSection[]
  why: string
  components: BuildGuideItem[]
  pins: BuildGuideItem[]
  warnings: string[]
  checklist: BuildGuideCheck[]
  dependency_fingerprint: string
}
export type BuildGuideEvidence = {
  status: string
  scope: string
  details: unknown
  checked_at?: string | null
  [key: string]: unknown
}
export type BuildGuideProgress = {
  revision: number
  current_step: string
  checks: Record<string, { confirmed: boolean; outdated: boolean; confirmed_at?: string | null }>
  outdated_steps: Record<string, string>
  evidence: Record<string, BuildGuideEvidence>
}
export type BuildGuideDocument = {
  schema_version: number
  version: string
  project_id: string
  project_revision: number
  firmware_revision: number
  steps: BuildGuideStep[]
  progress: BuildGuideProgress
}
export type BuildGuideVerification = 'connections' | 'compilation' | 'simulation'
export type BuildGuideProgressUpdate = {
  current_step?: string
  check_id?: string
  confirmed?: boolean
  checks?: Record<string, boolean>
}
type GuideProject = Pick<HardwareProject, 'id' | 'runtime_token'>

async function request<T>(id: string, suffix = '', init: RequestInit = {}): Promise<T> {
  const deadline = createRequestSignal(15_000, init.signal)
  try {
    const response = await fetch(`/api/hardware/projects/${encodeURIComponent(id)}/build-guide${suffix}`, {
      ...init,
      signal: deadline.signal,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    })
    const body = await response.json().catch(() => null)
    deadline.signal.throwIfAborted()
    if (!response.ok) {
      const detail = typeof body?.detail === 'string' ? body.detail : `Build guide request failed (${response.status}).`
      throw new HardwareApiError(detail, response.status)
    }
    if (!body || typeof body !== 'object') throw new HardwareApiError('The build guide service returned an invalid response.', response.status)
    return body as T
  } catch (error) {
    if (deadline.timedOut) throw new HardwareApiError('The build guide request timed out. Reload to check the saved progress before trying again.', 408)
    if (deadline.signal.aborted) throw deadline.signal.reason
    if (error instanceof HardwareApiError) throw error
    throw new HardwareApiError('Unable to reach the build guide service. Check your connection and retry.', 0)
  } finally { deadline.dispose() }
}

export const buildGuideApi = {
  get: (id: string, signal?: AbortSignal) => request<BuildGuideDocument>(id, '', { signal }),
  updateProgress: (project: GuideProject, guide: BuildGuideDocument, update: BuildGuideProgressUpdate, signal?: AbortSignal) =>
    request<BuildGuideDocument>(project.id, '/progress', {
      method: 'PATCH', signal,
      body: JSON.stringify({
        runtime_token: project.runtime_token, version: guide.version, expected_progress_revision: guide.progress.revision,
        ...(update.current_step !== undefined ? { current_step: update.current_step } : {}),
        checks: update.checks ?? (update.check_id !== undefined ? { [update.check_id]: update.confirmed } : {}),
      }),
    }),
  verify: (project: GuideProject, guide: BuildGuideDocument, check: BuildGuideVerification, signal?: AbortSignal) =>
    request<BuildGuideDocument>(project.id, '/verify', {
      method: 'POST', signal,
      body: JSON.stringify({
        runtime_token: project.runtime_token, version: guide.version, expected_progress_revision: guide.progress.revision,
        checks: [check === 'connections' ? 'topology' : check === 'compilation' ? 'compile' : check],
      }),
    }),
}
