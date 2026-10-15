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
  elapsedMs: number
  activity: string | null
  rgr: string | null
  warning: boolean
  error: string | null
}

const visible = (s: ProgressState) =>
  s.order.map(id => s.runs[id]).filter((r): r is ProgressRunState => r !== undefined && !r.hidden)

const needsAttention = (r: ProgressRunState) => r.status === 'waiting-user' || r.status === 'failed'
const newest = (rs: ProgressRunState[], key: (r: ProgressRunState) => number) =>
  rs.reduce<ProgressRunState | undefined>((best, r) => (best === undefined || key(r) >= key(best) ? r : best), undefined)

// The run the band shows: one that needs the person, else the foreground run
// that last committed, else the newest foreground run, else the newest active one.
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

export const runView = (r: ProgressRunState, now: number): RunView => {
  const stage = r.manifest.stages.find(x => x.id === r.currentStageId)
  const ended = r.endedAt ?? now
  const activity =
    r.status === 'waiting-tool' && r.liveness.currentActivity !== undefined ? r.liveness.currentActivity : null
  const stageLabel = stage !== undefined && stage.label !== '' ? stage.label : null
  return {
    runId: r.runId,
    label: r.label,
    detail: r.liveness.currentMessage ?? stageLabel,
    done: r.committed.completedStages.length,
    total: r.manifest.stages.length,
    percent: Math.round(r.committed.percent),
    committed: r.committed.percent,
    buffer: r.buffer.visualPercent,
    status: r.status,
    elapsedMs: Math.max(0, ended - r.liveness.startedAt),
    activity,
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
