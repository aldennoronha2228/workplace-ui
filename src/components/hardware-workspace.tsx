import { useState } from 'react'

const s = {
  root: { display: 'flex', flexDirection: 'column' as const, height: '100dvh', background: '#0f1012', color: '#e6e7ea', font: '12px system-ui, sans-serif' },
  header: { display: 'flex', alignItems: 'center', gap: 12, height: 45, padding: '0 15px', borderBottom: '1px solid #28292e', background: '#141518' },
  workbench: { display: 'grid', gridTemplateColumns: '232px 1fr 340px', flex: 1, minHeight: 0 },
  sidebar: { borderRight: '1px solid #28292e', background: '#17181b', overflow: 'auto', padding: 10 },
  center: { display: 'flex', flexDirection: 'column' as const, background: '#101113' },
  canvas: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(#313339 .65px, transparent .65px)', backgroundSize: '19px 19px', color: '#8f929a' },
  panel: { borderLeft: '1px solid #28292e', background: '#151619', padding: 12, color: '#8f929a' },
  btn: { padding: '6px 10px', border: '1px solid #28292e', borderRadius: 6, background: '#1e2024', color: '#e6e7ea', margin: 4 },
}

export function HardwareWorkspace() {
  const [tab, setTab] = useState('circuit')

  return (
    <div style={s.root}>
      <header style={s.header}>
        <strong>Workplace</strong>
        <span style={{ opacity: 0.6 }}>Prototype</span>
        <span style={{ marginLeft: 'auto', fontSize: 10 }}>Local</span>
      </header>
      <div style={s.workbench}>
        <aside style={s.sidebar}>
          <div>Components</div>
          <input placeholder="Search…" style={{ width: '100%', margin: '8px 0', padding: 6, background: '#121316', border: '1px solid #2c2e33', color: '#e6e7ea', borderRadius: 4 }} />
          <button style={s.btn}>Main Board</button>
          <button style={s.btn}>Component</button>
        </aside>
        <div style={s.center}>
          <div style={{ padding: 8, borderBottom: '1px solid #28292e' }}>
            <button style={s.btn} onClick={() => setTab('circuit')}>Circuit</button>
            <button style={s.btn} onClick={() => setTab('schematic')}>Schematic</button>
            <button style={s.btn}>Run</button>
            <button style={s.btn}>Stop</button>
          </div>
          <div style={s.canvas}>
            {tab === 'circuit' ? 'Circuit canvas' : 'Schematic canvas'}
          </div>
        </div>
        <aside style={s.panel}>Agent panel</aside>
      </div>
    </div>
  )
}
