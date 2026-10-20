import { readActivityStream } from './agent-activity'
import type { FeasibilityReport } from '@/components/ui/feasibility-card'
import type { ModelProvider } from '@/lib/model-selection'
import type { ProjectQuestions } from '@/components/ui/project-questions'
import type { ActivityBlock } from '@/components/ui/agent-activity-feed'

export type Message = {
  run?: { status: string; reason?: string; changes?: Record<string, number>; toolCalls?: number; modelCalls?: number; successfulTools?: Record<string, number> }
  hidden?: boolean
  approval?: { assessment_id: string; choice: string }
  blocks?: ActivityBlock[]
  questions?: ProjectQuestions
  feasibility?: FeasibilityReport
  feasibilityChoice?: string
  id: string
  role: 'user' | 'assistant'
  content: string
  status?: 'streaming' | 'done' | 'error' | 'stopped'
  error?: string
  startedAt?: number
  elapsedMs?: number
  model?: string
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number; output_token_details?: { reasoning?: number } }
}
export type ChatEvent = { changes?: Record<string, number>; toolCalls?: number; modelCalls?: number; successfulTools?: Record<string, number>; id?: string; project_id?: string; revision?: number; issues?: FeasibilityReport['issues']; choices?: FeasibilityReport['choices']; questions?: ProjectQuestions['questions']; summary?: string; status?: string; reason?: string; type: string; text?: string; message?: string; model?: string; elapsedMs?: number; usage?: Message['usage'] | null }
export type Conversation = { id: string; title: string; messages: Message[]; updatedAt: number; requirements?: Record<string, string>; projectId?: string }
export const storageKey = 'wireup.chats.v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasStrings(value: Record<string, unknown>, keys: string[], optional = false): boolean {
  return keys.every(key => (optional && value[key] === undefined) || typeof value[key] === 'string')
}

function isChoice(value: unknown): boolean {
  return isRecord(value) && hasStrings(value, ['id', 'label']) && hasStrings(value, ['description'], true)
}

export function isQuestions(value: unknown): value is ProjectQuestions {
  return isRecord(value) && typeof value.summary === 'string' && Array.isArray(value.questions) && value.questions.every(question =>
    isRecord(question) && hasStrings(question, ['id', 'question']) && Array.isArray(question.options) && question.options.every(isChoice))
}

export function isFeasibility(value: unknown): value is FeasibilityReport {
  return isRecord(value) && hasStrings(value, ['id', 'status']) && hasStrings(value, ['project_id', 'summary'], true)
    && (value.revision === undefined || (typeof value.revision === 'number' && Number.isFinite(value.revision)))
    && Array.isArray(value.issues) && value.issues.every(issue => isRecord(issue) && hasStrings(issue, ['code', 'severity', 'title', 'message', 'reason', 'alternative'], true))
    && Array.isArray(value.choices) && value.choices.every(isChoice)
}

export function serializeChatHistory(messages: readonly Message[]): { role: Message['role']; content: string }[] {
  const history: { role: Message['role']; content: string }[] = []
  let remaining = 48_000
  for (let index = messages.length - 1; index >= 0 && history.length < 200 && remaining > 0; index--) {
    const message = messages[index]
    if ((message.role !== 'user' && message.status !== 'done') || !message.content.trim()) continue
    const content = message.content.slice(0, Math.min(16_000, remaining))
    if (!content.trim()) continue
    history.push({ role: message.role, content })
    remaining -= content.length
  }
  history.reverse()
  const firstUser = history.findIndex(message => message.role === 'user')
  return firstUser < 0 ? [] : history.slice(firstUser)
}

