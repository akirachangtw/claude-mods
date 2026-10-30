import type { LivenessStatus, StepProgress } from '../types'
import { EMIT_TOOL } from './progress/events'
import type { RunView } from './progress/view'
import { fitText, fitTitle } from './layout'
import { displayWidth } from './text'
import { THIN_BARS, THIN_BAR_PX, thinBarSvg } from './thinbar'

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
    'For other multi-step work (3+ steps) give total and label on the first call. A workflow with ' +
    `stages and checkpoints reports through ${EMIT_TOOL} instead. Tool calls never count as ` +
    'progress. Do not mention these calls.',
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
export const ticketSectionStates = (md: string): { names: string[]; finished: boolean[] } => {
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
  return { names: secs.map(x => x.name), finished: secs.map(x => x.owed > 0 && x.ticked === x.owed) }
}

export const ticketSections = (md: string): { names: string[]; finished: number } => {
  const { names, finished } = ticketSectionStates(md)
  return { names, finished: finished.filter(Boolean).length }
}

// The ticket's file in a Pending/ listing: `<id>.md` or `<id>_<slug>.md`.
export const pendingName = (names: readonly { name: string; kind: string }[], id: string) =>
  names.find(f => f.kind === 'file' && (f.name === `${id}.md` || (f.name.startsWith(`${id}_`) && f.name.endsWith('.md'))))
    ?.name ?? null


type El = (props: Record<string, unknown>, ...children: unknown[]) => unknown
type Els = { Box: El; Text: El; Svg?: El }

const FUR = '#B8865B'
const EYE = '#2B1D16'

// The desktop cat's box, in CSS pixels: about one text row tall.
export const CAT_W = 21
export const CAT_H = 16

type Pose = 'run' | 'step' | 'sit' | 'hop' | 'droop' | 'sleep'

// running and waiting-tool share a pose: every tool call flips between the two,
// and a pose change is a new SVG source, which would restart the animation on
// each call. The liveness line says which one it is.
const POSE: Record<LivenessStatus, Pose> = {
  queued: 'sit',
  running: 'run',
  'waiting-tool': 'run',
  'waiting-user': 'sit',
  paused: 'sit',
  stale: 'sleep',
  completed: 'hop',
  failed: 'droop',
  cancelled: 'sit',
  orphaned: 'sleep',
}

// An original 12x9 pixel cat, side view: ears, head, body, raised tail. Its pose
// says the run's liveness, never how far it has got. SMIL runs in the surface;
// the hook never redraws for a frame.
export const catSvg = (status: LivenessStatus) => {
  const pose = POSE[status]
  const anim = (attr: string, values: string, dur: string, extra = '') =>
    `<animate attributeName="${attr}" values="${values}" dur="${dur}" repeatCount="indefinite"${extra}/>`
  const bob =
    pose === 'run'
      ? '<animateTransform attributeName="transform" type="translate" values="0 0;0 -0.5;0 0" dur="0.36s" repeatCount="indefinite"/>'
      : pose === 'hop'
        ? '<animateTransform attributeName="transform" type="translate" values="0 0;0 -1.6;0 0" keyTimes="0;0.4;1" dur="0.6s" repeatCount="1" fill="freeze"/>'
        : ''
  const leg = (x: number, phase: 'a' | 'b') => {
    const move = pose === 'run' ? anim('height', phase === 'a' ? '2;1;2' : '1;2;1', '0.36s') : pose === 'step' ? anim('height', phase === 'a' ? '2;1.4;2' : '1.4;2;1.4', '0.9s') : ''
    const h = pose === 'sit' || pose === 'sleep' || pose === 'droop' ? 1 : 2
    return `<rect x="${x}" y="7" width="1" height="${h}" fill="${FUR}">${move}</rect>`
  }
  const tailWag = pose === 'run' ? anim('y', '1;2;1', '0.36s') : ''
  const earY = pose === 'droop' ? 2 : 0
  const eyeH = pose === 'sleep' ? 0.25 : 1
  const blink = pose === 'sit' ? anim('height', '1;1;0.15;1', '3s', ' keyTimes="0;0.9;0.95;1"') : ''
  const zz = pose === 'sleep' ? `<text x="7" y="2" font-size="3" fill="${FUR}">z</text>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -1 13 10" width="${CAT_W}" height="${CAT_H}" shape-rendering="crispEdges">` +
    `<g>${bob}` +
    `<rect x="1" y="${earY}" width="1" height="1" fill="${FUR}"/>` +
    `<rect x="4" y="${earY}" width="1" height="1" fill="${FUR}"/>` +
    `<rect x="1" y="1" width="4" height="3" fill="${FUR}"/>` +
    `<rect x="3" y="2" width="1" height="${eyeH}" fill="${EYE}">${blink}</rect>` +
    `<rect x="2" y="4" width="9" height="3" fill="${FUR}"/>` +
    `<rect x="11" y="1" width="1" height="4" fill="${FUR}">${tailWag}</rect>` +
    leg(2, 'a') + leg(4, 'b') + leg(8, 'a') + leg(10, 'b') +
    zz +
    '</g></svg>'
  )
}

