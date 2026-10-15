import type {
  Actor,
  Diagnostic,
  DiagnosticCode,
  ProgressEvent,
  ProgressRunState,
  ProgressState,
  RunId,
  StageDefinition,
  WorkflowManifest,
} from '../../types'
import { REGISTRY, normalize } from './manifests'
import { advanceRgr } from './rgr'
import { PRIMARY_HOLD_MS, settlePrimary } from './view'

// The progress reducer: pure, one action in, the next state and what became of
// the action out. Three layers, each with its own sources:
//
//   committed  run.started's manifest, stage moves, checkpoints, declared child
//              units, run.completed. Monotonic; percent derived from weights.
//   buffer     tool and subagent activity within the current stage, drawn past
//              the committed end but never past the stage's ceiling.
//   liveness   status, activity, counts and times; never completion.

export const STALE_MS = 120_000
export const FADE_MS = 2_000
export const DIAG_LIMIT = 50
export const MAX_RUNS = 12

export const emptyState = (): ProgressState => ({
  version: 2,
  runs: {},
  order: [],
  legacy: null,
  diagnostics: [],
  counts: { accepted: 0, ignored: 0 },
})

export type Action =
  | { kind: 'event'; event: ProgressEvent }
  // Host-observed tool calls: activity only.
  | { kind: 'tool.start'; activityId: string; name: string; actor: Actor; agentId?: string; at: number }
  | { kind: 'tool.end'; activityId: string; at: number }
  // The legacy adapter's commit: whole stages, as its plan proves them.
  // `message`: undefined keeps the current one, null clears it.
  | { kind: 'legacy.commit'; runId: RunId; stageIds: string[]; message?: string | null; initial: boolean; at: number }
  | { kind: 'turn.ended'; at: number }
  | { kind: 'prompt'; at: number }
  | { kind: 'tick'; at: number }
  | { kind: 'reload'; at: number }
  | { kind: 'dismiss'; runId?: RunId; at: number }

