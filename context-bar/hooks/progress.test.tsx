import { expect, mock, test } from 'claude-code/testing'

import type { ProgressEvent, ProgressState, StepProgress, WorkflowManifest } from '../types'
import { seeded } from './progress'
import { applyLegacyPlan, migrateSteps } from './progress/legacy'
import { TICKET_AUTHOR } from './progress/manifests'
import { type Action, FADE_MS, STALE_MS, emptyState, reduce, stageCeiling } from './progress/reducer'
import { primaryRun, runView } from './progress/view'

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
