import { Component } from 'react'
import type { ReactNode } from 'react'

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return <main className="flex min-h-svh items-center justify-center bg-neutral-950 p-6 text-white">
      <section className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <h1 className="text-lg font-semibold">Unable to load this workspace</h1>
        <p role="alert" className="mt-3 text-sm leading-6 text-neutral-400">An application error interrupted this page. Reload to fetch the application again, or return to home.</p>
        <p className="mt-3 text-xs leading-5 text-neutral-500">Saved server projects are not deleted by these actions. Unsaved changes on this page may be lost.</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button type="button" onClick={() => window.location.reload()} className="rounded-lg bg-[#4a8fd9] px-4 py-2 text-sm font-medium text-white">Reload page</button>
          <a href="/" className="rounded-lg border border-neutral-700 px-4 py-2 text-sm">Back to home</a>
        </div>
      </section>
    </main>
  }
}
