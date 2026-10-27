import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BarCategory, ProgressState, Snapshot } from '../types'
import {
  ACTIVE_PATH,
  PENDING_DIR,
  PROGRESS_SPEC,
  PROGRESS_TOOL,
  PROMPT_SECTION,
  applyReport,
  pendingName,
  progressRows,
  seeded,
  skillSections,
  ticketSectionStates,
} from './progress'
import { EMIT_SPEC, EMIT_TOOL, normalizeEmit, outcomeText } from './progress/events'
import { applyLegacyPlan, currentPlan, hasOpenEmitRun, migrateSteps } from './progress/legacy'
import { type Action, emptyState, isTerminal, nextDue, reduce } from './progress/reducer'
import { backgroundCount, diagnosticsText, runView, shownRun } from './progress/view'
import { cleanName, folderName, labelFor, projectKey, readNames, resolveName } from './project/name'

const snapshot = atom({ plugin: 'context-bar', key: 'snapshot' } as const, null)
// Why the last refresh produced no full breakdown; shown while there is no snapshot.
const diag = atom({ plugin: 'context-bar', key: 'diag' } as const, null)
// Whether the per-category legend is shown; collapsed by default, the header and bar always are.
const detailsOpen = atom({ plugin: 'context-bar', key: 'detailsOpen' } as const, false)
// v1's progress row: read once at load to migrate into `progress`, then cleared.
const steps = atom({ plugin: 'context-bar', key: 'steps' } as const, null)
// Progress v2: every run's committed / buffer / liveness layers, the legacy
// adapter's plan and the diagnostics. Its own atom: context never reads it and
// it never reads context.
const progress = atom({ plugin: 'context-bar', key: 'progress' } as const, emptyState(), { shape: 'progress-v2' })
// The session's project and its label on the context header.
const project = atom({ plugin: 'context-bar', key: 'project' } as const, null)

const FREE_COLOR = 'inactive'
const TICK_COLOR = 'warning'
// Free space as a block background; a background cannot be dimmed, so a lighter key stands in.
const FREE_BG = 'subtle'
// How much of the row the desktop's divider spans: a desktop draws ─ wider than
// a cell, so a full row of them overflows into an ellipsis. Centred, the
// shorter rule reads as an inset separator.
const DESKTOP_RULE_SHARE = 0.85

// The project label: white on blue, a block like the usage badge, the same for every project.
const LABEL_BG = '#2F6FB0'
const LABEL_FG = '#FFFFFF'

// Delay before measuring the conversation a /clear started.
const CLEAR_REFRESH_MS = 500

// 4200 -> 4.2k, 17000 -> 17k, 1000000 -> 1M
export const formatTokens = (n: number): string => {
  const trim = (v: number) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, ''))
  if (n >= 1e6) return `${trim(n / 1e6)}M`
  if (n >= 1e3) return `${trim(n / 1e3)}k`
  return String(Math.round(n))
}

// Rounded share of the window; any non-zero row shows at least 1%.
export const sharePercent = (tokens: number, max: number): number =>
  tokens > 0 && max > 0 ? Math.max(1, Math.round((tokens / max) * 100)) : 0

const badgeColor = (pct: number) => (pct < 50 ? 'success' : pct < 80 ? 'warning' : 'error')

type Cell = { color: string; dim: boolean; char: string }

// One cell per column: used rows in order, then free space, then the compaction tick.
export const barCells = (s: Snapshot, width: number): Cell[] => {
  const cells: Cell[] = []
  const max = s.maxTokens > 0 ? s.maxTokens : 1
  let cum = 0
  for (const c of s.categories) {
    if (c.kind !== 'used' || c.tokens <= 0) continue
    const start = Math.min(width, Math.round((cum / max) * width))
    let end = Math.min(width, Math.round(((cum + c.tokens) / max) * width))
    if (end <= start && start < width) end = start + 1
    for (let i = cells.length; i < end; i++) cells.push({ color: c.color, dim: false, char: '█' })
    cum += c.tokens
  }
  while (cells.length < width) cells.push({ color: FREE_COLOR, dim: true, char: '█' })
  if (s.threshold !== null && s.threshold > 0) {
    const pos = Math.min(width - 1, Math.max(0, Math.round((s.threshold / max) * width) - 1))
    cells[pos] = { color: TICK_COLOR, dim: false, char: '▌' }
  }
  return cells
}

