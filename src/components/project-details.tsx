import { useEffect, useId, useRef, useState } from 'react'
import { Download, X } from 'lucide-react'
import { catalogType } from '../lib/hardware'
import type { CatalogComponent, HardwareComponent, HardwareProject, WireEndpoint } from '../lib/hardware'
import { InstructionsGuide } from './instructions-guide'
import './project-details.css'

export type ProjectDetailsProps = {
  project: HardwareProject
  catalog: CatalogComponent[]
  onClose: () => void
  initialTab?: 'Info' | 'Parts' | 'Wiring' | 'Instructions'
  embedded?: boolean
  readOnly?: boolean
  onOpenPart?: (id: string) => void
  onOpenWiring?: () => void
  onOpenCode?: () => void
}

type DetailsTab = 'Info' | 'Parts' | 'Wiring' | 'Instructions'
const tabs: DetailsTab[] = ['Info', 'Parts', 'Wiring', 'Instructions']

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

function groupParts(components: HardwareComponent[]) {
  const groups = new Map<string, { type: string; properties: Record<string, unknown>; references: string[] }>()
  for (const component of components) {
    const key = JSON.stringify([component.type, canonical(component.properties)])
    const group = groups.get(key)
    if (group) group.references.push(component.id)
    else groups.set(key, { type: component.type, properties: component.properties, references: [component.id] })
  }
  return [...groups.values()]
}

function backupValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(backupValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
      return !/(token|password|passwd|secret|credential|apikey|privatekey|accesskey)/.test(normalized) &&
        !['keys', 'history', 'binary', 'hex', 'artifact', 'artifacts'].includes(normalized)
    }).map(([key, item]) => [key, backupValue(item)]))
  }
  return value
}

function projectBackup(project: HardwareProject) {
  return {
    schema_version: project.schema_version,
    name: project.name,
    board: project.board,
    components: project.components.map(({ id, type, x, y, rotation, properties }) => ({ id, type, x, y, rotation, properties: backupValue(properties) })),
    wires: project.wires.map(({ id, from, to, color }) => ({ id, from: { component: from.component, pin: from.pin }, to: { component: to.component, pin: to.pin }, color })),
    firmware: { filename: project.firmware.filename, source: project.firmware.source, revision: project.firmware.revision },
  }
}

function csvCell(value: string) {
  // Spreadsheet formulas can follow leading whitespace or control characters.
  let offset = 0
  while (offset < value.length && (value.charCodeAt(offset) <= 32 || /\s/.test(value[offset]))) offset++
  const formula = '=+@-'.includes(value[offset] || '\uFFFF')
  const safe = formula || ['\t', '\r', '\n'].includes(value[0]) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}

