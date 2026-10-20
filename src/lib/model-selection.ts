export type ModelProvider = 'groq' | 'nvidia' | 'bedrock' | 'azure' | 'zenllm'
export type ModelOption = { id: ModelProvider; label: string; model: string; configured: boolean; rate?: string; group?: string }
export const defaultModels: ModelOption[] = [
  { id: 'groq', label: 'Groq', model: 'Configured Groq model', configured: false },
  { id: 'nvidia', label: 'NVIDIA', model: 'Configured NVIDIA model', configured: false },
  { id: 'bedrock', label: 'Amazon Bedrock', model: 'Configured Bedrock model', configured: false },
  { id: 'azure', label: 'Azure', model: 'gpt-6.1-sol', configured: false },
  { id: 'zenllm', label: 'ZenLLM', model: 'claude-sonnet-5', configured: false },
]

// ZenLLM text models grouped by family, with input/output pricing per million tokens
export const zenllmModels: ModelOption[] = [
  // Claude — Sonnet
  { id: 'zenllm', label: 'ZenLLM', group: 'Claude',    model: 'claude-sonnet-5',     rate: '$1.00 / $5.00',  configured: true },
  { id: 'zenllm', label: 'ZenLLM', group: 'Claude',    model: 'claude-sonnet-5.5',   rate: '$1.20 / $6.00',  configured: true },
  { id: 'zenllm', label: 'ZenLLM', group: 'Claude',    model: 'claude-sonnet-4.6',   rate: '$1.50 / $7.50',  configured: true },
  // Claude — Opus
  { id: 'zenllm', label: 'ZenLLM', group: 'Claude',    model: 'claude-opus-5.5',     rate: '$2.00 / $10.00', configured: true },
  { id: 'zenllm', label: 'ZenLLM', group: 'Claude',    model: 'claude-opus-5',       rate: '$2.50 / $12.50', configured: true },
  // Claude — Haiku & Fable
  { id: 'zenllm', label: 'ZenLLM', group: 'Claude',    model: 'claude-haiku-5.5',    rate: '$0.08 / $0.40',  configured: true },
  { id: 'zenllm', label: 'ZenLLM', group: 'Claude',    model: 'claude-haiku-4.5',    rate: '$0.80 / $4.00',  configured: true },
  { id: 'zenllm', label: 'ZenLLM', group: 'Claude',    model: 'claude-fable-5.1',    rate: '$5.43 / $27.14', configured: true },
  // DeepSeek
  { id: 'zenllm', label: 'ZenLLM', group: 'DeepSeek',  model: 'deepseek-v4.1-flash', rate: '$0.03 / $0.14',  configured: true },
  { id: 'zenllm', label: 'ZenLLM', group: 'DeepSeek',  model: 'deepseek-v4-flash',   rate: '$0.06 / $0.11',  configured: true },
  { id: 'zenllm', label: 'ZenLLM', group: 'DeepSeek',  model: 'deepseek-v4-pro',     rate: '$0.16 / $0.31',  configured: true },
  { id: 'zenllm', label: 'ZenLLM', group: 'DeepSeek',  model: 'deepseek-r1',         rate: '$0.72 / $2.85',  configured: true },
  { id: 'zenllm', label: 'ZenLLM', group: 'DeepSeek',  model: 'deepseek-v3.2',       rate: '$0.04 / $0.06',  configured: true },
  // Qwen
  { id: 'zenllm', label: 'ZenLLM', group: 'Qwen',      model: 'qwen-3-8-max',        rate: '$1.00 / $3.00',  configured: true },
  { id: 'zenllm', label: 'ZenLLM', group: 'Qwen',      model: 'qwen-3-7-max',        rate: '$1.65 / $4.93',  configured: true },
  { id: 'zenllm', label: 'ZenLLM', group: 'Qwen',      model: 'qwen-3-7-plus',       rate: '$0.25 / $1.00',  configured: true },
]

export function modelOptionKey(option: ModelOption): string {
  return `${option.id}::${option.model}`
}
export function readSelectedModel(): string {
  try { return localStorage.getItem('wireup.model-id') || '' } catch { return '' }
}
export function readModelSelection(): ModelProvider {
  try {
    const saved = localStorage.getItem('wireup.model-provider')
    if (saved === 'azure' || saved === 'bedrock' || saved === 'nvidia' || saved === 'zenllm') return saved
    return 'zenllm'
  }
  catch { return 'zenllm' }
}