// The terminal's cat: a glyph per pose, stable from one draw to the next.
const CAT_GLYPH: Record<Pose, string> = {
  run: '=^.^=',
  step: '=^.^=',
  sit: '=^-^=',
  hop: '=^o^=',
  droop: '=;.;=',
  sleep: '=-.-=',
}

const MARK: Record<LivenessStatus, [string, string]> = {
  queued: ['·', 'inactive'],
  running: ['▶', 'claude'],
  'waiting-tool': ['▶', 'claude'],
  'waiting-user': ['⏸', 'inactive'],
  paused: ['⏸', 'inactive'],
  stale: ['◌', 'inactive'],
  completed: ['✓', 'success'],
  failed: ['✗', 'error'],
  cancelled: ['■', 'inactive'],
  orphaned: ['?', 'inactive'],
}

// The buffer reads as "not done yet": a light tint of the running colour, lighter
// than the committed fill and apart from the neutral rest of the track. Other
// states draw no buffer tint, so nothing grey-on-grey looks finished.
export const BUFFER_TINT = '#EDC3AE'

const DIM = new Set<LivenessStatus>(['waiting-user', 'paused', 'stale', 'cancelled', 'orphaned'])

// What the run is doing, said as a state, never as a time: nothing redraws the
// band while a call runs, so any seconds shown would stand still and mislead.
const STATUS_TEXT: Record<LivenessStatus, string> = {
  queued: 'queued',
  running: 'working',
  'waiting-tool': 'running a tool',
  'waiting-user': 'waiting for you',
  paused: 'paused',
  stale: 'no recent activity',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  orphaned: 'lost track after a reload',
}

// Under this width the band drops what it can do without: `+N` alone. The
// desktop band is about 95 cells, so it keeps the full words.
export const COMPACT_COLUMNS = 80

// `columns` is the band's width; `cells` the text a row may take (layout.ts);
// `narrow` the small-text band with thin bars; `light` picks the bar colours.
export type BlockOpts = { background: number; columns: number; cells: number; narrow: boolean; light: boolean }

