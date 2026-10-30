import { expect, mock, test } from 'claude-code/testing'

import type { ProgressEvent, ProgressState, StepProgress, WorkflowManifest } from '../types'
import { BUFFER_TINT, seeded } from './progress'
import { applyLegacyPlan, migrateSteps } from './progress/legacy'
import { TICKET_AUTHOR } from './progress/manifests'
import { type Action, FADE_MS, STALE_MS, emptyState, nextDue, reduce, stageCeiling } from './progress/reducer'
import { PRIMARY_HOLD_MS, primaryRun, runView, shownRun } from './progress/view'
import { NARROW_TEXT_SIZE, textCells } from './layout'
import { displayWidth } from './text'

// ---- helpers -----------------------------------------------------------------

const T0 = 1_000_000

// Events for one run, numbered in the order the test writes them.
const runEvents = (runId = 'r1', workflowId = 'ticket-author') => {
  let seq = 0
  return (type: ProgressEvent['type'], extra: Partial<ProgressEvent> = {}, at = T0): Action => ({
    kind: 'event',
    event: { runId, workflowId, manifestVersion: 1, sequence: ++seq, timestamp: at, actor: 'main', type, ...extra },
  })
}

const fold = (s: ProgressState, ...actions: Action[]) => actions.reduce((acc, a) => reduce(acc, a).state, s)

const pct = (s: ProgressState, id = 'r1') => s.runs[id]!.committed.percent
const codes = (s: ProgressState) => s.diagnostics.map(d => d.code)

const toolStart = (id: string, at = T0, agentId?: string): Action => ({
  kind: 'tool.start',
  activityId: id,
  name: 'Bash',
  actor: agentId !== undefined ? 'subagent' : 'main',
  agentId,
  at,
})
const toolEnd = (id: string, at = T0): Action => ({ kind: 'tool.end', activityId: id, at })

// Ticket Author through to the RGR stage, every checkpoint reported.
const toRgr = (e: ReturnType<typeof runEvents>) => [
  e('run.started'),
  e('checkpoint.completed', { stageId: 'bootstrap', checkpointId: 'templates-loaded' }),
  e('stage.started', { stageId: 'intake' }),
  e('checkpoint.completed', { stageId: 'intake', checkpointId: 'parent-parsed' }),
  e('stage.started', { stageId: 'evidence' }),
  e('checkpoint.completed', { stageId: 'evidence', checkpointId: 'sources-located' }),
  e('checkpoint.completed', { stageId: 'evidence', checkpointId: 'load-bearing-verified' }),
  e('checkpoint.completed', { stageId: 'evidence', checkpointId: 'conflicts-resolved' }),
  e('stage.started', { stageId: 'mapping' }),
  e('checkpoint.completed', { stageId: 'mapping', checkpointId: 'mapped' }),
  e('stage.started', { stageId: 'draft' }),
  e('checkpoint.completed', { stageId: 'draft', checkpointId: 'drafted' }),
  e('stage.started', { stageId: 'rgr' }),
]

const report = (done: number, total: number, label = 'plan'): StepProgress => ({
  source: 'report',
  label,
  sections: [],
  step: null,
  mech: 0,
  reported: done,
  done,
  total,
  paused: false,
  calls: 0,
})

// ---- Reducer (spec tests 1–10) ---------------------------------------------------

test('1. 0/7 then 20 tool calls: committed stays, buffer and liveness move', () => {
  const e = runEvents()
  let s = fold(emptyState(), e('run.started'))
  for (let i = 0; i < 20; i++) s = fold(s, toolStart(`t${i}`, T0 + i), toolEnd(`t${i}`, T0 + i + 1))
  const r = s.runs.r1!
  expect(r.committed.percent).toBe(0)
  expect(r.committed.completedStages).toEqual([])
  expect(r.buffer.activityCount).toBe(20)
  expect(r.buffer.visualPercent).toBeGreaterThan(0)
  expect(r.buffer.visualPercent).toBeLessThan(8)
  expect(r.liveness.lastEventAt).toBe(T0 + 20)
  expect(runView(r, T0 + 20)).toMatchObject({ done: 0, total: 7, percent: 0 })
})

test('2. a repeated checkpoint is idempotent', () => {
  const e = runEvents()
  const once = fold(emptyState(), e('run.started'), e('checkpoint.completed', { stageId: 'bootstrap', checkpointId: 'templates-loaded' }))
  const twice = fold(once, e('checkpoint.completed', { stageId: 'bootstrap', checkpointId: 'templates-loaded' }))
  expect(pct(once)).toBe(8)
  expect(pct(twice)).toBe(8)
  expect(twice.runs.r1!.committed.completedCheckpoints.bootstrap).toEqual(['templates-loaded'])
  expect(codes(twice)).toContain('duplicate-checkpoint')
})

test('3. an old sequence arriving late is ignored and nothing goes back', () => {
  let s = fold(emptyState(), runEvents()('run.started'))
  const at = (sequence: number, type: ProgressEvent['type'], extra: Partial<ProgressEvent> = {}): Action => ({
    kind: 'event',
    event: { runId: 'r1', workflowId: 'ticket-author', manifestVersion: 1, sequence, timestamp: T0, type, ...extra },
  })
  s = fold(s, at(5, 'checkpoint.completed', { stageId: 'bootstrap', checkpointId: 'templates-loaded' }), at(6, 'stage.started', { stageId: 'intake' }))
  const late = reduce(s, at(3, 'run.paused'))
  expect(late.outcome).toMatchObject({ accepted: false, code: 'stale-sequence' })
  expect(late.state.runs.r1!.base).toBe('running')
  expect(late.state.runs.r1!.currentStageId).toBe('intake')
  expect(late.state.runs.r1!.lastSequence).toBe(6)
  expect(pct(late.state)).toBe(8)
})

