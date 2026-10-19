import { useState } from 'react'
import { Search, CircuitBoard, Code2, Cpu, Play, Square, Maximize, Minus, Plus, Terminal } from 'lucide-react'
import './hardware-workspace.css'

export function HardwareWorkspace() {
  const [tab, setTab] = useState<'circuit' | 'schematic'>('circuit')
  const [query, setQuery] = useState('')
  const [consoleOpen, setConsoleOpen] = useState(false)

  return (
    <div className="hardware-workspace">
      <header className="hw-header">
        <div className="hw-brand"><CircuitBoard size={20} /><span>Workplace</span></div>
        <div className="hw-header-divider" />
        <span className="hw-project-title">Prototype</span>
        <span className="hw-chip">Board</span>
        <div className="hw-header-spacer" />
        <div className="hw-local"><span /> Local</div>
      </header>

      <div className="hw-workbench">
        <aside className="hw-sidebar">
          <div className="hw-panel-heading">Components <span>3</span></div>
          <label className="hw-search"><Search size={14} /><input placeholder="Search…" value={query} onChange={e => setQuery(e.target.value)} /></label>
          <div className="hw-catalog">
            <details className="hw-category" open>
              <summary>Boards <span>1</span></summary>
              <div className="hw-category-grid">
                <button className="hw-catalog-card"><Cpu size={22} /><strong>Main Board</strong><small>board</small></button>
              </div>
            </details>
            <details className="hw-category" open>
              <summary>Parts <span>1</span></summary>
              <div className="hw-category-grid">
                <button className="hw-catalog-card"><span className="hw-catalog-art"><Cpu size={22} /></span><strong>Component</strong><small>part</small></button>
              </div>
            </details>
          </div>
        </aside>

        <div className="hw-center">
          <div className="hw-toolbar">
            <div className="hw-view-tabs">
              <button aria-selected={tab === 'circuit'} onClick={() => setTab('circuit')}>Circuit</button>
              <button aria-selected={tab === 'schematic'} onClick={() => setTab('schematic')}>Schematic</button>
            </div>
            <div className="hw-actions">
              <button><Play size={13} /> Run</button>
              <button className="hw-stop"><Square size={13} /> Stop</button>
              <button><Code2 size={13} /> Code</button>
            </div>
          </div>
          <div className="hw-design-surface">
            <div className="hw-canvas-viewport">
              <div className="hw-canvas" style={{ minHeight: '100%', background: 'radial-gradient(#313339 .65px, transparent .65px)', backgroundSize: '19px 19px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8f929a' }}>
                {tab === 'circuit' ? 'Circuit canvas' : 'Schematic canvas'}
              </div>
            </div>
            <div className="hw-floating-tools">
              <button><Maximize size={14} /></button>
              <i />
              <button><Minus size={14} /></button>
              <span>100%</span>
              <button><Plus size={14} /></button>
            </div>
          </div>
          <div className="hw-dock" data-open={consoleOpen}>
            <nav>
              <button className={consoleOpen ? 'active' : ''} onClick={() => setConsoleOpen(v => !v)}><Terminal size={12} /> Console</button>
              <button>Serial</button>
              <button>Results</button>
              <button className="hw-console-collapse" onClick={() => setConsoleOpen(v => !v)}>{consoleOpen ? '▼' : '▲'}</button>
            </nav>
            {consoleOpen && <div className="hw-dock-body"><pre>Ready</pre></div>}
          </div>
        </div>

        <aside style={{ borderLeft: '1px solid #28292e', background: '#151619', padding: 12, width: 340, color: '#8f929a' }}>
          Agent panel
        </aside>
      </div>
    </div>
  )
}
