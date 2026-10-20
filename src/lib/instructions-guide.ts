import type { BuildGuideDocument, BuildGuideSection, BuildGuideStep, BuildGuideVerification } from './build-guide'
import type { CatalogComponent, Firmware, HardwareProject, HardwareWire } from './hardware'

export type InstructionsPhaseId = 'fabricate' | 'assemble' | 'wire' | 'bring-up'
export type InstructionsValue = string | number | boolean | null | InstructionsValue[] | { [key: string]: InstructionsValue }
export type InstructionsItem = string | { [key: string]: InstructionsValue }
export type InstructionsCatalog = readonly CatalogComponent[] | Readonly<Record<string, CatalogComponent>>
export type InstructionsCheck = {
  id: string
  label: string
  confirmed: boolean
  outdated: boolean
}
export type InstructionsCard = {
  id: string
  stepId: string
  stage: string
  checkIds: string[]
  checks: InstructionsCheck[]
  title: string
  explanation: string
  why: string
  instructions: string[]
  partIds: string[]
  tools: InstructionsItem[]
  prerequisites: string[]
  details: BuildGuideSection[]
  connections: HardwareWire[]
  source?: Firmware
  warnings: string[]
  material?: InstructionsValue
  settings?: InstructionsValue
  dimensions?: InstructionsValue
  artifacts?: InstructionsValue
  code?: InstructionsValue
  images?: InstructionsValue
  verification?: BuildGuideVerification
  completed: boolean
  outdated: boolean
  outdatedReason?: string
}
export type InstructionsPhase = {
  id: InstructionsPhaseId
  title: string
  cards: InstructionsCard[]
}
export type InstructionsGuide = {
  projectId: string
  version: string
  projectRevision: number
  firmwareRevision: number
  progressRevision: number
  phases: InstructionsPhase[]
}

type SuppliedStep = BuildGuideStep & Record<string, unknown>

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strings(value: unknown): string[] {
  return typeof value === 'string' ? (text(value) ? [text(value)] : [])
    : Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function normalize(value: unknown): InstructionsValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) return value.flatMap(item => {
    const supplied = normalize(item)
    return supplied === undefined ? [] : [supplied]
  })
  const object = record(value)
  if (!object) return undefined
  return Object.fromEntries(Object.entries(object).flatMap(([key, item]) => {
    const supplied = normalize(item)
    return supplied === undefined ? [] : [[key, supplied]]
  }))
}

function items(value: unknown): InstructionsItem[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return values.flatMap<InstructionsItem>(item => {
    if (typeof item === 'string') return text(item) ? [text(item)] : []
    const supplied = record(item) ? normalize(item) : undefined
    return supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? [supplied] : []
  })
}

function sections(value: unknown): BuildGuideSection[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const supplied = record(item)
    if (!supplied) return []
    const title = text(supplied.title)
    const paragraphs = strings(supplied.paragraphs)
    const actions = strings(supplied.actions)
    return title || paragraphs.length || actions.length ? [{ title, paragraphs, actions }] : []
  })
}

function references(step: SuppliedStep): string[] {
  const ids = strings(step.partIds ?? step.part_ids)
  for (const value of [step.components, step.parts, step.pins]) {
    if (!Array.isArray(value)) continue
    for (const item of value) {
      const supplied = record(item)
      if (supplied) ids.push(text(supplied.id), text(supplied.component), text(supplied.ref), text(supplied.partId), text(supplied.part_id))
      // String component references are retained even when the project no longer contains them.
      else if (typeof item === 'string' && value !== step.pins && !/^\d+\s*[×x]\s|^Gather\s/i.test(text(item))) ids.push(text(item))
    }
  }
  return unique(ids)
}

function prerequisites(step: SuppliedStep, details: BuildGuideSection[]): string[] {
  const supplied = strings(step.prerequisites)
  const fromSections = details.filter(section => /prerequisite|before|safety|supply|power|requirements/i.test(section.title))
    .flatMap(section => [...section.paragraphs, ...section.actions])
  const safetyActions = strings(step.instructions).filter(action => /disconnect|power.off|supply.compatibility|logic.level.compatibility/i.test(action))
  return unique([...supplied, ...fromSections, ...safetyActions, ...strings(step.warnings)])
}