test('4. legacy 1/7 → 5/7 records a protocol violation and fabricates no checkpoint', () => {
  let s = applyLegacyPlan(emptyState(), report(1, 7), T0)
  s = applyLegacyPlan(s, report(5, 7), T0 + 1)
  const r = s.runs[s.legacy!.runId]!
  expect(r.committed.completedStages.length).toBe(5)
  expect(r.committed.completedCheckpoints).toEqual({})
  expect(s.diagnostics.find(d => d.code === 'missing-checkpoints')?.detail).toContain('4 stages')
  // The emit path: jumping from bootstrap to draft leaves every skipped stage open.
  const e = runEvents()
  const jumped = fold(emptyState(), e('run.started'), e('stage.started', { stageId: 'draft' }))
  expect(pct(jumped)).toBe(0)
  expect(jumped.runs.r1!.committed.completedStages).toEqual([])
  expect(jumped.diagnostics.find(d => d.code === 'missing-checkpoints')?.detail).toContain('bootstrap, intake, evidence, mapping')
})

test('5. a subagent tool call moves only buffer and liveness', () => {
  const e = runEvents()
  const s = fold(emptyState(), e('run.started'), toolStart('sub-call', T0 + 5, 'agent-1'))
  const r = s.runs.r1!
  expect(r.committed.percent).toBe(0)
  expect(r.liveness.activeChildCount).toBe(1)
  expect(r.liveness.activeToolCount).toBe(0)
  expect(r.buffer.visualPercent).toBeGreaterThan(0)
  expect(r.status).toBe('running')
})

test('6. a declared child unit commits its own weight only; an undeclared one nothing', () => {
  const manifest: WorkflowManifest = {
    id: 'fanout',
    label: 'Fan-out',
    version: 1,
    stages: [
      { id: 'work', label: 'Work', weight: 50, childUnits: [{ id: 'a', label: 'A', weight: 1 }, { id: 'b', label: 'B', weight: 3 }] },
      { id: 'wrap', label: 'Wrap', weight: 50 },
    ],
  }
  const e = runEvents('r1', 'fanout')
  let s = fold(emptyState(), e('run.started', { manifest }), e('child.started', { stageId: 'work', childUnitId: 'a' }))
  expect(s.runs.r1!.liveness.activeChildCount).toBe(1)
  s = fold(s, e('child.completed', { stageId: 'work', childUnitId: 'a' }))
  expect(pct(s)).toBe(12.5)
  s = fold(s, e('child.completed', { stageId: 'work', childUnitId: 'stray' }))
  expect(pct(s)).toBe(12.5)
  expect(codes(s)).toContain('undeclared-child')
  s = fold(s, e('child.completed', { stageId: 'work', childUnitId: 'b' }))
  expect(pct(s)).toBe(50)
  expect(s.runs.r1!.committed.completedStages).toEqual(['work'])
})

test('7. a second RGR round never moves the parent back; passed commits the stage', () => {
  const e = runEvents()
  let s = fold(emptyState(), ...toRgr(e))
  const before = pct(s)
  expect(before).toBe(73)
  // RGR state rides on a repeated stage.started of the rgr stage.
  const rgr = (round: number, phase: string, extra: object = {}) =>
    e('stage.started', { stageId: 'rgr', metadata: { rgr: { round, maxRounds: 3, phase, ...extra } } })
  s = fold(s, rgr(1, 'review'), rgr(1, 'repair', { findingsTotal: 4, findingsRepaired: 2 }), rgr(2, 'rerun'))
  expect(pct(s)).toBe(before)
  expect(runView(s.runs.r1!, T0).rgr).toBe('RGR · Round 2/3 · Rerunning · 2/4 fixed')
  // Rounds open no activity: the run is running, not waiting on a tool, and can still go stale.
  expect(s.runs.r1!.status).toBe('running')
  expect(s.runs.r1!.buffer.activeActivities).toEqual({})
  // The loop cannot jump from rerun back to review within a round.
  s = fold(s, rgr(2, 'review'))
  expect(codes(s)).toContain('rgr-regression')
  expect(s.runs.r1!.rgr?.phase).toBe('rerun')
  // A premature rgr-passed is refused while the loop has not passed.
  const early = reduce(s, e('checkpoint.completed', { stageId: 'rgr', checkpointId: 'rgr-passed' }))
  expect(early.outcome.accepted).toBe(false)
  s = fold(s, rgr(2, 'passed'))
  expect(pct(s)).toBe(95)
  expect(s.runs.r1!.committed.completedStages).toContain('rgr')
})

test('8. run.completed with a required stage open is not silently 100%', () => {
  const e = runEvents()
  const s = fold(emptyState(), e('run.started'), e('checkpoint.completed', { stageId: 'bootstrap', checkpointId: 'templates-loaded' }), e('run.completed'))
  const r = s.runs.r1!
  expect(r.committed.percent).toBe(8)
  expect(r.warning).toBe('inconsistent-completion')
  expect(r.status).toBe('completed')
  expect(runView(r, T0).warning).toBe(true)
})

test('8b. a run whose stages are all done completes at 100%', () => {
  const e = runEvents()
  const s = fold(
    emptyState(),
    ...toRgr(e),
    e('stage.started', { stageId: 'rgr', metadata: { rgr: { round: 1, maxRounds: 3, phase: 'passed' } } }),
    e('stage.started', { stageId: 'finalize' }),
    e('checkpoint.completed', { stageId: 'finalize', checkpointId: 'written' }),
    e('run.completed'),
  )
  expect(pct(s)).toBe(100)
  expect(s.runs.r1!.warning).toBeUndefined()
})

test('9. failed and cancelled keep what was committed', () => {
  for (const end of ['run.failed', 'run.cancelled'] as const) {
    const e = runEvents()
    const s = fold(emptyState(), e('run.started'), e('checkpoint.completed', { stageId: 'bootstrap', checkpointId: 'templates-loaded' }), e(end, { message: 'boom' }))
    expect(pct(s)).toBe(8)
    expect(s.runs.r1!.committed.completedCheckpoints.bootstrap).toEqual(['templates-loaded'])
    // Nothing after the end moves it.
    expect(reduce(s, e('checkpoint.completed', { stageId: 'intake', checkpointId: 'parent-parsed' })).outcome.code).toBe('run-ended')
  }
})

