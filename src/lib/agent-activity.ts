export type ActivityBlock =
  | { type: 'text'; id: string; text: string; channel?: 'answer' | 'narration' | 'thinking' }
  | { type: 'step'; id: string; label: string; command: string; status: 'running' | 'success' | 'error' | 'stopped'; output: string; toolName?: string; args?: Record<string, unknown>; result?: unknown }
export type ActivityEvent =
  | { type: 'text'; text: string; channel?: 'answer' | 'narration' | 'thinking' }
  | { type: 'step_start'; id: string; label: string; command: string; toolName?: string; args?: Record<string, unknown> }
  | { type: 'step_end'; id: string; status: 'success' | 'error' | 'stopped'; output: string; result?: unknown }
  | { type: 'done'; model?: string; elapsedMs?: number; usage?: { input_tokens: number; output_tokens: number; total_tokens: number } | null }

export function appendActivity(blocks: ActivityBlock[], event: ActivityEvent): ActivityBlock[] {
  if (event.type === 'text') {
    const last = blocks.at(-1)
    if (last?.type === 'text' && last.channel === event.channel) return [...blocks.slice(0, -1), { ...last, text: last.text + event.text }]
    return [...blocks, { type: 'text', id: crypto.randomUUID(), text: event.text, channel: event.channel }]
  }
  if (event.type === 'step_start') {
    if (blocks.some(block => block.id === event.id)) throw new Error('The backend sent a duplicate tool activity ID.')
    return [...blocks, { type: 'step', id: event.id, label: event.label, command: event.command, toolName: event.toolName, args: event.args, status: 'running', output: '' }]
  }
  if (event.type === 'step_end') {
    if (!blocks.some(block => block.type === 'step' && block.id === event.id)) throw new Error('The backend completed a tool without a matching start event.')
    return blocks.map(block => block.type === 'step' && block.id === event.id ? { ...block, status: event.status, output: event.output, result: event.result } : block)
  }
  return blocks
}

export async function readActivityStream(response: Response, onEvent: (event: ActivityEvent) => void) {
  if (!response.body) throw new Error('The server returned an empty stream.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed = false
  const toolStates = new Map<string, string>()
  const line = (value: string) => {
    if (completed || !value.trim()) return
    const event = JSON.parse(value)
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('The backend returned an invalid activity event.')
    if (event.type === 'text' && (typeof event.text !== 'string' || (event.channel !== undefined && !['answer', 'narration', 'thinking'].includes(event.channel)))) throw new Error('The backend returned invalid text activity.')
    if (event.type === 'step_start' && (typeof event.id !== 'string' || !event.id || typeof event.label !== 'string' || typeof event.command !== 'string' || (event.toolName !== undefined && typeof event.toolName !== 'string') || (event.args !== undefined && (!event.args || typeof event.args !== 'object' || Array.isArray(event.args))))) throw new Error('The backend returned an invalid tool start event.')
    if (event.type === 'step_end' && (typeof event.id !== 'string' || !event.id || !['success', 'error', 'stopped'].includes(event.status) || typeof event.output !== 'string')) throw new Error('The backend returned an invalid tool result event.')
    if (event.type === 'done' && event.status !== undefined && !['success', 'error', 'awaiting_answers', 'awaiting_approval', 'awaiting_revision', 'cancelled'].includes(event.status)) throw new Error('The backend returned an unknown run outcome.')
    if (event.type === 'done') {
      if (event.reason == null) delete event.reason
      else if (typeof event.reason !== 'string') throw new Error('The backend returned an invalid run reason.')
      for (const key of ['changes', 'successfulTools']) {
        const values = event[key]
        if (values !== undefined && (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0))) throw new Error('The backend returned invalid run totals.')
      }
      for (const key of ['toolCalls', 'modelCalls', 'elapsedMs']) {
        if (event[key] !== undefined && (typeof event[key] !== 'number' || !Number.isFinite(event[key]) || event[key] < 0)) throw new Error('The backend returned invalid run totals.')
      }
    }
    if (event.type === 'step_start') {
      if (toolStates.has(event.id)) throw new Error('The backend sent a duplicate tool activity ID.')
      toolStates.set(event.id, 'running')
    }
    if (event.type === 'step_end') {
      if (!toolStates.has(event.id)) throw new Error('The backend completed a tool without a matching start event.')
      if (toolStates.get(event.id) !== 'running') throw new Error('The backend completed the same tool more than once.')
      toolStates.set(event.id, event.status)
    }
    if (event.type === 'done' && (event.status === undefined || event.status === 'success') && [...toolStates.values()].includes('running')) throw new Error('The backend reported success before all tools completed.')
    if (event.type === 'error') throw new Error(event.message || 'Generation failed. Please retry.')
    if (event.type === 'done') completed = true
    onEvent(event)
  }
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The AI connection stopped sending updates for 45 seconds. Please retry or select another model.')), 45_000) }),
      ]).finally(() => clearTimeout(timer))
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const value of lines) line(value)
      if (done || completed) break
    }
    line(buffer)
    if (!completed) throw new Error('The stream ended before completion. Please retry.')
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