// Collapse adjacent cells of the same style into runs.
const runs = (cells: Cell[]) => {
  const out: { color: string; dim: boolean; text: string }[] = []
  for (const c of cells) {
    const last = out[out.length - 1]
    if (last && last.color === c.color && last.dim === c.dim) last.text += c.char
    else out.push({ color: c.color, dim: c.dim, text: c.char })
  }
  return out
}

const refresh = async ($: EngineInterface) => {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const b = usage.context.breakdown
    if (!b) {
      // No breakdown on this host: fall back to the status line's figures.
      const { tokens, window, percent } = usage.context
      await update($, diag, () => `no breakdown (tokens=${tokens ?? '-'}, window=${window})`)
      if (tokens === undefined) return
      const fallback: Snapshot = {
        categories: [{ name: 'Used', tokens, color: 'claude', kind: 'used' }],
        totalTokens: tokens,
        maxTokens: window,
        percentage: percent ?? sharePercent(tokens, window),
        threshold: null,
      }
      await update($, snapshot, () => fallback)
      return
    }
    const categories: BarCategory[] = b.categories.map(c => ({
      name: c.name,
      tokens: c.tokens,
      color: c.color,
      kind: c.kind,
    }))
    const next: Snapshot = {
      categories,
      totalTokens: b.totalTokens,
      maxTokens: b.rawMaxTokens,
      percentage: b.percentage,
      threshold: b.isAutoCompactEnabled && b.autoCompactThreshold !== undefined ? b.autoCompactThreshold : null,
    }
    await update($, snapshot, () => next)
    await update($, diag, () => null)
  } catch (err) {
    // Usage unavailable: keep the last snapshot, surface the reason.
    const reason = err instanceof Error ? err.message : String(err)
    try {
      await update($, diag, () => `usage failed: ${reason}`)
    } catch {
      // State itself unavailable: nothing more to report.
    }
  }
}

// The expand/collapse choice outlives the session in the plugin's own store.
const DETAILS_KEY = 'detailsOpen'

const loadPrefs = async ($: EngineInterface) => {
  try {
    const saved = await $.store.get(DETAILS_KEY)
    if (typeof saved === 'boolean') await update($, detailsOpen, () => saved)
  } catch {
    // Store unreadable: keep the default (collapsed).
  }
}

const toggleDetails = async ($: EngineInterface) => {
  let open = false
  await update($, detailsOpen, v => (open = !v))
  try {
    await $.store.set(DETAILS_KEY, open)
  } catch {
    // Not saved: the toggle still holds for this session.
  }
}

const registerProgressTool = async ($: EngineInterface) => {
  try {
    // The deprecated v1 report, kept for skills that still send done/total.
    await $.tool.register(PROGRESS_SPEC)
    await $.tool.register(EMIT_SPEC)
  } catch {
    // Not bound yet or refused: the bar works without source 1.
  }
  try {
    await $.command.register({
      name: 'project-name',
      description: 'The project label on the context header: set it, or reset, off, on',
      argumentHint: '[name | reset | off | on]',
      immediate: true,
    })
  } catch {
    // No command: the automatic label still shows.
  }
  try {
    await $.command.register({
      name: 'progress',
      description: 'Progress runs and diagnostics; "dismiss" hides ended runs',
      argumentHint: '[dismiss]',
      immediate: true,
    })
  } catch {
    // No command: the band still draws.
  }
}

// Names by project key, kept between sessions (see ProjectNames).
const NAMES_KEY = 'projectNames'
// Where the session's project was last found: /clear starts no session.start.
let projectPath: string | null = null

const loadNames = async ($: EngineInterface) => {
  try {
    return readNames(await $.store.get(NAMES_KEY))
  } catch {
    return readNames(undefined)
  }
}

// The session's project root (it follows /cd), else the directory it started in.
const loadProject = async ($: EngineInterface, cwd?: string) => {
  try {
    projectPath = await $.session.root()
  } catch {
    if (cwd !== undefined) projectPath = cwd
  }
  const key = projectPath === null ? null : projectKey(projectPath)
  if (projectPath === null || key === null) {
    await update($, project, () => null)
    return
  }
  const before = await loadNames($)
  const { label, names } = resolveName(before, key, folderName(projectPath))
  if (names !== before) {
    try {
      await $.store.set(NAMES_KEY, names)
    } catch {
      // Not saved: the label holds for this session and is made again next time.
    }
  }
  const folder = folderName(projectPath)
  await update($, project, () => ({ key, folder, label }))
}