test('10. a reload replays nothing twice: no second start, no second checkpoint', () => {
  const e = runEvents()
  const log = [e('run.started'), e('checkpoint.completed', { stageId: 'bootstrap', checkpointId: 'templates-loaded' }), e('stage.started', { stageId: 'intake' })]
  const before = fold(emptyState(), ...log, toolStart('in-flight'))
  const reloaded = fold(before, { kind: 'reload', at: T0 + 10 })
  // The call in flight never reports its end: the run is orphaned until its next event.
  expect(reloaded.runs.r1!.status).toBe('orphaned')
  expect(reloaded.runs.r1!.buffer.activeActivities).toEqual({})
  const replayed = fold(reloaded, ...log)
  expect(replayed.runs.r1!.committed).toEqual(before.runs.r1!.committed)
  expect(replayed.order).toEqual(['r1'])
  expect(codes(replayed).filter(c => c === 'duplicate-start').length).toBe(1)
  const next = fold(replayed, e('checkpoint.completed', { stageId: 'intake', checkpointId: 'parent-parsed' }, T0 + 20))
  expect(next.runs.r1!.status).toBe('running')
  expect(pct(next)).toBe(15)
})

// ---- Liveness (spec tests 11–15) -----------------------------------------------

test('11. a three-minute Bash: percent holds, elapsed grows, status waiting-tool', () => {
  const e = runEvents()
  let s = fold(emptyState(), e('run.started'), e('checkpoint.completed', { stageId: 'bootstrap', checkpointId: 'templates-loaded' }), toolStart('bash', T0 + 1000))
  s = fold(s, { kind: 'tick', at: T0 + 181_000 })
  const v = runView(s.runs.r1!, T0 + 181_000)
  expect(v.status).toBe('waiting-tool')
  expect(v.percent).toBe(8)
  expect(v.elapsedMs).toBe(181_000)
  expect(v.activity).toBe('Bash')
})

test('12. a paused run is not resumed by unrelated tool calls', () => {
  const e = runEvents()
  let s = fold(emptyState(), e('run.started'), e('run.paused', { message: 'hold' }), toolStart('x'), toolEnd('x'))
  expect(s.runs.r1!.status).toBe('paused')
  s = fold(s, e('checkpoint.completed', { stageId: 'bootstrap', checkpointId: 'templates-loaded' }))
  expect(s.runs.r1!.status).toBe('paused')
  s = fold(s, e('run.resumed'))
  expect(s.runs.r1!.status).toBe('running')
})

test('13. a heartbeat does not end waiting-user', () => {
  const e = runEvents()
  const s = fold(emptyState(), e('run.started'), e('run.waiting', { message: 'approve plan' }), e('heartbeat', {}, T0 + 5000))
  expect(s.runs.r1!.status).toBe('waiting-user')
  expect(s.runs.r1!.liveness.lastEventAt).toBe(T0 + 5000)
  expect(pct(s)).toBe(0)
  // The next prompt does.
  expect(fold(s, { kind: 'prompt', at: T0 + 6000 }).runs.r1!.status).toBe('running')
})

test('14. past the stale TTL a run turns stale and stays; its next event revives it', () => {
  const e = runEvents()
  let s = fold(emptyState(), e('run.started'), { kind: 'tick', at: T0 + STALE_MS - 1 })
  expect(s.runs.r1!.status).toBe('running')
  s = fold(s, { kind: 'tick', at: T0 + STALE_MS })
  expect(s.runs.r1!.status).toBe('stale')
  expect(s.runs.r1!.hidden).toBeUndefined()
  expect(primaryRun(s)?.runId).toBe('r1')
  s = fold(s, e('heartbeat', {}, T0 + STALE_MS + 1))
  expect(s.runs.r1!.status).toBe('running')
})

test('15. completed fades after a moment; failed stays until dismissed', () => {
  const ok = runEvents('ok')
  const bad = runEvents('bad')
  let s = fold(emptyState(), ok('run.started'), ok('run.completed'), bad('run.started'), bad('run.failed', { message: 'gate failed' }))
  s = fold(s, { kind: 'tick', at: T0 + FADE_MS - 1 })
  expect(s.runs.ok!.hidden).toBeUndefined()
  s = fold(s, { kind: 'tick', at: T0 + FADE_MS })
  expect(s.runs.ok!.hidden).toBe(true)
  s = fold(s, { kind: 'tick', at: T0 + 3_600_000 })
  expect(s.runs.bad!.hidden).toBeUndefined()
  expect(primaryRun(s)?.runId).toBe('bad')
  expect(runView(s.runs.bad!, T0).error).toBe('gate failed')
  s = fold(s, { kind: 'dismiss', at: T0 })
  expect(primaryRun(s)).toBeNull()
})

// ---- Property checks -----------------------------------------------------------

// A small deterministic PRNG, so a failure names the seed that found it.
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

const randomActions = (seed: number, n: number): Action[] => {
  const r = rng(seed)
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!
  const stages = TICKET_AUTHOR.stages
  const out: Action[] = [{ kind: 'event', event: { runId: 'p', workflowId: 'ticket-author', manifestVersion: 1, sequence: 1, timestamp: T0, type: 'run.started' } }]
  let seq = 1
  for (let i = 0; i < n; i++) {
    const at = T0 + i * 1000
    const st = pick(stages)
    const roll = r()
    // Sometimes reuse an old sequence number, as a late or replayed event would.
    const sequence = r() < 0.15 ? Math.max(1, seq - Math.floor(r() * 4)) : ++seq
    const ev = (type: ProgressEvent['type'], extra: Partial<ProgressEvent> = {}): Action => ({
      kind: 'event',
      event: { runId: 'p', workflowId: 'ticket-author', manifestVersion: 1, sequence, timestamp: at, type, ...extra },
    })
    if (roll < 0.25) out.push(ev('checkpoint.completed', { stageId: st.id, checkpointId: pick(st.checkpoints ?? [{ id: 'x', label: '' }]).id }))
    else if (roll < 0.4) out.push(ev('stage.started', { stageId: st.id }))
    else if (roll < 0.5) out.push(ev('heartbeat'))
    else if (roll < 0.55) out.push(ev(pick(['run.paused', 'run.resumed', 'run.waiting'] as const)))
    else if (roll < 0.8) out.push(toolStart(`a${i % 5}`, at, r() < 0.3 ? 'sub' : undefined))
    else out.push(toolEnd(`a${(i + 2) % 5}`, at))
  }
  return out
}

