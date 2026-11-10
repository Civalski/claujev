import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { effortOptions, verdictFrom } from '../hooks/register'

const LOG = '/home/u/.claude/claujev/logs/2026-10-20.jsonl'

// The claujev hooks beneath the mod: each Bash call appends `line` to the day's log.
function world(on: On, line: object) {
  let log = ''
  mock.env(on, { HOME: '/home/u' })
  mock.clock(on, { now: Date.UTC(2026, 9, 20, 12) })
  on('session.id', () => ({ value: 's-1234567890' }))
  on('fs.read', (_, e) => {
    if (e.path === LOG) return { value: log }
    throw new Error('missing')
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => {
    log += JSON.stringify({ ts: '2026-10-20T12:34:00.000Z', session: 's-123456', ...line }) + '\n'
    return { result: {} }
  })
}

function row(id: string) {
  return {
    plugin: 'claujev-mod',
    component: 'ToolUse',
    requestId: id,
    props: { tool_use_id: id, tool: 'Bash', input: { command: 'rm -rf build' }, isRunning: false, isErrored: false, isInterrupted: false },
  } as const
}

const PANE = {
  plugin: 'claujev-mod',
  component: 'Pane',
  requestId: 'claujev-activity',
  props: { title: 'Jev', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('low, medium and high are always offered, suggestion first and current second', () => {
  const t = { use: (e: string) => `Use ${e}`, keep: (e: string) => `Keep ${e}` } as never
  expect(effortOptions(t, 'high', 'medium').map(o => o.effort)).toEqual(['high', 'medium', 'low'])
  expect(effortOptions(t, 'xhigh', 'medium').map(o => o.effort)).toEqual(['xhigh', 'medium', 'low', 'high'])
  expect(effortOptions(t, 'low', 'xhigh').map(o => o.effort)).toEqual(['low', 'xhigh', 'medium', 'high'])
})

test('the verdict is the entry its hook wrote during the call, for this session and file', () => {
  const fresh = [
    { hook: 'edit', session: 'other', acted: true, file: 'a.ts' },
    { hook: 'edit', session: 's-1', acted: false, file: 'b.ts' },
    { hook: 'edit', session: 's-1', acted: true, file: 'a.ts', flagged: ['segredo no código'] },
  ]
  expect(verdictFrom(fresh, 'edit', 's-1', '/x/b.ts')).toEqual({ hook: 'edit', acted: false, detail: undefined, skipped: undefined })
  expect(verdictFrom(fresh, 'edit', 's-1', '/x/a.ts')?.detail).toBe('segredo no código')
  expect(verdictFrom(fresh, 'bash', 's-1')).toBeUndefined()
})

test('a flagged Bash call shows a badge under its row and a line in the pane, on every surface', async ($, on) => {
  world(on, { hook: 'bash', acted: true, flagged: ['efeito destrutivo (p=0.95)'] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build', tool_use_id: 'tu-1' } as never)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...row('tu-1'), surface })
    expect((await ui.find({ type: 'Text', text: /Jev ⚠/ }))?.text).toContain('efeito destrutivo')
    await ui.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect((await pane.find({ type: 'Text', text: /efeito destrutivo/ }))?.text).toContain('12:34')
    await pane.unmount()
  }
})

test('a call Jev let through shows "reviewed"; a call it never saw shows nothing', async ($, on) => {
  world(on, { hook: 'bash', acted: false })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'tu-2' } as never)

  const ui = await $.ui.mount({ ...row('tu-2'), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Jev ✓/ }))?.text).toContain('reviewed')
  await ui.unmount()

  const other = await $.ui.mount({ ...row('tu-unknown'), surface: 'terminal' })
  expect(await other.find({ type: 'Text', text: /Jev/ })).toBeUndefined()
  await other.unmount()
})
