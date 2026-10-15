import { expect, mock, test } from 'claude-code/testing'

import { barCells, formatTokens, sharePercent } from './register'
import { applyReport, seeded, skillSections, ticketSections } from './progress'
import type { Snapshot } from '../types'

// The figures in the reference screenshot.
const SNAP: Snapshot = {
  categories: [
    { name: 'System prompt', tokens: 4200, color: 'promptBorder', kind: 'used' },
    { name: 'System tools', tokens: 17000, color: 'inactive', kind: 'used' },
    { name: 'MCP tools', tokens: 52000, color: 'claude', kind: 'used' },
    { name: 'Custom agents', tokens: 3400, color: 'success', kind: 'used' },
    { name: 'Memory files', tokens: 8600, color: 'warning', kind: 'used' },
    { name: 'Skills', tokens: 5100, color: 'permission', kind: 'used' },
    { name: 'Messages', tokens: 0, color: 'ide', kind: 'used' },
    { name: 'Free space', tokens: 897000, color: 'inactive', kind: 'free' },
    { name: 'Autocompact buffer', tokens: 13000, color: 'inactive', kind: 'buffer' },
  ],
  totalTokens: 90300,
  maxTokens: 1000000,
  percentage: 9,
  threshold: 987000,
}

// What $.session.usage answers beneath the plugin, shaped from SNAP.
const USAGE = {
  startedAt: 0,
  rateLimits: [],
  context: {
    tokens: 90300,
    window: 1000000,
    percent: 9,
    breakdown: {
      categories: SNAP.categories.map(c => ({ ...c, isDeferred: false })),
      totalTokens: 90300,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 9,
      autoCompactThreshold: 987000,
      isAutoCompactEnabled: true,
    },
  },
} as never

const MEASURE = { context: { window: 1000000 }, rateLimits: [], changed: ['context'] } as never

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 19, contentRows: 0 },
  view: {},
} as never

// Stands for the engine's own (empty) band beneath the plugin.
const engineBand = ($: any, e: any) => {
  const { Box } = $.ui.resolve(e)
  return <Box key="engine" />
}

test('formats token counts like /context', () => {
  expect(formatTokens(4200)).toBe('4.2k')
  expect(formatTokens(17000)).toBe('17k')
  expect(formatTokens(987000)).toBe('987k')
  expect(formatTokens(1000000)).toBe('1M')
  expect(formatTokens(0)).toBe('0')
  expect(sharePercent(3400, 1000000)).toBe(1)
  expect(sharePercent(52000, 1000000)).toBe(5)
  expect(sharePercent(0, 1000000)).toBe(0)
})

test('bar fills the width with the compaction tick near the end', () => {
  const cells = barCells(SNAP, 100)
  expect(cells.length).toBe(100)
  expect(cells[98]?.color).toBe('warning')
  expect(cells[0]?.color).toBe('promptBorder')
  expect(cells[50]?.color).toBe('inactive')
})

test('details collapsed by default: header and bar only, toggle shows and hides the legend', async ($, on) => {
  on('session.usage', () => ({ value: USAGE }) as never)
  on('session.measure', () => ({ changed: ['context'] }) as never)
  on('ui.render', engineBand)
  await $.session.measure(MEASURE)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ key: 'header' }))?.text).toContain('9%')
    expect(await ui.find({ key: 'bar' })).toBeDefined()
    expect(await ui.find({ key: 'legend' })).toBeUndefined()
    expect((await ui.find({ key: 'details-toggle' }))?.text).toContain('▸ details')
    await ui.press({ key: 'details-toggle' })
    expect((await ui.find({ key: 'legend' }))?.text).toContain('mcp tools 52k 5%')
    expect((await ui.find({ key: 'details-toggle' }))?.text).toContain('▾ details')
    await ui.press({ key: 'details-toggle' })
    expect(await ui.find({ key: 'legend' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a saved expanded choice is restored at session start', async ($, on) => {
  mock.store(on, { detailsOpen: true })
  on('session.start', () => ({ cwd: '.' }) as never)
  on('session.usage', () => ({ value: USAGE }) as never)
  on('ui.render', engineBand)
  await $.session.start({ cwd: '.' } as never)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect((await ui.find({ key: 'legend' }))?.text).toContain('mcp tools 52k 5%')
  await ui.unmount()
})

test('pressing the toggle saves the choice for later sessions', async ($, on) => {
  const writes: unknown[] = []
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', ($, e: any) => (writes.push([e.key, e.value]), { value: undefined }) as never)
  on('session.start', () => ({ cwd: '.' }) as never)
  on('session.usage', () => ({ value: USAGE }) as never)
  on('ui.render', engineBand)
  await $.session.start({ cwd: '.' } as never)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'details-toggle' })
  await ui.press({ key: 'details-toggle' })
  expect(writes).toEqual([
    ['detailsOpen', true],
    ['detailsOpen', false],
  ])
  await ui.unmount()
})

