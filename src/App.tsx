import { HardwareWorkspace } from './components/hardware-workspace'

// Demo App for UI editing. Hardware data and backend calls are stubbed
// so the layout, catalog, canvas, and panels can be viewed and modified locally.
export default function App() {
  return (
    <HardwareWorkspace
      chatSlot={<div style={{ padding: 16, color: '#8f929a' }}>Agent panel (stubbed)</div>}
    />
  )
}