function componentNames(project: HardwareProject, catalog: InstructionsCatalog): Map<string, string> {
  const entries: [string, CatalogComponent][] = Array.isArray(catalog)
    ? catalog.map(item => [item.type ?? item.id ?? '', item]) : Object.entries(catalog)
  const kinds = new Map(entries.map(([key, item]) => [item.type ?? item.id ?? key, text(item.name)]))
  const sorted = [...project.components].sort((a, b) => a.id.localeCompare(b.id))
  const totals = new Map<string, number>()
  const seen = new Map<string, number>()
  for (const part of sorted) totals.set(part.type, (totals.get(part.type) ?? 0) + 1)
  return new Map(sorted.map(part => {
    const base = kinds.get(part.type) || part.type
    const number = (seen.get(part.type) ?? 0) + 1
    seen.set(part.type, number)
    return [part.id, (totals.get(part.type) ?? 0) > 1 ? `${base} ${number}` : base]
  }))
}

function wireCopy(wire: HardwareWire): HardwareWire {
  return { id: wire.id, from: { ...wire.from }, to: { ...wire.to }, color: wire.color }
}

function checksFor(guide: BuildGuideDocument, step: SuppliedStep, ids?: string[]): InstructionsCheck[] {
  return (step.checklist ?? []).filter(check => (!ids || ids.includes(check.id)) && Object.hasOwn(guide.progress.checks, check.id))
    .map(check => {
      const state = guide.progress.checks[check.id]
      return { id: check.id, label: text(check.display_label) || text(check.label), confirmed: state.confirmed, outdated: state.outdated }
    })
}

function cardFor(guide: BuildGuideDocument, step: SuppliedStep, stage: string, ids?: string[]): InstructionsCard {
  const details = sections(step.sections)
  const checks = checksFor(guide, step, ids)
  const outdatedReason = guide.progress.outdated_steps[step.id]
  const card: InstructionsCard = {
    id: step.id, stepId: step.id, stage,
    checkIds: checks.map(check => check.id), checks,
    title: text(step.title), explanation: text(step.objective), why: text(step.why),
    instructions: strings(step.instructions), partIds: references(step), tools: items(step.tools),
    prerequisites: prerequisites(step, details), details, connections: [], warnings: strings(step.warnings),
    completed: checks.length > 0 && checks.every(check => check.confirmed && !check.outdated) && !outdatedReason,
    outdated: !!outdatedReason || checks.some(check => check.outdated),
    ...(outdatedReason ? { outdatedReason } : {}),
  }
  for (const key of ['material', 'settings', 'dimensions', 'artifacts', 'code', 'images'] as const) {
    const value = normalize(step[key])
    if (value !== undefined) card[key] = value
  }
  return card
}

function hasTasks(step: SuppliedStep): boolean {
  return strings(step.instructions).length > 0 || sections(step.sections).some(section => section.actions.length > 0)
    || ['material', 'settings', 'dimensions', 'artifacts', 'code', 'images'].some(key => normalize(step[key]) !== undefined)
}

function actionKey(action: string): string {
  return action.trim().replace(/[.!]+$/, '').toLowerCase()
}