test('band draws header, bar and legend on terminal and desktop', async ($, on) => {
  on('session.usage', () => ({ value: USAGE }) as never)
  on('session.measure', () => ({ changed: ['context'] }) as never)
  on('ui.render', engineBand)
  await $.session.measure(MEASURE)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ key: 'header' }))?.text).toContain('90k of 1M · compacts at 987k')
    expect((await ui.find({ key: 'header' }))?.text).toContain('9%')
    // Expanded once on the first surface; the state carries to the second.
    if (!(await ui.find({ key: 'legend' }))) await ui.press({ key: 'details-toggle' })
    const legend = (await ui.find({ key: 'legend' }))?.text ?? ''
    expect(legend).toContain('mcp tools 52k 5%')
    expect(legend).toContain('messages 0 0%')
    expect(legend).toContain('free 897k')
    expect(legend).not.toContain('autocompact')
    await ui.unmount()
  }
})

test('bar is one row of proportional blocks, no glyphs to wrap on desktop', async ($, on) => {
  on('session.usage', () => ({ value: USAGE }) as never)
  on('session.measure', () => ({ changed: ['context'] }) as never)
  on('ui.render', engineBand)
  await $.session.measure(MEASURE)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: BAND })
    await ui.drawn()
    const bar = await ui.find({ key: 'bar' })
    expect(bar?.text ?? '').not.toContain('█')
    // Grow shares add up to the full width the cells were computed for (bodyColumns - 4).
    const segs = (bar?.children ?? []) as { props?: { flexGrow?: number } }[]
    const grow = segs.reduce((n, c) => n + (c.props?.flexGrow ?? 0), 0)
    expect(grow).toBe(96)
    await ui.unmount()
  }
})

test('band shows a waiting line before the first measurement', async ($, on) => {
  on('ui.render', engineBand)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ key: 'context-bar' }))?.text).toContain('waiting for first measurement')
    await ui.unmount()
  }
})

test('after /clear the band measures again without waiting for a prompt', async ($, on) => {
  const clock = mock.clock(on)
  on('session.usage', () => ({ value: USAGE }) as never)
  on('session.end', () => ({ sessionId: 'old' }) as never)
  on('ui.render', engineBand)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect((await ui.find({ key: 'context-bar' }))?.text).toContain('waiting for first measurement')
  await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } } as never)
  await clock.advance(1000)
  expect((await ui.find({ key: 'header' }))?.text).toContain('90k of 1M')
  await ui.unmount()
})

test('without a breakdown the band falls back to the status line figures', async ($, on) => {
  const bare = { startedAt: 0, rateLimits: [], context: { tokens: 120000, window: 200000, percent: 60 } }
  on('session.usage', () => ({ value: bare }) as never)
  on('session.measure', () => ({ changed: ['context'] }) as never)
  on('ui.render', engineBand)
  await $.session.measure(MEASURE)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ key: 'header' }))?.text).toContain('120k of 200k')
    expect((await ui.find({ key: 'header' }))?.text).toContain('60%')
    await ui.unmount()
  }
})

// ---- progress rows -------------------------------------------------------

const TOOL = 'mcp__context-bar__progress'
const PENDING = 'plans/cso_briefing/project/Pending'

const TICKET_MD = [
  '# T',
  '## Action Items',
  '- [x] AI-1 one',
  '- [ ] AI-2 two',
  '## Acceptance Criteria',
  '- [x] AC-1',
  '- [ ] AC-2',
  '- [ ] ~~`assembleDebug` PASS~~ (N/A: docs preset)',
  '## Notes',
  '- [ ] not owed: outside the checklist sections',
].join('\n')

