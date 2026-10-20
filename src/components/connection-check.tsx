import { useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, Cable, CheckCircle2, RefreshCw, Wrench, X } from 'lucide-react'
import type { HardwareProject } from '../lib/hardware'
import { HardwareApiError } from '../lib/hardware'
import { connectionCheckApi } from '../lib/connection-check'
import type { ConnectionCheckResult, ConnectionFinding } from '../lib/connection-check'
import './connection-check.css'

export type ConnectionCheckProps = {
  project: HardwareProject
  repairDisabled: boolean
  dirty: boolean
  onProjectChange: (project: HardwareProject) => void
  onClose: () => void
  onShowPart?: (componentId: string) => void
}

function findingParts(finding: ConnectionFinding): string[] {
  const evidence = finding.evidence ?? {}
  return [...new Set([
    ...(evidence.component_id ? [evidence.component_id] : []),
    ...(evidence.component_ids ?? []),
    ...(evidence.endpoints ?? []).map(endpoint => endpoint.component),
  ])]
}

export function ConnectionCheck(props: ConnectionCheckProps) {
  const { project, dirty, repairDisabled, onClose, onShowPart } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const latest = useRef(props)
  useEffect(() => { latest.current = props })
  const controller = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const titleId = useId()
  const descriptionId = useId()
  const [result, setResult] = useState<ConnectionCheckResult | null>(null)
  const [busy, setBusy] = useState<'check' | 'repair' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const stale = !!result && (result.validation.project_id !== project.id || result.validation.revision !== project.revision)
  const canRepair = !!result?.proposed_repairs.length && !busy && !stale && !conflict && !repairDisabled && !!project.runtime_token && !dirty

  async function check(snapshot = latest.current.project, keepNotice = false) {
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    busyRef.current = true
    setBusy('check'); setError(''); setConfirmed(false)
    if (!keepNotice) setNotice('')
    try {
      const checked = await connectionCheckApi.check(snapshot, abort.signal)
      if (abort.signal.aborted) return
      setResult(checked); setConflict(false)
      return true
    } catch (err) {
      if (!abort.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Could not check connections. Please try again.')
        setConflict(true)
      }
    } finally {
      if (!abort.signal.aborted) { busyRef.current = false; setBusy(null) }
    }
  }

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
    let active = true
    queueMicrotask(() => { if (active) { setResult(null); void check() } })
    return () => { active = false; controller.current?.abort(); busyRef.current = false; element?.close() }
  }, [project.id])

  async function repair() {
    if (!canRepair || !confirmed || !result || busyRef.current) return
    const snapshot = latest.current.project
    const abort = new AbortController()
    controller.current = abort
    busyRef.current = true
    setBusy('repair'); setError(''); setNotice(''); setConfirmed(false)
    let rechecking = false
    try {
      const repaired = await connectionCheckApi.repair(snapshot, result.validation.revision, abort.signal)
      if (abort.signal.aborted) return
      setResult(repaired)
      if (repaired.changed) latest.current.onProjectChange(repaired.project)
      setNotice(repaired.changed
        ? `${repaired.repairs.length} safe repair${repaired.repairs.length === 1 ? '' : 's'} applied. Rechecking the saved connections…`
        : 'No repairs were applied. Rechecking the saved connections…')
      rechecking = true
      const verified = await check(repaired.project, true)
      if (!verified) {
        if (!controller.current?.signal.aborted) setNotice('The repair request finished, but the automatic recheck could not be completed. Recheck before making further changes.')
        return
      }
      if (!controller.current?.signal.aborted) setNotice(repaired.changed
        ? `${repaired.repairs.length} safe repair${repaired.repairs.length === 1 ? '' : 's'} applied. Review the recheck below; other findings may still need your attention.`
        : 'No repairs were applied. Review the recheck below for issues that need manual attention.')
    } catch (err) {
      if (!abort.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Could not repair connections.')
        setConflict(true)
        if (err instanceof HardwareApiError && err.status === 409) setNotice('The project changed since this check. Recheck before repairing again.')
      }
    } finally {
      if (!rechecking && !abort.signal.aborted) { busyRef.current = false; setBusy(null) }
    }
  }

  function findings(title: string, items: ConnectionFinding[], severity: 'error' | 'warning') {
    if (!items.length) return null
    return <section className="connection-check-group" data-severity={severity} aria-label={title}>
      <h3><AlertTriangle size={16} aria-hidden="true"/>{title} <span>{items.length}</span></h3>
      <ul>{items.map((finding, index) => <li key={`${finding.code}-${index}`}>
        <p>{finding.message}</p>
        {!!finding.evidence?.endpoints?.length && <p className="connection-check-muted">{finding.evidence.endpoints.map(endpoint => `${endpoint.component} · ${endpoint.pin}`).join(' ↔ ')}</p>}
        {onShowPart && <div className="connection-check-parts">{findingParts(finding).filter(id => project.components.some(part => part.id === id)).map(id =>
          <button type="button" key={id} disabled={busy === 'repair'} onClick={() => { onClose(); onShowPart(id) }}>Show {id}</button>,
        )}</div>}
      </li>)}</ul>
    </section>
  }

  return <dialog ref={dialog} className="connection-check" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); if (busy !== 'repair') onClose() }}>
    <header className="connection-check-header">
      <h2 id={titleId}><Cable size={21} aria-hidden="true"/>Check connections</h2>
      <button type="button" aria-label="Close connection check" disabled={busy === 'repair'} onClick={onClose}><X size={18}/></button>
    </header>
    <div className="connection-check-body">
      <p id={descriptionId}>Review the saved circuit for connection mistakes and apply only conservative, explicitly offered repairs.</p>
      <p className="connection-check-limit">This is a schematic check, not a full electrical or physical validation. It cannot prove real-world safety, correct breadboard assembly, or intended firmware behavior.</p>
      {dirty && <p className="connection-check-warning">You have unsaved firmware edits. This check inspects saved wiring and does not analyze your editor changes. Save or discard those edits before repairing; checking is still available.</p>}
      {(repairDisabled || !project.runtime_token) && <p className="connection-check-warning">Repairs are unavailable in the current workspace state. You can still run a read-only connection check.</p>}
      {(stale || conflict) && <p className="connection-check-warning">{stale ? 'These findings are for a different project revision.' : 'The last operation could not confirm the current project revision.'} Repairs are disabled. Recheck, and reload the project if its saved revision has changed.</p>}
      <div role="status" aria-live="polite" className="connection-check-status">
        {busy && <p><RefreshCw size={16} className="connection-check-spin" aria-hidden="true"/>{busy === 'repair' ? 'Applying safe repairs…' : 'Checking saved connections…'}</p>}
        {notice && <p>{notice}</p>}
        {!busy && result && <p><CheckCircle2 size={16} aria-hidden="true"/>Revision {result.validation.revision} · {result.validation.errors.length} issue{result.validation.errors.length === 1 ? '' : 's'} · {result.validation.warnings.length} warning{result.validation.warnings.length === 1 ? '' : 's'}</p>}
      </div>
      {error && <p className="connection-check-error" role="alert">{error}</p>}
      {result && <>
        {!result.validation.errors.length && !result.validation.warnings.length && <p className="connection-check-empty">No connection issues were found within this check’s limited scope. Verify the actual hardware and firmware separately.</p>}
        {findings('Connection issues', result.validation.errors, 'error')}
        {findings('Things to review', result.validation.warnings, 'warning')}
        <section className="connection-check-repairs" aria-label="Safe repairs">
          <h3><Wrench size={16} aria-hidden="true"/>Safe repairs</h3>
          {result.proposed_repairs.length ? <>
            <p>Only the changes listed here will be requested. Repairs do not guess missing wires or rewrite firmware.</p>
            <ul>{result.proposed_repairs.map((action, index) => <li key={`${action.wire_id}-${index}`}>{action.operation === 'canonicalize_endpoints' ? 'Use canonical pin names' : action.operation === 'remove_self_wire' ? 'Remove a wire connected to itself' : action.operation === 'remove_duplicate_wire' ? 'Remove a redundant duplicate wire' : action.operation.replaceAll('_', ' ')} · {action.wire_id}</li>)}</ul>
            <label className="connection-check-confirm"><input type="checkbox" checked={confirmed} disabled={!canRepair} onChange={event => setConfirmed(event.target.checked)}/>Apply these safe repairs to the saved circuit, then automatically check it again.</label>
          </> : <p>No automatic safe repairs are offered. Any remaining findings need manual review.</p>}
        </section>
        <details className="connection-check-scope"><summary>What this check covers</summary><p>{result.validation.scope}</p></details>
      </>}
    </div>
    <footer className="connection-check-footer">
      <button type="button" disabled={!!busy} onClick={() => void check()}><RefreshCw size={16} aria-hidden="true"/>Recheck</button>
      <button type="button" className="hw-primary" disabled={!canRepair || !confirmed} onClick={() => void repair()}><Wrench size={16} aria-hidden="true"/>Apply safe repairs</button>
      <button type="button" disabled={busy === 'repair'} onClick={onClose}>Close</button>
    </footer>
  </dialog>
}