test('property: committed stays within 0–100 and never decreases; buffer stays between committed and the stage ceiling', () => {
  for (let seed = 1; seed <= 40; seed++) {
    let s = emptyState()
    let last = 0
    for (const a of randomActions(seed, 80)) {
      s = reduce(s, a).state
      const run = s.runs.p
      if (run === undefined) continue
      const c = run.committed.percent
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(100)
      expect(c).toBeGreaterThanOrEqual(last)
      expect(run.buffer.visualPercent).toBeGreaterThanOrEqual(c)
      expect(run.buffer.visualPercent).toBeLessThanOrEqual(stageCeiling(run) + 1e-9)
      last = c
    }
  }
})

test('property: delivering every event twice ends at the same committed state', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const acts = randomActions(seed, 60).filter(a => a.kind === 'event')
    const once = fold(emptyState(), ...acts)
    const twice = fold(emptyState(), ...acts.flatMap(a => [a, a]))
    expect(twice.runs.p!.committed).toEqual(once.runs.p!.committed)
  }
})

test('property: swapping two independent activity events leaves committed unchanged', () => {
  const e = runEvents('p')
  const head = [e('run.started'), e('checkpoint.completed', { stageId: 'bootstrap', checkpointId: 'templates-loaded' })]
  const a = toolStart('x', T0 + 1)
  const b = toolStart('y', T0 + 2, 'sub')
  const ab = fold(emptyState(), ...head, a, b, toolEnd('x', T0 + 3))
  const ba = fold(emptyState(), ...head, b, a, toolEnd('x', T0 + 3))
  expect(ba.runs.p!.committed).toEqual(ab.runs.p!.committed)
})

// ---- Migration -------------------------------------------------------------------

test('a v1 row migrates into a legacy run; an unreadable one leaves progress empty', () => {
  const s = migrateSteps(seeded('skill', 'ticket-rigor-gate', ['Load', 'Review', 'Report'], 1), T0)
  const r = s.runs[s.legacy!.runId]!
  expect(r.committed.completedStages).toEqual(['s1'])
  expect(codes(s)).toContain('migrated')
  const bad = migrateSteps({ nonsense: true }, T0)
  expect(bad.order).toEqual([])
  expect(codes(bad)).toContain('migration-failed')
})

// ---- Through the plugin: the emit tool, /progress and the band ----------------------

const EMIT = 'mcp__context-bar__progress_emit'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 19, contentRows: 0 },
  view: {},
} as never

const engineBand = ($: any, e: any) => {
  const { Box } = $.ui.resolve(e)
  return <Box key="engine" />
}

const emit = async ($: any, input: Record<string, unknown>) =>
  JSON.parse(String((await $.tool.call({ tool: EMIT, runId: 'T01', ...input } as never)).result))

test('progress_emit drives the band: manifest stage, weighted percent, refusals reported back', async ($, on) => {
  mock.clock(on, { now: T0 })
  on('ui.render', engineBand)
  expect((await $.tool.check({ tool: EMIT, input: {} } as never)).decision).toBe('allow')
  expect(await emit($, { type: 'run.started', workflowId: 'ticket-author', label: 'ticket-author T01' })).toMatchObject({ accepted: true, sequence: 1 })
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  let row = (await ui.find({ key: 'progress-steps' }))?.text ?? ''
  expect(row).toContain('ticket-author T01')
  expect(row).toContain('0/7')
  expect(row).toContain('Bootstrap')
  expect(await emit($, { type: 'checkpoint.completed', stageId: 'bootstrap', checkpointId: 'templates-loaded' })).toMatchObject({ accepted: true, committedPercent: 8 })
  expect(await emit($, { type: 'checkpoint.completed', stageId: 'bootstrap', checkpointId: 'templates-loaded' })).toMatchObject({ accepted: false, code: 'duplicate-checkpoint' })
  // A refusal still says where the run stands.
  expect(await emit($, { type: 'stage.started', stageId: 'evidence', sequence: 2 })).toMatchObject({
    accepted: false,
    code: 'stale-sequence',
    sequence: 2,
    committedPercent: 8,
  })
  expect(await emit($, { type: 'activity.started' })).toMatchObject({ accepted: false, code: 'invalid-event' })
  expect(await emit($, { type: 'nonsense' })).toMatchObject({ accepted: false, code: 'invalid-event' })
  row = (await ui.find({ key: 'progress-steps' }))?.text ?? ''
  expect(row).toContain('1/7')
  expect(row).toContain('8%')
  await ui.unmount()
})

test('no run, no progress block: the band is the context bar alone', async ($, on) => {
  on('ui.render', engineBand)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ key: 'progress' })).toBeUndefined()
  expect((await ui.find({ key: 'context-bar' }))?.text).toContain('context')
  await ui.unmount()
})