// An in-memory working directory: active.json naming `id`, and the ticket file in `dir`.
// The handle edits the ticket, moves it to another folder, or activates another id.
const fakeTree = (on: any, id: string, dir: string, text = TICKET_MD) => {
  const name = `${id}_fixture.md`
  const at = { dir, active: id, text, mtime: 1 }
  const tail = (p: string) => p.split('\\').join('/')
  on('fs.read', ($: any, e: any) => {
    const p = tail(e.path)
    if (p.endsWith('tmp/verify/active.json')) return { value: JSON.stringify({ ticket_id: at.active }) }
    if (p.endsWith(`${at.dir}/${name}`)) return { value: at.text }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.list', ($: any, e: any) => ({
    value: tail(e.path).endsWith(at.dir) ? [{ name, kind: 'file', size: 1, mtimeMs: at.mtime, isLink: false }] : [],
  }))
  on('fs.stat', ($: any, e: any) => {
    if (!tail(e.path).endsWith(`${at.dir}/${name}`)) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: at.text.length, mtimeMs: at.mtime, isLink: false } }
  })
  return {
    edit: (t: string) => Object.assign(at, { text: t, mtime: at.mtime + 1 }),
    moveTo: (d: string) => Object.assign(at, { dir: d }),
    activate: (other: string) => Object.assign(at, { active: other }),
  }
}

// A harmless tool for the test to call, so the plugin's after-call hook runs.
const touchTool = (on: any) => {
  on('tool.check', { tool: 'mcp__fake__touch' }, () => ({ decision: 'allow' }))
  on('tool.call', { tool: 'mcp__fake__touch' }, () => ({ result: 'ok' }))
}

const mountBand = ($: any) =>
  $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: BAND })

test('the progress tool is allowed without a prompt and draws a row', async ($, on) => {
  on('ui.render', engineBand)
  expect((await $.tool.check({ tool: TOOL, input: {} } as never)).decision).toBe('allow')
  await $.tool.call({ tool: TOOL, total: 4, done: 1, label: 'ticket-author plan', step: 'Source' } as never)
  const ui = await mountBand($)
  const row = (await ui.find({ key: 'progress-steps' }))?.text ?? ''
  expect(row).toContain('ticket-author plan')
  expect(row).toContain('1/4')
  expect(row).toContain('Source')
  await ui.unmount()
})

// Rewritten for progress v2 (spec §Status Host UI): a completed row used to stay
// until the next prompt; it now fades about two seconds after it completes, and
// a prompt before then still clears it.
test('a finished task shows ✓ then fades (or leaves at the next prompt); an unfinished one waits', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('ui.render', engineBand)
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  await $.tool.call({ tool: TOOL, total: 3, done: 1, label: 'rigor' } as never)
  await $.turn.complete({ reason: 'answer', answer: 'done' } as never)
  const ui = await mountBand($)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('⏸')
  await $.tool.call({ tool: TOOL, total: 3, done: 3, label: 'rigor' } as never)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('✓')
  await clock.advance(1_000)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('✓')
  await clock.advance(1_500)
  expect(await ui.find({ key: 'progress-steps' })).toBeUndefined()
  // A prompt clears a completed row sooner.
  await $.tool.call({ tool: TOOL, total: 2, done: 2, label: 'quick' } as never)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('✓')
  await $.prompt.submit({ text: 'next' } as never)
  expect(await ui.find({ key: 'progress-steps' })).toBeUndefined()
  await ui.unmount()
})

test('progress reported from a subagent leaves the main row alone', async ($, on) => {
  on('ui.render', engineBand)
  await $.tool.call({ tool: TOOL, total: 5, done: 2, label: 'main' } as never)
  await $.tool.call({ tool: TOOL, total: 9, done: 9, label: 'sub', agentId: 'a1' } as never)
  const ui = await mountBand($)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('main')
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('2/5')
  await ui.unmount()
})

test('the system prompt asks for progress reports only when the tool is offered', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'x', scope: 'shared' }] }) as never)
  const M = { model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [] }
  const offered = await $.prompt.compose({ ...M, tools: [TOOL] } as never)
  expect(offered.sections.map(s => s.id)).toContain('context-bar:progress')
  const without = await $.prompt.compose({ ...M, tools: [] } as never)
  expect(without.sections.map(s => s.id)).not.toContain('context-bar:progress')
})

