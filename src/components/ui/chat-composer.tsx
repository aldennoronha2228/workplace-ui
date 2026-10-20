import { useRef } from 'react'
import { Cable, Cpu, GitCompare, Lightbulb } from 'lucide-react'
import { AiPromptInput } from './ai-prompt-input'
import { ChatModelPicker } from './chat-model-picker'
import type { ModelOption, ModelProvider } from '@/lib/model-selection'

type Props = {
  value: string; onChange: (value: string) => void
  onSend: (text?: string) => void; onStop: () => void; busy: boolean
  provider?: ModelProvider; models?: ModelOption[]; selectionKey?: string; onModelChange?: (key: string) => void; compact?: boolean
}

const quickPrompts = [
  { id: 'microcontrollers', label: 'List compatible microcontrollers for simulation', icon: <Cpu aria-hidden /> },
  { id: 'led', label: 'Explain how to connect an LED to Arduino Uno', icon: <Lightbulb aria-hidden /> },
  { id: 'compare', label: 'Compare Arduino Uno and ESP32 capabilities', icon: <GitCompare aria-hidden /> },
  { id: 'wiring', label: 'Review my circuit wiring and suggest fixes', icon: <Cable aria-hidden /> },
] as const

const placeholders = [
  'Ask anything…',
  'List boards that simulate in the browser…',
  'Explain how to wire a pull-up resistor…',
  'Describe the firmware you need…',
] as const

type SpeechRecognitionLike = { continuous: boolean; interimResults: boolean; lang: string; onresult: (event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void; onerror: () => void; start: () => void; stop: () => void }

export function ChatComposer({ value, onChange, onSend, onStop, busy, models, selectionKey, onModelChange, compact = false }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const recognition = useRef<SpeechRecognitionLike | null>(null)
  const transcript = useRef('')


  const onDictationChange = (listening: boolean) => {
    if (!listening) {
      try { recognition.current?.stop() } catch { /* already stopped */ }
      return
    }
    const source = (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike })
    const SpeechRecognition = source.SpeechRecognition ?? source.webkitSpeechRecognition
    if (!SpeechRecognition) return
    const session = new SpeechRecognition()
    session.continuous = true
    session.interimResults = false
    session.lang = navigator.language
    transcript.current = ''
    session.onresult = event => {
      for (let index = event.resultIndex; index < event.results.length; index++) {
        if (event.results[index].isFinal) transcript.current += `${event.results[index][0].transcript} `
      }
    }
    session.onerror = () => { /* transcript simply stays partial */ }
    session.start()
    recognition.current = session
  }
  const getDictationTranscript = () => {
    const text = transcript.current.trim()
    transcript.current = ''
    try { recognition.current?.stop() } catch { /* already stopped */ }
    return text
  }

  const readFile = (file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '').slice(0, 12000)
      if (!text.trim()) return
      const attached = `${file.name}:\n${text}`
      onChange(value.trim() ? `${value.trimEnd()}\n\n${attached}` : attached)
    }
    reader.readAsText(file)
  }

  return (
    <div className={`relative${compact ? ' wireup-composer-compact' : ''}`}>
      <input ref={fileInput} type="file" hidden aria-hidden tabIndex={-1}
        accept=".txt,.md,.ino,.c,.cpp,.h,.hpp,.json,.csv"
        onChange={event => { readFile(event.target.files?.[0]); event.target.value = '' }} />
      <AiPromptInput
        value={value}
        onChange={onChange}
        onSubmit={text => onSend(text)}
        onStop={busy ? onStop : undefined}
        status={busy ? 'loading' : 'idle'}
        maxLength={16000}
        maxRows={compact ? 4 : 8}
        minRows={1}
        className={compact ? 'wireup-prompt-compact' : undefined}
        placeholders={placeholders}
        showModelSelector={false}
        customActions={quickPrompts.map(prompt => ({ ...prompt, onSelect: () => onChange(value.trim() ? `${value.trimEnd()} ${prompt.label}` : prompt.label) }))}
        onUploadFile={() => fileInput.current?.click()}
        getDictationTranscript={getDictationTranscript}
        onDictationChange={onDictationChange}
        aria-label="Message WireUp"
      />
      <div className="mt-2"><ChatModelPicker models={models || []} value={selectionKey} onChange={onModelChange} disabled={busy}/></div>
    </div>
  )
}
