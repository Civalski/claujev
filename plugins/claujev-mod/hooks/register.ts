// ClauJev mod. Copyright (c) 2026 Alisson Civalski — MIT License — https://github.com/Civalski/claujev
import type { EngineInterface, Register } from 'claude-code'

// The claujev plugin's hooks write to ~/.claude/claujev; the mod only reads it.
// Triage (UserPromptSubmit) stores the effort suggestion in state/<session>.json,
// and every hook appends a line to logs/<day>.jsonl.

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

type TurnState = { effort?: Effort | null; explicitEffort?: boolean }
type LogEntry = {
  hook?: string
  acted?: boolean
  error?: string
  effort?: string
  flagged?: string[]
  problems?: string[]
  inputTokens?: number
}

const PRICE_PER_M_INPUT = 0.042

const TEXT = {
  en: {
    effort: 'effort',
    suggested: 'suggested',
    acted: (hook: string, detail: string) => `Jev acted (${hook}): ${detail}`,
    summaryTitle: 'ClauJev today',
    noLogs: 'No Jev activity logged today.',
    calls: 'calls',
    actedCol: 'acted',
    errors: 'errors',
    cost: 'cost',
    efforts: 'suggested effort',
    commandDesc: "Show today's Jev activity: calls, actions, cost and suggested effort",
  },
  pt: {
    effort: 'esforço',
    suggested: 'sugerido',
    acted: (hook: string, detail: string) => `Jev agiu (${hook}): ${detail}`,
    summaryTitle: 'ClauJev hoje',
    noLogs: 'Nenhuma atividade do Jev registrada hoje.',
    calls: 'chamadas',
    actedCol: 'agiu',
    errors: 'erros',
    cost: 'custo',
    efforts: 'esforço sugerido',
    commandDesc: 'Mostra a atividade do Jev hoje: chamadas, ações, custo e esforço sugerido',
  },
}
type Texts = (typeof TEXT)['en'] | (typeof TEXT)['pt']

// What the hooks share; module variables start over on a reload, which only costs one re-read.
type Ctx = { t: Texts; showStatus: boolean; seenLines: number }

const isLevel = (v: unknown): v is Effort => typeof v === 'string' && (LEVELS as readonly string[]).includes(v)

// Keeps the suggestion inside the limits the user set.
export function clampEffort(suggested: Effort, min: Effort, max: Effort): Effort {
  const i = LEVELS.indexOf(suggested)
  const lo = LEVELS.indexOf(min)
  const hi = Math.max(lo, LEVELS.indexOf(max))
  return LEVELS[Math.min(Math.max(i, lo), hi)] ?? suggested
}

export function parseLog(text: string): LogEntry[] {
  const out: LogEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as LogEntry)
    } catch {
      // a line cut while being written; the next read gets it whole
    }
  }
  return out
}

export function effortLabel(t: Texts, d: { effort: Effort; applied: boolean } | null | undefined): string | undefined {
  return d ? `${t.effort} ${d.effort}${d.applied ? '' : ` (${t.suggested})`}` : undefined
}

async function dataDir($: EngineInterface): Promise<string | undefined> {
  const custom = await $.env.get('CLAUJEV_HOME')
  if (custom) return custom.replace(/\\/g, '/')
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return home ? `${home.replace(/\\/g, '/')}/.claude/claujev` : undefined
}

async function readState($: EngineInterface): Promise<TurnState | null> {
  const dir = await dataDir($)
  if (!dir) return null
  const sid = (await $.session.id()).replace(/[^\w-]/g, '')
  try {
    return JSON.parse(await $.fs.read(`${dir}/state/${sid}.json`)) as TurnState
  } catch {
    return null
  }
}

async function todayLog($: EngineInterface): Promise<LogEntry[]> {
  const dir = await dataDir($)
  if (!dir) return []
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  try {
    return parseLog(await $.fs.read(`${dir}/logs/${day}.jsonl`))
  } catch {
    return []
  }
}

