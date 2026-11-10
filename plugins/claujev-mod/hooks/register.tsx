// ClauJev mod. Copyright (c) 2026 Alisson Civalski — MIT License — https://github.com/Civalski/claujev
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Activity, Verdict } from '../types'

// The claujev plugin's hooks write to ~/.claude/claujev; the mod only reads it.
// Triage (UserPromptSubmit) stores the effort suggestion in state/<session>.json,
// and every hook appends a line to logs/<day>.jsonl.

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

type TurnState = { effort?: Effort | null; explicitEffort?: boolean }
type LogEntry = {
  ts?: string
  hook?: string
  session?: string
  file?: string
  skipped?: string
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
    askHeader: 'Effort',
    askQuestion: (up: boolean, s: Effort, c: Effort) =>
      `Jev thinks this request is ${up ? 'complex' : 'simple'}. Use ${s} effort instead of ${c}?`,
    use: (e: Effort) => `Use ${e}`,
    keep: (e: Effort) => `Keep ${e}`,
    reviewed: 'reviewed',
    flagged: 'flagged',
    skippedBadge: 'skipped',
    paneTitle: 'Jev',
    paneDesc: "Open a pane with Jev's activity in this session",
    paneOpened: 'Jev pane opened.',
    paneEmpty: 'Jev has not acted in this session yet.',
    hooks: { prompt: 'request', bash: 'command', edit: 'edit', stop: 'final check', subagent: 'subagent' } as Record<string, string>,
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
    askHeader: 'Esforço',
    askQuestion: (up: boolean, s: Effort, c: Effort) =>
      `O Jev acha este pedido ${up ? 'complexo' : 'simples'}. Usar esforço ${s} em vez de ${c}?`,
    use: (e: Effort) => `Usar ${e}`,
    keep: (e: Effort) => `Manter ${e}`,
    reviewed: 'revisado',
    flagged: 'apontou',
    skippedBadge: 'pulou',
    paneTitle: 'Jev',
    paneDesc: 'Abre um painel com a atividade do Jev nesta sessão',
    paneOpened: 'Painel do Jev aberto.',
    paneEmpty: 'O Jev ainda não atuou nesta sessão.',
    hooks: { prompt: 'pedido', bash: 'comando', edit: 'edição', stop: 'checagem final', subagent: 'subagente' } as Record<string, string>,
  },
}
type Texts = (typeof TEXT)['en'] | (typeof TEXT)['pt']

// What the hooks share; module variables start over on a reload, which only costs one re-read.
type Ctx = { t: Texts; showStatus: boolean; seenLines: number; mode: string; minEffort: Effort; maxEffort: Effort }

// Preferences written by /claujev:configure in ~/.claude/claujev/config.json:
//   { "lang": "pt", "mod": { "effort": "ask" | "observe" | "on" | "off", "minEffort": "low", "maxEffort": "xhigh", "status": true } }
// ask (default): asks before changing the effort; observe: only shows it; on: applies it; off: nothing.
type Settings = { lang?: string; mod?: { effort?: string; minEffort?: string; maxEffort?: string; status?: boolean } }

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

// Re-read at session start and at each new request, so a change made by /claujev:configure applies right away.
async function loadSettings($: EngineInterface, ctx: Ctx): Promise<void> {
  const dir = await dataDir($)
  let s: Settings = {}
  try {
    if (dir) s = JSON.parse(await $.fs.read(`${dir}/config.json`)) as Settings
  } catch {
    // no config yet: defaults
  }
  const m = s.mod ?? {}
  ctx.t = s.lang === 'pt' ? TEXT.pt : TEXT.en
  ctx.mode = m.effort === 'on' || m.effort === 'off' || m.effort === 'observe' ? m.effort : 'ask'
  ctx.minEffort = isLevel(m.minEffort) ? m.minEffort : 'low'
  ctx.maxEffort = isLevel(m.maxEffort) ? m.maxEffort : 'xhigh'
  ctx.showStatus = m.status !== false
}

// Asks in Claude Code's own question dialog. A $ call: the wait does not count against the hook's budget.
// Dismissed, or nobody to ask (claude -p): the current effort stays.
export type EffortAnswer = 'use' | 'keep' | 'other' | 'dismissed'

// Options: Jev's suggestion, the current effort, then whatever of low/medium/high is missing,
// so low, medium and high are always offered (at most 4 options).
export function effortOptions(t: Texts, suggested: Effort, current: Effort): { label: string; effort: Effort }[] {
  const out = [
    { label: t.use(suggested), effort: suggested },
    { label: t.keep(current), effort: current },
  ]
  for (const l of ['low', 'medium', 'high'] as const) {
    if (l !== suggested && l !== current) out.push({ label: t.use(l), effort: l })
  }
  return out
}