function download(contents: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  try { link.click() }
  finally {
    link.remove()
    // Leave the URL alive until the browser has consumed the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
}

export function ProjectDetails({ project, catalog, onClose, initialTab = 'Info', embedded = false, readOnly = !project.runtime_token, onOpenPart, onOpenWiring, onOpenCode }: ProjectDetailsProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const filterId = useId()
  const [tab, setTab] = useState<DetailsTab>(initialTab)
  const [filter, setFilter] = useState('')
  const [exportError, setExportError] = useState('')
  const board = catalog.find(item => catalogType(item) === project.board)
  const boardName = board?.name || project.board
  const partName = (type: string) => catalog.find(item => catalogType(item) === type)?.name || type
  const endpoint = (value: WireEndpoint) => `${value.component} · ${value.pin}`
  const groups = groupParts(project.components)
  const compiler = project.compiler
  const artifact = compiler?.artifact
  const declaredStale = (compiler as (typeof compiler & { stale?: boolean }))?.stale === true
  const stale = declaredStale || !!artifact && (artifact.source_revision !== project.firmware.revision || artifact.board !== project.board) ||
    compiler?.source_revision !== undefined && compiler.source_revision !== project.firmware.revision
  const compileSupport = board?.compile === true ? 'Supported for this target' : board?.compile === false ? 'Not supported for this target' : 'Not confirmed by the supplied catalog'
  const externalWireCount = project.wires.filter(wire => wire.from.component !== wire.to.component).length
  const query = filter.trim().toLowerCase()
  const visibleWires = project.wires.filter(wire => [wire.id, wire.from.component, wire.from.pin, wire.to.component, wire.to.pin, wire.color].some(value => value.toLowerCase().includes(query)))
  const filename = project.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project'

  useEffect(() => {
    const element = dialog.current
    if (!embedded && element && !element.open) element.showModal()
    return () => { element?.close() }
  }, [embedded])
  const Container = embedded ? 'section' : 'dialog'

  function exportFile(kind: 'json' | 'csv') {
    setExportError('')
    try {
      if (kind === 'json') download(JSON.stringify(projectBackup(project), null, 2), `${filename}-backup.json`, 'application/json;charset=utf-8')
      else {
        const rows = [['wire_id', 'from_component', 'from_pin', 'to_component', 'to_pin', 'color'], ...project.wires.map(wire => [wire.id, wire.from.component, wire.from.pin, wire.to.component, wire.to.pin, wire.color])]
        download(rows.map(row => row.map(csvCell).join(',')).join('\r\n'), `${filename}-wiring.csv`, 'text/csv;charset=utf-8')
      }
    } catch { setExportError('Could not download the export. Please try again.') }
  }

  return <Container ref={embedded ? undefined : dialog} className={`project-details${embedded ? ' pd-embedded' : ''}${tab === 'Info' ? ' pd-info' : ''}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}>
    <header className="pd-header">
      <div><span className="pd-eyebrow">Project details</span><h2 id={titleId}>{project.name}</h2><p>{boardName} · Project revision {project.revision}</p></div>
      {!embedded && <button type="button" className="pd-close" aria-label="Close project details" onClick={onClose} autoFocus><X size={18} aria-hidden="true" /></button>}
    </header>
    {!embedded && <nav className="pd-tabs" aria-label="Project details tabs">
      {tabs.map(item => <button key={item} type="button" aria-pressed={tab === item} onClick={() => setTab(item)}>{item}</button>)}
    </nav>}
    <section className="pd-body" aria-label={`${tab} project details`}>
      {tab === 'Info' && <>
        <div className="pd-info-heading"><div><span className="pd-eyebrow">Saved project snapshot</span><h3>Project overview</h3><p>Board, connections, firmware, and compiler status in one place.</p></div><span className="pd-board-badge">{boardName}</span></div>
        <dl className="pd-facts">
          <div><dt>Board target</dt><dd>{boardName}<code>{project.board}</code></dd></div>
          <div><dt>Project revision</dt><dd>{project.revision}</dd></div>
          <div><dt>Components</dt><dd>{project.components.length}</dd></div>
          <div><dt>Wire connections</dt><dd>{project.wires.length}</dd></div>
          <div><dt>Firmware file</dt><dd><code>{project.firmware.filename || 'No filename supplied'}</code></dd></div>
          <div><dt>Firmware revision</dt><dd>{project.firmware.revision}</dd></div>
          <div><dt>Source state</dt><dd>{project.firmware.source.trim() ? 'Source present' : 'Source is empty'}</dd></div>
          <div><dt>Compile support</dt><dd>{compileSupport}</dd></div>
          <div><dt>Compiler status</dt><dd>{compiler?.status || 'Not compiled'}{stale && <span className="pd-status">Stale — compile current source again</span>}</dd></div>
          <div><dt>Artifact</dt><dd>{artifact ? `${artifact.format} · source revision ${artifact.source_revision} · target ${artifact.board}` : 'No compiled artifact'}</dd></div>
        </dl>
        <p className="pd-note">Compiler status describes a software build only. It does not verify physical wiring, supply compatibility, or operation on real hardware.</p>
        <p className="pd-muted">This view reflects the supplied project. Unsaved editor changes are not included until the workspace updates the project.</p>
      </>}
      {tab === 'Parts' && <>
        <h3>Parts and configuration</h3>
        <p className="pd-muted">Identical component types and properties are grouped regardless of canvas position or rotation. References identify each placed component.</p>
        {groups.length ? <div className="pd-table-wrap"><table><caption className="pd-sr-only">Project parts grouped by type and configuration</caption><thead><tr><th scope="col">Part</th><th scope="col">Qty</th><th scope="col">References</th><th scope="col">Actual configuration</th></tr></thead><tbody>
          {groups.map(group => <tr key={JSON.stringify([group.type, canonical(group.properties)])}><td>{partName(group.type)}<code>{group.type}</code></td><td>{group.references.length}</td><td>{group.references.join(', ')}</td><td><pre>{JSON.stringify(canonical(group.properties), null, 2)}</pre></td></tr>)}
        </tbody></table></div> : <p className="pd-empty">No components in this project.</p>}
        <div className="pd-note"><strong>Wiring accessories estimate: {externalWireCount} external wire connection{externalWireCount === 1 ? '' : 's'}.</strong><p>Counted from connections between different components. This is not a purchased-wire quantity; cable type, length, connectors, and other accessories must be chosen for the physical build.</p><p>No prices or priced estimates are provided. Parts shown are project definitions, not purchased inventory.</p></div>
      </>}
      {tab === 'Wiring' && <>
        <h3>Pin-to-pin wiring</h3>
        <label className="pd-filter" htmlFor={filterId}>Filter wiring by reference, pin, wire ID, or color<input id={filterId} type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Search wiring" /></label>
        <p className="pd-muted" role="status">{visibleWires.length} of {project.wires.length} connections shown. CSV exports all connections, not just filtered rows.</p>
        {visibleWires.length ? <div className="pd-table-wrap"><table><caption className="pd-sr-only">Exact project wire endpoints</caption><thead><tr><th scope="col">Wire</th><th scope="col">From component / pin</th><th scope="col">To component / pin</th><th scope="col">Color</th></tr></thead><tbody>
          {visibleWires.map((wire, index) => <tr key={`${wire.id}-${index}`}><td><code>{wire.id}</code></td><td><code>{endpoint(wire.from)}</code></td><td><code>{endpoint(wire.to)}</code></td><td>{wire.color}</td></tr>)}
        </tbody></table></div> : <p className="pd-empty">{project.wires.length ? 'No connections match this filter.' : 'No wire connections in this project.'}</p>}
        <p className="pd-note">Endpoint names are copied exactly from the project. Check them against the physical board and component pinouts before applying power.</p>
      </>}
      {tab === 'Instructions' && <InstructionsGuide key={project.id} project={project} catalog={catalog} readOnly={readOnly} onOpenPart={id => { if (onOpenPart) onOpenPart(id); else setTab('Parts') }} onOpenWiring={onOpenWiring} onOpenCode={onOpenCode} />}
    </section>
    <footer className="pd-footer">
      <div className="pd-exports"><button type="button" onClick={() => exportFile('json')}><Download size={14} aria-hidden="true" />Export JSON backup</button><button type="button" onClick={() => exportFile('csv')}><Download size={14} aria-hidden="true" />Export wiring CSV</button></div>
      <p className="pd-muted">Backup includes project definitions and firmware source, not runtime tokens, credential fields, history, or compiled binaries. Review source for embedded secrets before sharing.</p>
      {exportError && <p role="alert">{exportError}</p>}
    </footer>
  </Container>
}
