import { useEffect, useRef, useState } from 'react'
import { Wifi, X } from 'lucide-react'
import { getEspNetwork, setEspNetwork } from '../../hardware/espNetwork'

export function EspNetworkDialog({ projectId, board, running, onClose }: { projectId: string; board: string; running: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [settings, setSettings] = useState(() => getEspNetwork(projectId))
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const supported = board === 'esp32-c3' || board === 'esp32-s3'
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  return <dialog ref={dialog} className="hw-board-flash" aria-label="Simulated Wi-Fi network" onCancel={onClose}><header><strong><Wifi size={17}/>Simulated Wi-Fi</strong><button aria-label="Close simulated Wi-Fi" onClick={onClose}><X size={16}/></button></header><p>This configures the access point inside the ESP emulator. Use matching values in your firmware.</p>{!supported && <p role="status">This board has no supported browser Wi-Fi emulator. Circuit and source editing remain available.</p>}<label>Network name (SSID)<input aria-label="Simulated network SSID" value={settings.ssid} onChange={event => { setSettings({ ...settings, ssid: event.target.value }); setSaved(false) }}/></label><label>Password<input aria-label="Simulated network password" type="password" value={settings.password} onChange={event => { setSettings({ ...settings, password: event.target.value }); setSaved(false) }}/></label><p>Internet access and external networking are not connected. Wi-Fi association is emulator-local and is not a connection to your real router. Settings remain in memory for this page; they are not sent to the AI or saved as project secrets.</p>{running && <p role="status">Stop simulation before changing network settings.</p>}{error && <p role="alert">{error}</p>}{saved && <p role="status">Saved. The settings apply when simulation next starts.</p>}<footer><button disabled={!supported || running} onClick={() => { try { setEspNetwork(projectId, settings); setSaved(true); setError('') } catch (err) { setError(err instanceof Error ? err.message : 'Invalid network settings.') } }}>Apply network settings</button></footer></dialog>
}
