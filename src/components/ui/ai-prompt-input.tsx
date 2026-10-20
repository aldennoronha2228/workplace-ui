"use client"

import * as React from "react"
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  GlobeIcon,
  Loader2Icon,
  MicIcon,
  PencilIcon,
  PlusIcon,
  PuzzleIcon,
  SquareIcon,
  TelescopeIcon,
  UnplugIcon,
  UploadIcon,
  XIcon,
} from "lucide-react"
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  type HTMLMotionProps,
} from "framer-motion"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"

/* =============================================================================
 * AiPromptInput — Motoko UI
 *
 * A premium AI prompt composer: auto-growing textarea, rotating placeholder,
 * floating toolbar, Cursor-style model selector, and stateful send control.
 *
 *   <AiPromptInput onSubmit={(value, selection) => console.log(value, selection)} />
 * ============================================================================= */

// ---------------------------------------------------------------------------
// Motion tokens
// ---------------------------------------------------------------------------

const EASE = [0.2, 0, 0, 1] as const
const SPRING_SOFT = { type: "spring" as const, stiffness: 420, damping: 32 }
const SPRING_HEIGHT = { type: "spring" as const, stiffness: 380, damping: 34 }
const SPRING_PRESS = { type: "spring" as const, stiffness: 500, damping: 28 }
const SPRING_ICON = { type: "spring" as const, duration: 0.3, bounce: 0 }

const MENU_PANEL_CLASS = cn(
  "bg-popover text-popover-foreground origin-bottom-left overflow-hidden rounded-2xl border-2 border-border p-1.5",
  "shadow-[0_8px_30px_-8px_rgba(8,8,8,0.18),0_2px_8px_-2px_rgba(8,8,8,0.08)]",
  "dark:shadow-[0_8px_30px_-8px_rgba(0,0,0,0.45),0_2px_8px_-2px_rgba(0,0,0,0.3)]"
)

const CHIP_SURFACE_CLASS = cn(
  "bg-muted text-foreground inline-flex items-center gap-1.5 rounded-full py-1 pr-1 pl-2 text-xs font-medium",
  "shadow-[inset_0_0_0_1px_rgba(123,123,123,0.12)]"
)

const TOOLBAR_BTN_CLASS = cn(
  "relative flex size-9 cursor-pointer items-center justify-center rounded-xl",
  "transition-[background-color,color,box-shadow,opacity,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
  "hover:bg-muted hover:text-foreground",
  "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
  "disabled:pointer-events-none disabled:opacity-40"
)

type PresenceProps = Pick<
  HTMLMotionProps<"span">,
  "initial" | "animate" | "exit" | "transition"
>

const FADE_ONLY: PresenceProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
}

const ICON_SWAP: PresenceProps = {
  initial: { opacity: 0, scale: 0.25, filter: "blur(4px)" },
  animate: { opacity: 1, scale: 1, filter: "blur(0px)" },
  exit: { opacity: 0, scale: 0.25, filter: "blur(4px)" },
  transition: SPRING_ICON,
}

function scaleBlurPresence(reduceMotion: boolean): PresenceProps {
  if (reduceMotion) return FADE_ONLY
  return {
    initial: { opacity: 0, scale: 0.9, filter: "blur(4px)" },
    animate: { opacity: 1, scale: 1, filter: "blur(0px)" },
    exit: { opacity: 0, scale: 0.9, filter: "blur(4px)" },
    transition: SPRING_ICON,
  }
}

function menuPresence(reduceMotion: boolean): PresenceProps {
  if (reduceMotion) return FADE_ONLY
  return {
    initial: { opacity: 0, y: 6, scale: 0.96, filter: "blur(4px)" },
    animate: { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" },
    exit: { opacity: 0, y: 4, scale: 0.98, filter: "blur(2px)" },
    transition: { duration: 0.2, ease: EASE },
  }
}

function placeholderPresence(reduceMotion: boolean): PresenceProps {
  if (reduceMotion) return FADE_ONLY
  return {
    initial: { opacity: 0, y: 6, filter: "blur(4px)" },
    animate: { opacity: 1, y: 0, filter: "blur(0px)" },
    exit: { opacity: 0, y: -6, filter: "blur(4px)" },
    transition: { duration: 0.35, ease: EASE },
  }
}

function iconPresence(reduceMotion: boolean): PresenceProps {
  return reduceMotion ? FADE_ONLY : ICON_SWAP
}

function statusPresence(reduceMotion: boolean): PresenceProps {
  if (reduceMotion) return FADE_ONLY
  return {
    initial: { opacity: 0, scale: 0.92, filter: "blur(4px)" },
    animate: { opacity: 1, scale: 1, filter: "blur(0px)" },
    exit: { opacity: 0, scale: 0.94, filter: "blur(4px)" },
    transition: { type: "spring", duration: 0.35, bounce: 0 },
  }
}

// ---------------------------------------------------------------------------
// AI Model Selector (inlined — 21st has no registry deps)
// ---------------------------------------------------------------------------

function flyoutPresence(reduceMotion: boolean): PresenceProps {
  if (reduceMotion) return FADE_ONLY
  return {
    initial: { opacity: 0, x: -6, scale: 0.98, filter: "blur(4px)" },
    animate: { opacity: 1, x: 0, scale: 1, filter: "blur(0px)" },
    exit: { opacity: 0, x: -4, scale: 0.98, filter: "blur(2px)" },
    transition: { duration: 0.18, ease: EASE },
  }
}

function valuePresence(reduceMotion: boolean): PresenceProps {
  return reduceMotion ? FADE_ONLY : ICON_SWAP
}

const listVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
}

const itemVariants = {
  hidden: { opacity: 0, y: 4 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.2, ease: EASE },
  },
}

const itemVariantsReduced = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.15 } },
}

export type AiModelEffort = "high" | "medium" | "low"

export type AiModel = {
  id: string
  /** Display name, e.g. "Opus 4.5" or "Cursor Grok 4.5". */
  label: string
  description?: string
  efforts?: AiModelEffort[]
  contexts?: Array<string | number>
  supportsFast?: boolean
  supportsThinking?: boolean
  defaultEffort?: AiModelEffort
  defaultContext?: string | number
  defaultFast?: boolean
  defaultThinking?: boolean
  disabled?: boolean
}

/** Full selection: model id + per-model runtime options. */
export type AiModelSelection = {
  id: string
  effort?: AiModelEffort
  context?: string
  fast?: boolean
  thinking?: boolean
}

export const DEFAULT_AI_MODELS: AiModel[] = [
  {
    id: "opus-4.5",
    label: "Opus 4.5",
    description: "Powerful reasoning for complex coding and agentic tasks.",
    efforts: ["high", "medium", "low"],
    contexts: ["200K", "1M"],
    supportsFast: true,
    supportsThinking: true,
    defaultEffort: "high",
    defaultContext: "200K",
    defaultFast: true,
  },
  {
    id: "cursor-grok-4.5",
    label: "Cursor Grok 4.5",
    description: "Fast, capable model tuned for coding workflows.",
    efforts: ["high", "medium", "low"],
    contexts: ["128K", "256K"],
    supportsFast: true,
    supportsThinking: true,
    defaultEffort: "high",
    defaultContext: "128K",
    defaultFast: true,
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    description: "General-purpose reasoning with strong code generation.",
    efforts: ["high", "medium", "low"],
    contexts: ["128K", "400K"],
    supportsFast: true,
    supportsThinking: true,
    defaultEffort: "medium",
    defaultContext: "128K",
  },
  {
    id: "gemini-2.5",
    label: "Gemini 2.5",
    description: "Long-context model for large files and repositories.",
    efforts: ["high", "medium", "low"],
    contexts: ["1M"],
    supportsFast: true,
    supportsThinking: false,
    defaultEffort: "low",
    defaultContext: "1M",
    defaultFast: true,
  },
]

const EFFORT_LABEL: Record<AiModelEffort, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
}

export interface ModelSelectorProps {
  children: React.ReactNode
  models?: AiModel[]
  value?: AiModelSelection
  defaultValue?: AiModelSelection
  onValueChange?: (value: AiModelSelection) => void
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  className?: string
  "aria-label"?: string
}

export interface ModelSelectorTriggerProps extends Omit<
  HTMLMotionProps<"button">,
  "children"
> {
  children?: React.ReactNode
}

export type ModelSelectorValueProps = React.HTMLAttributes<HTMLSpanElement>

export interface ModelSelectorContentProps extends Omit<
  HTMLMotionProps<"div">,
  "children"