export type Outcome = {
  accepted: boolean
  runId?: RunId
  sequence?: number
  code?: DiagnosticCode
  detail?: string
  committedPercent?: number
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
// Ended runs that leave the band on their own: done, or called off. A failed
// run stays until it is dismissed or replaced.
const fades = (r: ProgressRunState) => r.base === 'completed' || r.base === 'cancelled'
export const isTerminal = (r: ProgressRunState) => TERMINAL.has(r.base)

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// ---- committed ---------------------------------------------------------------

type Unit = { kind: 'checkpoint' | 'child'; id: string; weight: number }

const unitsOf = (s: StageDefinition): Unit[] => [
  ...(s.checkpoints ?? []).map(c => ({ kind: 'checkpoint' as const, id: c.id, weight: 1 })),
  ...(s.childUnits ?? []).map(u => ({
    kind: 'child' as const,
    id: u.id,
    weight: typeof u.weight === 'number' && u.weight > 0 ? u.weight : 1,
  })),
]

const isUnitDone = (r: ProgressRunState, stageId: string, u: Unit) =>
  (u.kind === 'checkpoint' ? r.committed.completedCheckpoints[stageId] : r.committed.completedChildUnits[stageId])?.includes(
    u.id,
  ) ?? false

// The share of a stage its finished checkpoints and child units verify; a stage
// with none has nothing to verify before it completes.
export const verifiedFraction = (r: ProgressRunState, s: StageDefinition): number => {
  if (r.committed.completedStages.includes(s.id)) return 1
  const units = unitsOf(s)
  const total = units.reduce((n, u) => n + u.weight, 0)
  if (total === 0) return 0
  return units.filter(u => isUnitDone(r, s.id, u)).reduce((n, u) => n + u.weight, 0) / total
}

export const committedPercent = (r: ProgressRunState): number => {
  const { stages } = r.manifest
  if (stages.every(s => r.committed.completedStages.includes(s.id))) return 100
  const p = stages.reduce((n, s) => n + s.weight * verifiedFraction(r, s), 0)
  return Math.min(100, Math.max(0, p))
}

const stageIndex = (r: ProgressRunState, id: string | null | undefined) =>
  id == null ? -1 : r.manifest.stages.findIndex(s => s.id === id)

const firstOpenStage = (r: ProgressRunState) =>
  r.manifest.stages.find(s => !r.committed.completedStages.includes(s.id))?.id ?? null

const completeStage = (r: ProgressRunState, id: string) => {
  if (!r.committed.completedStages.includes(id)) r.committed.completedStages.push(id)
}

// A stage whose every checkpoint and child unit is done completes with them.
const closeVerifiedStages = (r: ProgressRunState) => {
  for (const s of r.manifest.stages) {
    const units = unitsOf(s)
    if (units.length > 0 && units.every(u => isUnitDone(r, s.id, u))) completeStage(r, s.id)
  }
}

// ---- buffer ------------------------------------------------------------------

// How far into the rest of the stage the buffer reaches after `n` activities:
// quick at first, never the whole way (only a commit gets there).
export const creep = (n: number) => 0.85 * (1 - Math.pow(0.7, Math.max(0, n)))

// The end the buffer may reach: committed plus what the current stage has yet to verify.
export const stageCeiling = (r: ProgressRunState): number => {
  const c = r.committed.percent
  const s = r.manifest.stages[stageIndex(r, r.currentStageId)]
  if (s === undefined || isTerminal(r) || r.committed.completedStages.includes(s.id)) return c
  return Math.min(100, c + s.weight * (1 - verifiedFraction(r, s)))
}

const refreshBuffer = (r: ProgressRunState) => {
  const c = r.committed.percent
  const ceiling = stageCeiling(r)
  if (r.buffer.stageId !== r.currentStageId) {
    r.buffer.stageId = r.currentStageId
    r.buffer.activityCount = 0
  }
  const want = c + creep(r.buffer.activityCount) * (ceiling - c)
  r.buffer.visualPercent = Math.min(ceiling, Math.max(c, want, r.buffer.visualPercent))
}

// ---- liveness ----------------------------------------------------------------

const settle = (r: ProgressRunState, at: number) => {
  const acts = Object.values(r.buffer.activeActivities)
  r.liveness.activeToolCount = acts.filter(a => a.actor !== 'subagent').length
  r.liveness.activeChildCount = new Set(acts.filter(a => a.actor === 'subagent').map(a => a.agentId ?? a.name)).size
  const status =
    r.base === 'running'
      ? r.liveness.activeToolCount > 0
        ? 'waiting-tool'
        : r.stale
          ? 'stale'
          : 'running'
      : r.base
  if (status !== r.status) {
    r.status = status
    r.liveness.statusSince = at
  }
}

const touch = (r: ProgressRunState, at: number) => {
  r.liveness.lastEventAt = Math.max(r.liveness.lastEventAt, at)
  r.stale = false
}

// A workflow statement (a stage, a checkpoint, a child unit) says the run is
// working again: it ends a wait for the user or an orphaned state, never a pause.
const wake = (r: ProgressRunState) => {
  if (r.base === 'waiting-user' || r.base === 'orphaned') {
    r.base = 'running'
    r.liveness.waitingSince = undefined
    r.liveness.pauseReason = undefined
  }
}

const finish = (r: ProgressRunState, at: number) => {
  const before = r.committed.percent
  r.committed.percent = committedPercent(r)
  // Whatever moved it (a checkpoint, a child unit, a stage left behind), a
  // rise is a commit: the band ranks runs by the newest one.
  if (r.committed.percent > before) r.liveness.lastCommittedAt = at
  refreshBuffer(r)
  settle(r, at)
}

// ---- state helpers -----------------------------------------------------------

const diag = (s: ProgressState, d: Diagnostic) => {
  s.diagnostics.push(d)
  if (s.diagnostics.length > DIAG_LIMIT) s.diagnostics.splice(0, s.diagnostics.length - DIAG_LIMIT)
}

// A refusal still says where the run stands, so the reporter can resync.
const ignore = (s: ProgressState, at: number, code: DiagnosticCode, runId?: RunId, detail?: string) => {
  s.counts.ignored += 1
  diag(s, { at, runId, code, detail })
  const r = runId !== undefined ? s.runs[runId] : undefined
  const where = r !== undefined ? { sequence: r.lastSequence, committedPercent: r.committed.percent } : {}
  return { state: s, outcome: { accepted: false, runId, code, detail, ...where } as Outcome }
}

// Keeps the run table bounded: hidden runs go first, then the oldest ended ones.
const prune = (s: ProgressState) => {
  while (s.order.length > MAX_RUNS) {
    const victim =
      s.order.find(id => s.runs[id]?.hidden) ?? s.order.find(id => s.runs[id] !== undefined && isTerminal(s.runs[id]))
    if (victim === undefined) return
    s.order = s.order.filter(id => id !== victim)
    delete s.runs[victim]
    if (s.legacy?.runId === victim) s.legacy = null
  }
}

export const newRun = (
  ev: Pick<ProgressEvent, 'runId' | 'workflowId' | 'sequence' | 'actor' | 'message'>,
  manifest: WorkflowManifest,
  at: number,
  label: string,
  origin: ProgressRunState['origin'],
  agentId?: string,
): ProgressRunState => {
  const r: ProgressRunState = {
    runId: ev.runId,
    workflowId: ev.workflowId,
    label,
    origin,
    foreground: ev.actor !== 'subagent',
    ownerAgentId: agentId,
    manifest,
    manifestVersion: manifest.version,
    lastSequence: ev.sequence,
    status: 'running',
    currentStageId: manifest.stages[0]?.id ?? null,
    committed: { completedStages: [], completedCheckpoints: {}, completedChildUnits: {}, percent: 0 },
    buffer: { visualPercent: 0, stageId: manifest.stages[0]?.id ?? null, activityCount: 0, activeActivities: {} },
    liveness: {
      currentMessage: ev.message,
      activeToolCount: 0,
      activeChildCount: 0,
      startedAt: at,
      lastEventAt: at,
      statusSince: at,
    },
    base: 'running',
    stale: false,
  }
  finish(r, at)
  return r
}

// The run the host's tool calls belong to: a subagent's own run, else the
// newest foreground run still going.
export const activityTarget = (s: ProgressState, agentId?: string): ProgressRunState | undefined => {
  const live = s.order
    .map(id => s.runs[id])
    .filter((r): r is ProgressRunState => r !== undefined && !isTerminal(r) && !r.hidden)
  if (agentId !== undefined) {
    const own = live.filter(r => r.ownerAgentId === agentId).pop()
    if (own !== undefined) return own
  }
  return live.filter(r => r.foreground).pop()
}

// Moves the current stage forward to `to`. The stage left behind completes only
// when it has nothing to verify; one with open checkpoints, and every stage
// jumped over, stays open and is reported, never assumed done.
const moveTo = (s: ProgressState, r: ProgressRunState, to: string, at: number): string | null => {
  const from = stageIndex(r, r.currentStageId)
  const dest = stageIndex(r, to)
  if (dest <= from) return null
  const missing: string[] = []
  const cur = r.manifest.stages[from]
  if (cur !== undefined && !r.committed.completedStages.includes(cur.id)) {
    if (unitsOf(cur).length === 0) completeStage(r, cur.id)
    else missing.push(cur.id)
  }
  for (const st of r.manifest.stages.slice(from + 1, dest)) {
    if (!r.committed.completedStages.includes(st.id)) missing.push(st.id)
  }
  r.currentStageId = to
  if (missing.length > 0) {
    const detail = `left open: ${missing.join(', ')}`
    diag(s, { at, runId: r.runId, code: 'missing-checkpoints', detail })
    return detail
  }
  return null
}

const startRun = (s: ProgressState, ev: ProgressEvent, agentId?: string) => {
  const at = ev.timestamp
  if (s.runs[ev.runId] !== undefined) return ignore(s, at, 'duplicate-start', ev.runId)
  let manifest: WorkflowManifest
  try {
    const source = ev.manifest ?? REGISTRY[ev.workflowId]
    if (source === undefined) return ignore(s, at, 'unknown-workflow', ev.runId, ev.workflowId)
    manifest = normalize(source)
  } catch (err) {
    return ignore(s, at, 'invalid-event', ev.runId, err instanceof Error ? err.message : String(err))
  }
  if (ev.manifestVersion > 0 && ev.manifestVersion !== manifest.version) {
    return ignore(s, at, 'manifest-mismatch', ev.runId, `event v${ev.manifestVersion}, manifest v${manifest.version}`)
  }
  const label = typeof ev.metadata?.label === 'string' ? ev.metadata.label.slice(0, 60) : manifest.label
  const r = newRun(ev, manifest, at, label, 'emit', ev.actor === 'subagent' ? agentId : undefined)
  s.runs[r.runId] = r
  s.order.push(r.runId)
  s.counts.accepted += 1
  prune(s)
  return { state: s, outcome: { accepted: true, runId: r.runId, sequence: r.lastSequence, committedPercent: r.committed.percent } }
}

// ---- events ------------------------------------------------------------------

const onEvent = (s: ProgressState, ev: ProgressEvent, agentId?: string): { state: ProgressState; outcome: Outcome } => {
  const at = ev.timestamp
  if (ev.type === 'run.started') return startRun(s, ev, agentId)
  const r = s.runs[ev.runId]
  if (r === undefined) return ignore(s, at, 'unknown-run', ev.runId)
  if (ev.sequence <= r.lastSequence) {
    const dupe =
      ev.type === 'checkpoint.completed' &&
      ev.stageId !== undefined &&
      ev.checkpointId !== undefined &&
      (r.committed.completedCheckpoints[ev.stageId] ?? []).includes(ev.checkpointId)
    return ignore(s, at, dupe ? 'duplicate-checkpoint' : 'stale-sequence', r.runId, `seq ${ev.sequence} ≤ ${r.lastSequence}`)
  }
  if (isTerminal(r)) return ignore(s, at, 'run-ended', r.runId, r.base)
  if (ev.manifestVersion > 0 && ev.manifestVersion !== r.manifestVersion) {
    return ignore(s, at, 'manifest-mismatch', r.runId, `event v${ev.manifestVersion}, run v${r.manifestVersion}`)
  }

  let note: { code: DiagnosticCode; detail: string } | null = null
  const findStage = (id: string | undefined) => r.manifest.stages.find(x => x.id === id)

  switch (ev.type) {
    case 'stage.started': {
      const st = findStage(ev.stageId)
      if (st === undefined) return ignore(s, at, 'unknown-stage', r.runId, ev.stageId)
      const i = stageIndex(r, st.id)
      const cur = stageIndex(r, r.currentStageId)
      if (i < cur) return ignore(s, at, 'stage-regression', r.runId, `${st.id} after ${r.currentStageId}`)
      const left = moveTo(s, r, st.id, at)
      if (left !== null) note = { code: 'missing-checkpoints', detail: left }
      wake(r)
      break
    }
    case 'checkpoint.completed': {
      const st =
        findStage(ev.stageId) ?? r.manifest.stages.find(x => x.checkpoints?.some(c => c.id === ev.checkpointId))
      if (st === undefined || !st.checkpoints?.some(c => c.id === ev.checkpointId)) {
        return ignore(s, at, 'unknown-checkpoint', r.runId, `${ev.stageId ?? '?'}/${ev.checkpointId ?? '?'}`)
      }
      const done = (r.committed.completedCheckpoints[st.id] ??= [])
      if (done.includes(ev.checkpointId!)) return ignore(s, at, 'duplicate-checkpoint', r.runId, `${st.id}/${ev.checkpointId}`)
      if (st.id === 'rgr' && ev.checkpointId === 'rgr-passed' && r.rgr !== undefined && r.rgr.phase !== 'passed') {
        return ignore(s, at, 'invalid-event', r.runId, `rgr-passed while ${r.rgr.phase}`)
      }
      if (stageIndex(r, st.id) > stageIndex(r, r.currentStageId)) {
        const left = moveTo(s, r, st.id, at)
        if (left !== null) note = { code: 'missing-checkpoints', detail: left }
      }
      done.push(ev.checkpointId!)
      closeVerifiedStages(r)
      r.liveness.lastCommittedAt = at
      wake(r)
      break
    }
    case 'child.started':
    case 'child.completed': {
      const id = ev.childUnitId ?? ''
      const st = findStage(ev.stageId) ?? r.manifest.stages.find(x => x.childUnits?.some(u => u.id === id))
      const declared = st?.childUnits?.some(u => u.id === id) ?? false
      const key = `child:${id}`
      if (ev.type === 'child.completed' && declared && st !== undefined && r.committed.completedChildUnits[st.id]?.includes(id)) {
        return ignore(s, at, 'duplicate-child', r.runId, `${st.id}/${id}`)
      }
      if (ev.type === 'child.started') {
        r.buffer.activeActivities[key] = { name: id, actor: 'subagent', agentId: key, startedAt: at }
        r.buffer.activityCount += 1
        r.liveness.currentActivity = id
      } else {
        delete r.buffer.activeActivities[key]
        if (declared && st !== undefined) {
          const done = (r.committed.completedChildUnits[st.id] ??= [])
          done.push(id)
          closeVerifiedStages(r)
          r.liveness.lastCommittedAt = at
          wake(r)
        }
      }
      if (!declared) {
        note = { code: 'undeclared-child', detail: id }
        diag(s, { at, runId: r.runId, code: 'undeclared-child', detail: id })
      }
      break
    }
    case 'activity.started': {
      // Without an id its completion could never match: it would hold the run
      // in waiting-tool for good.
      if (ev.activityId === undefined) return ignore(s, at, 'invalid-event', r.runId, 'activity.started needs an activityId')
      const key = `emit:${ev.activityId}`
      r.buffer.activeActivities[key] = {
        name: (ev.message ?? ev.activityId ?? 'activity').slice(0, 60),
        actor: ev.actor === 'subagent' ? 'subagent' : 'tool',
        agentId: ev.actor === 'subagent' ? (agentId ?? key) : undefined,
        startedAt: at,
      }
      r.buffer.activityCount += 1
      r.liveness.currentActivity = r.buffer.activeActivities[key].name
      break
    }
    case 'activity.completed':
      delete r.buffer.activeActivities[`emit:${ev.activityId ?? ''}`]
      break
    case 'run.waiting':
      r.base = 'waiting-user'
      r.liveness.waitingSince = at
      r.liveness.pauseReason = ev.message?.slice(0, 120)
      break
    case 'run.paused':
      r.base = 'paused'
      r.liveness.pauseReason = ev.message?.slice(0, 120)
      break
    case 'run.resumed':
      if (r.base === 'paused' || r.base === 'waiting-user' || r.base === 'orphaned') {
        r.base = 'running'
        r.liveness.waitingSince = undefined
        r.liveness.pauseReason = undefined
      }
      break
    case 'run.completed': {
      const cur = r.manifest.stages[stageIndex(r, r.currentStageId)]
      // The stage in hand completes with the run when it has nothing to verify.
      if (cur !== undefined && unitsOf(cur).length === 0) completeStage(r, cur.id)
      const open = r.manifest.stages.filter(x => !r.committed.completedStages.includes(x.id)).map(x => x.id)
      if (open.length > 0) {
        r.warning = 'inconsistent-completion'
        note = { code: 'inconsistent-completion', detail: `open: ${open.join(', ')}` }
        diag(s, { at, runId: r.runId, code: 'inconsistent-completion', detail: note.detail })
      }
      r.base = 'completed'
      r.endedAt = at
      r.buffer.activeActivities = {}
      break
    }
    case 'run.failed':
      r.base = 'failed'
      r.endedAt = at
      r.liveness.errorSummary = (ev.message ?? 'failed').slice(0, 200)
      r.buffer.activeActivities = {}
      break
    case 'run.cancelled':
      r.base = 'cancelled'
      r.endedAt = at
      r.buffer.activeActivities = {}
      break
    case 'heartbeat':
      break
  }

  // RGR rounds ride on any workflow event but a heartbeat; they move the RGR
  // view, never the parent's committed state, save `passed` closing its stage.
  if (ev.type !== 'heartbeat' && ev.metadata?.rgr !== undefined && !isTerminal(r)) {
    const res = advanceRgr(r.rgr, ev.metadata.rgr)
    if ('violation' in res) {
      note = { code: 'rgr-regression', detail: res.violation }
      diag(s, { at, runId: r.runId, code: 'rgr-regression', detail: res.violation })
    } else {
      r.rgr = res.next
      if (res.next.phase === 'needs-user') {
        r.base = 'waiting-user'
        r.liveness.waitingSince = at
        r.liveness.pauseReason = 'RGR needs user'
      } else wake(r)
      const rgrStage = r.manifest.stages.find(x => x.checkpoints?.some(c => c.id === 'rgr-passed'))
      if (res.next.phase === 'passed' && rgrStage !== undefined) {
        const done = (r.committed.completedCheckpoints[rgrStage.id] ??= [])
        if (!done.includes('rgr-passed')) {
          done.push('rgr-passed')
          closeVerifiedStages(r)
          r.liveness.lastCommittedAt = at
        }
      }
    }
  }

  r.lastSequence = ev.sequence
  // A wait's or a pause's words are its reason (pauseReason), not the run's
  // message, so they leave with the wait instead of outliving it.
  if (ev.message !== undefined && ev.type !== 'heartbeat' && ev.type !== 'run.waiting' && ev.type !== 'run.paused') {
    r.liveness.currentMessage = ev.message.slice(0, 120)
  }
  touch(r, at)
  finish(r, at)
  s.counts.accepted += 1
  return {
    state: s,
    outcome: {
      accepted: true,
      runId: r.runId,
      sequence: r.lastSequence,
      committedPercent: r.committed.percent,
      ...(note !== null ? { code: note.code, detail: note.detail } : {}),
    },
  }
}

// ---- the reducer -------------------------------------------------------------

// Every action also settles which run the band shows.
export const reduce = (
  prev: ProgressState,
  action: Action,
  agentId?: string,
): { state: ProgressState; outcome: Outcome } => {
  const res = reduceRuns(prev, action, agentId)
  const at = action.kind === 'event' ? action.event.timestamp : action.at
  const state = settlePrimary(res.state, at)
  return state === res.state ? res : { state, outcome: res.outcome }
}

const reduceRuns = (
  prev: ProgressState,
  action: Action,
  agentId?: string,
): { state: ProgressState; outcome: Outcome } => {
  const s = clone(prev)
  const none = { accepted: false }
  switch (action.kind) {
    case 'event':
      return onEvent(s, action.event, agentId)

    case 'tool.start': {
      const r = activityTarget(s, action.agentId)
      if (r === undefined) return { state: prev, outcome: none }
      r.buffer.activeActivities[action.activityId] = {
        name: action.name,
        actor: action.actor,
        agentId: action.agentId,
        startedAt: action.at,
      }
      if (r.buffer.stageId !== r.currentStageId) refreshBuffer(r)
      r.buffer.activityCount += 1
      r.liveness.currentActivity = action.name
      touch(r, action.at)
      finish(r, action.at)
      return { state: s, outcome: { accepted: true, runId: r.runId } }
    }

    case 'tool.end': {
      const r = s.order.map(id => s.runs[id]).find(x => x?.buffer.activeActivities[action.activityId] !== undefined)
      if (r === undefined) return { state: prev, outcome: none }
      delete r.buffer.activeActivities[action.activityId]
      if (!isTerminal(r)) touch(r, action.at)
      finish(r, action.at)
      return { state: s, outcome: { accepted: true, runId: r.runId } }
    }

    case 'legacy.commit': {
      const r = s.runs[action.runId]
      if (r === undefined || isTerminal(r)) return { state: prev, outcome: none }
      const fresh = action.stageIds.filter(id => !r.committed.completedStages.includes(id) && stageIndex(r, id) >= 0)
      for (const id of fresh) completeStage(r, id)
      if (fresh.length > 1 && !action.initial) {
        diag(s, { at: action.at, runId: r.runId, code: 'missing-checkpoints', detail: `${fresh.length} stages in one report` })
      }
      if (fresh.length > 0) r.liveness.lastCommittedAt = action.at
      r.currentStageId = firstOpenStage(r) ?? r.currentStageId
      if (action.message !== undefined) r.liveness.currentMessage = action.message ?? undefined
      wake(r)
      if (r.manifest.stages.every(x => r.committed.completedStages.includes(x.id))) {
        r.base = 'completed'
        r.endedAt = action.at
        r.buffer.activeActivities = {}
      }
      r.lastSequence += 1
      touch(r, action.at)
      finish(r, action.at)
      s.counts.accepted += 1
      return { state: s, outcome: { accepted: true, runId: r.runId, sequence: r.lastSequence, committedPercent: r.committed.percent } }
    }

    case 'turn.ended': {
      // The main turn ended with work open: the run waits for the person.
      for (const id of s.order) {
        const r = s.runs[id]
        if (r === undefined || !r.foreground || r.base !== 'running') continue
        r.base = 'waiting-user'
        r.liveness.waitingSince = action.at
        r.liveness.pauseReason = 'turn ended'
        finish(r, action.at)
      }
      return { state: s, outcome: none }
    }

    case 'prompt': {
      for (const id of s.order) {
        const r = s.runs[id]
        if (r === undefined) continue
        if (fades(r)) r.hidden = true
        else if (r.foreground && r.base === 'waiting-user') {
          r.base = 'running'
          r.liveness.waitingSince = undefined
          r.liveness.pauseReason = undefined
          touch(r, action.at)
          finish(r, action.at)
        }
      }
      return { state: s, outcome: none }
    }

    case 'tick': {
      for (const id of s.order) {
        const r = s.runs[id]
        if (r === undefined || r.hidden) continue
        if (fades(r) && r.endedAt !== undefined && action.at - r.endedAt >= FADE_MS) r.hidden = true
        else if (
          r.base === 'running' &&
          !r.stale &&
          Object.keys(r.buffer.activeActivities).length === 0 &&
          action.at - r.liveness.lastEventAt >= STALE_MS
        ) {
          r.stale = true
          finish(r, action.at)
        }
      }
      return { state: s, outcome: none }
    }

    case 'reload': {
      // Calls in flight when the code reloaded never report their end: a run
      // that was waiting on them has lost its owner until its next event.
      for (const id of s.order) {
        const r = s.runs[id]
        if (r === undefined || isTerminal(r) || Object.keys(r.buffer.activeActivities).length === 0) continue
        r.buffer.activeActivities = {}
        if (r.base === 'running') r.base = 'orphaned'
        finish(r, action.at)
      }
      return { state: s, outcome: none }
    }

    case 'dismiss': {
      for (const id of s.order) {
        const r = s.runs[id]
        if (r === undefined) continue
        if (action.runId !== undefined ? id === action.runId : isTerminal(r)) r.hidden = true
      }
      return { state: s, outcome: none }
    }
  }
}

// When the reducer next has something to do with no event: a running run going
// stale, a completed one fading. null when nothing is due.
export const nextDue = (s: ProgressState): number | null => {
  let due: number | null = null
  const consider = (t: number) => (due = due === null ? t : Math.min(due, t))
  // A run held back from the band gets its turn once the hold is over.
  if (s.primary?.held !== undefined) consider(s.primary.since + PRIMARY_HOLD_MS)
  for (const id of s.order) {
    const r = s.runs[id]
    if (r === undefined || r.hidden) continue
    if (fades(r) && r.endedAt !== undefined) consider(r.endedAt + FADE_MS)
    else if (r.base === 'running' && !r.stale && Object.keys(r.buffer.activeActivities).length === 0) {
      consider(r.liveness.lastEventAt + STALE_MS)
    }
  }
  return due
}