test('ticket row: hidden until this session names the ticket, then counts its sections', async ($, on) => {
  on('ui.render', engineBand)
  touchTool(on)
  const tree = fakeTree(on, 'ABC-01', PENDING)
  await $.tool.call({ tool: 'mcp__fake__touch', note: 'unrelated' } as never)
  const ui = await mountBand($)
  expect(await ui.find({ key: 'progress-steps' })).toBeUndefined()
  await $.tool.call({ tool: 'mcp__fake__touch', file_path: `${PENDING}/ABC-01_fixture.md` } as never)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('1/3')
  tree.edit(TICKET_MD.replace('- [ ] AI-2', '- [x] AI-2'))
  await $.tool.call({ tool: 'mcp__fake__touch', note: 'later call, no id' } as never)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('2/3')
  await ui.unmount()
})

test('ticket row: a ticket outside Pending/ (delivered or void) never shows', async ($, on) => {
  on('ui.render', engineBand)
  touchTool(on)
  fakeTree(on, 'OLD-01', 'plans/cso_briefing/project/deliver')
  await $.tool.call({ tool: 'mcp__fake__touch', file_path: 'OLD-01' } as never)
  const ui = await mountBand($)
  expect(await ui.find({ key: 'progress-steps' })).toBeUndefined()
  await ui.unmount()
})

test('ticket row: an unfinished ticket that leaves Pending/ drops its row', async ($, on) => {
  on('ui.render', engineBand)
  touchTool(on)
  const tree = fakeTree(on, 'ABC-02', PENDING)
  await $.tool.call({ tool: 'mcp__fake__touch', note: 'ABC-02' } as never)
  const ui = await mountBand($)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('1/3')
  tree.moveTo('plans/cso_briefing/project/deliver')
  await $.tool.call({ tool: 'mcp__fake__touch', note: 'closeout' } as never)
  expect(await ui.find({ key: 'progress-steps' })).toBeUndefined()
  await ui.unmount()
})

test('ticket row: activating another ticket drops the old unfinished row', async ($, on) => {
  on('ui.render', engineBand)
  touchTool(on)
  const tree = fakeTree(on, 'ABC-03', PENDING)
  await $.tool.call({ tool: 'mcp__fake__touch', note: 'ABC-03' } as never)
  const ui = await mountBand($)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('ABC-03')
  tree.activate('XYZ-09')
  await $.tool.call({ tool: 'mcp__fake__touch', note: 'switch' } as never)
  expect(await ui.find({ key: 'progress-steps' })).toBeUndefined()
  await ui.unmount()
})

// Rewritten for progress v2 (spec §三層模型): tool calls used to grow the solid fill
// toward the next step; they now grow only the lighter buffer segment, and the
// committed fill and count move on a report alone.
test('between reports tool calls grow the buffer within the current step, never the committed fill', async ($, on) => {
  on('ui.render', engineBand)
  touchTool(on)
  await $.tool.call({ tool: TOOL, total: 4, done: 1, label: 'plan', step: 'Source' } as never)
  const ui = await mountBand($)
  const grow = async (part: string) => ((await ui.find({ key: `progress-steps-${part}` })) as any)?.props?.flexGrow ?? 0
  expect(await grow('committed')).toBe(25)
  expect(await grow('buffer')).toBe(0)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'mcp__fake__touch' } as never)
  expect(await grow('committed')).toBe(25)
  const crept = await grow('buffer')
  expect(crept).toBeGreaterThan(5)
  for (let i = 0; i < 30; i++) await $.tool.call({ tool: 'mcp__fake__touch' } as never)
  expect(await grow('committed')).toBe(25)
  // The buffer stays short of the next step's start.
  expect(25 + (await grow('buffer'))).toBeLessThan(50)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('1/4')
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('25%')
  await $.tool.call({ tool: TOOL, total: 4, done: 2, label: 'plan' } as never)
  expect(await grow('committed')).toBe(50)
  await ui.unmount()
})

