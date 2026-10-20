import { useEffect, useState } from 'react'
import { Check, ChevronRight, CircleX, LoaderCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ActivityBlock } from '@/lib/agent-activity'
import './agent-activity-feed.css'

export { appendActivity, readActivityStream } from '@/lib/agent-activity'
export type { ActivityBlock, ActivityEvent } from '@/lib/agent-activity'

type AnswerBlock = Extract<ActivityBlock, { type: 'text' }>

function isAnswer(block: ActivityBlock): block is AnswerBlock {
  return block.type === 'text' && block.channel !== 'narration' && block.channel !== 'thinking'
}

function formatElapsed(ms?: number) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return undefined
  const total = Math.round(ms / 1000)
  return total >= 60 ? `${Math.floor(total / 60)}m ${total % 60}s` : `${total}s`
}

export function AgentActivityFeed({ blocks, running = false, outcome, startedAt, elapsedMs }: {
  blocks: ActivityBlock[]
  running?: boolean
  outcome?: 'done' | 'error' | 'stopped'
  startedAt?: number
  elapsedMs?: number
}) {
  const answers = blocks.filter(isAnswer)
  const process = blocks.filter(block => block.type === 'step' || (block.type === 'text' && (block.channel === 'narration' || (block.channel === 'thinking' && running))))
  const hasProcess = blocks.some(block => block.type === 'step' || (block.type === 'text' && block.channel === 'narration'))
  const answerNodes = answers.map(block => <div key={block.id} className="chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown></div>)
  if (!hasProcess) {
    return <div className="agent-feed">{process.map(block => block.type === 'text' ? <div key={block.id} className="agent-thinking"><ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown></div> : null)}{answerNodes}</div>
  }
  const failed = outcome === 'error' || blocks.some(block => block.type === 'step' && (block.status === 'error' || block.status === 'stopped'))
  return (
    <div className="agent-feed">
      <section className="agent-run" aria-label="Agent steps">
        <RunHeader running={running} failed={failed} stopped={outcome === 'stopped'} startedAt={startedAt} elapsedMs={elapsedMs} />
        <div className="agent-run-body">
          {process.map(block => block.type === 'step'
            ? <StepRow key={block.id} step={block} />
            : <div key={block.id} className={block.channel === 'thinking' ? 'agent-thinking' : 'agent-narration'}><ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown></div>)}
        </div>
      </section>
      {answerNodes}
    </div>
  )
}

function RunHeader({ running, failed, stopped, startedAt, elapsedMs }: { running: boolean; failed: boolean; stopped: boolean; startedAt?: number; elapsedMs?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  const elapsed = running && startedAt ? now - startedAt : elapsedMs
  const seconds = formatElapsed(elapsed)
  const label = running ? 'Working on your project…' : stopped ? 'Generation stopped' : failed ? 'Finished with errors' : 'Finished'
  return (
    <div className="agent-run-header" role="status">
      {running ? <LoaderCircle size={14} className="agent-spin" />
        : stopped ? <CircleX size={14} className="agent-run-muted" />
          : failed ? <CircleX size={14} className="agent-run-fail" />
            : <Check size={14} className="agent-run-check" />}
      <span>{label}</span>
      {seconds !== undefined && <small>{seconds}</small>}
    </div>
  )
}

function StepRow({ step }: { step: Extract<ActivityBlock, { type: 'step' }> }) {
  const [choice, setChoice] = useState<{ status: string; open: boolean } | null>(null)
  const open = choice?.status === step.status ? choice.open : step.status === 'running'
  return <div className="agent-step"><button type="button" aria-expanded={open} onClick={() => setChoice({ status: step.status, open: !open })}>{step.status === 'running' ? <LoaderCircle size={14} className="agent-spin" /> : step.status === 'success' ? <Check size={14} className="agent-step-check" /> : <CircleX size={14} className="agent-step-fail" />}<span>{step.label}</span>{(step.status === 'error' || step.status === 'stopped') && <small>{step.status}</small>}<ChevronRight size={13} className="agent-chevron" /></button>{open && <div className="agent-step-body"><pre className="agent-command">{step.command}</pre>{step.output && <pre className="agent-output">{step.output}</pre>}</div>}</div>
}