> {
  children?: React.ReactNode
  side?: "top" | "bottom"
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface ModelSelectorContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  selection: AiModelSelection
  selectModel: (id: string) => void
  patchSelection: (patch: Partial<AiModelSelection>) => void
  models: AiModel[]
  selectedModel: AiModel | undefined
  disabled: boolean
  reduceMotion: boolean
  triggerRef: React.RefObject<HTMLButtonElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  contentId: string
  layoutGroupId: string
  activeIndex: number
  setActiveIndex: (index: number) => void
  optionIds: string[]
  ariaLabel: string
  side: "top" | "bottom"
  setSide: (side: "top" | "bottom") => void
  editingId: string | null
  setEditingId: (id: string | null) => void
  previewId: string | null
  setPreviewId: (id: string | null) => void
  getConfigFor: (model: AiModel) => AiModelSelection
}

function optionDomId(contentId: string, modelId: string) {
  return `${contentId}-option-${modelId}`
}

function firstEnabledIndex(models: AiModel[], optionIds: string[]) {
  for (let i = 0; i < optionIds.length; i++) {
    const model = models.find((m) => m.id === optionIds[i])
    if (model && !model.disabled) return i
  }
  return 0
}

function lastEnabledIndex(models: AiModel[], optionIds: string[]) {
  for (let i = optionIds.length - 1; i >= 0; i--) {
    const model = models.find((m) => m.id === optionIds[i])
    if (model && !model.disabled) return i
  }
  return Math.max(0, optionIds.length - 1)
}

const ModelSelectorContext =
  React.createContext<ModelSelectorContextValue | null>(null)

function useModelSelectorContext(component: string): ModelSelectorContextValue {
  const ctx = React.useContext(ModelSelectorContext)
  if (!ctx) {
    throw new Error(`${component} must be used within <ModelSelector>`)
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function formatContext(
  context: string | number | undefined
): string | null {
  if (context === undefined || context === "") return null
  if (typeof context === "number") {
    if (context >= 1_000_000) return `${(context / 1_000_000).toFixed(0)}M`
    if (context >= 1_000) return `${Math.round(context / 1_000)}K`
    return String(context)
  }
  return String(context)
}

function defaultSelectionFor(model: AiModel): AiModelSelection {
  return {
    id: model.id,
    effort: model.defaultEffort ?? model.efforts?.[0],
    context:
      formatContext(model.defaultContext ?? model.contexts?.[0]) ?? undefined,
    fast: model.defaultFast ?? false,
    thinking: model.defaultThinking ?? false,
  }
}

function resolveSelection(
  models: AiModel[],
  value?: AiModelSelection
): AiModelSelection {
  const model = models.find((m) => m.id === value?.id) ?? models[0]
  if (!model) {
    return { id: value?.id ?? "" }
  }
  const base = defaultSelectionFor(model)
  if (!value || value.id !== model.id) return base
  return {
    id: model.id,
    effort: value.effort ?? base.effort,
    context: value.context ?? base.context,
    fast: value.fast ?? base.fast,
    thinking: value.thinking ?? base.thinking,
  }
}

function modelHasOptions(model: AiModel): boolean {
  return (
    (model.efforts?.length ?? 0) > 0 ||
    (model.contexts?.length ?? 0) > 0 ||
    !!model.supportsFast ||
    !!model.supportsThinking
  )
}

/** Renders "Opus 4.5 High Fast" with muted modifiers. */
function ModelLabelParts({
  model,
  selection,
  className,
}: {
  model: AiModel | undefined
  selection: AiModelSelection
  className?: string
}) {
  if (!model) {
    return (
      <span className={cn("text-muted-foreground", className)}>Select model</span>
    )
  }

  const mods: string[] = []
  if (selection.effort) mods.push(EFFORT_LABEL[selection.effort])
  if (selection.fast) mods.push("Fast")
  if (selection.thinking) mods.push("Thinking")

  return (
    <span className={cn("flex min-w-0 items-baseline gap-1.5", className)}>
      <span className="text-foreground truncate font-medium">{model.label}</span>
      {mods.map((mod) => (
        <span
          key={mod}
          className="text-muted-foreground/70 shrink-0 font-medium tabular-nums"
        >
          {mod}
        </span>
      ))}
    </span>
  )
}

function OptionChip({
  selected,
  onClick,
  children,
  disabled,
  reduceMotion,
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
  reduceMotion: boolean
}) {
  return (
    <motion.button
      type="button"
      disabled={disabled}
      onClick={onClick}
      whileTap={disabled ? undefined : { scale: 0.96 }}
      transition={SPRING_PRESS}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium",
        "transition-[background-color,color,box-shadow,opacity] duration-150 ease-[cubic-bezier(0.2,0,0,1)]",
        "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
        selected
          ? "bg-muted text-foreground shadow-[inset_0_0_0_1px_rgba(123,123,123,0.16)]"
          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
        disabled && "pointer-events-none opacity-40"
      )}
    >
      <span>{children}</span>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <MenuCheckmark
          visible={selected}
          reduceMotion={reduceMotion}
          className="text-foreground"
        />
      </span>
    </motion.button>
  )
}

function ToggleChip({
  selected,
  onClick,
  children,
  reduceMotion,
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
  reduceMotion: boolean
}) {
  return (
    <motion.button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      whileTap={{ scale: 0.96 }}
      transition={SPRING_PRESS}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium",
        "transition-[background-color,color,box-shadow,opacity] duration-150 ease-[cubic-bezier(0.2,0,0,1)]",
        "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
        selected
          ? "bg-muted text-foreground shadow-[inset_0_0_0_1px_rgba(123,123,123,0.2)]"
          : "text-muted-foreground/70 hover:bg-muted/70 hover:text-muted-foreground"
      )}
    >
      <span>{children}</span>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <MenuCheckmark
          visible={selected}
          reduceMotion={reduceMotion}
          className="text-foreground"
        />
      </span>
    </motion.button>
  )
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

function ModelSelector({
  children,
  models = DEFAULT_AI_MODELS,
  value: valueProp,
  defaultValue,
  onValueChange,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  className,
  "aria-label": ariaLabel = "AI models",
}: ModelSelectorProps) {
  const reduceMotion = usePrefersReducedMotion()
  const layoutGroupId = React.useId()
  const contentId = React.useId()
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  const contentRef = React.useRef<HTMLDivElement | null>(null)

  const initial =
    defaultValue ?? (models[0] ? defaultSelectionFor(models[0]) : { id: "" })

  const [selection, setSelection] = useControllableState({
    value: valueProp,
    defaultValue: initial,
    onChange: onValueChange,
  })

  const [open, setOpenState] = useControllableState({
    value: openProp,
    defaultValue: defaultOpen,
    onChange: onOpenChange,
  })

  const [activeIndex, setActiveIndex] = React.useState(0)
  const [side, setSide] = React.useState<"top" | "bottom">("top")
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [previewId, setPreviewId] = React.useState<string | null>(null)

  const optionIds = React.useMemo(() => models.map((m) => m.id), [models])

  // Cache last config per model so switching models restores options
  const configCacheRef = React.useRef<Record<string, AiModelSelection>>({})

  // Always expose a fully-resolved selection (fills effort/context/fast defaults)
  const resolved = resolveSelection(models, selection)

  React.useEffect(() => {
    if (resolved.id) configCacheRef.current[resolved.id] = resolved
  }, [resolved])

  const selectedModel = models.find((m) => m.id === resolved.id) ?? models[0]

  const getConfigFor = React.useCallback(
    (model: AiModel): AiModelSelection => {
      if (resolved.id === model.id) return resolved
      return configCacheRef.current[model.id] ?? defaultSelectionFor(model)
    },
    [resolved]
  )

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (disabled && next) return
      setOpenState(next)
      if (!next) {
        setEditingId(null)
        setPreviewId(null)
      }
    },
    [disabled, setOpenState]
  )

  const selectModel = React.useCallback(
    (id: string) => {
      const model = models.find((m) => m.id === id)
      if (!model || model.disabled) return
      const next = resolveSelection(models, { ...getConfigFor(model), id })
      setSelection(next)
      setEditingId(null)
      setOpen(false)
      triggerRef.current?.focus()
    },
    [models, getConfigFor, setSelection, setOpen]
  )

  const patchSelection = React.useCallback(
    (patch: Partial<AiModelSelection>) => {
      setSelection((prev) => {
        const id = patch.id ?? prev.id
        const model = models.find((m) => m.id === id)
        const base = model
          ? id === prev.id
            ? resolveSelection(models, prev)
            : (configCacheRef.current[id] ?? defaultSelectionFor(model))
          : prev
        const next = resolveSelection(models, { ...base, ...patch, id })
        configCacheRef.current[id] = next
        return next
      })
    },
    [models, setSelection]
  )

  React.useEffect(() => {
    if (!open) return
    const idx = optionIds.indexOf(resolved.id)
    setActiveIndex(idx >= 0 ? idx : firstEnabledIndex(models, optionIds))
  }, [open, optionIds, resolved.id, models])

  React.useEffect(() => {
    if (!open) return

    const onPointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (!target) return
      const inTrigger = triggerRef.current?.contains(target)
      const inContent = contentRef.current?.contains(target)
      if (!inTrigger && !inContent) setOpen(false)
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        if (editingId) {
          setEditingId(null)
          return
        }
        setOpen(false)
        triggerRef.current?.focus()
        return
      }

      if (editingId || optionIds.length === 0) return

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const delta = event.key === "ArrowDown" ? 1 : -1
        setActiveIndex((prev) => {
          let next = prev
          for (let i = 0; i < optionIds.length; i++) {
            next = (next + delta + optionIds.length) % optionIds.length
            const model = models.find((m) => m.id === optionIds[next])
            if (!model?.disabled) break
          }
          return next
        })
        return
      }

      if (event.key === "Enter" || event.key === " ") {
        const target = event.target as HTMLElement | null
        if (target?.closest("[data-slot='model-selector-item']")) return
        if (target?.closest("[data-slot='model-selector-edit']")) return
        event.preventDefault()
        const id = optionIds[activeIndex]
        if (id) selectModel(id)
        return
      }

      if (event.key === "Home") {
        event.preventDefault()
        setActiveIndex(firstEnabledIndex(models, optionIds))
        return
      }
      if (event.key === "End") {
        event.preventDefault()
        setActiveIndex(lastEnabledIndex(models, optionIds))
      }
    }

    document.addEventListener("mousedown", onPointer)
    document.addEventListener("touchstart", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointer)
      document.removeEventListener("touchstart", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, setOpen, optionIds, activeIndex, models, selectModel, editingId])

  React.useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled, setOpen])

  return (
    <ModelSelectorContext.Provider
      value={{
        open,
        setOpen,
        selection: resolved,
        selectModel,
        patchSelection,
        models,
        selectedModel,
        disabled,
        reduceMotion,
        triggerRef,
        contentRef,
        contentId,
        layoutGroupId,
        activeIndex,
        setActiveIndex,
        optionIds,
        ariaLabel,
        side,
        setSide,
        editingId,
        setEditingId,
        previewId,
        setPreviewId,
        getConfigFor,
      }}
    >
      <div
        data-slot="model-selector"
        data-state={open ? "open" : "closed"}
        className={cn("relative inline-flex", className)}
      >
        {children}
      </div>
    </ModelSelectorContext.Provider>
  )
}