// One progress block, wide: a title line (status, label, stage; count and
// committed percent on the right), a track whose solid fill is committed and
// whose lighter extension is the buffer, the cat at the committed end, and a
// liveness line with the other runs summed up on its right. Narrow: the title
// in small text (no stage, `+N` on its right) over a thin bar, nothing else.
// Every row is cut to one line before it is drawn.
const block = ({ Box, Text, Svg }: Els, key: string, v: RunView, opts: BlockOpts) => {
  const [mark, color] = v.warning && v.status === 'completed' ? ['!', 'warning'] : MARK[v.status]
  const isDim = DIM.has(v.status)
  const isCompact = opts.columns < COMPACT_COLUMNS
  const size = opts.narrow ? { size: 'footnote' } : {}
  const committed = Math.max(0, Math.min(100, v.committed))
  const buffer = Math.max(committed, Math.min(100, v.buffer))
  const bufferColor = color === 'claude' ? BUFFER_TINT : 'subtle'
  const others = opts.background > 0 ? (isCompact ? `+${opts.background}` : `+${opts.background} background`) : null
  const count = `${v.done}/${v.total}`
  const right = `${count}  ${v.percent}%` + (opts.narrow && others !== null ? `  ${others}` : '')
  const detail = v.detail !== null && v.status !== 'completed' ? v.detail : null
  const fit = fitTitle(v.label, detail, right, opts.cells)

  const head = (
    <Box key={`${key}-head`} flexDirection="row" columnGap={2}>
      <Box key={`${key}-title`} width={0} flexGrow={1}>
        <Text wrap="truncate-end" dimColor={isDim} {...size}>
          <Text color={color}>{`${mark} `}</Text>
          <Text bold>{fit.label}</Text>
          {fit.detail !== null ? <Text dimColor>{`   ${fit.detail}`}</Text> : null}
        </Text>
      </Box>
      <Text dimColor={isDim} {...size}>
        <Text bold>{count}</Text>
        <Text dimColor>{`  ${v.percent}%`}</Text>
        {opts.narrow && others !== null ? <Text dimColor>{`  ${others}`}</Text> : null}
      </Text>
    </Box>
  )

  if (opts.narrow) {
    // No cat and no status row. A desktop draws the bar thin; the terminal's
    // one-row blocks are as thin as it goes.
    const bar =
      Svg !== undefined && THIN_BARS ? (
        <Svg
          key={`${key}-thin`}
          source={thinBarSvg(
            [
              { weight: committed, color },
              { weight: buffer - committed, color: bufferColor },
              { weight: 100 - buffer, color: 'subtle' },
            ],
            opts.light,
          )}
          alt={`${v.percent}% done`}
          height={THIN_BAR_PX}
        />
      ) : (
        <Box key={`${key}-track`} flexDirection="row" height={1}>
          {committed > 0 ? <Box key={`${key}-committed`} width={0} flexGrow={committed} height={1} backgroundColor={color} /> : null}
          {buffer > committed ? (
            <Box key={`${key}-buffer`} width={0} flexGrow={buffer - committed} height={1} backgroundColor={bufferColor} />
          ) : null}
          {buffer < 100 ? <Box key={`${key}-rest`} width={0} flexGrow={100 - buffer} height={1} backgroundColor="subtle" /> : null}
        </Box>
      )
    return (
      <Box key={key} flexDirection="column">
        {head}
        {bar}
      </Box>
    )
  }

  const mascot =
    Svg !== undefined ? (
      <Svg key={`${key}-mascot`} source={catSvg(v.status)} alt={`cat ${POSE[v.status]}`} width={CAT_W} height={CAT_H} isInteractive />
    ) : (
      <Text color="claude">{CAT_GLYPH[POSE[v.status]]}</Text>
    )
  const state =
    v.error !== null
      ? v.error
      : v.activity !== null
        ? `⧗ ${v.activity}`
        : v.status === 'completed' && v.warning
          ? 'done · stages left open'
          : STATUS_TEXT[v.status]
  const live = [v.rgr, state].filter(x => x !== null).join(' · ')
  const liveRoom = opts.cells - (others !== null ? displayWidth(others) + 2 : 0)
  return (
    <Box key={key} flexDirection="column">
      {head}
      {/* The desktop track takes the cat's height (no fixed one-row height for an
          Svg to spill out of onto the rows around it); the bar stays one row,
          centred on it. The terminal's cat is text, one row like the bar. */}
      <Box key={`${key}-track`} flexDirection="row" alignItems="center" {...(Svg !== undefined ? { minHeight: 1 } : { height: 1 })}>
        {committed > 0 ? <Box key={`${key}-committed`} width={0} flexGrow={committed} height={1} backgroundColor={color} /> : null}
        {mascot}
        {buffer > committed ? (
          <Box key={`${key}-buffer`} width={0} flexGrow={buffer - committed} height={1} backgroundColor={bufferColor} />
        ) : null}
        {buffer < 100 ? <Box key={`${key}-rest`} width={0} flexGrow={100 - buffer} height={1} backgroundColor="subtle" /> : null}
      </Box>
      <Box key={`${key}-live`} flexDirection="row" columnGap={2}>
        <Box key={`${key}-state`} width={0} flexGrow={1}>
          <Text wrap="truncate-end" dimColor>
            {fitText(live, liveRoom)}
          </Text>
        </Box>
        {others !== null ? (
          <Box key={`${key}-others`}>
            <Text dimColor>{others}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

// The progress block drawn above the context bar: none while no run is shown.
export const progressRows = (v: RunView | null, els: Els, opts: BlockOpts): unknown[] =>
  v === null ? [] : [block(els, 'progress-steps', v, opts)]