// /project-name [name | reset | off | on]
const projectCommand = async ($: EngineInterface, args: string): Promise<string> => {
  const p = await read($, project)
  if (p === null) return 'No project directory for this session: no label is shown.'
  const names = await loadNames($)
  const arg = args.trim()
  const auto = names.auto[p.key]
  const without = (list: string[]) => list.filter(k => k !== p.key)
  let note = ''
  if (arg === '') {
    const source = names.off.includes(p.key) ? 'off' : names.custom[p.key] !== undefined ? 'custom' : 'automatic'
    return [
      `project   ${p.key}`,
      `label     ${p.label === null ? '(none)' : `[${p.label}]`} (${source})`,
      `automatic ${auto === undefined ? '(not made yet)' : `[${auto}]`}`,
      'usage     /project-name <name> · reset · off · on',
    ].join('\n')
  }
  let next = names
  if (arg === 'reset') {
    const { [p.key]: _gone, ...custom } = names.custom
    next = { ...names, custom, off: without(names.off) }
  } else if (arg === 'off') {
    next = { ...names, off: [...without(names.off), p.key] }
  } else if (arg === 'on') {
    next = { ...names, off: without(names.off) }
  } else {
    const { name, cut } = cleanName(arg)
    if (name === '') return 'A name needs at least one character other than [ and ].'
    if (cut) note = ' (cut to 8 cells)'
    next = { ...names, custom: { ...names.custom, [p.key]: name }, off: without(names.off) }
  }
  const { label, names: kept } = resolveName(next, p.key, p.folder)
  try {
    await $.store.set(NAMES_KEY, kept)
  } catch {
    note += ' (not saved: it holds for this session only)'
  }
  await update($, project, () => ({ ...p, label }))
  return `${label === null ? 'Project label off.' : `Project label: [${label}]`}${note}`
}

