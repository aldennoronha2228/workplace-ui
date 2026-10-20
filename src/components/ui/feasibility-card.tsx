import { useState } from 'react'

export type FeasibilityReport = {
  id: string
  project_id?: string
  revision?: number
  status: string
  summary?: string
  issues: { code?: string; severity?: string; title?: string; message?: string; reason?: string; alternative?: string }[]
  choices: { id: string; label: string; description?: string }[]
}

export function FeasibilityCard({ report, onChoose, busy, selected }: { report: FeasibilityReport; onChoose: (id: string, choice: string) => void; busy: boolean; selected?: string }) {
  const [choice, setChoice] = useState('')
  if (report.status === 'approved' || report.status === 'revise' || report.status === 'cancel' || !report.issues.length) return null
  return <form aria-label="Prototype feasibility review" onSubmit={event => { event.preventDefault(); if (choice) onChoose(report.id, choice) }} className="my-3 rounded-xl border border-amber-400/25 bg-neutral-900 p-4">
    <h3 className="text-sm font-semibold text-neutral-100">Before we build</h3>
    <p className="mt-2 text-xs leading-5 text-neutral-400">{report.summary || 'Review what WireUp can build and what cannot be tested before changing your project.'}</p>
    <div className="mt-3 space-y-3">{report.issues.map((issue, index) => <div key={issue.code || index} className="rounded-lg border border-neutral-700 p-3 text-xs leading-5"><strong className="text-amber-200">{issue.title || 'Capability to check'}</strong><p className="mt-1 text-neutral-300">{issue.message || issue.reason}</p>{issue.message && issue.reason && <p className="mt-1 text-neutral-400">Why: {issue.reason}</p>}{issue.alternative && <p className="mt-2 text-neutral-300">Alternative: {issue.alternative}</p>}</div>)}</div>
    {selected ? <p role="status" className="mt-4 text-xs text-neutral-400">Your choice: {report.choices.find(option => option.id === selected)?.label || selected}. {busy ? 'The agent is checking the approved plan…' : 'This review has already been answered.'}</p> : <><fieldset disabled={busy} className="mt-4 space-y-2"><legend className="mb-2 text-xs text-neutral-300">How would you like to continue?</legend>{report.choices.map(option => <label key={option.id} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-xs ${choice === option.id ? 'border-blue-400/50 bg-blue-400/5' : 'border-neutral-700'}`}><input type="radio" name={`feasibility-${report.id}`} checked={choice === option.id} onChange={() => setChoice(option.id)} className="mt-1 accent-blue-400" /><span><strong className="font-medium text-neutral-200">{option.label}</strong>{option.description && <span className="mt-1 block leading-5 text-neutral-400">{option.description}</span>}</span></label>)}</fieldset><button disabled={busy || !choice} className="mt-4 w-full rounded-lg bg-blue-500 px-3 py-2.5 text-xs font-medium text-white disabled:opacity-40">{busy ? 'Checking your choice…' : 'Confirm choice'}</button></>}
    <p className="mt-3 text-[11px] leading-5 text-neutral-500">A successful compile does not prove physical safety or that every part is simulated. Unsupported wiring is never guessed.</p>
  </form>
}