// Rewritten for progress v2: Clawd (Claude Code's own character) is replaced by an
// original pixel cat; the terminal draws a text cat, never an empty Svg.
test('progress sits above the context header, with the cat mascot on desktop and a text cat on the terminal', async ($, on) => {
  on('session.usage', () => ({ value: USAGE }) as never)
  on('session.measure', () => ({ changed: ['context'] }) as never)
  on('ui.render', engineBand)
  await $.session.measure(MEASURE)
  await $.tool.call({ tool: TOOL, total: 7, done: 3, label: 'ticket-author ticket T01' } as never)
  const desk = await mountBand($)
  const tree = JSON.stringify(await desk.drawn())
  expect(tree.indexOf('"progress"')).toBeGreaterThan(-1)
  expect(tree.indexOf('"progress"')).toBeLessThan(tree.indexOf('"header"'))
  const svg = (await desk.find({ type: 'Svg' })) as any
  expect(svg?.props?.isInteractive).toBe(true)
  expect(String(svg?.props?.alt)).toContain('cat')
  expect(String(svg?.props?.alt)).not.toContain('Clawd')
  expect(String(svg?.props?.source)).toContain('animate')
  expect((await desk.find({ key: 'progress-steps' }))?.text).toContain('43%')
  await desk.unmount()
  const term = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  expect((await term.find({ key: 'progress-steps-track' }))?.text).toContain('=^.^=')
  await term.unmount()
})

// Rewritten for progress v2 (spec §暫停、等待與失聯): a silent turn used to drop the
// row; now it waits for the person, then goes stale (grey) after 120s, never removed.
test('a waiting row: tool calls leave it waiting, a report resumes it, silence turns it stale but keeps it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('ui.render', engineBand)
  on('turn.complete', () => ({ text: '' }) as never)
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }) as never)
  touchTool(on)
  const endTurn = () => $.turn.complete({ reason: 'answer', answer: 'done' } as never)
  await $.tool.call({ tool: TOOL, total: 3, done: 1, label: 'rigor' } as never)
  await endTurn()
  const ui = await mountBand($)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('⏸')
  await $.tool.call({ tool: 'mcp__fake__touch' } as never)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('⏸')
  await $.tool.call({ tool: TOOL, total: 3, done: 2, label: 'rigor' } as never)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('▶')
  await endTurn()
  await endTurn()
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('⏸')
  await $.prompt.submit({ text: 'go on' } as never)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('▶')
  await clock.advance(121_000)
  const row = (await ui.find({ key: 'progress-steps' }))?.text ?? ''
  expect(row).toContain('◌')
  expect(row).toContain('2/3')
  await ui.unmount()
})

// Rewritten for progress v2: subagent work still moves the main row, but only its buffer.
test('re-reporting the same step keeps its buffer; subagent work grows the main row buffer only', async ($, on) => {
  on('ui.render', engineBand)
  touchTool(on)
  await $.tool.call({ tool: TOOL, total: 5, done: 0, label: 'plan' } as never)
  const ui = await mountBand($)
  const grow = async (part: string) => ((await ui.find({ key: `progress-steps-${part}` })) as any)?.props?.flexGrow ?? 0
  await $.tool.call({ tool: 'mcp__fake__touch', agentId: 'sub-1' } as never)
  await $.tool.call({ tool: 'mcp__fake__touch', agentId: 'sub-1' } as never)
  const crept = await grow('buffer')
  expect(crept).toBeGreaterThan(0)
  expect(await grow('committed')).toBe(0)
  await $.tool.call({ tool: TOOL, total: 5, done: 0, label: 'plan', step: 'Source' } as never)
  expect(await grow('buffer')).toBe(crept)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('0/5')
  await ui.unmount()
})

test('ticket sections: each ### under Action Items, then Acceptance Criteria as one', () => {
  const md = [
    '# T',
    '## Verify Config',
    '- [ ] not owed',
    '## Action Items',
    '### AI-0: anchors',
    'text',
    '- [x] 完成',
    '### AI-1: helper',
    '- [ ] 完成',
    '```text',
    '### not a heading inside a fence',
    '```',
    '## Hard Constraints',
    '- [ ] not owed either',
    '## Acceptance Criteria',
    '- [x] **[存在性]** one',
    '- [ ] **[行為性]** two',
    '- [ ] ~~`assembleDebug` PASS~~ (N/A: docs preset)',
  ].join('\r\n')
  expect(ticketSections(md)).toEqual({ names: ['AI-0: anchors', 'AI-1: helper', 'Acceptance Criteria'], finished: 1 })
  const allTicked = md.replace('- [ ] 完成', '- [x] 完成').replace('- [ ] **[行為性]**', '- [x] **[行為性]**')
  expect(ticketSections(allTicked).finished).toBe(3)
})