test('context and progress stay apart: a measure leaves progress alone, a heartbeat measures nothing', async ($, on) => {
  mock.clock(on, { now: T0 })
  let usageCalls = 0
  on('session.usage', () => (usageCalls++, { value: { startedAt: 0, rateLimits: [], context: { tokens: 1, window: 10, percent: 10 } } }) as never)
  on('session.measure', () => ({ changed: ['context'] }) as never)
  on('ui.render', engineBand)
  await emit($, { type: 'run.started', workflowId: 'rgr' })
  await emit($, { type: 'stage.started', stageId: 'rgr', rgr: { round: 1, maxRounds: 3, phase: 'review' } })
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const before = (await ui.find({ key: 'progress-steps' }))?.text
  await $.session.measure({ context: { window: 10 }, rateLimits: [], changed: ['context'] } as never)
  expect((await ui.find({ key: 'header' }))?.text).toContain('10%')
  expect((await ui.find({ key: 'progress-steps' }))?.text).toBe(before)
  expect(before).toContain('RGR · Round 1/3 · Reviewing')
  await ui.unmount()
  const calls = usageCalls
  await emit($, { type: 'heartbeat' })
  expect(usageCalls).toBe(calls)
})

test('/progress lists runs and refused events without tool arguments', async ($, on) => {
  mock.clock(on, { now: T0 })
  await emit($, { type: 'run.started', workflowId: 'ticket-author' })
  await emit($, { type: 'stage.started', stageId: 'draft' })
  const { text } = await $.command.run({ command: 'progress', args: '' } as never)
  expect(text).toContain('T01 · ticket-author v1')
  expect(text).toContain('missing-checkpoints')
})

test('an open progress_emit run owns the band: skill headings and done/total reports stand aside', async ($, on) => {
  mock.clock(on, { now: T0 })
  on('ui.render', engineBand)
  on('skill.prompt', ($: any, e: any) => ({ text: e.text }) as never)
  // A harmless tool the engine does not know, so the plugin's after-call hook runs.
  const anyOn = on as any
  anyOn('tool.check', { tool: 'mcp__fake__touch' }, () => ({ decision: 'allow' }))
  anyOn('tool.call', { tool: 'mcp__fake__touch' }, () => ({ result: 'ok' }))
  await emit($, { type: 'run.started', workflowId: 'ticket-author', label: 'ticket-author T01' })
  await $.tool.call({ tool: 'mcp__fake__touch' } as never)
  await $.skill.prompt({ skill: 'ticket-author', text: ['# TA', '## A', '## B', '## C'].join('\n') } as never)
  const legacy = await $.tool.call({ tool: 'mcp__context-bar__progress', done: 2, total: 5, label: 'mine' } as never)
  expect(String(legacy.result)).toContain('ignored')
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const row = (await ui.find({ key: 'progress-steps' }))?.text ?? ''
  expect(row).toContain('ticket-author T01')
  expect(row).toContain('0/7')
  const { text } = await $.command.run({ command: 'progress', args: '' } as never)
  expect(text).toContain('1 run(s)')
  await ui.unmount()
})

// ---- Band layout (P1.5) ----------------------------------------------------------
// The kit draws trees, never a surface's paint: these pin the structure that
// keeps the cat inside its own row, not the pixels.

const bandOf = (cols: number) => ({ ...(BAND as object), bodyColumns: cols }) as never

test('desktop band: progress sits above the context header, the track grows to the cat instead of a fixed row', async ($, on) => {
  mock.clock(on, { now: T0 })
  on('ui.render', engineBand)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 1, window: 10, percent: 10 } } }) as never)
  on('session.measure', () => ({ changed: ['context'] }) as never)
  await $.session.measure({ context: { window: 10 }, rateLimits: [], changed: ['context'] } as never)
  await emit($, { type: 'run.started', workflowId: 'ticket-author', label: 'ticket-author T01' })
  await emit($, { type: 'checkpoint.completed', stageId: 'bootstrap', checkpointId: 'templates-loaded' })
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  const tree = JSON.stringify(await ui.drawn())
  expect(tree.indexOf('"progress"')).toBeLessThan(tree.indexOf('"header"'))
  const track = (await ui.find({ key: 'progress-steps-track' })) as any
  expect(track.props.height).toBeUndefined()
  expect(track.props.minHeight).toBe(1)
  expect(track.props.alignItems).toBe('center')
  const cat = (await ui.find({ type: 'Svg' })) as any
  expect(cat.props.height).toBeLessThanOrEqual(16)
  expect(String(cat.props.source)).toContain('height="16"')
  for (const part of ['committed', 'rest']) {
    expect(((await ui.find({ key: `progress-steps-${part}` })) as any).props.height).toBe(1)
  }
  await ui.unmount()
})

test('a tool call does not change the cat: same source and alt before, during and after it', async ($, on) => {
  mock.clock(on, { now: T0 })
  on('ui.render', engineBand)
  let ui: any = null
  const cat = async () => {
    const p = ((await ui.find({ type: 'Svg' })) as any).props
    return `${p.alt}|${p.source}`
  }
  let during = ''
  let liveDuring = ''
  const anyOn = on as any
  anyOn('tool.check', { tool: 'mcp__fake__slow' }, () => ({ decision: 'allow' }))
  anyOn('tool.call', { tool: 'mcp__fake__slow' }, async () => {
    during = await cat()
    liveDuring = (await ui.find({ key: 'progress-steps-live' }))?.text ?? ''
    return { result: 'ok' }
  })
  await emit($, { type: 'run.started', workflowId: 'ticket-author' })
  ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  const before = await cat()
  await $.tool.call({ tool: 'mcp__fake__slow' } as never)
  expect(liveDuring).toContain('⧗ fake:slow')
  expect(during).toBe(before)
  expect(await cat()).toBe(before)
  await ui.unmount()
})

test('80-column terminal: the label truncates, the count and percent keep their own cell', async ($, on) => {
  mock.clock(on, { now: T0 })
  on('ui.render', engineBand)
  await emit($, { type: 'run.started', workflowId: 'ticket-author', label: 'ticket-author ' + 'a-very-long-ticket-name-'.repeat(4) })
  for (const cols of [80, 120, 160]) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: bandOf(cols) })
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    const title = (await ui.find({ key: 'progress-steps-title' })) as any
    expect(title.props.width).toBe(0)
    expect(title.props.flexGrow).toBe(1)
    expect(JSON.stringify(title.children)).toContain('truncate-end')
    const head = (await ui.find({ key: 'progress-steps-head' }))?.text ?? ''
    expect(head).toContain('0/7')
    expect(head).toContain('0%')
    expect(((await ui.find({ key: 'progress-steps-track' })) as any).props.height).toBe(1)
    await ui.unmount()
  }
})