export function readChats(key = storageKey): { chats: Conversation[]; warning: string } {
  try {
    const raw = localStorage.getItem(key) ?? (key === storageKey ? localStorage.getItem('simply.chats.v1') : null)
    if (!raw) return { chats: [], warning: '' }
    const data: unknown = JSON.parse(raw)
    if (!Array.isArray(data) || data.length > 100) throw new Error()
    for (const chat of data) {
      if (!chat || typeof chat.id !== 'string' || typeof chat.title !== 'string' || !Array.isArray(chat.messages) || typeof chat.updatedAt !== 'number') throw new Error()
      for (const message of chat.messages) {
        if (!message || typeof message.id !== 'string' || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw new Error()
        if (message.blocks !== undefined && (!Array.isArray(message.blocks) || message.blocks.some((block: ActivityBlock) => !block || typeof block.id !== 'string' || (block.type === 'text' ? typeof block.text !== 'string' : block.type !== 'step' || typeof block.label !== 'string' || typeof block.command !== 'string' || typeof block.output !== 'string' || !['running', 'success', 'error', 'stopped'].includes(block.status))))) throw new Error()
        if (message.blocks) message.blocks = message.blocks.map((block: ActivityBlock) => block.type === 'step' && block.status === 'running' ? { ...block, status: 'stopped', output: 'Generation interrupted by reload.' } : block)
        if (message.run && message.run.reason === null) delete message.run.reason
        if (message.run !== undefined && (!message.run || typeof message.run !== 'object' || Array.isArray(message.run) || typeof message.run.status !== 'string' || (message.run.reason !== undefined && typeof message.run.reason !== 'string') || ['toolCalls', 'modelCalls'].some(key => message.run[key] !== undefined && (typeof message.run[key] !== 'number' || !Number.isFinite(message.run[key]) || message.run[key] < 0)) || ['changes', 'successfulTools'].some(key => message.run[key] !== undefined && (!message.run[key] || typeof message.run[key] !== 'object' || Array.isArray(message.run[key]) || Object.values(message.run[key]).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0))))) throw new Error()
        if (message.questions !== undefined && !isQuestions(message.questions)) throw new Error()
        if (message.feasibility !== undefined && !isFeasibility(message.feasibility)) throw new Error()
        if (message.feasibilityChoice !== undefined && typeof message.feasibilityChoice !== 'string') throw new Error()
        if (message.model !== undefined && typeof message.model !== 'string') throw new Error()
        if (message.elapsedMs !== undefined && (typeof message.elapsedMs !== 'number' || !Number.isFinite(message.elapsedMs))) throw new Error()
        if (message.startedAt !== undefined && (typeof message.startedAt !== 'number' || !Number.isFinite(message.startedAt))) throw new Error()
        if (message.usage !== undefined && (!message.usage || !['input_tokens', 'output_tokens', 'total_tokens'].every(key => typeof message.usage[key] === 'number'))) throw new Error()
        if (message.status === 'streaming') { message.status = 'stopped'; message.run = { status: 'interrupted', reason: 'reload' } }
      }
    }
    return { chats: data as Conversation[], warning: '' }
  } catch {
    return { chats: [], warning: 'Saved chats could not be loaded. You can start a new conversation.' }
  }
}

export async function streamReply(
  messages: Message[], signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
  scope: { projectId?: string; runtimeToken?: string; answers?: Record<string, string>; provider?: ModelProvider; model?: string; approval?: { assessment_id: string; choice: string } } = {},
) {
  const requestController = new AbortController()
  const cancel = () => requestController.abort(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  let headerTimeout = false
  const timer = setTimeout(() => { headerTimeout = true; requestController.abort() }, 30_000)
  try {
  const response = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: requestController.signal,
    body: JSON.stringify({ provider: scope.provider || 'groq', model: scope.model, project_id: scope.projectId, runtime_token: scope.runtimeToken, project_answers: scope.answers, approval: scope.approval, messages: serializeChatHistory(messages) }),
  })
  clearTimeout(timer)
  if (!response.ok) {
    let bodyTimer: ReturnType<typeof setTimeout> | undefined
    let stopReading: (() => void) | undefined
    let error: unknown
    try {
      error = await Promise.race([
        response.json().catch(() => null),
        new Promise<null>(resolve => {
          stopReading = () => resolve(null)
          signal.addEventListener('abort', stopReading, { once: true })
          if (signal.aborted) stopReading()
          bodyTimer = setTimeout(() => { resolve(null); requestController.abort() }, 5_000)
        }),
      ])
      signal.throwIfAborted()
    } finally {
      clearTimeout(bodyTimer)
      if (stopReading) signal.removeEventListener('abort', stopReading)
      void response.body?.cancel().catch(() => {})
    }
    const detail = isRecord(error) ? error.detail : undefined
    const details = Array.isArray(detail) ? detail.map(item => {
      const loc = isRecord(item) && Array.isArray(item.loc) ? item.loc.filter(value => value !== 'body' && (typeof value === 'string' || typeof value === 'number')).join('.') : ''
      const message = isRecord(item) && typeof item.msg === 'string' ? item.msg : 'Invalid value'
      return `${loc || 'request'}: ${message}`
    }).join('; ') : null
    throw new Error(typeof detail === 'string' ? detail : details || `Chat request failed (${response.status}). Please try again.`)
  }
  await readActivityStream(response, onEvent)
  } catch (error) {
    if (headerTimeout) throw new Error('The AI server did not start a response within 30 seconds. Restart the backend or retry with another model.')
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
    requestController.abort()
  }
}
