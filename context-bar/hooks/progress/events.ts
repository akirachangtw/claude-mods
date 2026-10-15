import type { Actor, ProgressEvent, ProgressEventType, ProgressState, WorkflowManifest } from '../../types'
import type { Outcome } from './reducer'

// The single entry for workflow progress: `progress_emit`. It only folds an
// event into the plugin's own state; it reads no file, runs nothing, fetches
// nothing. Percent is never an input: the reducer derives it from the manifest.

export const EMIT_TOOL = 'mcp__context-bar__progress_emit'

const TYPES: readonly ProgressEventType[] = [
  'run.started',
  'stage.started',
  'checkpoint.completed',
  'child.started',
  'child.completed',
  'activity.started',
  'activity.completed',
  'run.waiting',
  'run.paused',
  'run.resumed',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'heartbeat',
]

export const EMIT_SPEC = {
  name: 'progress_emit',
  description:
    'Report one workflow progress event to the bar above the prompt. Start with run.started ' +
    '(a known workflowId: ticket-author, execution-ticket, rgr; or your own manifest), then ' +
    'stage.started before each stage and checkpoint.completed the moment each checkpoint is done, ' +
    'one call each, never batched. Tool calls never count as progress and percent is computed by ' +
    'the host; never send one. Send an increasing sequence per run. Pair every activity.started ' +
    'with an activity.completed of the same activityId. Report RGR rounds as stage.started on the ' +
    'rgr stage with rgr state (repeatable; it never moves the parent back). End with ' +
    'run.completed, run.failed or run.cancelled.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [...TYPES] },
      runId: { type: 'string', description: 'One id per run, kept for its whole life (RGR reruns included)' },
      workflowId: { type: 'string', description: 'run.started only' },
      manifestVersion: { type: 'integer' },
      sequence: { type: 'integer', description: 'Increasing per run; omitted, the host uses the next one' },
      stageId: { type: 'string' },
      checkpointId: { type: 'string' },
      childUnitId: { type: 'string' },
      activityId: { type: 'string' },
      message: { type: 'string', description: 'Short status text; no ticket body, prompt or secrets' },
      label: { type: 'string', description: 'run.started only: what the band calls the run' },
      manifest: {
        type: 'object',
        description: 'run.started only, for a run-specific workflow: { id, label, version, stages: [{ id, label, weight, checkpoints?: [{ id, label }], childUnits?: [{ id, label, weight? }] }] }',
      },
      rgr: {
        type: 'object',
        description: 'RGR state, sent with stage.started on the rgr stage at each phase change',
        properties: {
          round: { type: 'integer' },
          maxRounds: { type: 'integer' },
          phase: { type: 'string', enum: ['review', 'repair', 'rerun', 'passed', 'needs-user'] },
          findingsTotal: { type: 'integer' },
          findingsRepaired: { type: 'integer' },
        },
      },
    },
    required: ['type', 'runId'],
  },
  isDeferred: false,
} as const

const str = (v: unknown, max: number) => (typeof v === 'string' && v !== '' ? v.slice(0, max) : undefined)
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined)

const MAX_STAGES = 40
const MAX_UNITS = 40

// Copies only the fields the reducer reads, each bounded.
const manifestOf = (v: unknown): WorkflowManifest | undefined => {
  if (v === null || typeof v !== 'object') return undefined
  const m = v as Record<string, unknown>
  const stages = Array.isArray(m.stages) ? m.stages.slice(0, MAX_STAGES) : []
  const units = (xs: unknown) =>
    Array.isArray(xs)
      ? xs.slice(0, MAX_UNITS).map(x => {
          const u = (x ?? {}) as Record<string, unknown>
          return { id: str(u.id, 80) ?? '', label: str(u.label, 60) ?? str(u.id, 60) ?? '', weight: int(u.weight) }
        })
      : undefined
  return {
    id: str(m.id, 80) ?? 'custom',
    label: str(m.label, 60) ?? str(m.id, 60) ?? 'workflow',
    version: int(m.version) ?? 1,
    stages: stages.map(x => {
      const st = (x ?? {}) as Record<string, unknown>
      return {
        id: str(st.id, 80) ?? '',
        label: str(st.label, 60) ?? str(st.id, 60) ?? '',
        weight: typeof st.weight === 'number' ? st.weight : 1,
        checkpoints: units(st.checkpoints)?.map(({ id, label }) => ({ id, label })),
        childUnits: units(st.childUnits),
      }
    }),
  }
}

// Turns the tool's input into an event, or says why it cannot be one.
export const normalizeEmit = (
  input: Record<string, unknown>,
  state: ProgressState,
  ctx: { at: number; agentId?: string; sessionId?: string },
): ProgressEvent | { error: string } => {
  const type = input.type as ProgressEventType
  if (!TYPES.includes(type)) return { error: `unknown event type ${String(input.type)}` }
  const runId = str(input.runId, 80)
  if (runId === undefined) return { error: 'runId is required' }
  const run = state.runs[runId]
  const manifest = type === 'run.started' ? manifestOf(input.manifest) : undefined
  const workflowId = str(input.workflowId, 80) ?? run?.workflowId ?? manifest?.id
  if (workflowId === undefined) return { error: 'workflowId is required to start a run' }
  const actor: Actor = ctx.agentId !== undefined ? 'subagent' : 'main'
  const label = str(input.label, 60)
  const rgr = input.rgr !== undefined && typeof input.rgr === 'object' ? input.rgr : undefined
  return {
    runId,
    workflowId,
    manifestVersion: int(input.manifestVersion) ?? 0,
    sequence: int(input.sequence) ?? (run?.lastSequence ?? 0) + 1,
    timestamp: ctx.at,
    sourceSessionId: ctx.sessionId,
    actor,
    type,
    stageId: str(input.stageId, 80),
    checkpointId: str(input.checkpointId, 80),
    childUnitId: str(input.childUnitId, 80),
    activityId: str(input.activityId, 80),
    message: str(input.message, 120),
    manifest,
    metadata: {
      ...(label !== undefined ? { label } : {}),
      ...(rgr !== undefined ? { rgr } : {}),
    },
  }
}

// What the tool answers: enough for a skill to notice a refused or out-of-order report.
export const outcomeText = (o: Outcome | { error: string }) => JSON.stringify(o)
