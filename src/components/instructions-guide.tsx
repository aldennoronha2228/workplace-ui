import { useEffect, useId, useRef, useState } from 'react'
import { Cable, Check, ChevronDown, ChevronUp, Copy, Cpu, Hammer, Wrench } from 'lucide-react'
import type { SyntaxHighlighterProps } from 'react-syntax-highlighter'
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import coldarkDark from 'react-syntax-highlighter/dist/esm/styles/prism/coldark-dark'
import { buildGuideApi } from '../lib/build-guide'
import type { BuildGuideDocument } from '../lib/build-guide'
import { HardwareApiError, catalogType } from '../lib/hardware'
import type { CatalogComponent, HardwareProject } from '../lib/hardware'
import { deriveInstructionsGuide } from '../lib/instructions-guide'
import type { InstructionsCard, InstructionsValue } from '../lib/instructions-guide'

type InstructionCard = Omit<InstructionsCard, 'tools' | 'code' | 'images'> & { sourceStepIds: string[]; sections: InstructionsCard['details']; tools: string[]; code: { source: string; language: string; filename?: string }[]; images: { url: string; alt: string }[]; fabrication?: { facts: string[]; status: string; artifacts: { url: string; label: string }[] } }
function readable(value: InstructionsValue | undefined): string {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join(' · ')
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key.replaceAll('_', ' ')}: ${readable(item)}`).join(' · ')
  return String(value)
}
function objectList(value: InstructionsValue | undefined): Record<string, InstructionsValue>[] {
  return (Array.isArray(value) ? value : value ? [value] : []).filter((item): item is Record<string, InstructionsValue> => !!item && typeof item === 'object' && !Array.isArray(item))
}
function viewCard(card: InstructionsCard): InstructionCard {
  const code = card.source ? [{ source: card.source.source, language: card.source.filename.endsWith('.py') ? 'python' : 'cpp', filename: card.source.filename }] : objectList(card.code).flatMap(item => typeof item.source === 'string' ? [{ source: item.source, language: typeof item.language === 'string' ? item.language : 'text' }] : [])
  const images = objectList(card.images).flatMap(item => typeof item.url === 'string' ? [{ url: item.url, alt: typeof item.alt === 'string' ? item.alt : 'Project diagram' }] : [])
  const artifacts = objectList(card.artifacts)
  const titles: Record<string, string> = { preparation: 'Prepare parts and disconnect power', verification: 'Inspect connections before applying power', firmware: 'Review the saved firmware', simulation: 'Compile and review simulation limits', testing: 'Test behavior and investigate mismatches', completion: 'Review outstanding build checks' }
  return { ...card, title: titles[card.stage] || card.title, sourceStepIds: [card.stepId], sections: card.details.length ? card.details : card.instructions.length ? [{ title: 'Steps', paragraphs: [], actions: card.instructions }] : [], tools: card.tools.map(readable), code, images,
    ...(card.stage === 'fabricate' ? { fabrication: { facts: [card.material !== undefined ? `Material: ${readable(card.material)}` : '', card.settings !== undefined ? `Settings: ${readable(card.settings)}` : '', card.dimensions !== undefined ? `Dimensions: ${readable(card.dimensions)}` : ''].filter(Boolean), status: !artifacts.length ? 'CAD geometry and fabrication files have not been supplied. This task does not mean files are available.' : artifacts.some(item => item.stale === true || item.status === 'stale') ? 'Fabrication geometry is stale. Review updated files before fabricating.' : 'Provided fabrication artifacts; confirm their revision before use.', artifacts: artifacts.filter(item => item.stale !== true && item.status !== 'stale').map(item => ({ url: typeof item.url === 'string' ? item.url : '', label: typeof item.name === 'string' ? item.name : 'Fabrication artifact' })) } } : {}) }
}
import './instructions-guide.css'

SyntaxHighlighter.registerLanguage('cpp', cpp)
SyntaxHighlighter.registerLanguage('python', python)

type Props = { project: HardwareProject; catalog: CatalogComponent[]; readOnly: boolean; onOpenPart: (id: string) => void; onOpenWiring?: () => void; onOpenCode?: () => void }
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Unable to load the instructions. Please retry.'
const safeUrl = (value: string) => /^(https?:\/\/|\/(?!\/))/.test(value) ? value : undefined

export function InstructionsGuide({ project, catalog, readOnly, onOpenPart, onOpenWiring, onOpenCode }: Props) {
  const [guide, setGuide] = useState<BuildGuideDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const [active, setActive] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const sequence = useRef(0)
  const lock = useRef(false)
  const rootId = useId()
  useEffect(() => {
    const controller = new AbortController()
    const current = ++sequence.current
    lock.current = false
    void Promise.resolve().then(() => { if (!controller.signal.aborted) { setLoading(true); setSaving(''); setError('') } })
    void buildGuideApi.get(project.id, controller.signal).then(next => {
      if (current !== sequence.current || controller.signal.aborted) return
      setGuide(next); setLoading(false)
    }).catch(cause => { if (current === sequence.current && !controller.signal.aborted) { setError(messageOf(cause)); setLoading(false) } })
    const requestSequence = sequence
    return () => { controller.abort(); requestSequence.current++ }
  }, [project.id, project.revision, project.firmware.revision, project.compiler, reload])

  const phases = guide ? deriveInstructionsGuide(guide, project, catalog).phases.map(phase => ({ ...phase, cards: phase.cards.map(viewCard) })) : []
  const cards = phases.flatMap(phase => phase.cards)
  const isOutdated = (card: InstructionCard) => !!guide && (card.checkIds.some(id => guide.progress.checks[id]?.outdated) || card.sourceStepIds.some(id => !!guide.progress.outdated_steps[id]))
  const isComplete = (card: InstructionCard) => !!guide && card.checkIds.length > 0 && !isOutdated(card) && card.checkIds.every(id => guide.progress.checks[id]?.confirmed)
  const completed = cards.filter(isComplete).length
  const stale = !!guide && (guide.project_revision !== project.revision || guide.firmware_revision !== project.firmware.revision)

  async function complete(card: InstructionCard, confirmed: boolean) {
    if (!guide || readOnly || lock.current || loading || stale) return
    lock.current = true
    const current = ++sequence.current
    setSaving(card.id); setError(''); setNotice('')
    try {
      const next = await buildGuideApi.updateProgress(project, guide, { checks: Object.fromEntries(card.checkIds.map(id => [id, confirmed])) })
      if (current === sequence.current) { setGuide(next); setNotice(confirmed ? 'Step marked complete. Progress saved.' : 'Step marked incomplete. Progress saved.') }
    } catch (cause) {
      if (current !== sequence.current) return
      setError(cause instanceof HardwareApiError && cause.status === 409 ? 'The instructions or progress changed elsewhere. Reload and review the latest step before confirming again.' : `${messageOf(cause)} Reload to check saved progress before trying again.`)
      try { const next = await buildGuideApi.get(project.id); if (current === sequence.current) setGuide(next) } catch { /* Preserve the last known server state. */ }
    } finally { if (current === sequence.current) { lock.current = false; setSaving('') } }
  }

  function navigate(id: string) {
    setActive(id)
    const heading = document.getElementById(`${rootId}-${id}`)
    heading?.scrollIntoView({ block: 'start', behavior: 'instant' })
    heading?.focus({ preventScroll: true })
  }

  return <div className="instructions-guide" aria-busy={loading || !!saving}>
    <div className="ig-intro"><h3>{project.name} build instructions</h3><p>{guide?.steps.find(step => step.id === 'introduction')?.objective || 'Follow the saved circuit and firmware, one task at a time.'} Check off a step only after you have performed it.</p></div>
    {readOnly && <p className="ig-banner">Read-only project. You can explore instructions and parts; completion cannot be changed.</p>}
    {loading && <p role="status" className="ig-banner">Loading project instructions…</p>}
    {error && <div role="alert" className="ig-banner"><p>{error}</p><button type="button" onClick={() => setReload(value => value + 1)}>Retry loading instructions</button></div>}
    {!loading && guide && <>
      <div className="ig-progress"><progress value={completed} max={Math.max(1, cards.length)} aria-label="Physical build completion" /><span>{completed} of {cards.length} steps complete</span></div>
      <p className="ig-feedback">Physical tasks are not automatically completed. Generated instructions and compiler artifacts are separate from build completion.</p>
      <div className="ig-feedback" role="status" aria-live="polite">{saving ? 'Saving progress…' : notice}</div>
      {stale && <div className="ig-banner">Instructions do not match the current project. Reload before confirming completion.<button onClick={() => setReload(value => value + 1)}>Reload instructions</button></div>}
      {!phases.length ? <div className="ig-empty"><h4>No build instructions yet</h4><p>Add components and connections, or save firmware to give the existing guide generator project data to work with. No fabrication or assembly tasks have been supplied.</p>{onOpenWiring && <button onClick={onOpenWiring}>Open Wiring to add parts</button>} {onOpenCode && <button onClick={onOpenCode}>Open Code</button>}</div> : <div className="ig-layout">
        <nav className="ig-nav" aria-label="Build phases">{phases.map(phase => { const Icon = phase.id === 'wire' ? Cable : phase.id === 'bring-up' ? Cpu : phase.id === 'fabricate' ? Hammer : Wrench; return <button key={phase.id} type="button" aria-current={(active || phases[0].id) === phase.id ? 'step' : undefined} onClick={() => navigate(phase.id)}><Icon size={14} aria-hidden="true" />{phase.title}<small>{phase.cards.filter(isComplete).length}/{phase.cards.length}</small></button> })}</nav>
        <div>{phases.map((phase, phaseIndex) => <section className="ig-phase" key={phase.id} aria-labelledby={`${rootId}-${phase.id}`}><div className="ig-phase-heading"><h4 tabIndex={-1} id={`${rootId}-${phase.id}`}>{phaseIndex + 1}. {phase.title}</h4><span>{phase.cards.filter(isComplete).length} of {phase.cards.length} complete</span></div>
          {phase.cards.map((card, index) => <article className="ig-card" key={card.id} data-complete={isComplete(card)} aria-labelledby={`${rootId}-${card.id}-title`}>
            <div className="ig-step-heading"><span className="ig-step-number">{phaseIndex + 1}.{index + 1}</span><h5 id={`${rootId}-${card.id}-title`}>{card.title}</h5><span className="ig-state">{isOutdated(card) ? 'Changed · review again' : isComplete(card) ? 'Complete' : 'To do'}</span></div>
            <p>{card.explanation}</p>
            {card.partIds.length > 0 && <><div className="ig-label"><Cpu size={12} aria-hidden="true" />Referenced parts</div><div className="ig-parts">{card.partIds.map(id => { const part = project.components.find(item => item.id === id); const product = part && catalog.find(item => catalogType(item) === part.type); return part ? <button type="button" className="ig-part" key={id} onClick={() => onOpenPart(id)} aria-label={`Open part ${id}`}><strong>{typeof part.properties.label === 'string' && part.properties.label || product?.name || part.type}</strong><small>{typeof part.properties.label === 'string' && part.properties.label ? `${product?.name || part.type} · ` : ''}{product?.category || 'Category not supplied'} · Qty 1 · {id}</small></button> : <span className="ig-missing" key={id}>Part unavailable: {id}. Review this reference in Wiring.</span> })}</div></>}
            <div className="ig-label"><Wrench size={12} aria-hidden="true" />Tools</div><div className="ig-tools">{card.tools.length ? card.tools.map(tool => <span key={tool}><Wrench size={12} aria-hidden="true" />{tool}</span>) : <span>Required tools are not specified in this project.</span>}</div>
            {card.prerequisites.length > 0 && <><div className="ig-label">Before you start</div><ul className="ig-prerequisites">{card.prerequisites.map((text, i) => <li key={i}>{text}</li>)}</ul></>}
            <div className="ig-controls"><button type="button" aria-expanded={!!expanded[card.id]} aria-controls={`${rootId}-${card.id}-details`} onClick={() => setExpanded(value => ({ ...value, [card.id]: !value[card.id] }))}>{expanded[card.id] ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}{expanded[card.id] ? 'Hide details' : 'View details'}</button><label className="ig-completion"><input type="checkbox" checked={isComplete(card)} disabled={readOnly || loading || !!saving || stale || !card.checkIds.length} onChange={event => void complete(card, event.target.checked)} aria-label={`${isComplete(card) ? 'Mark incomplete' : 'Mark complete'}: ${card.title}`} />{isComplete(card) ? 'Completed' : isOutdated(card) ? 'Confirm after reviewing changes' : 'Mark complete'}</label></div>
            {expanded[card.id] && <div className="ig-detail" id={`${rootId}-${card.id}-details`}><StepDetails card={card} project={project} catalog={catalog} />{card.sourceStepIds.includes('firmware') && onOpenCode && <button onClick={onOpenCode}>Open saved firmware in Code</button>}{card.connections.length > 0 && onOpenWiring && <button onClick={onOpenWiring}>Inspect in Wiring</button>}</div>}
          </article>)}
        </section>)}</div>
      </div>}
    </>}
  </div>
}

function CodeBlock({ source, language, filename }: { source: string; language: string; filename?: string }) {
  const [status, setStatus] = useState('')
  async function copy() { try { await navigator.clipboard.writeText(source); setStatus('Copied') } catch { setStatus('Copy failed. Select the code and copy it manually.') } }
  return <div className="ig-code"><div className="ig-code-header"><span>{filename || language}</span><button type="button" onClick={() => void copy()} aria-label="Copy code">{status === 'Copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{status === 'Copied' ? 'Copied' : 'Copy code'}</button></div><SyntaxHighlighter {...({ language, style: coldarkDark, wrapLongLines: false } satisfies Partial<SyntaxHighlighterProps>)}>{source}</SyntaxHighlighter><span className="ig-feedback" role="status">{status}</span></div>
}

function GuideImage({ url, alt }: { url: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  return <figure className="ig-assets">{failed || !safeUrl(url) ? <p role="status">Image unavailable: {alt}</p> : <img src={safeUrl(url)} alt={alt} loading="lazy" onError={() => setFailed(true)} />}<figcaption>{alt}</figcaption></figure>
}

function StepDetails({ card, project, catalog }: { card: InstructionCard; project: HardwareProject; catalog: CatalogComponent[] }) {
  const partName = (id: string) => { const part = project.components.find(value => value.id === id); return part ? catalog.find(item => catalogType(item) === part.type)?.name || part.type : `Unavailable part (${id})` }
  return <>
    {card.why && <><h6>Why it matters</h6><p>{card.why}</p></>}
    {card.connections.map(connection => <div key={connection.id} className="ig-connection"><div><small>Source</small><strong>{partName(connection.from.component)}</strong><code>{connection.from.component} · {connection.from.pin}</code></div><span aria-label="connects to">→</span><div><small>Destination</small><strong>{partName(connection.to.component)}</strong><code>{connection.to.component} · {connection.to.pin}</code></div></div>)}
    {card.sections.map((section, index) => <section key={index}><h6>{section.title}</h6>{section.paragraphs.map((text, i) => <p key={i}>{text}</p>)}{section.actions.length > 0 && <ol>{section.actions.map((text, i) => <li key={i}>{text}</li>)}</ol>}</section>)}
    {card.checks.length > 0 && <section><h6>Check before marking complete</h6><ul>{card.checks.map(check => <li key={check.id}>{check.label}</li>)}</ul></section>}
    {card.warnings.length > 0 && <aside className="ig-warning" aria-label="Warnings"><strong>Before continuing</strong><ul>{card.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></aside>}
    {card.code.map((code, i) => <CodeBlock key={i} {...code} />)}
    {card.fabrication && <div className="ig-assets"><h6>Fabrication information</h6>{card.fabrication.facts.map((fact, i) => <p key={i}>{fact}</p>)}<p>{card.fabrication.status}</p>{card.fabrication.artifacts.map((artifact, i) => safeUrl(artifact.url) ? <p key={i}><a href={safeUrl(artifact.url)} target="_blank" rel="noreferrer">{artifact.label}</a></p> : <p key={i}>Artifact link unavailable: {artifact.label}</p>)}</div>}
    {card.images.map((image, i) => <GuideImage key={i} {...image} />)}
    {!card.sections.length && !card.connections.length && !card.code.length && !card.fabrication && !card.images.length && <p>No detailed substeps, diagrams, or troubleshooting information have been supplied for this step.</p>}
  </>
}