test('skill sections: its ## headings (### when fewer than two), fenced code ignored', () => {
  const lines = (...l: string[]) => l.join('\n')
  expect(skillSections(lines('# Skill', '## Step 0: scope', '## Step 1: build', '```', '## not one', '```', '## Step 2: test'))).toEqual([
    'Step 0: scope',
    'Step 1: build',
    'Step 2: test',
  ])
  expect(skillSections(lines('# Skill', '## Only one', '### a', '### b'))).toEqual(['a', 'b'])
  expect(skillSections('no headings')).toEqual([])
})

test('reports: done-only advances seeded sections; a ticket ignores a foreign plan; a skill yields to one', () => {
  const ticket = seeded('ticket', 'ABC-01', ['AI-0', 'AI-1', 'Acceptance Criteria'], 0)
  expect(applyReport(ticket, { done: 1 })).toMatchObject({ done: 1, total: 3, step: 'AI-1', source: 'ticket' })
  expect(applyReport(ticket, { done: 2, total: 9, label: 'x' })).toMatchObject({ done: 0, total: 3, source: 'ticket' })
  const skill = seeded('skill', 'ticket-author', ['Diag', 'Plan'], 0)
  expect(applyReport(skill, { done: 1 })).toMatchObject({ done: 1, total: 2, step: 'Plan' })
  expect(applyReport(skill, { done: 1, total: 5, label: 'mine' })).toMatchObject({ source: 'report', done: 1, total: 5, label: 'mine' })
  expect(applyReport(null, { done: 2, total: 4, label: 'p', step: 's' })).toMatchObject({ done: 2, total: 4, step: 's' })
  // A lower report never moves a seeded row back.
  expect(applyReport({ ...skill, reported: 1, done: 1 }, { done: 0 }).done).toBe(1)
})

test('expanding a skill once work is under way seeds the row with its sections', async ($, on) => {
  on('ui.render', engineBand)
  on('skill.prompt', ($: any, e: any) => ({ text: e.text }) as never)
  touchTool(on)
  const body = ['# RGR', '## Load', '## Review', '## Report'].join('\n')
  await $.skill.prompt({ skill: 'ticket-rigor-gate', text: body } as never)
  const ui = await mountBand($)
  expect(await ui.find({ key: 'progress-steps' })).toBeUndefined()
  await $.tool.call({ tool: 'mcp__fake__touch' } as never)
  await $.skill.prompt({ skill: 'ticket-rigor-gate', text: body } as never)
  const row = (await ui.find({ key: 'progress-steps' }))?.text ?? ''
  expect(row).toContain('ticket-rigor-gate')
  expect(row).toContain('0/3')
  expect(row).toContain('Load')
  await $.tool.call({ tool: TOOL, done: 1 } as never)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('1/3')
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('Review')
  await ui.unmount()
})

test('a busy ticket row is not replaced by a skill expansion', async ($, on) => {
  on('ui.render', engineBand)
  on('skill.prompt', ($: any, e: any) => ({ text: e.text }) as never)
  touchTool(on)
  fakeTree(on, 'ABC-04', PENDING)
  await $.tool.call({ tool: 'mcp__fake__touch', note: 'ABC-04' } as never)
  await $.skill.prompt({ skill: 'uc', text: ['# UC', '## A', '## B'].join('\n') } as never)
  const ui = await mountBand($)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('ABC-04')
  await ui.unmount()
})

test('every skill expansion carries the progress hint', async ($, on) => {
  on('skill.prompt', ($: any, e: any) => ({ text: e.text }) as never)
  const r = await $.skill.prompt({ skill: 'ticket-author', text: 'SKILL BODY' } as never)
  expect(r.text.startsWith('SKILL BODY')).toBe(true)
  expect(r.text).toContain('mcp__context-bar__progress')
  expect(r.text).toContain('never batched')
})

test('a ticket row survives silent turns (paused), unlike a skill row', async ($, on) => {
  on('ui.render', engineBand)
  on('turn.complete', () => ({ text: '' }) as never)
  touchTool(on)
  fakeTree(on, 'ABC-05', PENDING)
  await $.tool.call({ tool: 'mcp__fake__touch', note: 'ABC-05' } as never)
  for (let i = 0; i < 3; i++) await $.turn.complete({ reason: 'answer', answer: 'done' } as never)
  const ui = await mountBand($)
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('⏸')
  expect((await ui.find({ key: 'progress-steps' }))?.text).toContain('ABC-05')
  await ui.unmount()
})
