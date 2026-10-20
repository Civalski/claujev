import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// The world beneath the mod: the state the claujev hooks wrote, a fixed session and home.
function world(on: On, state: object | null, statuses: string[] = []) {
  mock.env(on, { HOME: '/home/u' })
  mock.clock(on, { now: Date.UTC(2026, 9, 20, 12) })
  on('session.id', () => ({ value: 's-1' }))
  on('fs.read', (_, e) => {
    if (e.path === '/home/u/.claude/claujev/state/s-1.json' && state) return { value: JSON.stringify(state) }
    if (e.path === '/home/u/.claude/claujev/logs/2026-10-20.jsonl') return { value: '{"hook":"bash","acted":true,"flagged":["destructive effect (p=0.97)"]}\n' }
    throw new Error('missing')
  })
  on('ui.status', (_, e) => { statuses.push(String(e.text)); return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
}

// Runs one model request through the mod and returns the effort that reached the engine.
async function step($: Engine, on: On, effort: 'medium' | 'high' = 'medium', agentId?: string) {
  let sent: unknown
  on('turn.step', async function* (_, e) {
    sent = e.effort
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
  })
  const stream = $.turn.step({ turnId: `t-${agentId ?? 'main'}`, index: 0, model: 'opus', effort, messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) { /* no chunks */ }
  await stream.result
  return sent
}

test('effort "on": the suggestion reaches the model request', { options: { effort: 'on' } }, async ($, on) => {
  world(on, { effort: 'high' })
  expect(await step($, on)).toBe('high')
})

test('effort "on": the suggestion is kept within max_effort', { options: { effort: 'on', max_effort: 'medium' } }, async ($, on) => {
  world(on, { effort: 'xhigh' })
  expect(await step($, on, 'high')).toBe('medium')
})

test('effort "observe" (default): the request keeps its effort, the status line shows the suggestion', async ($, on) => {
  const statuses: string[] = []
  world(on, { effort: 'high' }, statuses)
  expect(await step($, on, 'medium')).toBe('medium')
  // The status line is refreshed without waiting; let that work settle.
  for (let i = 0; i < 50 && !statuses.length; i++) await Promise.resolve()
  expect(statuses.some(s => /effort high \(suggested\)/.test(s))).toBe(true)
})

test('a request that asked for effort itself is never overridden', { options: { effort: 'on' } }, async ($, on) => {
  world(on, { effort: 'low', explicitEffort: true })
  expect(await step($, on, 'high')).toBe('high')
})

test('subagents keep their own effort', { options: { effort: 'on' } }, async ($, on) => {
  world(on, { effort: 'low' })
  expect(await step($, on, 'high', 'agent-1')).toBe('high')
})

test('no suggestion (Jev failed): the effort is left alone', { options: { effort: 'on' } }, async ($, on) => {
  world(on, null)
  expect(await step($, on, 'high')).toBe('high')
})