/** Adapts saved server tasks without creating checklist IDs or inferring build specifications. */
export function deriveInstructionsGuide(
  guide: BuildGuideDocument,
  project: HardwareProject,
  catalog: InstructionsCatalog = [],
): InstructionsGuide {
  const result: InstructionsGuide = {
    projectId: guide.project_id, version: guide.version, projectRevision: guide.project_revision,
    firmwareRevision: guide.firmware_revision, progressRevision: guide.progress.revision, phases: [],
  }
  if (!project.components.length && !project.wires.length && !project.firmware.source.trim() && !guide.steps.some(step => ['fabricate', 'assemble', 'bring-up'].includes(String(step.stage)) && hasTasks(step as SuppliedStep))) return result

  const names = componentNames(project, catalog)
  const phaseCards: Record<InstructionsPhaseId, InstructionsCard[]> = { fabricate: [], assemble: [], wire: [], 'bring-up': [] }
  const deferredCompletion: SuppliedStep[] = []
  for (const raw of guide.steps) {
    const step = raw as SuppliedStep
    const stage = typeof step.stage === 'string' ? step.stage.toLowerCase() : step.id.toLowerCase()
    if (stage === 'introduction' || step.id === 'introduction') continue
    if (stage === 'completion' || step.id === 'completion') {
      deferredCompletion.push(step)
      continue
    }
    if (stage === 'wiring' || step.id === 'wiring') {
      const savedDetails = sections(step.sections)
      for (const wire of [...project.wires].sort((a, b) => a.id.localeCompare(b.id))) {
        const checkId = `wiring.wire.${wire.id}`
        const card = cardFor(guide, step, 'wiring', [checkId])
        const start = `${names.get(wire.from.component) || wire.from.component} pin ${wire.from.pin}`
        const end = `${names.get(wire.to.component) || wire.to.component} pin ${wire.to.pin}`
        const check = (step.checklist ?? []).find(item => item.id === checkId)
        const serverAction = text(check?.display_label).replace(/^Check /, 'Connect ')
        const matchingDetails = savedDetails.flatMap(section => {
          const actions = section.actions.filter(action => actionKey(action) === actionKey(serverAction) || action.includes(`wire ${wire.id}:`))
          return actions.length ? [{ ...section, paragraphs: [...section.paragraphs], actions }] : []
        })
        card.id = checkId
        card.title = `Connect ${start} to ${end}`
        card.explanation = `Saved connection: ${start} → ${end}.`
        card.instructions = matchingDetails.flatMap(section => section.actions)
        if (!card.instructions.length) card.instructions = [`Connect ${start} to ${end}.`]
        card.details = [...matchingDetails, ...savedDetails.filter(section => !section.actions.length && /check|inspect|before|safety/i.test(section.title))]
        card.partIds = unique([wire.from.component, wire.to.component])
        card.connections = [wireCopy(wire)]
        phaseCards.wire.push(card)
      }
      // An explicit no-wires review is a real server task, not a fabricated connection.
      if (!project.wires.length && hasTasks(step)) phaseCards.wire.push(cardFor(guide, step, stage))
      continue
    }
    if (stage === 'preparation' || step.id === 'preparation') {
      if (!project.components.length && !hasTasks(step)) continue
      const card = cardFor(guide, step, 'preparation')
      card.partIds = unique([...project.components.map(part => part.id), ...card.partIds])
      phaseCards.wire.push(card)
      continue
    }
    if (stage === 'verification' || step.id === 'verification') {
      const card = cardFor(guide, step, 'verification')
      card.connections = project.wires.map(wireCopy)
      card.partIds = unique([...card.partIds, ...project.wires.flatMap(wire => [wire.from.component, wire.to.component])])
      card.verification = 'connections'
      phaseCards.wire.push(card)
      continue
    }
    if (stage === 'firmware' || step.id === 'firmware') {
      if (!project.firmware.source.trim()) continue
      const card = cardFor(guide, step, 'firmware')
      card.source = { ...project.firmware }
      phaseCards['bring-up'].push(card)
      continue
    }
    if (stage === 'simulation' || stage === 'testing' || step.id === 'simulation' || step.id === 'testing') {
      if (!hasTasks(step)) continue
      const card = cardFor(guide, step, stage)
      if (stage === 'simulation' || step.id === 'simulation') card.verification = 'compilation'
      phaseCards['bring-up'].push(card)
      continue
    }
    if (stage === 'bring-up' && (hasTasks(step) || step.checklist?.length)) phaseCards['bring-up'].push(cardFor(guide, step, stage))
    if ((stage === 'fabricate' || stage === 'assemble') && (hasTasks(step) || step.checklist?.length)) phaseCards[stage].push(cardFor(guide, step, stage))
  }

  const existingActions = new Set(Object.values(phaseCards).flat().flatMap(card => [...card.instructions, ...card.details.flatMap(section => section.actions)]).map(actionKey))
  for (const step of deferredCompletion) {
    const card = cardFor(guide, step, 'completion')
    const useful = (action: string) => !existingActions.has(actionKey(action)) && !/^continue with\b/i.test(action)
    card.instructions = card.instructions.filter(useful)
    card.details = card.details.flatMap(section => {
      const actions = section.actions.filter(useful)
      return actions.length ? [{ ...section, actions }] : []
    })
    if (card.instructions.length || card.details.length) phaseCards['bring-up'].push(card)
  }
  // Preparation always precedes saved wires, even if a supplied document is reordered.
  phaseCards.wire.sort((a, b) => {
    const rank = (card: InstructionsCard) => card.stage === 'preparation' ? 0 : card.stage === 'verification' ? 2 : 1
    return rank(a) - rank(b)
  })
  const titles: Record<InstructionsPhaseId, string> = { fabricate: 'Fabricate', assemble: 'Assemble', wire: 'Wire', 'bring-up': 'Bring-up' }
  result.phases = (['fabricate', 'wire', 'bring-up', 'assemble'] as const).flatMap(id => phaseCards[id].length ? [{ id, title: titles[id], cards: phaseCards[id] }] : [])
  return result
}
