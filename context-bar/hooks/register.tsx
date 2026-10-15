import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BarCategory, Snapshot } from '../types'
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
  ticketSections,
} from './progress'

const snapshot = atom({ plugin: 'context-bar', key: 'snapshot' } as const, null)
// Why the last refresh produced no full breakdown; shown while there is no snapshot.
const diag = atom({ plugin: 'context-bar', key: 'diag' } as const, null)
// Whether the per-category legend is shown; collapsed by default, the header and bar always are.
const detailsOpen = atom({ plugin: 'context-bar', key: 'detailsOpen' } as const, false)
// The progress row: the sections of the ticket or skill being worked through (or the
// model's own plan), advanced by its reports and by ticked ticket boxes.
const steps = atom({ plugin: 'context-bar', key: 'steps' } as const, null)

const FREE_COLOR = 'inactive'
const TICK_COLOR = 'warning'
// Free space as a block background; a background cannot be dimmed, so a lighter key stands in.
const FREE_BG = 'subtle'
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
    await $.tool.register(PROGRESS_SPEC)
  } catch {
    // Not bound yet or refused: the bar works without source 1.
  }
}

// A turn that ended short of the total leaves the row dimmed, not "running". A whole
// turn after that with no report drops a skill's or a plan's row; a ticket's stays,
// since its file still says where the work stands.
const pauseSteps = async ($: EngineInterface) => {
  const s = await read($, steps)
  if (s === null || s.done >= s.total) return
  await update($, steps, () => (s.paused && s.source !== 'ticket' ? null : { ...s, paused: true }))
}

// Completed rows stay until the next prompt; unfinished ones carry on.
const clearFinished = async ($: EngineInterface) => {
  const s = await read($, steps)
  if (s !== null && s.done >= s.total) await update($, steps, () => null)
}

// Which ticket this session's calls have named, its file's last seen mtime, and
// whether the session has started working (a skill preloaded before that seeds nothing).
let touched: string | null = null
let lastMtime = -1
let hasWorked = false

const clearProgress = async ($: EngineInterface) => {
  await update($, steps, () => null)
  touched = null
  lastMtime = -1
}

// After a main-loop tool call: once this session's calls have named the active ticket
// (reading it counts) and while its file is in Pending/, the row is that ticket's
// sections; a ticked section moves it on.
const syncTicket = async ($: EngineInterface, call: unknown) => {
  let id: string | null = null
  try {
    const raw = JSON.parse(await $.fs.read(ACTIVE_PATH)).ticket_id
    if (typeof raw === 'string' && raw !== '') id = raw
  } catch {
    // No active ticket.
  }
  const shown = await read($, steps)
  const isShownTicket = shown !== null && shown.source === 'ticket'
  // Another ticket (or none) is active now: drop the old one's unfinished row.
  if (isShownTicket && shown.label !== id && shown.done < shown.total) await update($, steps, () => null)
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
    if (isShownTicket && shown.label === id && shown.done < shown.total) await update($, steps, () => null)
    return
  }
  const file = `${PENDING_DIR}/${name}`
  const { mtimeMs } = await $.fs.stat(file)
  if (mtimeMs === lastMtime) return
  lastMtime = mtimeMs
  const { names, finished } = ticketSections(await $.fs.read(file))
  if (names.length === 0) return
  await update($, steps, prev => {
    if (prev === null || prev.source !== 'ticket' || prev.label !== id || prev.total !== names.length) {
      return seeded('ticket', id, names, finished)
    }
    const done = Math.min(prev.total, Math.max(finished, prev.reported))
    return { ...prev, sections: names, mech: finished, done, step: names[done] ?? null, calls: done === prev.done ? prev.calls : 0 }
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await registerProgressTool($)
    await loadPrefs($)
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
    await clearFinished($)
    await refresh($)
    return r
  })

  // The progress tool is the mod's own and harmless: never a permission prompt.
  on('tool.check', { tool: 'mcp__context-bar__progress' }, ($, e, next) =>
    e.tool === PROGRESS_TOOL ? { decision: 'allow' } : next(e),
  )

  // Serves the progress tool; after any other main-loop call, re-reads the ticket.
  on('tool.call', async ($, e, next) => {
    if (e.tool === PROGRESS_TOOL) {
      if (e.agentId !== undefined) return { result: 'progress is tracked for the main conversation only' }
      const reported = applyReport(await read($, steps), e as unknown as Record<string, unknown>)
      await update($, steps, () => reported)
      return { result: `${reported.done}/${reported.total}` }
    }
    const r = await next(e)
    hasWorked = true
    // Work between two reports, a subagent's included, moves the bar within the
    // current step; only a report resumes a paused row.
    const s = await read($, steps)
    if (s !== null && s.done < s.total && !s.paused) await update($, steps, () => ({ ...s, calls: s.calls + 1 }))
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
    const shown = await read($, steps)
    const isTicketBusy = shown !== null && shown.source === 'ticket' && shown.done < shown.total
    if (hasWorked && sections.length >= 2 && !isTicketBusy) {
      await update($, steps, () => seeded('skill', e.skill, sections, 0))
    }
    return { text: `${r.text}\n\n${PROMPT_SECTION.text}` }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return e.tools.includes(PROGRESS_TOOL) ? { sections: [...r.sections, PROMPT_SECTION] } : r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if ((e as { agentId?: string }).agentId === undefined) await pauseSteps($)
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

    const blocks = progressRows(await read($, steps), { Box, Text, Svg: mascotSvg } as never)
    // Progress sits above the context bar, one blank row between them.
    const progress =
      blocks.length > 0 ? (
        <Box key="progress" flexDirection="column" rowGap={1} marginBottom={1}>
          {blocks}
        </Box>
      ) : null

    if (s === null) {
      const why = await read($, diag)
      return (
        <Box key="context-bar" flexDirection="column">
          {progress}
          <Text>
            <Text color="claude">◆ </Text>
            <Text bold>context </Text>
            <Text dimColor>{why ?? 'waiting for first measurement…'}</Text>
          </Text>
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
          <Text>
            <Text color="claude">◆ </Text>
            <Text bold>context</Text>
          </Text>
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
        {progress}
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