ModelSelector.displayName = "ModelSelector"

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

const ModelSelectorTrigger = React.forwardRef<
  HTMLButtonElement,
  ModelSelectorTriggerProps
>(({ className, children, disabled, onClick, ...props }, ref) => {
  const {
    open,
    setOpen,
    triggerRef,
    contentId,
    disabled: rootDisabled,
    selectedModel,
    selection,
  } = useModelSelectorContext("ModelSelectorTrigger")

  const isDisabled = disabled || rootDisabled
  const label = selectedModel
    ? [
        selectedModel.label,
        selection.effort ? EFFORT_LABEL[selection.effort] : null,
        selection.fast ? "Fast" : null,
        selection.thinking ? "Thinking" : null,
      ]
        .filter(Boolean)
        .join(" ")
    : "Select model"

  return (
    <motion.button
      ref={(node) => assignRef(node, ref, triggerRef)}
      type="button"
      disabled={isDisabled}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={contentId}
      aria-label={`Model: ${label}`}
      data-slot="model-selector-trigger"
      data-state={open ? "open" : "closed"}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || isDisabled) return
        setOpen(!open)
      }}
      whileHover={isDisabled ? undefined : { scale: 1.02, y: -1 }}
      whileTap={isDisabled ? undefined : { scale: 0.96 }}
      transition={SPRING_PRESS}
      className={cn(
        "text-muted-foreground flex min-h-9 cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-xs font-medium",
        "transition-[background-color,color,box-shadow,opacity] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
        "hover:bg-muted hover:text-foreground",
        "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-40",
        open && "bg-muted text-foreground",
        className
      )}
      {...props}
    >
      {children ?? <ModelSelectorValue />}
      <motion.span
        animate={{ rotate: open ? 180 : 0 }}
        transition={{ duration: 0.2, ease: EASE }}
        className="flex shrink-0"
      >
        <ChevronDownIcon className="size-3.5 opacity-60" aria-hidden />
      </motion.span>
    </motion.button>
  )
})
ModelSelectorTrigger.displayName = "ModelSelectorTrigger"

// ---------------------------------------------------------------------------
// Value
// ---------------------------------------------------------------------------

