export type BarCategory = {
  name: string
  tokens: number
  color: string
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

export type Snapshot = {
  categories: BarCategory[]
  totalTokens: number
  maxTokens: number
  percentage: number
  threshold: number | null
}

// A plan the legacy `progress(done, total)` reports, a ticket's file or a skill's
// headings describe; the legacy adapter turns it into a run with equal-weight stages.
export type StepProgress = {
  source: 'skill' | 'ticket' | 'report'
  label: string
  sections: string[]
  step: string | null
  mech: number
  reported: number
  done: number
  total: number
  paused: boolean
  calls: number
}

// ---- progress v2: committed / buffer / liveness ---------------------------

export type RunId = string
export type WorkflowId = string
export type StageId = string
export type CheckpointId = string

export type LivenessStatus =
  | 'queued'
  | 'running'
  | 'waiting-tool'
  | 'waiting-user'
  | 'paused'
  | 'stale'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned'

export type CheckpointDefinition = { id: CheckpointId; label: string }
export type ChildUnitDefinition = { id: string; label: string; weight?: number }

export type StageDefinition = {
  id: StageId
  label: string
  weight: number
  checkpoints?: CheckpointDefinition[]
  childUnits?: ChildUnitDefinition[]
}

export type WorkflowManifest = {
  id: WorkflowId
  label: string
  version: number
  stages: StageDefinition[]
}

export type ProgressEventType =
  | 'run.started'
  | 'stage.started'
  | 'checkpoint.completed'
  | 'child.started'
  | 'child.completed'
  | 'activity.started'
  | 'activity.completed'
  | 'run.waiting'
  | 'run.paused'
  | 'run.resumed'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'heartbeat'

export type Actor = 'main' | 'subagent' | 'tool' | 'system'

export type ProgressEvent = {
  runId: RunId
  workflowId: WorkflowId
  manifestVersion: number
  sequence: number
  // Milliseconds since the epoch, stamped by the host.
  timestamp: number
  sourceSessionId?: string
  actor?: Actor
  type: ProgressEventType
  stageId?: StageId
  checkpointId?: CheckpointId
  childUnitId?: string
  activityId?: string
  message?: string
  // run.started only: a run-specific manifest (an execution ticket's phases).
  manifest?: WorkflowManifest
  metadata?: Record<string, unknown>
}

export type ActivityState = { name: string; actor: Actor; agentId?: string; startedAt: number }

export type RgrPhase = 'review' | 'repair' | 'rerun' | 'passed' | 'needs-user'

export type RgrState = {
  round: number
  maxRounds: number
  phase: RgrPhase
  findingsTotal?: number
  findingsRepaired?: number
}

export type RunOrigin = 'emit' | 'legacy'

export type ProgressRunState = {
  runId: RunId
  workflowId: WorkflowId
  label: string
  origin: RunOrigin
  // A run the main conversation started; a subagent's is background.
  foreground: boolean
  ownerAgentId?: string
  manifest: WorkflowManifest
  manifestVersion: number
  lastSequence: number
  status: LivenessStatus
  currentStageId: StageId | null
  committed: {
    completedStages: StageId[]
    completedCheckpoints: Record<StageId, CheckpointId[]>
    completedChildUnits: Record<StageId, string[]>
    percent: number
  }
  buffer: {
    visualPercent: number
    // The stage the activity count belongs to; a new stage starts it over.
    stageId: StageId | null
    activityCount: number
    activeActivities: Record<string, ActivityState>
  }
  liveness: {
    currentMessage?: string
    currentActivity?: string
    activeToolCount: number
    activeChildCount: number
    startedAt: number
    lastEventAt: number
    lastCommittedAt?: number
    statusSince: number
    waitingSince?: number
    pauseReason?: string
    errorSummary?: string
  }
  // The status before liveness overlays (waiting-tool, stale) were applied.
  base: 'running' | 'waiting-user' | 'paused' | 'orphaned' | 'completed' | 'failed' | 'cancelled'
  stale: boolean
  rgr?: RgrState
  warning?: 'inconsistent-completion'
  endedAt?: number
  hidden?: boolean
}

export type DiagnosticCode =
  | 'stale-sequence'
  | 'duplicate-checkpoint'
  | 'duplicate-child'
  | 'unknown-run'
  | 'run-ended'
  | 'duplicate-start'
  | 'unknown-workflow'
  | 'manifest-mismatch'
  | 'unknown-stage'
  | 'unknown-checkpoint'
  | 'undeclared-child'
  | 'stage-regression'
  | 'missing-checkpoints'
  | 'inconsistent-completion'
  | 'rgr-regression'
  | 'invalid-event'
  | 'migrated'
  | 'migration-failed'

export type Diagnostic = { at: number; runId?: RunId; code: DiagnosticCode; detail?: string }

export type ProgressState = {
  version: 2
  runs: Record<RunId, ProgressRunState>
  // Run ids, oldest first.
  order: RunId[]
  // The legacy adapter's plan and the run it drives.
  legacy: { plan: StepProgress; runId: RunId } | null
  diagnostics: Diagnostic[]
  counts: { accepted: number; ignored: number }
  // The run the band shows, kept a moment before an equal-priority run may
  // take its place; `held` is the run waiting for that moment.
  primary?: { runId: RunId; since: number; held?: RunId }
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      snapshot: Snapshot | null
      diag: string | null
      detailsOpen: boolean
      // v1 row, read once to migrate into `progress`.
      steps: StepProgress | null
      // Kept under the atom's shape tag (Shaped<ProgressState>, spelled out: this
      // contract may import nothing). A new tag reads an older value as absent.
      progress: { shape: string; value: ProgressState }
    }
  }
}
