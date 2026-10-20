import { useEffect, useRef, useState } from 'react'
import { Cable, RefreshCw, Upload, X } from 'lucide-react'
import type { HardwareProject } from '../../lib/hardware'

export type BoardDevice = { port: string; label?: string; boards?: { name?: string; fqbn?: string }[] }
export function BoardFlashDialog({ project, dirty, running, onClose }: { project: HardwareProject; dirty: boolean; running: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [devices, setDevices] = useState<BoardDevice[]>([])
  const [port, setPort] = useState('')
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState('')
  const [output, setOutput] = useState('')
  const [success, setSuccess] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const artifact = project.compiler?.artifact
  const current = !!artifact && ['simulation_ready','compilation_complete'].includes(project.compiler?.status ?? '') && artifact.board === project.board && artifact.source_revision === project.firmware.revision && artifact.project_revision === project.revision && !dirty
  async function refresh() {
    controller.current?.abort()
    const abort = new AbortController(); controller.current = abort
    setLoading(true); setError('')
    try {
      const response = await fetch('/api/hardware/devices', {signal:abort.signal})
      const body = await response.json()
      if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Could not detect connected boards.')
      if (!abort.signal.aborted) { setDevices(body.devices); setPort(''); setConfirmed(false) }
    } catch (err) { if(!abort.signal.aborted) setError(err instanceof Error ? err.message : 'Device detection failed.') }
    finally { if(!abort.signal.aborted) setLoading(false) }
  }
  useEffect(() => {
    dialog.current?.showModal()
    void refresh()
    return () => { controller.current?.abort(); dialog.current?.close() }
  }, [])
  async function flash() {
    if (!confirmed || !port || !current || running || uploading) return
    const abort = new AbortController(); controller.current = abort
    setUploading(true); setError(''); setOutput(''); setSuccess(false)
    try {
      const response = await fetch(`/api/hardware/projects/${encodeURIComponent(project.id)}/flash`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal, body: JSON.stringify({ port, expected_revision: project.revision, source_revision: project.firmware.revision, confirm: true }) })
      const body = await response.json()
      if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Hardware upload failed.')
      setOutput([body.stdout, body.stderr].filter(Boolean).join('\n'))
      if (!body.success) throw new Error(body.error || 'The uploader did not confirm success.')
      setSuccess(true)
    } catch (err) { if (!abort.signal.aborted) setError(err instanceof Error ? err.message : 'Hardware upload failed.') }
    finally { if (!abort.signal.aborted) setUploading(false) }
  }
  return <dialog ref={dialog} className="hw-board-flash" aria-label="Connect and flash board" onCancel={event => { if (uploading) event.preventDefault(); else onClose() }}>
    <header><strong><Cable size={17}/> Connect your actual board</strong><button aria-label="Close board connection" disabled={uploading} onClick={onClose}><X size={16}/></button></header>
    <p>Plug the board into this computer with a data-capable USB cable. Uploading replaces the code on that physical device.</p>
    <p><b>Project target:</b> {project.board}</p>
    {!current && <p role="status">Save and compile the current firmware before flashing.</p>}
    {running && <p role="status">Stop simulation before connecting and uploading.</p>}
    <div className="hw-board-device-row"><label>Connected device<select aria-label="Connected board port" value={port} disabled={loading || uploading} onChange={event => { setPort(event.target.value); setConfirmed(false); setSuccess(false) }}><option value="">Select a USB/serial port</option>{devices.map(device => <option key={device.port} value={device.port}>{device.label || device.port}{device.boards?.[0]?.name ? ` · ${device.boards[0].name}` : ''}</option>)}</select></label><button onClick={() => void refresh()} disabled={loading || uploading}><RefreshCw size={14}/>{loading ? 'Detecting…' : 'Refresh'}</button></div>
    {!loading && !devices.length && <p>No serial boards detected. Check the USB cable and board driver, then refresh.</p>}
    <label className="hw-board-confirm"><input type="checkbox" checked={confirmed} disabled={!port || uploading} onChange={event => setConfirmed(event.target.checked)}/>I selected the correct physical board and want to replace its firmware.</label>
    {error && <p role="alert">{error}</p>}{success && <p role="status">Uploader reported success on {port}. Verify the behavior on your physical board.</p>}
    {output && <details><summary>Uploader output</summary><pre>{output}</pre></details>}
    <footer><button disabled={!current || !port || !confirmed || uploading || running} onClick={() => void flash()}><Upload size={15}/>{uploading ? 'Uploading…' : 'Flash code to board'}</button><small>Close Serial Monitor or other apps using the port. Physical hardware is never flashed by the AI.</small></footer>
  </dialog>
}