export async function askEffort($: EngineInterface, t: Texts, suggested: Effort, current: Effort): Promise<{ effort: Effort; answer: EffortAnswer }> {
  const up = LEVELS.indexOf(suggested) > LEVELS.indexOf(current)
  const options = effortOptions(t, suggested, current)
  try {
    const answer = await $.ui.ask(t.askQuestion(up, suggested, current), { header: t.askHeader, options: options.map(o => o.label) })
    const picked = options.find(o => o.label === answer)
    if (!picked || picked.effort === current) return { effort: current, answer: 'keep' }
    return { effort: picked.effort, answer: picked.effort === suggested ? 'use' : 'other' }
  } catch {
    return { effort: current, answer: 'dismissed' }
  }
}

// Records the answer for `node claujev.mjs report`. $.fs has no append, so each session keeps its own
// file (logs/effort-<day>-<session>.jsonl): no other writer can race it. A failed write is ignored.
async function logAnswer($: EngineInterface, entry: { suggested: Effort; current: Effort; answer: EffortAnswer; chosen?: Effort }): Promise<void> {
  const dir = await dataDir($)
  if (!dir) return
  const now = new Date(await $.clock.now()).toISOString()
  const sid = (await $.session.id()).replace(/[^\w-]/g, '')
  const path = `${dir}/logs/effort-${now.slice(0, 10)}-${sid}.jsonl`
  let before = ''
  try {
    before = await $.fs.read(path)
  } catch {
    // first answer of the day in this session
  }
  try {
    await $.fs.write(path, `${before}${JSON.stringify({ ts: now, hook: 'effort', session: sid.slice(0, 8), ...entry })}\n`)
  } catch {
    // logging never gets in the way of the request
  }
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

// Kept in the session's $.state: survives a reload of the mod. Change a shape tag when its fields change.
const verdicts = atom({ plugin: 'claujev-mod', key: 'verdicts' } as const, {}, { shape: 'verdicts-1' })
const activity = atom({ plugin: 'claujev-mod', key: 'activity' } as const, [], { shape: 'activity-1' })
const PANE = 'claujev-activity'

// The claujev hooks log the session by its first 8 characters.
async function sessionTag($: EngineInterface): Promise<string> {
  return (await $.session.id()).replace(/[^\w-]/g, '').slice(0, 8)
}

// Which claujev hook reviews each tool. Edit/Write go through the edit review, Bash through the guard.
export function hookFor(tool: string): 'bash' | 'edit' | undefined {
  if (tool === 'Bash') return 'bash'
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') return 'edit'
  return undefined
}

function detailOf(e: LogEntry): string | undefined {
  return (e.problems?.[0] || e.flagged?.[0] || undefined)?.slice(0, 160)
}

// The log has no tool_use_id: the entry for a call is the one its hook wrote while the call ran.
// Lines skipped as read-only carry no session; they still count, as the call was this one.
export function verdictFrom(fresh: LogEntry[], hook: 'bash' | 'edit', sid: string, file?: string): Verdict | undefined {
  const base = file?.split(/[\\/]/).pop()
  const mine = fresh.filter(e => e.hook === hook && (!e.session || e.session === sid) && (hook !== 'edit' || !base || !e.file || e.file === base))
  const e = mine[mine.length - 1]
  if (!e) return undefined
  return { hook, acted: !!e.acted, detail: detailOf(e), skipped: e.skipped }
}

// Shows the day's numbers, and a toast for each new action Jev took since the last look.
async function refresh($: EngineInterface, ctx: Ctx, label?: string): Promise<void> {
  const entries = await todayLog($)
  if (ctx.seenLines >= 0 && entries.length > ctx.seenLines) {
    const sid = await sessionTag($)
    const fresh: Activity[] = entries
      .slice(ctx.seenLines)
      .filter(e => e.session === sid && !e.error && e.hook)
      .map(e => ({ ts: e.ts ?? '', hook: e.hook as string, acted: !!e.acted, detail: detailOf(e) }))
    if (fresh.length) {
      await update($, activity, list => [...list, ...fresh].slice(-200)) // redraws the pane
    }
  }
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

export const register: Register = on => {
  const ctx: Ctx = { t: TEXT.en, showStatus: true, seenLines: -1, mode: 'ask', minEffort: 'low', maxEffort: 'xhigh' }
  const decided = new Map<string, { effort: Effort; applied: boolean } | null>()

  on('session.start', async ($, e, next) => {
    await loadSettings($, ctx)
    await $.command.register({ name: 'claujev', description: ctx.t.commandDesc })
    await $.command.register({ name: 'claujev-painel', description: ctx.t.paneDesc })
    void refresh($, ctx)
    return next(e)
  })

  // Effort is set per model request, only in the main loop, never in subagents.
  // turn.step streams: the hook is an async generator and `yield* next(...)` forwards the stream.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || e.effort === undefined) return yield* next(e)

    if (!decided.has(e.turnId)) {
      await loadSettings($, ctx)
      if (ctx.mode === 'off') {
        decided.set(e.turnId, null)
        return yield* next(e)
      }
      const st = await readState($)
      // A request that asks for effort itself ("ultrathink") is never overridden.
      const suggestion = st && !st.explicitEffort && isLevel(st.effort) ? st.effort : null
      let d = suggestion ? { effort: clampEffort(suggestion, ctx.minEffort, ctx.maxEffort), applied: ctx.mode === 'on' } : null
      // "ask": only when Jev's suggestion differs from the effort in use, once per request.
      if (d && ctx.mode === 'ask' && isLevel(e.effort) && d.effort !== e.effort) {
        const { effort: chosen, answer } = await askEffort($, ctx.t, d.effort, e.effort)
        await logAnswer($, { suggested: d.effort, current: e.effort, answer, ...(answer === 'other' ? { chosen } : {}) })
        d = { effort: chosen, applied: chosen !== e.effort }
      }
      decided.set(e.turnId, d)
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

  on('command.run', { command: 'claujev-painel' }, async $ => {
    await $.ui.open({ id: PANE, title: ctx.t.paneTitle })
    return { text: ctx.t.paneOpened }
  })

  // Badge: notes the log length, lets the call run (the claujev hooks run beneath), then reads what Jev wrote.
  on('tool.call', async ($, e, next) => {
    const hook = hookFor(e.tool)
    if (!hook || e.agentId !== undefined) return next(e)
    const before = (await todayLog($)).length
    const ran = await next(e)
    try {
      const fresh = (await todayLog($)).slice(before)
      const file = (e as { file_path?: string; notebook_path?: string }).file_path ?? (e as { notebook_path?: string }).notebook_path
      const v = verdictFrom(fresh, hook, await sessionTag($), file)
      if (v) {
        await update($, verdicts, all => {
          const keys = Object.keys(all)
          const kept = keys.length >= 300 ? Object.fromEntries(keys.slice(-200).map(k => [k, all[k] as Verdict])) : all
          return { ...kept, [e.tool_use_id]: v }
        })
      }
      void refresh($, ctx)
    } catch {
      // a badge never gets in the way of the call
    }
    return ran
  }).catch(($, e, next) => next(e)) // the mod failing never blocks a call

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const v = (await read($, verdicts))[e.props.tool_use_id]
    const row = await next(e)
    if (!v || e.props.isRunning) return row
    const { Box, Text } = $.ui.resolve(e)
    const t = ctx.t
    const badge = v.skipped
      ? <Text dimColor>  Jev · {t.skippedBadge}</Text>
      : v.acted
        ? <Text color="warning">  Jev ⚠ {t.flagged}{v.detail ? `: ${v.detail}` : ''}</Text>
        : <Text color="success" dimColor>  Jev ✓ {t.reviewed}</Text>
    return (
      <Box flexDirection="column" borderStyle={v.acted && e.surface === 'mobile' ? 'round' : undefined}>
        {row}
        {badge}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const t = ctx.t
    const list = await read($, activity)
    const acted = list.filter(a => a.acted).length
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 5)
    const width = Math.max(20, (e.props.bodyColumns ?? 60) - 2)
    return (
      <Box flexDirection="column">
        <Text bold>Jev · ✓{list.length} ⚑{acted}</Text>
        {list.length === 0 && <Text dimColor>{t.paneEmpty}</Text>}
        {list.slice(-room).map(a => {
          const time = a.ts.slice(11, 16)
          const line = `${time} ${a.acted ? '⚠' : '✓'} ${t.hooks[a.hook] ?? a.hook}${a.detail ? `: ${a.detail}` : ''}`
          return a.acted
            ? <Text color="warning" wrap="truncate-end">{line.slice(0, width * 2)}</Text>
            : <Text dimColor wrap="truncate-end">{line.slice(0, width * 2)}</Text>
        })}
      </Box>
    )
  })
}
