import type { RgrPhase, RgrState } from '../../types'

// RGR is re-entrant: review → repair → rerun → repair → rerun → passed, with
// needs-user possible from anywhere. Its rounds live beside the parent's
// committed state and never move it; only `passed` lets the RGR stage commit.

const PHASES: readonly RgrPhase[] = ['review', 'repair', 'rerun', 'passed', 'needs-user']

const NEXT: Record<RgrPhase, readonly RgrPhase[]> = {
  review: ['repair', 'passed', 'needs-user'],
  repair: ['rerun', 'needs-user'],
  rerun: ['repair', 'passed', 'needs-user'],
  passed: [],
  'needs-user': ['review', 'repair', 'rerun'],
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined)

// Folds one `metadata.rgr` into the run's RGR state; a round that goes back or a
// phase the loop cannot reach from the current one is refused, not applied.
export const advanceRgr = (
  prev: RgrState | undefined,
  raw: unknown,
): { next: RgrState; changed: boolean } | { violation: string } => {
  if (raw === null || typeof raw !== 'object') return { violation: 'rgr metadata is not an object' }
  const r = raw as Record<string, unknown>
  const phase = r.phase as RgrPhase
  if (!PHASES.includes(phase)) return { violation: `unknown rgr phase ${String(r.phase)}` }
  const round = count(r.round) ?? prev?.round ?? 1
  const maxRounds = count(r.maxRounds) ?? prev?.maxRounds ?? 3
  if (prev !== undefined) {
    if (prev.phase === 'passed') return { violation: 'rgr already passed' }
    if (round < prev.round) return { violation: `round ${round} after ${prev.round}` }
    if (round === prev.round && phase !== prev.phase && !NEXT[prev.phase].includes(phase)) {
      return { violation: `${prev.phase} → ${phase}` }
    }
  }
  const findingsTotal = count(r.findingsTotal) ?? prev?.findingsTotal
  const repaired = count(r.findingsRepaired) ?? prev?.findingsRepaired
  const findingsRepaired =
    repaired === undefined ? undefined : findingsTotal === undefined ? repaired : Math.min(findingsTotal, repaired)
  const next: RgrState = { round: Math.max(1, round), maxRounds: Math.max(1, maxRounds), phase, findingsTotal, findingsRepaired }
  return { next, changed: JSON.stringify(next) !== JSON.stringify(prev) }
}

const PHASE_TEXT: Record<RgrPhase, string> = {
  review: 'Reviewing',
  repair: 'Repairing',
  rerun: 'Rerunning',
  passed: 'Passed',
  'needs-user': 'Needs user',
}

// `RGR · Round 1/3 · Reviewing · 2/5 fixed`
export const rgrText = (s: RgrState): string =>
  `RGR · Round ${s.round}/${s.maxRounds} · ${PHASE_TEXT[s.phase]}` +
  (s.findingsTotal !== undefined ? ` · ${s.findingsRepaired ?? 0}/${s.findingsTotal} fixed` : '')
