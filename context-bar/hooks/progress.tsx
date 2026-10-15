import type { StepProgress } from '../types'

// Pure helpers for the progress rows; everything that calls $, and the state atoms
// the engine scans for, live in register.tsx.

export const PROGRESS_TOOL = 'mcp__context-bar__progress'

// SmartCameraApp1's ticket layout, relative to the session's working directory.
export const ACTIVE_PATH = 'tmp/verify/active.json'
export const PENDING_DIR = 'plans/cso_briefing/project/Pending'

export const PROGRESS_SPEC = {
  name: 'progress',
  description:
    'Report progress to the bar above the prompt. When a skill or ticket was read, the bar ' +
    'already lists its sections: send done only. Otherwise also send total and label.',
  inputSchema: {
    type: 'object',
    properties: {
      done: { type: 'integer', description: 'Sections or steps finished so far' },
      total: { type: 'integer', description: 'Total steps, only for work the bar has no sections for' },
      label: { type: 'string', description: 'Task name, only with total' },
      step: { type: 'string', description: 'Step now starting, only with total' },
    },
    required: ['done'],
  },
  isDeferred: false,
} as const

export const PROMPT_SECTION = {
  id: 'context-bar:progress',
  text:
    `A bar above the prompt shows your progress through ${PROGRESS_TOOL}. When you read a ` +
    "skill or a ticket it lists that document's sections (a ticket's Action Items, then its " +
    'Acceptance Criteria); call the tool with done = sections finished so far at the start of ' +
    'every next section, one call per section, never batched, and a last call when all are done. ' +
    'For other multi-step work (3+ steps) give total and label on the first call. Do not mention ' +
    'these calls.',
  scope: 'session',
} as const

// Where the row's sections came from: the ticket wins over a skill; a report with a
// plan of its own replaces a skill's sections, never a ticket's.
type Source = StepProgress['source']

const int = (v: unknown) => (v === undefined || v === null || v === '' ? null : Math.floor(Number(v)))

// A row seeded from a document's sections, nothing finished by report yet.
export const seeded = (source: Source, label: string, sections: readonly string[], mech: number): StepProgress => {
  const total = Math.max(1, sections.length)
  const done = Math.min(total, mech)
  return { source, label, sections: [...sections], step: sections[done] ?? null, mech: done, reported: 0, done, total, paused: false, calls: 0 }
}

// Folds one progress report into the row; `calls` carries over while `done` holds.
export const applyReport = (prev: StepProgress | null, input: Record<string, unknown>): StepProgress => {
  const done = Math.max(0, int(input.done) ?? 0)
  const total = int(input.total)
  const isSamePlan = prev !== null && prev.source !== 'report' && (total === null || total === prev.total)
  if (prev !== null && prev.source === 'ticket' && !isSamePlan) return { ...prev, paused: false }
  if (isSamePlan && prev !== null) {
    const reported = Math.min(prev.total, Math.max(prev.reported, done))
    const shown = Math.max(prev.mech, reported)
    return { ...prev, reported, done: shown, step: prev.sections[shown] ?? null, paused: false, calls: shown === prev.done ? prev.calls : 0 }
  }
  const t = Math.max(1, total ?? prev?.total ?? Math.max(1, done))
  const d = Math.min(t, done)
  const step = typeof input.step === 'string' && input.step !== '' ? input.step.slice(0, 80) : null
  const label = String(input.label ?? prev?.label ?? 'task').slice(0, 60)
  const isSameStep = prev !== null && prev.source === 'report' && prev.done === d && prev.total === t
  return { source: 'report', label, sections: [], step, mech: 0, reported: d, done: d, total: t, paused: false, calls: isSameStep ? prev.calls : 0 }
}

// How far into the current step the bar creeps after `calls` tool calls: quick at
// first, never reaching the next step (only a report or a ticked box does that).
export const creep = (calls: number) => 0.85 * (1 - Math.pow(0.7, calls))

