import { useEffect, useId, useRef, useState } from 'react'
import type { RuntimeResults } from '../hardware/runtime'
import { HardwareApiError } from '../lib/hardware'
import type { HardwareProject } from '../lib/hardware'
import { buildGuideApi } from '../lib/build-guide'
import type { BuildGuideDocument, BuildGuideItem, BuildGuideProgressUpdate, BuildGuideStep, BuildGuideVerification } from '../lib/build-guide'
import './build-guide.css'

export type BuildGuideProps = {
  project: HardwareProject
  dirty: boolean
  busy: boolean | string
  results: RuntimeResults | null
  onOpenWiring: () => void
  onOpenCode: () => void
  onCompile: () => void | Promise<unknown>
  onRun: () => void | Promise<unknown>
  onStop: () => void | Promise<unknown>
  compileDisabled: boolean
  runDisabled: boolean
  running?: boolean
}

type Operation = { update: BuildGuideProgressUpdate } | { verify: BuildGuideVerification }
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The request failed. Reload the guide and try again.'
function readable(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join('; ')
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key.replaceAll('_', ' ')}: ${readable(item)}`).join(' · ')
  return String(value)
}
function ItemList({ items }: { items: BuildGuideItem[] }) {
  return <ul>{items.map((item, index) => <li key={index}>{readable(item)}</li>)}</ul>
}
function checkIsCurrent(guide: BuildGuideDocument, id: string) {
  const check = guide.progress.checks[id]
  return !!check?.confirmed && !check.outdated
}
function stepStatus(guide: BuildGuideDocument, step: BuildGuideStep) {
  if (guide.progress.outdated_steps[step.id] || step.checklist.some(check => guide.progress.checks[check.id]?.outdated)) return 'Outdated — needs review'
  if (step.checklist.length && step.checklist.every(check => checkIsCurrent(guide, check.id))) return 'Confirmed'
  return 'Outstanding'
}

export function BuildGuide({ project, dirty, busy, results, onOpenWiring, onOpenCode, onCompile, onRun, onStop, compileDisabled, runDisabled, running }: BuildGuideProps) {
  const [guide, setGuide] = useState<BuildGuideDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState<Operation | null>(null)
  const [reload, setReload] = useState(0)
  const requestId = useRef(0)
  const locked = useRef(false)
  const mounted = useRef(true)
  const heading = useRef<HTMLHeadingElement>(null)
  const stepsRef = useRef<HTMLOListElement>(null)
  const titleId = useId()
  const checklistId = useId()

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const sequence = ++requestId.current
    locked.current = false
    void Promise.resolve().then(() => {
      if (controller.signal.aborted || sequence !== requestId.current) return
      setSaving(false)
      setLoading(true)
      setError('')
      setRetry(null)
      setGuide(previous => previous?.project_id === project.id ? previous : null)
    })
    void buildGuideApi.get(project.id, controller.signal).then(next => {
      if (sequence !== requestId.current) return
      setGuide(next)
      setLoading(false)
    }).catch(cause => {
      if (controller.signal.aborted || sequence !== requestId.current) return
      setLoading(false)
      setError(messageOf(cause))
    })
    return () => controller.abort()
  }, [project.id, project.revision, project.firmware.revision, project.compiler, reload])

  async function perform(operation: Operation, fresh = false) {
    if (!guide || locked.current || loading) return
    locked.current = true
    const sequence = ++requestId.current
    const target = project
    setSaving(true)
    setError('')
    setNotice('')
    setRetry(null)
    try {
      const baseline = fresh ? await buildGuideApi.get(target.id) : guide
      if (sequence !== requestId.current) return
      if ('update' in operation) await buildGuideApi.updateProgress(target, baseline, operation.update)
      else await buildGuideApi.verify(target, baseline, operation.verify)
      const next = await buildGuideApi.get(target.id)
      if (sequence !== requestId.current || !mounted.current) return
      setGuide(next)
      setNotice('verify' in operation ? 'Check result saved.' : 'Progress saved.')
      if ('update' in operation && operation.update.current_step) heading.current?.focus()
    } catch (cause) {
      if (sequence !== requestId.current || !mounted.current) return
      const conflict = cause instanceof HardwareApiError && cause.status === 409
      setError(conflict ? 'The guide or progress changed elsewhere. Your change was not applied. Reload the latest guide and review it before confirming again.' : `${messageOf(cause)} Progress has not been confirmed here.`)
      if (!conflict) setRetry(operation)
      // A failed response may follow a successful write; recover the server state.
      try {
        const latest = await buildGuideApi.get(target.id)
        if (sequence === requestId.current && mounted.current) setGuide(latest)
      } catch { /* Keep the last server snapshot visible until reload succeeds. */ }
    } finally {
      if (sequence === requestId.current && mounted.current) {
        locked.current = false
        setSaving(false)
      }
    }
  }

  async function action(callback: () => void | Promise<unknown>) {
    try { await callback() }
    catch (cause) { if (mounted.current) setError(messageOf(cause)) }
  }

  const currentIndex = guide ? Math.max(0, guide.steps.findIndex(step => step.id === guide.progress.current_step)) : 0
  useEffect(() => {
    const list = stepsRef.current
    if (!list || !window.matchMedia('(max-width: 680px)').matches) return
    const active = list.querySelector<HTMLButtonElement>('[aria-current="step"]')
    if (active) list.scrollLeft += active.getBoundingClientRect().left - list.getBoundingClientRect().left - 4
  }, [currentIndex, guide?.project_id])
  const step = guide?.steps[currentIndex]
  const disabled = loading || saving || !!busy
  const projectStale = !!guide && (guide.project_revision !== project.revision || guide.firmware_revision !== project.firmware.revision)
  const checklist = guide?.steps.flatMap(item => item.checklist.map(check => ({ step: item, check }))) ?? []
  const confirmed = guide ? checklist.filter(item => checkIsCurrent(guide, item.check.id)).length : 0
  const stale = guide ? checklist.filter(item => guide.progress.checks[item.check.id]?.outdated || !guide.progress.checks[item.check.id]?.confirmed && !!guide.progress.outdated_steps[item.step.id]).length : 0
  const completedSteps = guide?.steps.filter(item => stepStatus(guide, item) === 'Confirmed').length ?? 0
  const evidence = Object.entries(guide?.progress.evidence ?? {})
  const automatic = evidence.filter(([, item]) => item.status === 'passed' || item.status === 'pass').length
  const stage = String(step?.stage ?? '').toLowerCase()
  const stageId = `${stage} ${step?.id ?? ''}`.toLowerCase()
  const testingStage = step?.id === 'testing'
  const firmwareStage = /firmware|code/.test(stageId)
  const compilationStage = /compil|simulation/.test(stageId)
  const simulationStage = /simulat|observ/.test(stageId) || stage === 'test'
  const connectionStage = /connect|wir|verification/.test(stageId) || ['power', 'signals', 'review'].includes(stage)
  const summaryStage = /summary|complet/.test(stageId) || !!guide && currentIndex === guide.steps.length - 1
  const stageEvidence = evidence.filter(([name]) => summaryStage || connectionStage && name === 'topology' || compilationStage && ['compile', 'simulation'].includes(name) || testingStage && name === 'simulation')
  const closingSections = step?.sections?.filter(section => ['Check your work', "What's next"].includes(section.title)) ?? []
  const openingSections = step?.sections?.filter(section => !closingSections.includes(section)) ?? []
  const nextIncomplete = guide?.steps.find(item => item.id !== 'completion' && (guide.progress.outdated_steps[item.id] || item.checklist.some(check => !checkIsCurrent(guide, check.id))))
  const compiler = project.compiler
  const compilerStale = !!compiler && (compiler.source_revision !== undefined && compiler.source_revision !== project.firmware.revision || compiler.project_revision !== undefined && compiler.project_revision !== project.revision || !!compiler.artifact && (compiler.artifact.source_revision !== project.firmware.revision || compiler.artifact.project_revision !== project.revision || compiler.artifact.board !== project.board))
  const runtimeStale = !!results && (!results.artifact_id || results.artifact_id !== compiler?.artifact?.id || compilerStale)
  const isRunning = running ?? results?.running ?? false
  const compilerState = busy === 'Compiling firmware' ? 'Running — compiling your sketch.'
    : !compiler ? 'Not tested — compile the saved sketch.'
    : compilerStale ? 'Outdated — compile again for the current project.'
    : compiler.status === 'error' || !!compiler.errors?.length ? 'Failed — fix the first compiler error and try again.'
    : ['simulation_ready', 'compilation_complete'].includes(compiler.status) ? 'Build succeeded — behavior still needs testing.'
    : 'No current successful build. Open the compiler diagnostics.'
  const observationState = !results ? 'Not tested here — no live observations are available.'
    : runtimeStale ? 'Outdated — run the current firmware again.'
    : results.error ? `Failed: ${results.error}. Stop and check the simulation diagnostics.`
    : isRunning ? 'Running — compare the input and output with the test steps.'
    : 'Stopped — last observations available; behavior is not automatically verified.'

  return <section className="build-guide" aria-labelledby={titleId} aria-busy={loading || saving}>
    <header className="build-guide-header">
      <div><p className="build-guide-eyebrow">Project instructions <span aria-hidden="true">/</span> {project.name}</p><h1 id={titleId}>Interactive Build Guide</h1><p>Follow the instructions, inspect the saved code, and confirm each step as you build.</p></div>
      <button type="button" disabled={saving || loading} onClick={() => setReload(value => value + 1)}>Reload guide</button>
    </header>
    {dirty && <p className="build-guide-banner" role="status">Unsaved firmware changes are present. This guide and its evidence refer to saved source, not your editor draft. Open Code to save your changes before compiling or verifying.</p>}
    {projectStale && <p className="build-guide-banner" role="status">This guide snapshot does not match the current project. Reload before confirming checks.</p>}
    {error && <div className="build-guide-error" role="alert"><p>{error}</p><div className="build-guide-actions">{retry && <button type="button" disabled={disabled} onClick={() => void perform(retry, true)}>Retry save / verification</button>}<button type="button" disabled={loading || saving} onClick={() => setReload(value => value + 1)}>Reload latest progress</button></div></div>}
    <p className="build-guide-save-status" role="status" aria-live="polite">{loading ? 'Loading saved build guide…' : saving ? 'Saving to the project…' : notice}</p>
    {!guide && !loading && !error && <p role="status">The server has not returned a build guide.</p>}
    {guide && <>
      <div className="build-guide-progress">
        <div><strong>{confirmed} of {checklist.length} checklist items confirmed</strong><span>{completedSteps} of {guide.steps.length} stages confirmed · {stale} checklist items need review</span></div>
        <div className="build-guide-progress-track" role="progressbar" aria-label="Build checklist progress" aria-valuemin={0} aria-valuemax={checklist.length || 1} aria-valuenow={confirmed} aria-valuetext={`${confirmed} of ${checklist.length} checklist items confirmed`}><span style={{ width: `${checklist.length ? confirmed / checklist.length * 100 : 0}%` }} /></div>
      </div>
      <div className="build-guide-layout">
        <nav className="build-guide-nav" aria-label="Build guide steps"><ol ref={stepsRef}>{guide.steps.map((item, index) => <li key={item.id}><button type="button" aria-current={step?.id === item.id ? 'step' : undefined} disabled={disabled || projectStale} onClick={() => void perform({ update: { current_step: item.id } })}><span className="build-guide-stage-number" aria-hidden="true">{index + 1}</span><span><strong>{item.title}</strong><small>{stepStatus(guide, item)}</small></span></button></li>)}</ol><p>Your place is saved. Opening a stage does not complete it.</p></nav>
        {step ? <article className="build-guide-content" aria-labelledby={`${titleId}-step`}>
          <p className="build-guide-eyebrow">Stage {currentIndex + 1} of {guide.steps.length}</p>
          <h2 id={`${titleId}-step`} ref={heading} tabIndex={-1}>{step.title}</h2>
          {guide.progress.outdated_steps[step.id] && <p className="build-guide-banner" role="status">Outdated: {guide.progress.outdated_steps[step.id]}</p>}
          {firmwareStage && <details className="build-guide-code" open><summary>Saved sketch <span>{project.firmware.filename} · revision {project.firmware.revision}</span></summary>{dirty && <p>Editor changes are not shown until saved.</p>}<pre className="build-guide-source" aria-label="Saved firmware source"><code>{project.firmware.source || 'No firmware source has been saved.'}</code></pre></details>}
          {!step.sections?.some(section => section.title === "What you'll do") && <section><h3>What you'll do</h3><p>{step.objective}</p></section>}
          {openingSections.map((section, index) => <section key={`${step.id}-${index}`}><h3>{section.title}</h3>{section.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}{!!section.actions.length && <ol className="build-guide-instructions">{section.actions.map((instruction, actionIndex) => <li key={actionIndex}>{instruction}</li>)}</ol>}</section>)}
          {!!step.instructions.length && !(step.id === 'wiring' && step.sections?.some(section => section.actions.some(action => action.startsWith('Connect ')))) && <section><h3>Steps</h3><ol className="build-guide-instructions">{step.instructions.map((instruction, index) => <li key={index}>{instruction}</li>)}</ol></section>}
          {!!step.why && <section><h3>Why it matters</h3><p>{step.why}</p></section>}
          {closingSections.map((section, index) => <section key={`closing-${step.id}-${index}`}><h3>{section.title}</h3>{section.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}{!!section.actions.length && <ol className="build-guide-instructions">{section.actions.map((instruction, actionIndex) => <li key={actionIndex}>{instruction}</li>)}</ol>}</section>)}
          {!!step.warnings.length && <section className="build-guide-warnings"><h3>Before you continue</h3><ul>{step.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></section>}
          {!!step.components.length && !step.sections?.length && <section><h3>Components for this stage</h3><ItemList items={step.components} /></section>}
          {!!step.pins.length && <section><h3>Pins and connections</h3><ItemList items={step.pins} /></section>}
          <div className="build-guide-actions"><button type="button" onClick={onOpenWiring}>Open Wiring</button><button type="button" onClick={onOpenCode}>Open Code</button></div>
          {connectionStage && <section><h3>Connection verification</h3><p>Check the saved diagram. Inspect physical connections separately.</p><button type="button" disabled={disabled || projectStale} onClick={() => void perform({ verify: 'connections' })}>Run connection checks</button></section>}
          {compilationStage && <section><h3>Compile saved firmware</h3><p>Build the saved sketch for your board, then test its behavior.</p><div className="build-guide-actions"><button type="button" disabled={disabled || compileDisabled || dirty} onClick={() => void action(onCompile)}>Compile firmware</button><button type="button" disabled={disabled || projectStale || dirty} onClick={() => void perform({ verify: 'compilation' })}>Verify compilation evidence</button></div>
            {compiler ? <div className="build-guide-diagnostics"><p role="status">{compilerState}</p><details><summary>Compiler diagnostics</summary>{compiler.stdout && <pre aria-label="Compiler output">{compiler.stdout}</pre>}{compiler.stderr && <pre aria-label="Compiler diagnostics">{compiler.stderr}</pre>}{!!compiler.errors?.length && <ul>{compiler.errors.map((item, index) => <li key={index}>{readable(item)}</li>)}</ul>}{compiler.artifact && <p>Built source revision: {compiler.artifact.source_revision}</p>}</details></div> : <p>No compiler result is available. Compile the saved firmware to obtain diagnostics.</p>}
          </section>}
          {(testingStage || summaryStage) && !!results && <details><summary>Live observations</summary><p>Compilation: {compilerState}</p><p>Simulation: {observationState}</p><p>{guide.progress.checks['testing.observed']?.confirmed && !guide.progress.checks['testing.observed'].outdated ? 'Behavior: confirmed by you, without a saved measurement log.' : 'Behavior: Not tested — no current observation confirmation.'}</p>{!!results?.serial && <pre aria-label="Recorded serial observations">{results.serial}</pre>}{!!results && !runtimeStale && Object.keys(results.pins).length > 0 && <ul>{Object.entries(results.pins).map(([pin, value]) => <li key={pin}>Observed {pin}: {value.level === null ? 'unknown' : value.level ? 'HIGH' : 'LOW'} · {value.drive}</li>)}</ul>}{!!results && <ul>{[...results.limitations, ...results.support_warnings ?? []].map((item, index) => <li key={index}>{item}</li>)}</ul>}</details>}
          {simulationStage && <section><h3>Run and observe the simulation</h3><p>{observationState} Compare your observations with the expected behavior described in Testing and troubleshooting.</p><div className="build-guide-actions"><button type="button" disabled={disabled || runDisabled || dirty || isRunning} onClick={() => void action(onRun)}>Run simulation</button><button type="button" disabled={disabled || !isRunning} onClick={() => void action(onStop)}>Stop simulation</button><button type="button" disabled={disabled || projectStale || dirty} onClick={() => void perform({ verify: 'simulation' })}>Verify simulation evidence</button></div>
            {results ? <details className="build-guide-diagnostics"><summary>Simulation diagnostics</summary><p role="status">Runtime: {results.running ? 'Running' : 'Stopped'} · {results.engine}{results.state ? ` · ${results.state}` : ''}{runtimeStale ? ' · not current for the saved artifact' : ''}</p><p>Observed simulated time: {results.simulated_ms.toFixed(1)} ms · cycles: {results.cycles}</p>{results.error && <p role="alert">{results.error}</p>}<h4>Serial observations</h4>{results.serial ? <pre aria-label="Live serial observations">{results.serial}</pre> : <p>No serial output observed.</p>}<h4>Pin observations</h4>{Object.keys(results.pins).length ? <ul>{Object.entries(results.pins).map(([pin, value]) => <li key={pin}>{pin}: {value.level === null ? 'unknown' : value.level ? 'HIGH' : 'LOW'} · {value.drive}</li>)}</ul> : <p>No pin observations available.</p>}{[...results.limitations, ...results.support_warnings ?? []].length > 0 && <><h4>Runtime limitations</h4><ul>{[...results.limitations, ...results.support_warnings ?? []].map((item, index) => <li key={index}>{item}</li>)}</ul></>}</details> : <p>Not tested here — no live observations.</p>}
          </section>}
          {!!stageEvidence.length && <details><summary>Automatic check details</summary><ul className="build-guide-evidence">{stageEvidence.map(([name, item]) => <li key={name}><strong>{name.replaceAll('_', ' ')}: {item.status === 'passed' ? 'Automatically verified within stated scope' : item.status}</strong><p>Scope: {readable(item.scope)}</p>{item.details !== undefined && <p>{readable(item.details)}</p>}{item.checked_at && <p>Checked at: <time dateTime={item.checked_at}>{item.checked_at}</time></p>}</li>)}</ul><p>Automatic results are separate from your checklist confirmations.</p></details>}
          <section><h3 id={`${checklistId}-heading`}>Your checklist</h3><p>Check off the work you’ve done.</p>{step.checklist.length ? <fieldset className="build-guide-checklist" aria-labelledby={`${checklistId}-heading`}>{step.checklist.map(check => {
            const state = guide.progress.checks[check.id]
            const outdated = !!state?.outdated || !state?.confirmed && !!guide.progress.outdated_steps[step.id]
            return <label key={check.id}><input type="checkbox" checked={checkIsCurrent(guide, check.id)} disabled={disabled || projectStale} onChange={event => void perform({ update: { check_id: check.id, confirmed: event.target.checked } })} /><span>{check.display_label ?? check.label}{outdated && <small>Changed — check this again.</small>}{state?.confirmed_at && <small>Last confirmed: {state.confirmed_at}</small>}</span></label>
          })}</fieldset> : <p>No manual checklist items are defined for this stage.</p>}</section>
          {summaryStage && !step.sections?.length && <section className="build-guide-summary"><h3>Completion summary</h3><dl><div><dt>Confirmed checklist items</dt><dd>{confirmed}</dd></div><div><dt>Outstanding checklist items</dt><dd>{checklist.length - confirmed}</dd></div><div><dt>Stale checklist items</dt><dd>{stale}</dd></div><div><dt>Automatic checks passed</dt><dd>{automatic} of {evidence.length}</dd></div></dl>{!step.sections?.length && <p>{nextIncomplete ? `Your next unfinished stage is ${nextIncomplete.title}. Open that stage and follow its instructions before confirming the outstanding checklist items.` : 'Your earlier-stage checklist items are confirmed by you. These confirmations do not replace a current compiler result, measured behavior tests, or physical inspection.'}</p>}{checklist.some(item => !checkIsCurrent(guide, item.check.id)) && <ul>{checklist.filter(item => !checkIsCurrent(guide, item.check.id)).map(item => <li key={item.check.id}>{item.step.title}: {item.check.display_label ?? item.check.label}</li>)}</ul>}</section>}
          <footer className="build-guide-step-footer"><button type="button" disabled={disabled || projectStale || currentIndex === 0} onClick={() => void perform({ update: { current_step: guide.steps[currentIndex - 1].id } })}>Previous</button><span>Stage {currentIndex + 1} of {guide.steps.length}</span><button type="button" disabled={disabled || projectStale || currentIndex === guide.steps.length - 1} onClick={() => void perform({ update: { current_step: guide.steps[currentIndex + 1].id } })}>Next</button></footer>
        </article> : <p role="status">The server guide has no stages.</p>}
      </div>
    </>}
  </section>
}