function ModelSelectorValue({ className, ...props }: ModelSelectorValueProps) {
  const { selectedModel, selection, reduceMotion } =
    useModelSelectorContext("ModelSelectorValue")

  return (
    <span
      data-slot="model-selector-value"
      className={cn("relative flex min-w-0 items-center", className)}
      {...props}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={`${selection.id}-${selection.effort}-${selection.fast}-${selection.thinking}`}
          {...valuePresence(reduceMotion)}
          className="flex min-w-0"
        >
          <ModelLabelParts
            model={selectedModel}
            selection={selection}
            className="text-sm"
          />
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
ModelSelectorValue.displayName = "ModelSelectorValue"

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const ModelSelectorContent = React.forwardRef<
  HTMLDivElement,
  ModelSelectorContentProps
>(({ className, children, side: sideProp = "top", style, ...props }, ref) => {
  const {
    open,
    contentId,
    triggerRef,
    contentRef,
    reduceMotion,
    ariaLabel,
    setSide,
    editingId,
    previewId,
    models,
    activeIndex,
    optionIds,
  } = useModelSelectorContext("ModelSelectorContent")

  const [mounted, setMounted] = React.useState(false)
  const [coords, setCoords] = React.useState<{
    top: number
    left: number
  } | null>(null)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  React.useEffect(() => {
    setSide(sideProp)
  }, [sideProp, setSide])

  React.useLayoutEffect(() => {
    if (!open) return

    const update = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      if (sideProp === "bottom") {
        setCoords({
          top: rect.bottom + 8,
          left: rect.left,
        })
      } else {
        setCoords({
          top: rect.top - 8,
          left: rect.left,
        })
      }
    }

    update()
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [open, triggerRef, sideProp])

  if (!mounted) return null

  const list = children ?? <ModelSelectorDefaultItems />
  const editingModel = models.find((m) => m.id === editingId)
  const previewModel = models.find((m) => m.id === previewId)
  const panelModel = editingModel ?? previewModel
  const activeModelId = optionIds[activeIndex]
  const activeOptionId = activeModelId
    ? optionDomId(contentId, activeModelId)
    : undefined

  return createPortal(
    <AnimatePresence>
      {open && coords ? (
        <motion.div
          key={contentId}
          ref={(node) => assignRef(node, ref, contentRef)}
          data-slot="model-selector-content"
          data-editing={editingId ? "" : undefined}
          {...menuPresence(reduceMotion)}
          style={{
            position: "fixed",
            top: sideProp === "top" ? undefined : coords.top,
            bottom: sideProp === "top" ? window.innerHeight - coords.top : undefined,
            left: Math.max(8, Math.min(coords.left, window.innerWidth - 320)),
            maxWidth: "calc(100vw - 16px)",
            maxHeight: sideProp === "top" ? Math.max(80, coords.top - 8) : Math.max(80, window.innerHeight - coords.top - 8),
            overflowY: "auto",
            zIndex: 100,
            ...style,
          }}
          className={cn("dark flex origin-top-left items-start gap-3", className)}
          {...props}
        >
          <div
            id={contentId}
            role="listbox"
            aria-label={ariaLabel}
            aria-activedescendant={activeOptionId}
            data-slot="model-selector-listbox"
            className="min-w-0"
          >
            {list}
          </div>

          <AnimatePresence initial={false}>
            {panelModel ? (
              <ModelSidePanel
                key="model-side-panel"
                model={panelModel}
                editing={!!editingModel}
              />
            ) : null}
          </AnimatePresence>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body
  )
})
ModelSelectorContent.displayName = "ModelSelectorContent"

// ---------------------------------------------------------------------------
// Default list
// ---------------------------------------------------------------------------

function ModelSelectorDefaultItems() {
  const { models, layoutGroupId, reduceMotion, editingId, setPreviewId } =
    useModelSelectorContext("ModelSelectorDefaultItems")

  return (
    <LayoutGroup id={layoutGroupId}>
      <motion.ul
        role="presentation"
        variants={listVariants}
        initial={reduceMotion ? false : "hidden"}
        animate="show"
        className={cn(MENU_PANEL_CLASS, "flex min-w-64 flex-col gap-0.5")}
        onMouseLeave={() => {
          if (!editingId) setPreviewId(null)
        }}
      >
        {models.map((model) => (
          <li key={model.id} role="none">
            <ModelSelectorItem model={model} />
          </li>
        ))}
      </motion.ul>
    </LayoutGroup>
  )
}

// ---------------------------------------------------------------------------
// Stable side panel shell
// ---------------------------------------------------------------------------

function ModelSidePanel({
  model,
  editing,
}: {
  model: AiModel
  editing: boolean
}) {
  const { reduceMotion } = useModelSelectorContext("ModelSidePanel")

  return (
    <motion.aside
      data-slot="model-selector-side-panel"
      aria-label={
        editing ? `${model.label} settings` : `${model.label} details`
      }
      {...flyoutPresence(reduceMotion)}
      className={cn(MENU_PANEL_CLASS, "flex w-56 shrink-0 flex-col gap-3 p-3")}
    >
      {editing ? (
        <ModelEditPanelContent model={model} />
      ) : (
        <ModelInfoPanelContent model={model} />
      )}
    </motion.aside>
  )
}

// ---------------------------------------------------------------------------
// Hover info side panel
// ---------------------------------------------------------------------------

function ModelInfoPanelContent({ model }: { model: AiModel }) {
  const contexts = model.contexts
    ?.map((context) => formatContext(context))
    .filter(Boolean)
    .join(" · ")

  return (
    <>
      <div className="text-foreground text-sm font-semibold">{model.label}</div>
      {model.description ? (
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          {model.description}
        </p>
      ) : null}
      {contexts ? (
        <div className="mt-1 flex flex-col gap-1">
          <span className="text-muted-foreground/70 text-[10px] font-semibold tracking-wide uppercase">
            Context
          </span>
          <span className="text-muted-foreground text-xs font-medium tabular-nums">
            {contexts}
          </span>
        </div>
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Edit side panel
// ---------------------------------------------------------------------------

function ModelEditPanelContent({ model }: { model: AiModel }) {
  const { getConfigFor, patchSelection, reduceMotion } =
    useModelSelectorContext("ModelEditPanelContent")

  const config = getConfigFor(model)
  const efforts = model.efforts ?? []
  const contexts = model.contexts ?? []

  return (
    <>
      {efforts.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="text-muted-foreground/70 px-0.5 text-[10px] font-semibold tracking-wide uppercase">
            Effort
          </div>
          <div className="flex flex-col gap-0.5">
            {efforts.map((effort) => (
              <OptionChip
                key={effort}
                selected={config.effort === effort}
                reduceMotion={reduceMotion}
                onClick={() => patchSelection({ id: model.id, effort })}
              >
                {EFFORT_LABEL[effort]}
              </OptionChip>
            ))}
          </div>
        </div>
      ) : null}

      {contexts.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="text-muted-foreground/70 px-0.5 text-[10px] font-semibold tracking-wide uppercase">
            Context
          </div>
          <div className="flex flex-col gap-0.5">
            {contexts.map((ctx) => {
              const label = formatContext(ctx) ?? String(ctx)
              return (
                <OptionChip
                  key={label}
                  selected={config.context === label}
                  reduceMotion={reduceMotion}
                  onClick={() =>
                    patchSelection({ id: model.id, context: label })
                  }
                >
                  <span className="tabular-nums">{label}</span>
                </OptionChip>
              )
            })}
          </div>
        </div>
      ) : null}

      {(model.supportsFast || model.supportsThinking) && (
        <div className="flex flex-col gap-1.5">
          <div className="text-muted-foreground/70 px-0.5 text-[10px] font-semibold tracking-wide uppercase">
            Modes
          </div>
          <div className="flex flex-col gap-0.5">
            {model.supportsFast ? (
              <ToggleChip
                selected={!!config.fast}
                reduceMotion={reduceMotion}
                onClick={() =>
                  patchSelection({ id: model.id, fast: !config.fast })
                }
              >
                Fast
              </ToggleChip>
            ) : null}
            {model.supportsThinking ? (
              <ToggleChip
                selected={!!config.thinking}
                reduceMotion={reduceMotion}
                onClick={() =>
                  patchSelection({
                    id: model.id,
                    thinking: !config.thinking,
                  })
                }
              >
                Thinking
              </ToggleChip>
            ) : null}
          </div>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

function ModelSelectorItem({ model }: { model: AiModel }) {
  const {
    selection,
    selectModel,
    reduceMotion,
    layoutGroupId,
    contentId,
    activeIndex,
    setActiveIndex,
    optionIds,
    editingId,
    setEditingId,
    setPreviewId,
    getConfigFor,
    patchSelection,
  } = useModelSelectorContext("ModelSelectorItem")

  const isActive = model.id === selection.id
  const isEditing = editingId === model.id
  const optionIndex = optionIds.indexOf(model.id)
  const isHighlighted = optionIndex === activeIndex && optionIndex >= 0
  const isDisabled = !!model.disabled
  const config = getConfigFor(model)
  const optionId = optionDomId(contentId, model.id)
  const hasOptions = modelHasOptions(model)

  const optionRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (isHighlighted) {
      optionRef.current?.scrollIntoView({ block: "nearest" })
    }
  }, [isHighlighted])

  return (
    <motion.div
      variants={reduceMotion ? itemVariantsReduced : itemVariants}
      className={cn(
        "group/item relative flex w-full items-center gap-1 rounded-xl",
        "transition-colors duration-150 ease-[cubic-bezier(0.2,0,0,1)]",
        isActive ? "text-foreground" : "text-muted-foreground",
        isHighlighted && !isActive && "bg-muted/50",
        isEditing && "bg-muted/80",
        isDisabled && "pointer-events-none opacity-40"
      )}
      onMouseEnter={() => {
        if (!isDisabled && optionIndex >= 0) {
          setActiveIndex(optionIndex)
          if (!editingId) setPreviewId(model.id)
        }
      }}
    >
      {isActive ? (
        <motion.span
          layoutId={`${layoutGroupId}-active`}
          className="bg-muted absolute inset-0 rounded-xl"
          transition={SPRING_SOFT}
        />
      ) : null}

      {/* Option has no nested buttons — Edit is a sibling for valid listbox a11y. */}
      <div
        ref={optionRef}
        id={optionId}
        role="option"
        aria-selected={isActive}
        aria-disabled={isDisabled || undefined}
        data-slot="model-selector-item"
        data-highlighted={isHighlighted ? "" : undefined}
        data-active={isActive ? "" : undefined}
        data-editing={isEditing ? "" : undefined}
        onClick={() => {
          if (!isDisabled) selectModel(model.id)
        }}
        className={cn(
          "relative z-10 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left",
          "transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)]",
          !isDisabled && "active:scale-[0.98]"
        )}
      >
        <span className="min-w-0 flex-1">
          <ModelLabelParts
            model={model}
            selection={config}
            className="text-sm"
          />
        </span>
        {isActive ? (
          <MenuCheckmark
            visible
            reduceMotion={reduceMotion}
            className="text-foreground"
          />
        ) : (
          <span className="size-3.5 shrink-0" aria-hidden />
        )}
      </div>

      {hasOptions ? (
        <motion.button
          type="button"
          data-slot="model-selector-edit"
          aria-label={`Edit ${model.label} settings`}
          aria-expanded={isEditing}
          disabled={isDisabled}
          onClick={(event) => {
            event.stopPropagation()
            if (isEditing) {
              setEditingId(null)
              return
            }
            // Opening edit selects this model's config into the active selection
            // so the panel edits the live value, without closing the list.
            patchSelection({ ...config, id: model.id })
            setEditingId(model.id)
          }}
          whileTap={isDisabled ? undefined : { scale: 0.96 }}
          transition={SPRING_PRESS}
          className={cn(
            "relative z-10 mr-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg",
            "text-muted-foreground/70 opacity-0 transition-[opacity,background-color,color] duration-150 ease-[cubic-bezier(0.2,0,0,1)]",
            "hover:bg-accent hover:text-foreground",
            "focus-visible:ring-ring/50 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none",
            "group-hover/item:opacity-100",
            (isEditing || isHighlighted) && "opacity-100",
            isEditing && "bg-accent text-foreground"
          )}
        >
          <PencilIcon className="size-3.5" aria-hidden />
        </motion.button>
      ) : null}
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Kit
// ---------------------------------------------------------------------------

export interface ModelSelectorKitProps {
  models?: AiModel[]
  value?: AiModelSelection
  defaultValue?: AiModelSelection
  onValueChange?: (value: AiModelSelection) => void
  disabled?: boolean
  className?: string
  "aria-label"?: string
}

function ModelSelectorKit({
  models = DEFAULT_AI_MODELS,
  value,
  defaultValue,
  onValueChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: ModelSelectorKitProps) {
  return (
    <ModelSelector
      models={models}
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
      className={className}
      aria-label={ariaLabel}
    >
      <ModelSelectorTrigger>
        <ModelSelectorValue />
      </ModelSelectorTrigger>
      <ModelSelectorContent />
    </ModelSelector>
  )
}
ModelSelectorKit.displayName = "ModelSelectorKit"

// ---------------------------------------------------------------------------
// Public types & defaults
// ---------------------------------------------------------------------------

/** @deprecated Use `AiModel` from the model selector. */
export type AiPromptModel = AiModel

export type AiPromptSendStatus = "idle" | "loading" | "success"

export type DictationPhase = "idle" | "recording" | "processing"

export const DEFAULT_PLACEHOLDERS = [
  "Ask anything...",
  "Explain this React component...",
  "Generate a landing page...",
  "Fix this TypeScript error...",
  "Create a pricing section...",
  "Write SQL query...",
] as const

/** Default models — same set as `DEFAULT_AI_MODELS` from AI Model Selector. */
export const DEFAULT_MODELS: AiModel[] = DEFAULT_AI_MODELS

export interface AiPromptInputProps {
  /** Controlled prompt value. */
  value?: string
  /** Uncontrolled initial value. */
  defaultValue?: string
  /** Fires on every value change. */
  onChange?: (value: string) => void
  /** Fires when the user sends (Enter or Send button). */
  onSubmit?: (value: string, selection: AiModelSelection) => void
  /** Fires while a generation is running so the send button can stop it. */
  onStop?: () => void
  /** Rotating placeholder phrases. Falls back to Motoko defaults. */
  placeholders?: readonly string[]
  /** Interval between placeholder rotates, in ms. */
  placeholderInterval?: number
  /** Available models for the selector. */
  models?: AiModel[]
  /** Controlled model selection (id + effort / context / modes). */
  modelSelection?: AiModelSelection
  /** Uncontrolled initial model selection. */
  defaultModelSelection?: AiModelSelection
  /** Fires when the model selection changes. */
  onModelSelectionChange?: (selection: AiModelSelection) => void
  /** Disable the whole composer. */
  disabled?: boolean
  /** External send status — drives loader / success on the send button. */
  status?: AiPromptSendStatus
  /** Soft limit for the textarea `maxLength` attribute. */
  maxLength?: number
  /** Minimum textarea rows. */
  minRows?: number
  /** Maximum textarea rows before scrolling. */
  maxRows?: number
  /** Show the floating toolbar. */
  showToolbar?: boolean
  /** Show the + actions menu. */
  showActions?: boolean
  /** Show the model selector. */
  showModelSelector?: boolean
  /** Extra items rendered at the top of the + menu. */
  customActions?: Array<{
    id: string
    label: string
    icon?: React.ReactNode
    onSelect: () => void
  }>
  /** Controlled deep research toggle. */
  deepResearch?: boolean
  /** Uncontrolled initial deep research. */
  defaultDeepResearch?: boolean
  /** Fires when deep research is toggled. Providing it enables the menu item. */
  onDeepResearchChange?: (active: boolean) => void
  /** Controlled web search toggle. */
  webSearch?: boolean
  /** Uncontrolled initial web search. */
  defaultWebSearch?: boolean
  /** Fires when web search is toggled. Providing it enables the menu item. */
  onWebSearchChange?: (active: boolean) => void
  /** Fires when Upload file is chosen. Providing it enables the menu item. */
  onUploadFile?: () => void
  /** Fires when Skills is chosen. Providing it enables the menu item. */
  onSkills?: () => void
  /** Fires when Connectors is chosen. Providing it enables the menu item. */
  onConnectors?: () => void
  /**
   * Optional transcript provider for mic dictation.
   * Return the recognized text; an empty string inserts nothing.
   */
  getDictationTranscript?: () => string
  /** Fires when mic dictation starts or stops. */
  onDictationChange?: (listening: boolean) => void
  /** Extra classes on the shell. */
  className?: string
  /** Extra classes on the textarea. */
  textareaClassName?: string
  /** Accessible name for the prompt field. */
  "aria-label"?: string
  /** Test id for the shell. */
  "data-testid"?: string
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

function assignRef<T>(
  node: T | null,
  ...refs: Array<React.Ref<T> | undefined>
) {
  for (const ref of refs) {
    if (typeof ref === "function") ref(node)
    else if (ref) (ref as React.MutableRefObject<T | null>).current = node
  }
}

function usePrefersReducedMotion() {
  const [reduceMotion, setReduceMotion] = React.useState(false)

  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    const sync = () => setReduceMotion(mq.matches)
    sync()
    mq.addEventListener("change", sync)
    return () => mq.removeEventListener("change", sync)
  }, [])

  return reduceMotion
}

function useControllableState<T>({
  value,
  defaultValue,
  onChange,
}: {
  value: T | undefined
  defaultValue: T
  onChange?: (value: T) => void
}): [T, (next: T | ((prev: T) => T)) => void] {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue)
  const isControlled = value !== undefined
  const current = isControlled ? value : uncontrolled

  const setValue = React.useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved =
        typeof next === "function" ? (next as (prev: T) => T)(current) : next
      if (!isControlled) setUncontrolled(resolved)
      onChange?.(resolved)
    },
    [isControlled, onChange, current]
  )

  return [current, setValue]
}

type MenuCoords = { top: number; left: number }

/** Shared open/close, portal coords, outside-click, and Escape for anchored menus. */
function useAnchoredMenu(disabled = false) {
  const [open, setOpen] = React.useState(false)
  const [mounted, setMounted] = React.useState(false)
  const [coords, setCoords] = React.useState<MenuCoords | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const menuId = React.useId()

  React.useEffect(() => {
    setMounted(true)
  }, [])

  React.useLayoutEffect(() => {
    if (!open) return

    const update = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      setCoords({
        top: rect.top + window.scrollY - 8,
        left: rect.left + window.scrollX,
      })
    }

    update()
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [open])

  React.useEffect(() => {
    if (!open) return

    const onPointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (!target) return
      const inTrigger = triggerRef.current?.contains(target)
      const inContent = contentRef.current?.contains(target)
      if (!inTrigger && !inContent) setOpen(false)
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }

    document.addEventListener("mousedown", onPointer)
    document.addEventListener("touchstart", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointer)
      document.removeEventListener("touchstart", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  React.useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return { open, setOpen, mounted, coords, triggerRef, contentRef, menuId }
}

function AnchoredMenuPortal({
  mounted,
  open,
  coords,
  contentRef,
  id,
  role,
  "aria-label": ariaLabel,
  reduceMotion,
  className,
  children,
}: {
  mounted: boolean
  open: boolean
  coords: MenuCoords | null
  contentRef: React.RefObject<HTMLDivElement | null>
  id: string
  role: "menu" | "listbox"
  "aria-label": string
  reduceMotion: boolean
  className?: string
  children: React.ReactNode
}) {
  if (!mounted) return null

  return createPortal(
    <AnimatePresence>
      {open && coords ? (
        <motion.div
          key={id}
          ref={contentRef}
          id={id}
          role={role}
          aria-label={ariaLabel}
          {...menuPresence(reduceMotion)}
          style={{
            position: "absolute",
            top: coords.top,
            left: coords.left,
            transform: "translateY(-100%)",
            zIndex: 50,
          }}
          className={cn("dark", MENU_PANEL_CLASS, className)}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body
  )
}

function MenuCheckmark({
  visible,
  reduceMotion,
  className,
}: {
  visible: boolean
  reduceMotion: boolean
  className?: string
}) {
  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.span
          key="check"
          {...scaleBlurPresence(reduceMotion)}
          className={cn("flex shrink-0", className)}
        >
          <CheckIcon className="size-3.5" aria-hidden />
        </motion.span>
      ) : null}
    </AnimatePresence>
  )
}

function IconSwapFrame({
  swapKey,
  reduceMotion,
  children,
}: {
  swapKey: string
  reduceMotion: boolean
  children: React.ReactNode
}) {
  return (
    <motion.span
      key={swapKey}
      {...iconPresence(reduceMotion)}
      className="relative z-10 flex"
    >
      {children}
    </motion.span>
  )
}

// ---------------------------------------------------------------------------
// Rotating placeholder
// ---------------------------------------------------------------------------

function RotatingPlaceholder({
  phrases,
  interval,
  active,
  reduceMotion,
}: {
  phrases: readonly string[]
  interval: number
  active: boolean
  reduceMotion: boolean
}) {
  const [index, setIndex] = React.useState(0)
  const safePhrases = phrases.length > 0 ? phrases : DEFAULT_PLACEHOLDERS
  const phraseCount = safePhrases.length

  React.useEffect(() => {
    if (!active || reduceMotion || phraseCount <= 1) return
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % phraseCount)
    }, interval)
    return () => window.clearInterval(id)
  }, [active, interval, reduceMotion, phraseCount])

  const current = safePhrases[index % phraseCount] ?? safePhrases[0]

  if (!active) return null

  return (
    <div
      aria-hidden
      className="wireup-rotating-placeholder pointer-events-none absolute inset-x-0 top-0 px-1"
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={current}
          className="text-muted-foreground/70 block truncate text-[15px] leading-7 sm:text-base"
          {...placeholderPresence(reduceMotion)}
        >
          {current}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Active tool chip
// ---------------------------------------------------------------------------

function ActiveToolChip({
  label,
  icon,
  onRemove,
  reduceMotion,
}: {
  label: string
  icon: React.ReactNode
  onRemove: () => void
  reduceMotion: boolean
}) {
  return (
    <motion.span
      layout
      {...scaleBlurPresence(reduceMotion)}
      className={CHIP_SURFACE_CLASS}
    >
      <span className="flex shrink-0 [&_svg]:size-3.5">{icon}</span>
      <span>{label}</span>
      <button
        type="button"
        aria-label={`Disable ${label}`}
        onClick={onRemove}
        className={cn(
          "text-muted-foreground hover:text-foreground flex size-5 cursor-pointer items-center justify-center rounded-full",
          "transition-colors duration-150 ease-[cubic-bezier(0.2,0,0,1)]",
          "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none"
        )}
      >
        <XIcon className="size-3" aria-hidden />
      </button>
    </motion.span>
  )
}

// ---------------------------------------------------------------------------
// Plus actions menu
// ---------------------------------------------------------------------------

function actionsItemClass(active = false) {
  return cn(
    "relative flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm",
    "transition-colors duration-150 ease-[cubic-bezier(0.2,0,0,1)]",
    "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
    active
      ? "bg-muted text-foreground"
      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
  )
}

function PlusActionsMenu({
  disabled,
  reduceMotion,
  customActions,
  deepResearch,
  webSearch,
  onUploadFile,
  onToggleDeepResearch,
  onToggleWebSearch,
  onSkills,
  onConnectors,
}: {
  disabled?: boolean
  reduceMotion: boolean
  customActions?: AiPromptInputProps["customActions"]
  deepResearch: boolean
  webSearch: boolean
  onUploadFile?: () => void
  onToggleDeepResearch?: () => void
  onToggleWebSearch?: () => void
  onSkills?: () => void
  onConnectors?: () => void
}) {
  const { open, setOpen, mounted, coords, triggerRef, contentRef, menuId } =
    useAnchoredMenu(disabled)

  const runAndClose = (action?: () => void) => {
    action?.()
    setOpen(false)
  }

  return (
    <div className="relative">
      <motion.button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Open actions"
        onClick={() => setOpen((v) => !v)}
        whileHover={disabled ? undefined : { scale: 1.05, y: -1 }}
        whileTap={disabled ? undefined : { scale: 0.96 }}
        transition={SPRING_PRESS}
        className={cn(
          TOOLBAR_BTN_CLASS,
          "text-muted-foreground",
          open && "bg-muted text-foreground"
        )}
      >
        <motion.span
          animate={{ rotate: open ? 45 : 0 }}
          transition={{ duration: 0.2, ease: EASE }}
          className="flex [&_svg]:size-4"
        >
          <PlusIcon aria-hidden />
        </motion.span>
      </motion.button>

      <AnchoredMenuPortal
        mounted={mounted}
        open={open}
        coords={coords}
        contentRef={contentRef}
        id={menuId}
        role="menu"
        aria-label="Actions"
        reduceMotion={reduceMotion}
        className="min-w-56"
      >
        <div className="flex flex-col gap-0.5">
          {(customActions ?? []).map((action) => (
            <motion.button
              key={action.id}
              type="button"
              role="menuitem"
              whileTap={{ scale: 0.98 }}
              transition={SPRING_PRESS}
              className={actionsItemClass()}
              onClick={() => runAndClose(action.onSelect)}
            >
              <span className="flex size-4 shrink-0 opacity-70 [&_svg]:size-4">
                {action.icon ?? <PuzzleIcon aria-hidden />}
              </span>
              <span className="min-w-0 flex-1 font-medium">{action.label}</span>
            </motion.button>
          ))}

          {customActions?.length ? (
            <div role="separator" className="bg-border my-1.5 h-px" />
          ) : null}

          {onUploadFile ? (
            <motion.button
              type="button"
              role="menuitem"
              whileTap={{ scale: 0.98 }}
              transition={SPRING_PRESS}
              className={actionsItemClass()}
              onClick={() => runAndClose(onUploadFile)}
            >
              <UploadIcon className="size-4 shrink-0 opacity-70" aria-hidden />
              <span className="font-medium">Upload file</span>
            </motion.button>
          ) : null}

          {onToggleDeepResearch ? (
            <motion.button
              type="button"
              role="menuitemcheckbox"
              aria-checked={deepResearch}
              whileTap={{ scale: 0.98 }}
              transition={SPRING_PRESS}
              className={actionsItemClass(deepResearch)}
              onClick={() => runAndClose(onToggleDeepResearch)}
            >
              <TelescopeIcon className="size-4 shrink-0 opacity-70" aria-hidden />
              <span className="min-w-0 flex-1 font-medium">Deep research</span>
              <MenuCheckmark visible={deepResearch} reduceMotion={reduceMotion} />
            </motion.button>
          ) : null}

          {onToggleWebSearch ? (
            <motion.button
              type="button"
              role="menuitemcheckbox"
              aria-checked={webSearch}
              whileTap={{ scale: 0.98 }}
              transition={SPRING_PRESS}
              className={actionsItemClass(webSearch)}
              onClick={() => runAndClose(onToggleWebSearch)}
            >
              <GlobeIcon className="size-4 shrink-0 opacity-70" aria-hidden />
              <span className="min-w-0 flex-1 font-medium">Web search</span>
              <MenuCheckmark visible={webSearch} reduceMotion={reduceMotion} />
            </motion.button>
          ) : null}

          {onSkills || onConnectors ? (
            <div role="separator" className="bg-border my-1.5 h-px" />
          ) : null}

          {onSkills ? (
            <motion.button
              type="button"
              role="menuitem"
              whileTap={{ scale: 0.98 }}
              transition={SPRING_PRESS}
              className={actionsItemClass()}
              onClick={() => runAndClose(onSkills)}
            >
              <PuzzleIcon className="size-4 shrink-0 opacity-70" aria-hidden />
              <span className="font-medium">Skills</span>
            </motion.button>
          ) : null}

          {onConnectors ? (
            <motion.button
              type="button"
              role="menuitem"
              whileTap={{ scale: 0.98 }}
              transition={SPRING_PRESS}
              className={actionsItemClass()}
              onClick={() => runAndClose(onConnectors)}
            >
              <UnplugIcon className="size-4 shrink-0 opacity-70" aria-hidden />
              <span className="font-medium">Connectors</span>
            </motion.button>
          ) : null}
        </div>
      </AnchoredMenuPortal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dictation UI
// ---------------------------------------------------------------------------

const WAVE_BARS = [0.35, 0.7, 0.45, 0.9, 0.55, 0.8, 0.4] as const

function DictationWaveform({
  processing,
  reduceMotion,
}: {
  processing: boolean
  reduceMotion: boolean
}) {
  return (
    <motion.div
      layout
      {...statusPresence(reduceMotion)}
      className={cn(
        "bg-muted text-foreground flex h-9 items-center gap-2 rounded-xl px-2.5",
        "shadow-[inset_0_0_0_1px_rgba(123,123,123,0.12)]"
      )}
      aria-hidden
    >
      {processing ? (
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <Loader2Icon className="size-3.5 animate-spin" />
          Processing
        </span>
      ) : (
        <div className="flex h-4 items-end gap-[3px]">
          {WAVE_BARS.map((base, index) => (
            <motion.span
              key={index}
              className="bg-foreground w-[3px] origin-bottom rounded-full"
              initial={{ height: 4 }}
              animate={
                reduceMotion
                  ? { height: Math.max(4, base * 14) }
                  : {
                      height: [
                        Math.max(3, base * 6),
                        Math.max(8, base * 16),
                        Math.max(4, base * 9),
                        Math.max(10, base * 14),
                      ],
                    }
              }
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : {
                      duration: 0.7 + index * 0.08,
                      repeat: Infinity,
                      ease: "easeInOut",
                      delay: index * 0.05,
                    }
              }
            />
          ))}
        </div>
      )}
    </motion.div>
  )
}

function MicButton({
  disabled,
  phase,
  onToggle,
  reduceMotion,
}: {
  disabled?: boolean
  phase: DictationPhase
  onToggle: () => void
  reduceMotion: boolean
}) {
  const active = phase === "recording"
  const processing = phase === "processing"
  const label =
    phase === "recording"
      ? "Stop recording"
      : phase === "processing"
        ? "Processing voice"
        : "Start dictation"

  return (
    <motion.button
      type="button"
      aria-label={label}
      aria-pressed={active}
      aria-busy={processing || undefined}
      disabled={disabled || processing}
      onClick={onToggle}
      whileHover={disabled || processing ? undefined : { scale: 1.05, y: -1 }}
      whileTap={disabled || processing ? undefined : { scale: 0.96 }}
      transition={SPRING_PRESS}
      className={cn(
        TOOLBAR_BTN_CLASS,
        "overflow-visible",
        active || processing
          ? "bg-muted text-foreground"
          : "text-muted-foreground"
      )}
    >
      <AnimatePresence>
        {active && !reduceMotion ? (
          <motion.span
            key="mic-ring"
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-xl border border-current"
            initial={{ opacity: 0.45, scale: 1 }}
            animate={{ opacity: 0, scale: 1.55 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.2, ease: EASE, repeat: Infinity }}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence mode="wait" initial={false}>
        {processing ? (
          <IconSwapFrame swapKey="processing" reduceMotion={reduceMotion}>
            <Loader2Icon className="size-4 animate-spin" aria-hidden />
          </IconSwapFrame>
        ) : active ? (
          <IconSwapFrame swapKey="stop" reduceMotion={reduceMotion}>
            <SquareIcon className="size-3.5 fill-current" aria-hidden />
          </IconSwapFrame>
        ) : (
          <IconSwapFrame swapKey="mic" reduceMotion={reduceMotion}>
            <MicIcon className="size-4" aria-hidden />
          </IconSwapFrame>
        )}
      </AnimatePresence>
    </motion.button>
  )
}

function ActionButton({
  disabled,
  status,
  hasText,
  onSend,
  onStop,
  reduceMotion,
}: {
  disabled?: boolean
  status: AiPromptSendStatus
  hasText: boolean
  onSend: () => void
  onStop?: () => void
  reduceMotion: boolean
}) {
  const isLoading = status === "loading"
  const isSuccess = status === "success"
  const canStop = isLoading && !!onStop
  const isDisabled = disabled || (!hasText && !isLoading) || (isLoading && !canStop)

  const label = canStop
    ? "Stop generating"
    : isLoading
      ? "Sending"
      : isSuccess
        ? "Sent"
        : "Send message"

  return (
    <motion.button
      type="button"
      aria-label={label}
      aria-busy={isLoading || undefined}
      disabled={isDisabled}
      onClick={() => {
        if (canStop) onStop?.()
        else onSend()
      }}
      whileHover={isDisabled ? undefined : { scale: 1.06, transition: SPRING_SOFT }}
      whileTap={isDisabled ? undefined : { scale: 0.94 }}
      animate={{
        scale: isSuccess && !isLoading ? [1, 1.08, 1] : 1,
      }}
      transition={SPRING_PRESS}
      className={cn(
        "relative flex size-10 cursor-pointer items-center justify-center overflow-hidden rounded-full",
        "transition-[background-color,box-shadow,opacity,color] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
        "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
        "disabled:pointer-events-none",
        hasText || isLoading || isSuccess
          ? [
              "bg-linear-to-b from-[#2C2C2C] to-[#282828] text-white",
              "shadow-[inset_2px_0_8px_2px_rgba(248,248,248,0.18)]",
              "hover:shadow-[0_0_0_4px_rgba(20,20,20,0.08),inset_2px_0_8px_2px_rgba(248,248,248,0)]",
              "dark:from-[#f7f7f7] dark:to-white dark:text-black",
              "dark:shadow-[inset_2px_0_8px_2px_rgba(24,24,24,0.1)]",
              "dark:hover:shadow-[0_0_0_4px_rgba(255,255,255,0.1)]",
            ]
          : "bg-muted text-muted-foreground"
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        {canStop ? (
          <IconSwapFrame swapKey="stop" reduceMotion={reduceMotion}>
            <SquareIcon className="size-3.5 fill-current" aria-hidden />
          </IconSwapFrame>
        ) : isLoading ? (
          <IconSwapFrame swapKey="loader" reduceMotion={reduceMotion}>
            <Loader2Icon className="size-4 animate-spin" aria-hidden />
          </IconSwapFrame>
        ) : isSuccess ? (
          <IconSwapFrame swapKey="check" reduceMotion={reduceMotion}>
            <CheckIcon className="size-4" aria-hidden />
          </IconSwapFrame>
        ) : (
          <IconSwapFrame swapKey="arrow" reduceMotion={reduceMotion}>
            <ArrowUpIcon className="size-4" aria-hidden />
          </IconSwapFrame>
        )}
      </AnimatePresence>
    </motion.button>
  )
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

const AiPromptInput = React.forwardRef<HTMLTextAreaElement, AiPromptInputProps>(
  (
    {
      value: valueProp,
      defaultValue = "",
      onChange,
      onSubmit,
      onStop,
      placeholders = DEFAULT_PLACEHOLDERS,
      placeholderInterval = 3200,
      models = DEFAULT_MODELS,
      modelSelection: modelSelectionProp,
      defaultModelSelection,
      onModelSelectionChange,
      disabled = false,
      status = "idle",
      maxLength = 4000,
      minRows = 1,
      maxRows = 8,
      showToolbar = true,
      showActions = true,
      showModelSelector = true,
      customActions,
      deepResearch: deepResearchProp,
      defaultDeepResearch = false,
      onDeepResearchChange,
      webSearch: webSearchProp,
      defaultWebSearch = false,
      onWebSearchChange,
      onUploadFile,
      onSkills,
      onConnectors,
      getDictationTranscript,
      onDictationChange,
      className,
      textareaClassName,
      "aria-label": ariaLabel = "AI prompt",
      "data-testid": dataTestId,
    },
    ref
  ) => {
    const [value, setValue] = useControllableState({
      value: valueProp,
      defaultValue,
      onChange,
    })

    const initialSelection =
      defaultModelSelection ??
      (models[0] ? defaultSelectionFor(models[0]) : { id: "" })
    const [modelSelection, setModelSelection] = useControllableState({
      value: modelSelectionProp,
      defaultValue: initialSelection,
      onChange: onModelSelectionChange,
    })

    const [deepResearch, setDeepResearch] = useControllableState({
      value: deepResearchProp,
      defaultValue: defaultDeepResearch,
      onChange: onDeepResearchChange,
    })

    const [webSearch, setWebSearch] = useControllableState({
      value: webSearchProp,
      defaultValue: defaultWebSearch,
      onChange: onWebSearchChange,
    })

    const [focused, setFocused] = React.useState(false)
    const [height, setHeight] = React.useState<number | "auto">("auto")
    const reduceMotion = usePrefersReducedMotion()
    const [dictationPhase, setDictationPhase] =
      React.useState<DictationPhase>("idle")

    const valueRef = React.useRef(value)
    valueRef.current = value
    const processTimer = React.useRef<number | null>(null)
    const getTranscriptRef = React.useRef(getDictationTranscript)
    getTranscriptRef.current = getDictationTranscript

    const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
    const mirrorRef = React.useRef<HTMLDivElement | null>(null)
    const fieldId = React.useId()

    const trimmed = value.trim()
    const hasText = trimmed.length > 0
    const showPlaceholder = value.length === 0 && !focused
    const hasActiveTools = deepResearch || webSearch
    const dictating = dictationPhase !== "idle"
    const sessionLocked = dictating

    React.useEffect(() => {
      return () => {
        if (processTimer.current !== null) {
          window.clearTimeout(processTimer.current)
        }
      }
    }, [])

    const resize = React.useCallback(() => {
      const el = textareaRef.current
      const mirror = mirrorRef.current
      if (!el) return

      const styles = window.getComputedStyle(el)
      const lineHeight = Number.parseFloat(styles.lineHeight) || 28
      const paddingY =
        Number.parseFloat(styles.paddingTop) +
        Number.parseFloat(styles.paddingBottom)
      const minH = lineHeight * minRows + paddingY
      const maxH = lineHeight * maxRows + paddingY

      if (mirror) {
        mirror.style.width = `${el.clientWidth}px`
        mirror.textContent = value.endsWith("\n") ? `${value} ` : value || " "
        const next = Math.min(Math.max(mirror.scrollHeight, minH), maxH)
        setHeight(next)
        el.style.overflowY = mirror.scrollHeight > maxH ? "auto" : "hidden"
      } else {
        el.style.height = "auto"
        const next = Math.min(Math.max(el.scrollHeight, minH), maxH)
        setHeight(next)
        el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden"
      }
    }, [value, minRows, maxRows])

    React.useLayoutEffect(() => {
      resize()
    }, [resize])

    const submit = React.useCallback(() => {
      if (disabled || status === "loading" || !trimmed) return
      onSubmit?.(trimmed, modelSelection)
    }, [disabled, status, trimmed, onSubmit, modelSelection])

    const finishDictation = React.useCallback(() => {
      setDictationPhase("processing")
      onDictationChange?.(false)
      if (processTimer.current !== null) {
        window.clearTimeout(processTimer.current)
      }
      processTimer.current = window.setTimeout(() => {
        // With a transcript provider the recognized text is real; an empty
        // result inserts nothing. Without one, cycle demo phrases.
        const sample = getTranscriptRef.current
          ? getTranscriptRef.current()
          : DEMO_TRANSCRIPTS[0]
        if (sample) {
          const current = valueRef.current
          const nextValue = current.trim()
            ? `${current.trim()} ${sample}`
            : sample
          setValue(nextValue)
        }
        setDictationPhase("idle")
        processTimer.current = null
      }, 1100)
    }, [onDictationChange, setValue])

    const toggleDictation = React.useCallback(() => {
      if (disabled || dictationPhase === "processing") return
      if (dictationPhase === "recording") {
        finishDictation()
        return
      }
      setDictationPhase("recording")
      onDictationChange?.(true)
    }, [disabled, dictationPhase, finishDictation, onDictationChange])

    const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault()
        submit()
      }
    }

    return (
      <motion.div
        data-slot="ai-prompt-input"
        data-focused={focused || undefined}
        data-disabled={disabled || undefined}
        data-status={status}
        data-dictating={dictating || undefined}
        data-dictation-phase={
          dictationPhase === "idle" ? undefined : dictationPhase
        }
        animate={
          reduceMotion
            ? undefined
            : {
                boxShadow: focused
                  ? "0 2px 8px rgba(8,8,8,0.06), 0 16px 48px -12px rgba(8,8,8,0.22)"
                  : "0 1px 2px rgba(8,8,8,0.04), 0 8px 24px -12px rgba(8,8,8,0.14)",
              }
        }
        transition={{ duration: 0.28, ease: EASE }}
        className={cn(
          "bg-popover border-border relative w-full overflow-visible rounded-[1.75rem] border-2 p-3.5 sm:p-4",
          "transition-[background-color,opacity] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
          disabled && "pointer-events-none opacity-55",
          className
        )}
        data-testid={dataTestId}
      >
        <div
          ref={mirrorRef}
          aria-hidden
          className="invisible absolute top-0 left-0 -z-10 px-1 text-[15px] leading-7 break-words whitespace-pre-wrap sm:text-base"
        />

        <AnimatePresence initial={false}>
          {hasActiveTools ? (
            <motion.div
              key="active-tools"
              initial={false}
              className="mb-2.5 flex flex-wrap items-center gap-1.5 px-0.5"
            >
              <AnimatePresence initial={false} mode="popLayout">
                {deepResearch ? (
                  <ActiveToolChip
                    key="deep-research"
                    label="Deep research"
                    icon={<TelescopeIcon aria-hidden />}
                    reduceMotion={reduceMotion}
                    onRemove={() => setDeepResearch(false)}
                  />
                ) : null}
                {webSearch ? (
                  <ActiveToolChip
                    key="web-search"
                    label="Web search"
                    icon={<GlobeIcon aria-hidden />}
                    reduceMotion={reduceMotion}
                    onRemove={() => setWebSearch(false)}
                  />
                ) : null}
              </AnimatePresence>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div
          className={cn(
            "relative min-h-7 transition-opacity duration-200 ease-[cubic-bezier(0.2,0,0,1)]"
          )}
        >
          <RotatingPlaceholder
            phrases={placeholders}
            interval={placeholderInterval}
            active={showPlaceholder}
            reduceMotion={reduceMotion}
          />

          <motion.textarea
            id={fieldId}
            ref={(node) => assignRef(node, ref, textareaRef)}
            value={value}
            disabled={disabled || sessionLocked}
            rows={minRows}
            maxLength={maxLength}
            aria-label={ariaLabel}
            aria-multiline="true"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            animate={
              reduceMotion
                ? undefined
                : { height: typeof height === "number" ? height : undefined }
            }
            transition={SPRING_HEIGHT}
            className={cn(
              "text-foreground relative z-10 block w-full resize-none bg-transparent px-1",
              "text-[15px] leading-7 sm:text-base",
              "placeholder:text-transparent",
              "outline-none focus-visible:outline-none",
              "disabled:cursor-not-allowed",
              "caret-foreground",
              textareaClassName
            )}
            style={
              reduceMotion && typeof height === "number"
                ? { height }
                : undefined
            }
          />
        </div>

        <AnimatePresence initial={false}>
          {showToolbar ? (
            <motion.div
              key="toolbar"
              initial={false}
              animate={{
                opacity:
                  focused ||
                  value.length > 0 ||
                  hasActiveTools ||
                  dictating
                    ? 1
                    : 0.78,
                y: 0,
              }}
              transition={{ duration: 0.22, ease: EASE }}
              className="border-border mt-3 flex items-center justify-between gap-2 border-t pt-3 sm:mt-3.5"
            >
              <div
                className={cn(
                  "flex min-w-0 items-center gap-0.5 transition-opacity duration-200 ease-[cubic-bezier(0.2,0,0,1)] sm:gap-1",
                  sessionLocked && "pointer-events-none opacity-40"
                )}
              >
                {showActions &&
                (!!customActions?.length ||
                  !!onUploadFile ||
                  !!onSkills ||
                  !!onConnectors ||
                  !!onDeepResearchChange ||
                  !!onWebSearchChange) ? (
                  <PlusActionsMenu
                    disabled={disabled || sessionLocked}
                    reduceMotion={reduceMotion}
                    customActions={customActions}
                    deepResearch={deepResearch}
                    webSearch={webSearch}
                    onUploadFile={onUploadFile}
                    onToggleDeepResearch={onDeepResearchChange ? () => setDeepResearch(!deepResearch) : undefined}
                    onToggleWebSearch={onWebSearchChange ? () => setWebSearch(!webSearch) : undefined}
                    onSkills={onSkills}
                    onConnectors={onConnectors}
                  />
                ) : null}

                {showModelSelector && models.length > 0 ? (
                  <ModelSelector
                    models={models}
                    value={modelSelection}
                    onValueChange={setModelSelection}
                    disabled={disabled || sessionLocked}
                  >
                    <ModelSelectorTrigger className="h-9">
                      <ModelSelectorValue className="max-w-40 sm:max-w-52" />
                    </ModelSelectorTrigger>
                    <ModelSelectorContent side="top" />
                  </ModelSelector>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <AnimatePresence initial={false}>
                  {dictating ? (
                    <DictationWaveform
                      key="dictation-wave"
                      processing={dictationPhase === "processing"}
                      reduceMotion={reduceMotion}
                    />
                  ) : null}
                </AnimatePresence>

                {SUPPORTS_DICTATION ? (
                  <MicButton
                    disabled={disabled || status === "loading"}
                    phase={dictationPhase}
                    onToggle={toggleDictation}
                    reduceMotion={reduceMotion}
                  />
                ) : null}
                <ActionButton
                  disabled={disabled || dictationPhase !== "idle"}
                  status={status}
                  hasText={hasText}
                  onSend={submit}
                  onStop={onStop}
                  reduceMotion={reduceMotion}
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    )
  }
)

AiPromptInput.displayName = "AiPromptInput"

const DEMO_TRANSCRIPTS = [
  "Explain how this Motoko component handles focus and motion.",
  "Generate a pricing section with three tiers and a soft Motoko surface.",
  "Refactor this TypeScript module to use stricter types.",
] as const

const SUPPORTS_DICTATION =
  typeof window !== "undefined" &&
  !!((window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition)

export { AiPromptInput }

export default AiPromptInput
