import type { ProgressState, StepProgress } from '../../types'
import { legacyManifest } from './manifests'
import { emptyState, isTerminal, newRun, reduce } from './reducer'

// Legacy adapter (deprecated): the v1 sources (`progress(done, total)` reports,
// a ticket's ticked sections, a skill's headings) keep their plan bookkeeping
// in `StepProgress`, and each plan drives one run of equal-weight stages. A
// `done` becomes stage completions and nothing else; tool calls never do.

const identity = (p: StepProgress) => `${p.source}|${p.label}|${p.total}`

// Folds the next plan into the state. `finished` are the ticket file's own
// per-section verdicts, when the plan came from a ticket.
export const applyLegacyPlan = (
  prev: ProgressState,
  plan: StepProgress | null,
  at: number,
  finished?: readonly boolean[],
): ProgressState => {
  let s = prev
  const old = s.legacy
  const oldRun = old !== null ? s.runs[old.runId] : undefined
  const isSame =
    old !== null && plan !== null && oldRun !== undefined && oldRun.hidden !== true && identity(old.plan) === identity(plan)

  if (!isSame) {
    if (oldRun !== undefined) {
      // The plan behind it is gone or replaced: an open run ends cancelled with
      // its committed history kept; either way it leaves the band.
      s = {
        ...s,
        runs: {
          ...s.runs,
          [oldRun.runId]: {
            ...oldRun,
            base: isTerminal(oldRun) ? oldRun.base : 'cancelled',
            status: isTerminal(oldRun) ? oldRun.status : 'cancelled',
            endedAt: oldRun.endedAt ?? at,
            hidden: true,
          },
        },
      }
    }
    if (plan === null) return { ...s, legacy: null }
    const runId = `legacy-${at}-${s.counts.accepted + s.counts.ignored}`
    const manifest = legacyManifest(plan.label, plan.sections, plan.total)
    const run = newRun({ runId, workflowId: 'legacy', sequence: 0, actor: 'main' }, manifest, at, plan.label, 'legacy')
    s = {
      ...s,
      runs: { ...s.runs, [runId]: run },
      order: [...s.order, runId],
      legacy: { plan, runId },
    }
  } else {
    s = { ...s, legacy: { plan: plan!, runId: old!.runId } }
  }

  const p = plan!
  const runId = s.legacy!.runId
  const stages = s.runs[runId]!.manifest.stages
  // Which stages the plan proves: the ticket's ticked sections plus the first
  // `reported` ones; for a skill or a report, the first `done`.
  const proven = new Set<string>()
  const upTo = p.source === 'ticket' ? p.reported : p.done
  stages.slice(0, upTo).forEach(st => proven.add(st.id))
  finished?.forEach((f, i) => f && stages[i] !== undefined && proven.add(stages[i].id))
  const message = p.source === 'report' ? p.step : undefined
  return reduce(s, { kind: 'legacy.commit', runId, stageIds: [...proven], message, initial: !isSame, at }).state
}

// v1's `steps` row, read once into a v2 state; a row that cannot be read
// leaves an empty progress (the context bar never depends on it).
export const migrateSteps = (steps: unknown, at: number): ProgressState => {
  const base = emptyState()
  if (steps === null || steps === undefined) return base
  try {
    const p = steps as StepProgress
    if (typeof p.label !== 'string' || !(p.total >= 1)) throw new Error('not a v1 row')
    const s = applyLegacyPlan(base, p, at)
    s.diagnostics.push({ at, code: 'migrated', detail: `v1 ${p.source} row ${p.done}/${p.total}` })
    return s
  } catch (err) {
    base.diagnostics.push({ at, code: 'migration-failed', detail: err instanceof Error ? err.message : String(err) })
    return base
  }
}

// The plan behind the band's legacy row, while that row is still shown.
export const currentPlan = (s: ProgressState): StepProgress | null => {
  if (s.legacy === null) return null
  const r = s.runs[s.legacy.runId]
  return r !== undefined && r.hidden !== true ? s.legacy.plan : null
}

// A foreground progress_emit run still going: the workflow reports for itself,
// so the legacy sources (skill headings, ticket ticks, done/total) stand aside
// rather than track the same work twice.
export const hasOpenEmitRun = (s: ProgressState): boolean =>
  s.order.some(id => {
    const r = s.runs[id]
    return r !== undefined && r.origin === 'emit' && r.foreground && !r.hidden && !isTerminal(r)
  })
