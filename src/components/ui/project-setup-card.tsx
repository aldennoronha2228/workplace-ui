import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { ProjectQuestionForm } from './project-questions'
import type { ProjectQuestions } from './project-questions'

export function ProjectSetupCard({ data, busy, onConfirm, onClose }: { data: ProjectQuestions; busy: boolean; onConfirm: (answers: Record<string, string>) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    element.showModal()
    return () => element.close()
  }, [])
  return <dialog ref={dialog} aria-label="Set up your project" onCancel={event => { event.preventDefault(); if (!busy) onClose() }} className="fixed inset-0 m-auto max-h-[90dvh] w-[min(720px,calc(100vw-24px))] overflow-y-auto rounded-2xl border border-neutral-700 bg-neutral-950 p-0 text-neutral-100 shadow-2xl backdrop:bg-black/70">
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-800 bg-neutral-950 px-5 py-4"><h2 className="text-base font-semibold">Set up your project</h2><button type="button" aria-label="Close project setup" disabled={busy} onClick={onClose} className="rounded p-2 hover:bg-neutral-800"><X size={18}/></button></header>
    <div className="p-4 sm:p-6"><ProjectQuestionForm key={JSON.stringify(data)} data={data} onConfirm={onConfirm} disabled={busy}/></div>
  </dialog>
}
