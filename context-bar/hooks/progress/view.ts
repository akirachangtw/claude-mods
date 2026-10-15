import type { LivenessStatus, ProgressRunState, ProgressState } from '../../types'
import { rgrText } from './rgr'

// What the band draws for a run: everything derived, nothing stored.

export type RunView = {
  runId: string
  label: string
  // The current stage's name, or the run's own status text when it has one.
  detail: string | null
  done: number
  total: number
  // Committed, rounded for the header; committed and buffer, exact, for the track.
  percent: number
  committed: number
  buffer: number
  status: LivenessStatus
  // The whole run's time, and the time of the tool call in hand (its own clock).
  elapsedMs: number
  activity: string | null
  activityElapsedMs: number | null
  rgr: string | null
  warning: boolean
  error: string | null
}

const visible = (s: ProgressState) =>
  s.order.map(id => s.runs[id]).filter((r): r is ProgressRunState => r !== undefined && !r.hidden)

const needsAttention = (r: ProgressRunState) => r.status === 'waiting-user' || r.status === 'failed'
const newest = (rs: ProgressRunState[], key: (r: ProgressRunState) => number) =>
  rs.reduce<ProgressRunState | undefined>((best, r) => (best === undefined || key(r) >= key(best) ? r : best), undefined)

// How urgently a run wants the band: one that needs the person first.
const rank = (r: ProgressRunState) => (needsAttention(r) ? (r.foreground ? 0 : 1) : r.foreground ? 2 : 3)

// How long the shown run holds the band against a run of the same rank, so a
// stream of subagent events does not flip it back and forth.
export const PRIMARY_HOLD_MS = 3_000

// The run the band would pick now: one that needs the person, else the
// foreground run that last committed, else the newest foreground run, else the
// newest active one.
export const primaryRun = (s: ProgressState): ProgressRunState | null => {
  const rs = visible(s)
  return (
    newest(rs.filter(r => needsAttention(r) && r.foreground), r => r.liveness.statusSince) ??
    newest(rs.filter(needsAttention), r => r.liveness.statusSince) ??
    newest(rs.filter(r => r.foreground && r.liveness.lastCommittedAt !== undefined), r => r.liveness.lastCommittedAt ?? 0) ??
    newest(rs.filter(r => r.foreground), r => r.liveness.startedAt) ??
    newest(rs, r => r.liveness.lastEventAt) ??
    null
  )
}

// Moves `primary` toward the run the band would pick, with a hold: a run that
// outranks the shown one takes over at once; one of the same or lower rank
// only after the shown run has held the band PRIMARY_HOLD_MS.
export const settlePrimary = (s: ProgressState, at: number): ProgressState => {
  const want = primaryRun(s)
  const cur = s.primary !== undefined ? s.runs[s.primary.runId] : undefined
  const isShown = cur !== undefined && !cur.hidden
  let next: ProgressState['primary']
  if (want === null) next = undefined
  else if (isShown && cur.runId === want.runId) next = { runId: want.runId, since: s.primary!.since }
  // A run that is only fading out keeps the band, and takes a free one only in
  // the moment it ends (its ✓ shows); it never steps in later, so a group
  // ending together leaves with the run on show, not one after another.
  else if (isFading(want)) {
    next = isShown ? { runId: cur.runId, since: s.primary!.since } : want.endedAt === at ? { runId: want.runId, since: at } : undefined
  }
  else if (!isShown) next = { runId: want.runId, since: at }
  else if (rank(want) < rank(cur) || at - s.primary!.since >= PRIMARY_HOLD_MS) next = { runId: want.runId, since: at }
  else next = { runId: cur.runId, since: s.primary!.since, held: want.runId }
  return JSON.stringify(next) === JSON.stringify(s.primary) ? s : { ...s, primary: next }
}

// The run the band shows: the settled primary while it is still visible.
export const shownRun = (s: ProgressState): ProgressRunState | null => {
  const r = s.primary !== undefined ? s.runs[s.primary.runId] : undefined
  if (r !== undefined && !r.hidden) return r
  const want = primaryRun(s)
  return want !== null && !isFading(want) ? want : null
}

// Visible runs still going besides the shown one: the band's `+N background`.
export const backgroundCount = (s: ProgressState, shown: ProgressRunState | null): number =>
  visible(s).filter(r => r.runId !== shown?.runId && !isEnded(r)).length