const FENCE = /^\s*(```|~~~)/

const headings = (md: string) => {
  const out: { level: number; name: string; line: number }[] = []
  let inFence = false
  md.split(/\r?\n/).forEach((l, i) => {
    if (FENCE.test(l)) inFence = !inFence
    const h = inFence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l)
    if (h) out.push({ level: h[1].length, name: h[2].slice(0, 60), line: i })
  })
  return out
}

// A skill's steps: its level-2 headings, or level-3 when it has fewer than two.
export const skillSections = (text: string): string[] => {
  const hs = headings(text)
  for (const level of [2, 3]) {
    const names = hs.filter(h => h.level === level).map(h => h.name)
    if (names.length >= 2) return names.slice(0, 40)
  }
  return []
}

const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/

// A ticket's sections: each sub-heading under Action Items (each checkbox there when it
// has none), then Acceptance Criteria as one. A section is finished once it has owed
// boxes and all are ticked; a struck-through or N/A box is not owed.
export const ticketSections = (md: string): { names: string[]; finished: number } => {
  type Sec = { name: string; owed: number; ticked: number }
  const ai: Sec[] = []
  let ac: Sec | null = null
  let part: 'ai' | 'ac' | null = null
  let cur: Sec | null = null
  let inFence = false
  for (const line of md.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const h = /^(#{1,6})\s+(.*?)\s*$/.exec(line)
    if (h) {
      if (h[1].length <= 2) {
        part = /action items/i.test(h[2]) ? 'ai' : /acceptance criteria|驗收/i.test(h[2]) ? 'ac' : null
        cur = null
        if (part === 'ac') cur = ac = { name: 'Acceptance Criteria', owed: 0, ticked: 0 }
      } else if (part === 'ai') {
        cur = { name: h[2].slice(0, 60), owed: 0, ticked: 0 }
        ai.push(cur)
      }
      continue
    }
    const m = CHECKBOX.exec(line)
    if (!m || part === null) continue
    const isChecked = m[1] !== ' '
    if (!isChecked && (m[2].startsWith('~~') || /\bN\/A\b/.test(m[2]))) continue
    if (cur === null) {
      ai.push({ name: m[2].slice(0, 60), owed: 1, ticked: isChecked ? 1 : 0 })
      continue
    }
    cur.owed += 1
    if (isChecked) cur.ticked += 1
  }
  const secs = [...ai, ...(ac !== null && ac.owed > 0 ? [ac] : [])]
  return { names: secs.map(x => x.name), finished: secs.filter(x => x.owed > 0 && x.ticked === x.owed).length }
}

// The ticket's file in a Pending/ listing: `<id>.md` or `<id>_<slug>.md`.
export const pendingName = (names: readonly { name: string; kind: string }[], id: string) =>
  names.find(f => f.kind === 'file' && (f.name === `${id}.md` || (f.name.startsWith(`${id}_`) && f.name.endsWith('.md'))))
    ?.name ?? null

type El = (props: Record<string, unknown>, ...children: unknown[]) => unknown
type Els = { Box: El; Text: El; Svg?: El }
type RunState = 'running' | 'paused' | 'done'

const CLAWD = '#D97757'
const EYE = '#2B1D16'

// Clawd, Claude Code's mascot, in 11x8 pixels: walking while running, blinking while
// paused, hopping when done. SMIL runs in the surface; the hook never redraws for it.
export const clawdSvg = (state: RunState) => {
  const bob =
    state === 'running'
      ? '<animateTransform attributeName="transform" type="translate" values="0 0;0 -0.6;0 0" dur="0.36s" repeatCount="indefinite"/>'
      : state === 'done'
        ? '<animateTransform attributeName="transform" type="translate" values="0 0;0 -1.6;0 0;0 0" keyTimes="0;0.3;0.6;1" dur="0.9s" repeatCount="indefinite"/>'
        : ''
  const legs = (phase: 'a' | 'b') =>
    state === 'running'
      ? `<animate attributeName="height" values="${phase === 'a' ? '2;1;2' : '1;2;1'}" dur="0.36s" repeatCount="indefinite"/>`
      : ''
  const blink =
    state === 'paused'
      ? '<animate attributeName="height" values="1;1;0.15;1" keyTimes="0;0.9;0.95;1" dur="3s" repeatCount="indefinite"/>'
      : ''
  const leg = (x: number, phase: 'a' | 'b') =>
    `<rect x="${x}" y="6" width="1" height="2" fill="${CLAWD}">${legs(phase)}</rect>`
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -1 11 9" width="26" height="21" shape-rendering="crispEdges">' +
    `<g>${bob}` +
    `<rect x="2" y="2" width="7" height="4" fill="${CLAWD}"/>` +
    `<rect x="0" y="3" width="2" height="2" fill="${CLAWD}"/>` +
    `<rect x="9" y="3" width="2" height="2" fill="${CLAWD}"/>` +
    `<rect x="3" y="3" width="1" height="1" fill="${EYE}">${blink}</rect>` +
    `<rect x="7" y="3" width="1" height="1" fill="${EYE}">${blink}</rect>` +
    leg(2, 'a') + leg(4, 'b') + leg(6, 'a') + leg(8, 'b') +
    '</g></svg>'
  )
}

// One progress block: a title line (state, label, current step; count and percent on
// the right) over a full-width track whose fill carries the mascot at its head.
const block = (
  { Box, Text, Svg }: Els,
  key: string,
  label: string,
  detail: string | null,
  done: number,
  total: number,
  fill: number,
  state: RunState,
) => {
  const mark = state === 'done' ? '✓' : state === 'paused' ? '⏸' : '▶'
  const color = state === 'done' ? 'success' : state === 'paused' ? 'inactive' : 'claude'
  const isPaused = state === 'paused'
  const pct = Math.round((done / total) * 100)
  const mascot =
    Svg !== undefined ? (
      <Svg source={clawdSvg(state)} alt={`Clawd ${state}`} width={26} height={21} isInteractive />
    ) : (
      <Text color="claude">{state === 'done' ? '▝▛▜▘' : '▐▛▜▌'}</Text>
    )
  return (
    <Box key={key} flexDirection="column">
      <Box key={`${key}-head`} flexDirection="row" columnGap={2}>
        <Box key={`${key}-title`} width={0} flexGrow={1}>
          <Text wrap="truncate-end" dimColor={isPaused}>
            <Text color={color}>{`${mark} `}</Text>
            <Text bold>{label}</Text>
            {detail !== null ? <Text dimColor>{`   ${detail}`}</Text> : null}
          </Text>
        </Box>
        <Text dimColor={isPaused}>
          <Text bold>{`${done}/${total}`}</Text>
          <Text dimColor>{`  ${pct}%`}</Text>
        </Text>
      </Box>
      <Box key={`${key}-track`} flexDirection="row" alignItems="center" height={1}>
        {fill > 0 ? <Box width={0} flexGrow={fill} height={1} backgroundColor={color} /> : null}
        {mascot}
        {fill < total ? <Box width={0} flexGrow={total - fill} height={1} backgroundColor="subtle" /> : null}
      </Box>
    </Box>
  )
}

// The progress block drawn above the context bar: none while nothing reports.
export const progressRows = (s: StepProgress | null, els: Els): unknown[] => {
  if (s === null) return []
  const state: RunState = s.done >= s.total ? 'done' : s.paused ? 'paused' : 'running'
  const fill = state === 'running' ? Math.min(s.total, s.done + creep(s.calls)) : s.done
  return [block(els, 'progress-steps', s.label, state === 'done' ? null : s.step, s.done, s.total, fill, state)]
}
