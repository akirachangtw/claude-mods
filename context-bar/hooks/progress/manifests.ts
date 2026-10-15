import type { StageDefinition, WorkflowManifest } from '../../types'

// The workflows the host knows by id. A run may also bring its own manifest
// (an execution ticket built from its phases); either way the weights are
// normalised to 100 when the run starts and never change without a new version.

// Ticket Author: the spec's suggested split, evidence work kept apart from RGR.
// TODO(skill): reconcile stage and checkpoint ids with the ticket-author skill's
// actual procedure when its Progress Contract is written (separate change).
export const TICKET_AUTHOR: WorkflowManifest = {
  id: 'ticket-author',
  label: 'Ticket Author',
  version: 1,
  stages: [
    { id: 'bootstrap', label: 'Bootstrap', weight: 8, checkpoints: [{ id: 'templates-loaded', label: '模板與規範載入完成' }] },
    { id: 'intake', label: 'Intake', weight: 7, checkpoints: [{ id: 'parent-parsed', label: 'Parent／Review Note 解析完成' }] },
    {
      id: 'evidence',
      label: 'Evidence',
      weight: 24,
      checkpoints: [
        { id: 'sources-located', label: '來源定位' },
        { id: 'load-bearing-verified', label: '承重來源抽驗' },
        { id: 'conflicts-resolved', label: '衝突裁決' },
      ],
    },
    { id: 'mapping', label: 'Mapping', weight: 12, checkpoints: [{ id: 'mapped', label: '主張、依賴與交付物映射完成' }] },
    { id: 'draft', label: 'Draft', weight: 22, checkpoints: [{ id: 'drafted', label: 'Ticket 草稿完成' }] },
    { id: 'rgr', label: 'RGR', weight: 22, checkpoints: [{ id: 'rgr-passed', label: 'Review／Repair／Rerun 通過' }] },
    { id: 'finalize', label: 'Finalize', weight: 5, checkpoints: [{ id: 'written', label: '驗證與正式寫入完成' }] },
  ],
}

// Execution Ticket fallback, for a ticket whose run brings no manifest of its own.
export const EXECUTION_TICKET: WorkflowManifest = {
  id: 'execution-ticket',
  label: 'Execution Ticket',
  version: 1,
  stages: [
    { id: 'load', label: 'Load', weight: 10 },
    { id: 'plan', label: 'Plan', weight: 15 },
    { id: 'implement', label: 'Implement', weight: 45 },
    { id: 'verify', label: 'Verify', weight: 20 },
    { id: 'finalize', label: 'Finalize', weight: 10 },
  ],
}

// RGR run on its own (a gate over an existing ticket): one stage, passed only
// when the review/repair/rerun loop says so; rounds live in the run's `rgr`.
export const RGR: WorkflowManifest = {
  id: 'rgr',
  label: 'RGR',
  version: 1,
  stages: [{ id: 'rgr', label: 'RGR', weight: 100, checkpoints: [{ id: 'rgr-passed', label: 'Review／Repair／Rerun 通過' }] }],
}

export const REGISTRY: Readonly<Record<string, WorkflowManifest>> = {
  [TICKET_AUTHOR.id]: TICKET_AUTHOR,
  [EXECUTION_TICKET.id]: EXECUTION_TICKET,
  [RGR.id]: RGR,
}

// Weights scaled to sum to 100; a manifest whose weights are all zero or
// missing gets equal shares. Throws on a manifest the reducer cannot use.
export const normalize = (m: WorkflowManifest): WorkflowManifest => {
  if (!Array.isArray(m.stages) || m.stages.length === 0) throw new Error('manifest has no stages')
  const ids = new Set<string>()
  for (const s of m.stages) {
    if (typeof s.id !== 'string' || s.id === '' || ids.has(s.id)) throw new Error(`bad or duplicate stage id: ${String(s.id)}`)
    ids.add(s.id)
  }
  const raw = m.stages.map(s => (Number.isFinite(s.weight) && s.weight > 0 ? s.weight : 0))
  const sum = raw.reduce((a, b) => a + b, 0)
  const stages: StageDefinition[] = m.stages.map((s, i) => ({
    ...s,
    label: String(s.label ?? s.id).slice(0, 60),
    weight: sum > 0 ? ((raw[i] ?? 0) / sum) * 100 : 100 / m.stages.length,
  }))
  return { id: m.id, label: String(m.label ?? m.id).slice(0, 60), version: Math.max(1, Math.floor(m.version) || 1), stages }
}

// The legacy adapter's manifest: one equal-weight stage per section or step; a
// bare report's steps have no names (its own `step` text stands in).
export const legacyManifest = (label: string, sections: readonly string[], total: number): WorkflowManifest => {
  const n = Math.max(1, total)
  return normalize({
    id: 'legacy',
    label,
    version: 1,
    stages: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, label: sections[i] ?? '', weight: 1 })),
  })
}