const isEnded = (r: ProgressRunState) => r.base === 'completed' || r.base === 'failed' || r.base === 'cancelled'
// Ended and on its way out; a failed run is not: it stays and asks for the person.
const isFading = (r: ProgressRunState) => r.base === 'completed' || r.base === 'cancelled'

export const runView = (r: ProgressRunState, now: number): RunView => {
  const stage = r.manifest.stages.find(x => x.id === r.currentStageId)
  const ended = r.endedAt ?? now
  // The newest tool call still open, with the time since it started.
  const open = Object.values(r.buffer.activeActivities)
    .filter(a => a.actor !== 'subagent')
    .sort((a, b) => b.startedAt - a.startedAt)[0]
  const isWaiting = r.status === 'waiting-tool' && open !== undefined
  const stageLabel = stage !== undefined && stage.label !== '' ? stage.label : null
  // The host's own reason for a wait (a turn ended) says nothing the state does not.
  const reason = r.liveness.pauseReason !== undefined && r.liveness.pauseReason !== 'turn ended' ? r.liveness.pauseReason : null
  return {
    runId: r.runId,
    label: r.label,
    // While it waits or is paused, the reason it gave stands in the title.
    detail: (r.status === 'waiting-user' || r.status === 'paused') && reason !== null ? reason : (r.liveness.currentMessage ?? stageLabel),
    done: r.committed.completedStages.length,
    total: r.manifest.stages.length,
    percent: Math.round(r.committed.percent),
    committed: r.committed.percent,
    buffer: r.buffer.visualPercent,
    status: r.status,
    elapsedMs: Math.max(0, ended - r.liveness.startedAt),
    activity: isWaiting ? open.name : null,
    activityElapsedMs: isWaiting ? Math.max(0, now - open.startedAt) : null,
    rgr: r.rgr !== undefined ? rgrText(r.rgr) : null,
    warning: r.warning !== undefined,
    error: r.liveness.errorSummary ?? null,
  }
}

// 38s, 4m05s, 1h02m
export const formatElapsed = (ms: number) => {
  const t = Math.floor(ms / 1000)
  if (t < 60) return `${t}s`
  if (t < 3600) return `${Math.floor(t / 60)}m${String(t % 60).padStart(2, '0')}s`
  return `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}m`
}

// /progress: runs and the reasons events were refused. No tool arguments, no
// ticket or prompt text: ids, counts and the reducer's own codes only.
export const diagnosticsText = (s: ProgressState, now: number, surface: string): string => {
  const lines: string[] = []
  const rs = s.order.map(id => s.runs[id]).filter((r): r is ProgressRunState => r !== undefined)
  lines.push(`progress v${s.version} · ${rs.length} run(s) · accepted ${s.counts.accepted} · ignored ${s.counts.ignored} · surface ${surface}`)
  for (const r of rs) {
    const v = runView(r, now)
    lines.push(
      `${r.hidden === true ? '  (hidden) ' : '  '}${r.runId} · ${r.workflowId} v${r.manifestVersion} · seq ${r.lastSequence} · ${v.status}` +
        ` · ${v.done}/${v.total} ${r.committed.percent.toFixed(1)}% (buffer ${r.buffer.visualPercent.toFixed(1)}%)` +
        ` · stage ${r.currentStageId ?? '-'} · tools ${r.liveness.activeToolCount} · children ${r.liveness.activeChildCount}` +
        ` · last event ${formatElapsed(Math.max(0, now - r.liveness.lastEventAt))} ago` +
        (r.warning !== undefined ? ` · ${r.warning}` : ''),
    )
    const cps = Object.entries(r.committed.completedCheckpoints).flatMap(([st, ids]) => ids.map(id => `${st}/${id}`))
    if (cps.length > 0) lines.push(`    checkpoints: ${cps.join(', ')}`)
  }
  const ds = s.diagnostics.slice(-15)
  if (ds.length > 0) {
    lines.push('diagnostics (newest last):')
    for (const d of ds) lines.push(`  ${d.code}${d.runId !== undefined ? ` [${d.runId}]` : ''}${d.detail !== undefined ? ` ${d.detail}` : ''}`)
  }
  return lines.join('\n')
}