// Option A (P1.5 ruling): nothing redraws the band while a call runs, so any
// seconds shown froze for the whole call in the recording. The band says what
// the run is doing instead, and shows no times at all.
test('no frozen seconds: the band names the tool or the state, never a time', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  on('ui.render', engineBand)
  on('turn.complete', () => ({ text: '' }) as never)
  let ui: any = null
  let live = ''
  let head = ''
  const anyOn = on as any
  anyOn('tool.check', { tool: 'mcp__fake__slow' }, () => ({ decision: 'allow' }))
  anyOn('tool.call', { tool: 'mcp__fake__slow' }, async () => {
    live = (await ui.find({ key: 'progress-steps-live' }))?.text ?? ''
    head = (await ui.find({ key: 'progress-steps-head' }))?.text ?? ''
    return { result: 'ok' }
  })
  await emit($, { type: 'run.started', workflowId: 'ticket-author' })
  await clock.advance(8_000)
  ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await $.tool.call({ tool: 'mcp__fake__slow' } as never)
  expect(live).toBe('⧗ fake:slow')
  expect(head).not.toMatch(/\d+s\b|Run /)
  expect((await ui.find({ key: 'progress-steps-live' }))?.text).toBe('working')
  await $.turn.complete({ reason: 'answer', answer: 'done' } as never)
  expect((await ui.find({ key: 'progress-steps-live' }))?.text).toBe('waiting for you')
  expect(JSON.stringify(await ui.drawn())).not.toMatch(/\d+s"/)
  await ui.unmount()
})

test('buffer is a light tint: apart from the committed fill and lighter than a finished look', async ($, on) => {
  mock.clock(on, { now: T0 })
  on('ui.render', engineBand)
  const anyOn = on as any
  anyOn('tool.check', { tool: 'mcp__fake__touch' }, () => ({ decision: 'allow' }))
  anyOn('tool.call', { tool: 'mcp__fake__touch' }, () => ({ result: 'ok' }))
  await emit($, { type: 'run.started', workflowId: 'ticket-author' })
  await emit($, { type: 'checkpoint.completed', stageId: 'bootstrap', checkpointId: 'templates-loaded' })
  await emit($, { type: 'stage.started', stageId: 'intake' })
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'mcp__fake__touch' } as never)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  const bg = async (part: string) => ((await ui.find({ key: `progress-steps-${part}` })) as any)?.props?.backgroundColor
  expect(await bg('committed')).toBe('claude')
  expect(await bg('buffer')).toBe(BUFFER_TINT)
  expect(await bg('rest')).toBe('subtle')
  await ui.unmount()
})

// Found in the P1.5 recording: a cancelled run stayed on the band for minutes
// and took it back once a later run faded.
test('a cancelled run fades like a completed one and does not return after a later run fades', () => {
  const old = runEvents('old')
  const cur = runEvents('cur')
  let s = fold(emptyState(), old('run.started'), old('run.cancelled'), cur('run.started', {}, T0 + 10), cur('run.completed', {}, T0 + 10))
  s = fold(s, { kind: 'tick', at: T0 + FADE_MS })
  expect(s.runs.old!.hidden).toBe(true)
  s = fold(s, { kind: 'tick', at: T0 + 10 + FADE_MS })
  expect(s.runs.cur!.hidden).toBe(true)
  expect(primaryRun(s)).toBeNull()
  // A failed run is still the exception: it stays.
  const bad = runEvents('bad')
  const f = fold(emptyState(), bad('run.started'), bad('run.failed'), { kind: 'tick', at: T0 + 3_600_000 })
  expect(primaryRun(f)?.runId).toBe('bad')
})

// ---- P2: divider, multi-run summary, switch hold, column fallback ------------------

test('a divider separates progress from the context header; none without a run', async ($, on) => {
  mock.clock(on, { now: T0 })
  on('ui.render', engineBand)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 1, window: 10, percent: 10 } } }) as never)
  on('session.measure', () => ({ changed: ['context'] }) as never)
  await $.session.measure({ context: { window: 10 }, rateLimits: [], changed: ['context'] } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const bare = await $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: BAND })
    expect(await bare.find({ key: 'progress-divider' })).toBeUndefined()
    await bare.unmount()
  }
  await emit($, { type: 'run.started', workflowId: 'rgr' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: BAND })
    const tree = JSON.stringify(await ui.drawn())
    const at = (k: string) => tree.indexOf(`"${k}"`)
    expect(at('progress-steps')).toBeLessThan(at('progress-divider'))
    expect(at('progress-divider')).toBeLessThan(at('header'))
    const rule = (await ui.find({ key: 'progress-divider' })) as any
    expect(rule.props.height).toBe(1)
    expect(rule.text).toMatch(/^─+$/)
    expect(JSON.stringify(rule.children)).toContain('truncate-end')
    // BAND is 100 columns: 96 cells inside the border. The terminal's rule fills
    // them; the desktop's (found in the P2 recordings: a full row of ─ overflowed
    // into an ellipsis, and an Svg line drew nothing) is shorter and centred.
    if (surface === 'terminal') {
      expect(rule.text.length).toBe(96)
      expect(rule.props.justifyContent).toBe('flex-start')
    } else {
      expect(rule.text.length).toBe(81)
      expect(rule.props.justifyContent).toBe('center')
    }
    await ui.unmount()
  }
})