// Shows the day's numbers, and a toast for each new action Jev took since the last look.
async function refresh($: EngineInterface, ctx: Ctx, label?: string): Promise<void> {
  const entries = await todayLog($)
  if (ctx.seenLines >= 0) {
    for (const e of entries.slice(ctx.seenLines)) {
      if (!e.acted || e.hook === 'prompt') continue
      const detail = e.problems?.[0] || e.flagged?.[0] || ''
      $.ui.toast(ctx.t.acted(e.hook ?? '?', detail.slice(0, 120)))
    }
  }
  ctx.seenLines = entries.length
  if (!ctx.showStatus) return
  const calls = entries.filter(e => !e.error).length
  const acted = entries.filter(e => e.acted).length
  $.ui.status([`Jev ✓${calls} ⚑${acted}`, label].filter(Boolean).join(' · '))
}

async function summary($: EngineInterface, t: Texts): Promise<string> {
  const entries = await todayLog($)
  if (!entries.length) return t.noLogs
  const byHook = new Map<string, { calls: number; acted: number; errors: number }>()
  const efforts = new Map<string, number>()
  let tokens = 0
  for (const e of entries) {
    const hook = e.hook ?? '?'
    const s = byHook.get(hook) ?? { calls: 0, acted: 0, errors: 0 }
    s.calls += 1
    if (e.acted) s.acted += 1
    if (e.error) s.errors += 1
    byHook.set(hook, s)
    tokens += e.inputTokens ?? 0
    if (hook === 'prompt' && e.effort) efforts.set(e.effort, (efforts.get(e.effort) ?? 0) + 1)
  }
  const rows = [...byHook].map(([hook, s]) => `  ${hook.padEnd(9)} ${t.calls} ${s.calls}  ${t.actedCol} ${s.acted}  ${t.errors} ${s.errors}`)
  const effortLine = LEVELS.filter(l => efforts.has(l)).map(l => `${l} ${efforts.get(l)}`).join(' · ')
  return [
    t.summaryTitle,
    ...rows,
    `  ${t.cost} US$ ${((tokens / 1e6) * PRICE_PER_M_INPUT).toFixed(4)}`,
    effortLine ? `  ${t.efforts}: ${effortLine}` : '',
  ].filter(Boolean).join('\n')
}

export const register: Register = (on, options) => {
  const mode = String(options.effort ?? 'observe')
  const minEffort: Effort = isLevel(options.min_effort) ? options.min_effort : 'low'
  const maxEffort: Effort = isLevel(options.max_effort) ? options.max_effort : 'xhigh'
  const ctx: Ctx = { t: options.lang === 'pt' ? TEXT.pt : TEXT.en, showStatus: options.status !== false, seenLines: -1 }
  const decided = new Map<string, { effort: Effort; applied: boolean } | null>()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'claujev', description: ctx.t.commandDesc })
    void refresh($, ctx)
    return next(e)
  })

  // Effort is set per model request, only in the main loop, never in subagents.
  // turn.step streams: the hook is an async generator and `yield* next(...)` forwards the stream.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || mode === 'off' || e.effort === undefined) return yield* next(e)

    if (!decided.has(e.turnId)) {
      const st = await readState($)
      // A request that asks for effort itself ("ultrathink") is never overridden.
      const suggestion = st && !st.explicitEffort && isLevel(st.effort) ? st.effort : null
      decided.set(e.turnId, suggestion ? { effort: clampEffort(suggestion, minEffort, maxEffort), applied: mode === 'on' } : null)
      if (decided.size > 50) decided.delete(decided.keys().next().value as string)
      void refresh($, ctx, effortLabel(ctx.t, decided.get(e.turnId)))
    }

    const d = decided.get(e.turnId)
    return yield* next(d?.applied ? { ...e, effort: d.effort } : e)
  })

  on('turn.complete', async ($, e, next) => {
    void refresh($, ctx, effortLabel(ctx.t, decided.get(e.turnId)))
    return next(e)
  })

  on('command.run', { command: 'claujev' }, async $ => ({ text: await summary($, ctx.t) }))
}