// The host's time; a host without a clock (some test kits) falls back to the environment's.
const now = async ($: EngineInterface) => {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

// Whether this load has looked for a v1 row to migrate, and the surface last drawn on.
let migrated = false
let lastSurface = 'none'

const ensureMigrated = async ($: EngineInterface) => {
  if (migrated) return
  migrated = true
  try {
    const old = await read($, steps)
    if (old === null) return
    const at = await now($)
    await update($, progress, s => (s.order.length === 0 && s.legacy === null ? migrateSteps(old, at) : s))
    await update($, steps, () => null)
  } catch {
    // Unreadable v1 state: progress starts empty, the context bar is untouched.
  }
}

// One timer for whatever the reducer has due with no event: a run going
// stale, a completed one fading.
let tickTimer: { cancel: () => void } | null = null
let tickDue: number | null = null

const scheduleTick = async ($: EngineInterface, s: ProgressState) => {
  const due = nextDue(s)
  if (due === tickDue) return
  tickTimer?.cancel()
  tickTimer = null
  tickDue = due
  if (due === null) return
  const at = await now($)
  try {
    tickTimer = $.clock.after(Math.max(1, due - at), () => {
      tickTimer = null
      tickDue = null
      void (async () => {
        const t = await now($)
        await commit($, s2 => reduce(s2, { kind: 'tick', at: t }).state)
      })()
    })
  } catch {
    // No timers here: stale and fade wait for the next event instead.
    tickDue = null
  }
}

// Every progress write: migrate first, fold, then re-arm the timer.
const commit = async ($: EngineInterface, fn: (s: ProgressState) => ProgressState) => {
  await ensureMigrated($)
  let next: ProgressState | null = null
  await update($, progress, s => (next = fn(s)))
  if (next !== null) await scheduleTick($, next)
}

const act = ($: EngineInterface, action: Action) => commit($, s => reduce(s, action).state)

// Which ticket this session's calls have named, its file's last seen mtime, and
// whether the session has started working (a skill preloaded before that seeds nothing).
let touched: string | null = null
let lastMtime = -1
let hasWorked = false
// Ids for tool calls that carry no tool_use_id.
let callSeq = 0

const clearProgress = async ($: EngineInterface) => {
  await commit($, () => emptyState())
  touched = null
  lastMtime = -1
}

// After a main-loop tool call: once this session's calls have named the active ticket
// (reading it counts) and while its file is in Pending/, the row is that ticket's
// sections; a ticked section commits that section's stage.
const syncTicket = async ($: EngineInterface, call: unknown) => {
  let id: string | null = null
  try {
    const raw = JSON.parse(await $.fs.read(ACTIVE_PATH)).ticket_id
    if (typeof raw === 'string' && raw !== '') id = raw
  } catch {
    // No active ticket.
  }
  const state = await read($, progress)
  // A workflow reporting through progress_emit owns the band; the file stands aside.
  if (hasOpenEmitRun(state)) return
  const shown = currentPlan(state)
  const shownRun = state.legacy !== null ? state.runs[state.legacy.runId] : undefined
  const isShownTicket = shown !== null && shown.source === 'ticket'
  const isOpen = shownRun !== undefined && !isTerminal(shownRun)
  const at = await now($)
  // Another ticket (or none) is active now: drop the old one's unfinished row.
  if (isShownTicket && shown.label !== id && isOpen) await commit($, s => applyLegacyPlan(s, null, at))
  if (id === null) return
  if (touched !== id) {
    // A reload forgets `touched` but the row survives: its ticket still counts as named.
    if (!(isShownTicket && shown.label === id) && !JSON.stringify(call).includes(id)) return
    touched = id
    lastMtime = -1
  }
  const name = pendingName(await $.fs.list(PENDING_DIR), id)
  if (name === null) {
    // Left Pending/ (delivered or void) short of done: the row would freeze, so drop it.
    if (isShownTicket && shown.label === id && isOpen) await commit($, s => applyLegacyPlan(s, null, at))
    return
  }
  const file = `${PENDING_DIR}/${name}`
  const { mtimeMs } = await $.fs.stat(file)
  if (mtimeMs === lastMtime) return
  lastMtime = mtimeMs
  const { names, finished } = ticketSectionStates(await $.fs.read(file))
  if (names.length === 0) return
  const count = finished.filter(Boolean).length
  await commit($, s => {
    const prev = currentPlan(s)
    if (prev === null || prev.source !== 'ticket' || prev.label !== id || prev.total !== names.length) {
      return applyLegacyPlan(s, seeded('ticket', id, names, count), at, finished)
    }
    const done = Math.min(prev.total, Math.max(count, prev.reported))
    return applyLegacyPlan(s, { ...prev, sections: names, mech: count, done, step: names[done] ?? null }, at, finished)
  })
}

// `mcp__server__tool` → `server:tool`; a built-in keeps its name. Never its arguments.
const toolLabel = (tool: string) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  return (m ? `${m[1]}:${m[2]}` : tool).slice(0, 40)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await registerProgressTool($)
    await loadPrefs($)
    await loadProject($, e.cwd)
    // A reload keeps the runs but loses the calls that were in flight.
    await act($, { kind: 'reload', at: await now($) })
    await refresh($)
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await refresh($)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    await refresh($)
    return r
  })

  // /clear ends the session with no session.start for the new one: measure again
  // once it is under way, so the bar does not wait for the next prompt.
  on('session.end', async ($, e, next) => {
    const r = await next(e)
    if (e.reason === 'clear') {
      $.clock.after(CLEAR_REFRESH_MS, () => {
        void (async () => {
          await clearProgress($)
          await registerProgressTool($)
          await loadPrefs($)
          await loadProject($)
          await refresh($)
        })()
      })
    }
    return r
  })

  // Covers /clear, which starts a new conversation without session.start.
  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    hasWorked = true
    // A run waiting for the person resumes; a completed one leaves the band.
    await act($, { kind: 'prompt', at: await now($) })
    await refresh($)
    return r
  })

  on('command.run', { command: 'project-name' }, async ($, e) => ({ text: await projectCommand($, e.args) }))

  // The progress tools are the mod's own and harmless: never a permission prompt.
  on('tool.check', { tool: ['mcp__context-bar__progress', 'mcp__context-bar__progress_emit'] }, ($, e, next) =>
    e.tool === PROGRESS_TOOL || e.tool === EMIT_TOOL ? { decision: 'allow' } : next(e),
  )

  // /progress: the runs and why events were refused; `/progress dismiss` hides ended runs.
  on('command.run', { command: 'progress' }, async ($, e) => {
    const at = await now($)
    if (e.args.trim() === 'dismiss') await act($, { kind: 'dismiss', at })
    await ensureMigrated($)
    return { text: diagnosticsText(await read($, progress), at, lastSurface) }
  })

  // Serves the progress tools. Any other call is activity (buffer and liveness,
  // never committed); after a main-loop call the ticket is read again.
  on('tool.call', async ($, e, next) => {
    if (e.tool === PROGRESS_TOOL) {
      if (e.agentId !== undefined) return { result: 'progress is tracked for the main conversation only' }
      const at = await now($)
      let shown = 'ignored: a progress_emit run is reporting this work'
      await commit($, s => {
        if (hasOpenEmitRun(s)) return s
        const n = applyLegacyPlan(s, applyReport(currentPlan(s), e as unknown as Record<string, unknown>), at)
        const run = n.legacy !== null ? n.runs[n.legacy.runId] : undefined
        if (run !== undefined) shown = `${run.committed.completedStages.length}/${run.manifest.stages.length}`
        return n
      })
      return { result: shown }
    }
    if (e.tool === EMIT_TOOL) {
      const at = await now($)
      let answer = ''
      await commit($, s => {
        const ev = normalizeEmit(e as unknown as Record<string, unknown>, s, { at, agentId: e.agentId })
        if ('error' in ev) {
          answer = outcomeText({ accepted: false, code: 'invalid-event', detail: ev.error })
          return s
        }
        const { state, outcome } = reduce(s, { kind: 'event', event: ev }, e.agentId)
        answer = outcomeText(outcome)
        return state
      })
      return { result: answer }
    }
    // Bookkeeping around the call never fails it: a progress error is swallowed,
    // so the tool runs exactly once whatever the state does.
    const activityId = e.tool_use_id ?? `call-${++callSeq}`
    try {
      await act($, {
        kind: 'tool.start',
        activityId,
        name: toolLabel(e.tool),
        actor: e.agentId !== undefined ? 'subagent' : 'main',
        agentId: e.agentId,
        at: await now($),
      })
    } catch {
      // Progress unavailable: the call goes ahead untracked.
    }
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
    } finally {
      try {
        await act($, { kind: 'tool.end', activityId, at: await now($) })
      } catch {
        // As above.
      }
    }
    hasWorked = true
    if (e.agentId === undefined) {
      try {
        await syncTicket($, e)
      } catch {
        // Ticket unreadable: the bar keeps its last count.
      }
    }
    return r
  })

  // A session's system prompt is composed once; the skill text is read fresh on every
  // expansion, so the hint reaches sessions that started before the mod loaded.
  // Expanding a skill once work is under way also seeds the row with its sections,
  // unless a ticket's unfinished row holds it (the ticket is the actual work).
  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    const sections = skillSections(r.text)
    if (hasWorked && sections.length >= 2) {
      const at = await now($)
      await commit($, s => {
        const shown = currentPlan(s)
        const run = s.legacy !== null ? s.runs[s.legacy.runId] : undefined
        const isTicketBusy = shown !== null && shown.source === 'ticket' && run !== undefined && !isTerminal(run)
        return isTicketBusy || hasOpenEmitRun(s) ? s : applyLegacyPlan(s, seeded('skill', e.skill, sections, 0), at)
      })
    }
    return { text: `${r.text}\n\n${PROMPT_SECTION.text}` }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return e.tools.includes(PROGRESS_TOOL) ? { sections: [...r.sections, PROMPT_SECTION] } : r
  })

  // The main turn ended with a run open: it waits for the person, dimmed, and
  // stays until the next prompt resumes it or it goes stale.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if ((e as { agentId?: string }).agentId === undefined) await act($, { kind: 'turn.ended', at: await now($) })
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    // Svg draws on the remote surfaces (desktop); the terminal resolves it to an empty
    // box, so it gets the glyph mascot instead.
    const { Svg } = $.ui.resolve(e) as unknown as { Svg?: unknown }
    const mascotSvg = e.surface === 'terminal' ? undefined : Svg
    lastSurface = e.surface

    const state = await read($, progress)
    const run = shownRun(state)
    const view = run !== null ? runView(run, await now($)) : null
    const blocks = progressRows(view, { Box, Text, Svg: mascotSvg } as never, {
      background: backgroundCount(state, run),
      columns: e.props.bodyColumns,
    })
    // Progress sits above the context bar, a low-contrast text rule between them,
    // cut to one line. The terminal's spans the row, one ─ per cell; the
    // desktop's is shorter and centred (DESKTOP_RULE_SHARE). An Svg line drew
    // nothing there: without a width of its own it is laid out zero wide.
    const ruleCells = Math.max(10, e.props.bodyColumns - 4)
    const isTerminal = e.surface === 'terminal'
    const ruleWidth = isTerminal ? ruleCells : Math.floor(ruleCells * DESKTOP_RULE_SHARE)
    const progressBox =
      blocks.length > 0 ? (
        <Box key="progress" flexDirection="column">
          {blocks}
          <Box key="progress-divider" height={1} flexDirection="row" justifyContent={isTerminal ? 'flex-start' : 'center'}>
            <Text wrap="truncate-end" color="inactive" dimColor>
              {'─'.repeat(ruleWidth)}
            </Text>
          </Box>
        </Box>
      ) : null

    // ◆ [name] context: the project label sits between the mark and the title,
    // each its own Text in a row so the label keeps its block colours.
    const p = await read($, project)
    const label =
      p !== null && p.label !== null ? (
        <Text key="project-label" bold color={LABEL_FG} backgroundColor={LABEL_BG}>
          {`[${labelFor(p.label, e.props.bodyColumns)}]`}
        </Text>
      ) : null
    const title = (tail: string) => [
      <Text key="mark" color="claude">
        ◆{' '}
      </Text>,
      label,
      label !== null ? <Text key="label-gap"> </Text> : null,
      <Text key="name" bold>
        {tail}
      </Text>,
    ]

    if (s === null) {
      const why = await read($, diag)
      return (
        <Box key="context-bar" flexDirection="column">
          {progressBox}
          <Box key="waiting" flexDirection="row">
            {title('context ')}
            <Text dimColor wrap="truncate-end">
              {why ?? 'waiting for first measurement…'}
            </Text>
          </Box>
        </Box>
      )
    }
    const pct = Math.round(s.percentage)
    const open = await read($, detailsOpen)
    const summary =
      `${formatTokens(s.totalTokens)} of ${formatTokens(s.maxTokens)}` +
      (s.threshold !== null ? ` · compacts at ${formatTokens(s.threshold)}` : '')

    const header = (
      <Box key="header" flexDirection="row" justifyContent="space-between">
        <Box key="title" flexDirection="row" columnGap={1}>
          <Box key="title-text" flexDirection="row">
            {title('context')}
          </Box>
          <Button
            key="details-toggle"
            label={open ? '▾ details' : '▸ details'}
            plain
            dimColor
            onPress={() => toggleDetails($)}
          />
        </Box>
        <Text>
          <Text dimColor>{summary} </Text>
          <Text bold color="inverseText" backgroundColor={badgeColor(pct)}>
            {` ${pct}% `}
          </Text>
        </Text>
      </Box>
    )

    // Too little room: the one-line header alone, no progress.
    if (e.props.maxRows < 5) {
      return (
        <Box key="context-bar" flexDirection="column">
          {header}
        </Box>
      )
    }

    const width = Math.max(10, e.props.bodyColumns - 4)
    const legendRows = s.categories.filter(c => c.kind === 'used' || c.kind === 'free')

    return (
      <Box key="context-bar" flexDirection="column" borderStyle="round" borderColor={FREE_COLOR} paddingX={1}>
        {progressBox}
        {header}
        {/* Proportional colour blocks, not glyphs: a desktop font draws █ wider than a cell, so a glyph bar wraps. */}
        <Box key="bar" flexDirection="row" width="100%" height={1}>
          {runs(barCells(s, width)).map(r => (
            <Box
              width={0}
              flexGrow={r.text.length}
              height={1}
              backgroundColor={r.dim ? FREE_BG : r.color}
            />
          ))}
        </Box>
        {open ? (
          <Box key="legend" flexDirection="row" flexWrap="wrap" columnGap={2}>
            {legendRows.map(c => (
              <Text>
                <Text color={c.kind === 'free' ? FREE_BG : c.color}>
                  ■{' '}
                </Text>
                <Text>{c.kind === 'free' ? 'free' : c.name.toLowerCase()} </Text>
                <Text bold>{formatTokens(c.tokens)}</Text>
                {c.kind === 'used' ? <Text dimColor> {sharePercent(c.tokens, s.maxTokens)}%</Text> : null}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    )
  })
}