test('several runs: the band shows one and sums up the rest as +N background', async ($, on) => {
  mock.clock(on, { now: T0 })
  on('ui.render', engineBand)
  await emit($, { type: 'run.started', workflowId: 'ticket-author', label: 'main ticket' })
  // The kit drops agentId from a call's input, so these two start as further
  // runs of the main conversation; the main one keeps the band by committing.
  await $.tool.call({ tool: EMIT, runId: 'sub-rgr', type: 'run.started', workflowId: 'rgr' } as never)
  await $.tool.call({ tool: EMIT, runId: 'sub-exec', type: 'run.started', workflowId: 'execution-ticket' } as never)
  await emit($, { type: 'checkpoint.completed', stageId: 'bootstrap', checkpointId: 'templates-loaded' })
  // Full words from 80 columns (the desktop band is about 95); `+N` alone below.
  for (const [cols, others] of [[160, '+2 background'], [120, '+2 background'], [80, '+2 background'], [60, '+2']] as const) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: bandOf(cols) })
    expect((await ui.find({ key: 'progress-steps-head' }))?.text).toContain('main ticket')
    expect((await ui.findAll({ key: 'progress-steps' })).length).toBe(1)
    expect((await ui.find({ key: 'progress-steps-others' }))?.text).toBe(others)
    await ui.unmount()
  }
  // An ended run is no longer counted (a failed one would take the band instead).
  await $.tool.call({ tool: EMIT, runId: 'sub-exec', type: 'run.cancelled' } as never)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: bandOf(160) })
  expect((await ui.find({ key: 'progress-steps-head' }))?.text).toContain('main ticket')
  expect((await ui.find({ key: 'progress-steps-others' }))?.text).toBe('+1 background')
  await ui.unmount()
})

test('switch hold: an equal-rank run waits its turn; one that needs the person takes over at once', () => {
  const a = runEvents('a')
  const b = runEvents('b')
  let s = fold(emptyState(), a('run.started'), a('checkpoint.completed', { stageId: 'bootstrap', checkpointId: 'templates-loaded' }))
  expect(s.primary?.runId).toBe('a')
  // b commits later: it would win, but a holds the band for PRIMARY_HOLD_MS.
  s = fold(s, b('run.started', {}, T0 + 500), b('checkpoint.completed', { stageId: 'bootstrap', checkpointId: 'templates-loaded' }, T0 + 600))
  expect(s.primary).toMatchObject({ runId: 'a', held: 'b' })
  expect(shownRun(s)?.runId).toBe('a')
  // A burst of activity inside the hold changes nothing.
  for (let i = 0; i < 10; i++) s = fold(s, toolStart(`x${i}`, T0 + 700 + i), toolEnd(`x${i}`, T0 + 700 + i))
  expect(shownRun(s)?.runId).toBe('a')
  expect(nextDue(s)).toBe(T0 + PRIMARY_HOLD_MS)
  s = fold(s, { kind: 'tick', at: T0 + PRIMARY_HOLD_MS })
  expect(shownRun(s)?.runId).toBe('b')
  // a now asks for the person: it outranks b and takes the band back at once.
  s = fold(s, a('run.waiting', { message: 'approve' }, T0 + PRIMARY_HOLD_MS + 10))
  expect(shownRun(s)?.runId).toBe('a')
  expect(s.primary?.held).toBeUndefined()
})

test('the shown run leaving the band hands it over at once', () => {
  const a = runEvents('a')
  const b = runEvents('b')
  let s = fold(emptyState(), a('run.started'), b('run.started', {}, T0 + 1))
  expect(shownRun(s)?.runId).toBe('a')
  s = fold(s, a('run.cancelled', {}, T0 + 2), { kind: 'tick', at: T0 + 2 + FADE_MS })
  expect(s.runs.a!.hidden).toBe(true)
  expect(shownRun(s)?.runId).toBe('b')
})

// Found in the P2 recording: a run that commits by moving to its next stage (an
// execution ticket's stages have no checkpoints) never took the band, because
// only checkpoints stamped the commit time.
test('a commit by stage move counts: the run takes the band after the hold', () => {
  const a = runEvents('a')
  const c = runEvents('c', 'execution-ticket')
  let s = fold(emptyState(), a('run.started'), a('checkpoint.completed', { stageId: 'bootstrap', checkpointId: 'templates-loaded' }))
  s = fold(s, c('run.started', {}, T0 + 100), c('stage.started', { stageId: 'plan' }, T0 + 200))
  expect(s.runs.c!.committed.percent).toBe(10)
  expect(s.runs.c!.liveness.lastCommittedAt).toBe(T0 + 200)
  expect(s.primary).toMatchObject({ runId: 'a', held: 'c' })
  s = fold(s, { kind: 'tick', at: T0 + PRIMARY_HOLD_MS })
  expect(shownRun(s)?.runId).toBe('c')
})

// Found in the P2 recording: a cancelled run still showed the words it waited with.
test('a wait reason shows while waiting and leaves with the wait', () => {
  const a = runEvents('a')
  let s = fold(emptyState(), a('run.started'), a('run.waiting', { message: 'approve the plan' }))
  expect(runView(s.runs.a!, T0).detail).toBe('approve the plan')
  s = fold(s, a('run.cancelled'))
  expect(runView(s.runs.a!, T0).detail).toBe('Bootstrap')
  // The host's own "turn ended" is no reason worth a title.
  const b = runEvents('b')
  const t = fold(emptyState(), b('run.started'), { kind: 'turn.ended', at: T0 + 1 })
  expect(runView(t.runs.b!, T0).detail).toBe('Bootstrap')
})

// Found in the P2 re-run: cancelling a group showed one fading run, then another.
test('when runs end together, the shown one stays until it fades; a failed one still takes over', () => {
  const a = runEvents('a')
  const c = runEvents('c', 'execution-ticket')
  let s = fold(emptyState(), a('run.started'), c('run.started', {}, T0 + 1), c('stage.started', { stageId: 'plan' }, T0 + 2))
  s = fold(s, { kind: 'tick', at: T0 + 10_000 })
  expect(shownRun(s)?.runId).toBe('c')
  s = fold(s, c('run.cancelled', {}, T0 + 10_001), a('run.cancelled', {}, T0 + 10_002))
  expect(shownRun(s)?.runId).toBe('c')
  // c fades first; a, still fading, does not step in for its last moment.
  s = fold(s, { kind: 'tick', at: T0 + 10_001 + FADE_MS })
  expect(s.runs.a!.hidden).toBeUndefined()
  expect(shownRun(s)).toBeNull()
  s = fold(s, { kind: 'tick', at: T0 + 10_002 + FADE_MS })
  expect(primaryRun(s)).toBeNull()
  // A failed run is not fading: it takes the band from a live one at once.
  const x = runEvents('x')
  const y = runEvents('y')
  let f = fold(emptyState(), x('run.started'), y('run.started', {}, T0 + 1))
  f = fold(f, y('run.failed', { message: 'boom' }, T0 + 2))
  expect(shownRun(f)?.runId).toBe('y')
})

// ---- one line per row; the narrow band -----------------------------------------

const USAGE_FULL = {
  startedAt: 0,
  rateLimits: [],
  context: {
    tokens: 582000,
    window: 1000000,
    percent: 58,
    breakdown: {
      categories: [
        { name: 'System tools', tokens: 32000, color: 'inactive', kind: 'used', isDeferred: false },
        { name: 'Messages', tokens: 550000, color: 'permission', kind: 'used', isDeferred: false },
        { name: 'Free space', tokens: 418000, color: 'inactive', kind: 'free', isDeferred: false },
      ],
      totalTokens: 582000,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 58,
      autoCompactThreshold: 967000,
      isAutoCompactEnabled: true,
    },
  },
} as never

const LONG = 'ADV-CONSTRSRC-01 BLOCKED 回流（無模型啟動）'

// A measured band with one long-titled run, mounted at `cols` on `surface`.
const runBand = async ($: any, on: any, cols: number, surface: 'desktop' | 'terminal') => {
  await startRun($, on)
  return mountAt($, cols, surface)
}
const mountAt = ($: any, cols: number, surface: 'desktop' | 'terminal') =>
  $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: bandOf(cols) })
const startRun = async ($: any, on: any) => {
  mock.clock(on, { now: T0 })
  on('ui.render', engineBand)
  on('session.usage', () => ({ value: USAGE_FULL }) as never)
  on('session.measure', () => ({ changed: ['context'] }) as never)
  await $.session.measure({ context: { window: 1000000 }, rateLimits: [], changed: ['context'] } as never)
  await emit($, { type: 'run.started', workflowId: 'ticket-author', label: LONG })
}

const svgs = async (ui: any) => ((await ui.findAll({ type: 'Svg' })) as any[]).map(n => n.props)

test('narrow desktop: small text, two thin bars, no cat, status row, divider, token count or details', async ($, on) => {
  const ui = await runBand($, on, 50, 'desktop')
  const all = await svgs(ui)
  expect(all.some(p => String(p.alt).startsWith('cat'))).toBe(false)
  const thin = all.filter(p => p.height === 8)
  expect(thin.length).toBe(2)
  for (const p of thin) {
    expect(p.width).toBeUndefined()
    expect(String(p.source)).toContain('width="4000"')
  }
  expect(await ui.find({ key: 'progress-steps-live' })).toBeUndefined()
  expect(await ui.find({ key: 'progress-divider' })).toBeUndefined()
  expect(await ui.find({ key: 'details-toggle' })).toBeUndefined()
  expect(await ui.find({ key: 'bar' })).toBeUndefined()
  const header = (await ui.find({ key: 'header' })) as any
  expect(header.text).toContain('58%')
  expect(header.text).not.toContain('582k')
  const head = (await ui.find({ key: 'progress-steps-head' })) as any
  expect(head.text).toContain('0/7')
  expect(JSON.stringify(head)).toContain(`"size":"${NARROW_TEXT_SIZE}"`)
  expect(JSON.stringify(header)).toContain(`"size":"${NARROW_TEXT_SIZE}"`)
  await ui.unmount()
})

test('narrow terminal: one-row blocks for both bars, no Svg, no cat', async ($, on) => {
  const ui = await runBand($, on, 50, 'terminal')
  expect((await svgs(ui)).length).toBe(0)
  expect(((await ui.find({ key: 'progress-steps-track' })) as any).props.height).toBe(1)
  expect(((await ui.find({ key: 'bar' })) as any).props.height).toBe(1)
  expect((await ui.find({ key: 'progress-steps-track' }))?.text ?? '').not.toMatch(/[ᓚᘏᗢ=^]/)
  expect(await ui.find({ key: 'progress-steps-live' })).toBeUndefined()
  await ui.unmount()
})

test('wide desktop keeps the P2 band: cat, status row, divider, details, full token summary', async ($, on) => {
  const ui = await runBand($, on, 100, 'desktop')
  expect((await svgs(ui)).some(p => String(p.alt).startsWith('cat'))).toBe(true)
  expect(await ui.find({ key: 'progress-steps-live' })).toBeDefined()
  expect(await ui.find({ key: 'progress-divider' })).toBeDefined()
  expect(await ui.find({ key: 'details-toggle' })).toBeDefined()
  expect(await ui.find({ key: 'bar' })).toBeDefined()
  expect((await ui.find({ key: 'header' }))?.text).toContain('582k of 1M · compacts at 967k')
  await ui.unmount()
})

test('every row is cut to one line before it is drawn, wide or narrow', async ($, on) => {
  await startRun($, on)
  for (const cols of [40, 59, 60, 80]) {
    const ui = await mountAt($, cols, 'desktop')
    const cells = textCells(cols, 'desktop')
    const head = ((await ui.find({ key: 'progress-steps-head' })) as any).text as string
    const header = ((await ui.find({ key: 'header' })) as any).text as string
    expect(displayWidth(head)).toBeLessThanOrEqual(cells)
    expect(displayWidth(header)).toBeLessThanOrEqual(cells)
    expect(head).toContain('0/7')
    expect(header).toContain('58%')
    await ui.unmount()
  }
})
