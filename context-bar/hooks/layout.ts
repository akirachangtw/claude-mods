// One line per row, wide or narrow: the band works out what fits before it
// draws, leaving less important text out first, since a desktop does not
// always honour a Text's truncation.

import { clipWidth, displayWidth } from './text'

// Under this many columns the band is narrow: small text, thin bars, no cat,
// no status row or divider. The project label shortens at the same width.
export const NARROW_COLUMNS = 60

// A desktop draws text wider than a cell (the P2 divider showed it): it keeps a
// share of the cells for text. Small text fits more in the same width.
export const DESKTOP_TEXT_SHARE = 0.85
export const DESKTOP_SMALL_TEXT_SHARE = 1.0

// The band's round border and one cell of padding on each side.
const BAND_FRAME = 4

export const isNarrow = (columns: number): boolean => columns < NARROW_COLUMNS

// Cells a row of text may take inside the band.
export const textCells = (columns: number, surface: string): number => {
  const inner = Math.max(0, columns - BAND_FRAME)
  if (surface === 'terminal') return inner
  return Math.floor(inner * (isNarrow(columns) ? DESKTOP_SMALL_TEXT_SHARE : DESKTOP_TEXT_SHARE))
}

// `s` whole, or cut with an ellipsis to `width` cells.
export const fitText = (s: string, width: number): string =>
  displayWidth(s) <= width ? s : width <= 0 ? '' : `${clipWidth(s, width - 1)}…`

// Between the title and its count, as the row's columnGap draws it.
const TITLE_GAP = 2
// `▶ ` before the label; `   ` before the stage.
const MARK_CELLS = 2
const DETAIL_GAP = 3

// The progress title: the stage goes first, then the label is cut; the mark
// and the count on the right always stay.
export const fitTitle = (
  label: string,
  detail: string | null,
  right: string,
  cells: number,
): { label: string; detail: string | null } => {
  const room = cells - displayWidth(right) - TITLE_GAP - MARK_CELLS
  if (detail !== null && displayWidth(label) + DETAIL_GAP + displayWidth(detail) <= room) return { label, detail }
  return { label: fitText(label, room), detail: null }
}

// The context header's right side and whether `▸ details` still fits.
export type HeaderFit = { summary: string; details: boolean }

const DETAILS_CELLS = 1 + displayWidth('▸ details')
// The badge, ` 58% `, and the space before it.
const badgeCells = (pct: number) => displayWidth(` ${pct}% `) + 1

// Wide, the header leaves out, in turn: the compaction point, the details
// toggle, the long form of the token count, then the count. Narrow keeps the
// title and the badge alone.
export const fitHeader = (
  title: string,
  used: string,
  max: string,
  threshold: string | null,
  pct: number,
  cells: number,
  narrow: boolean,
): HeaderFit => {
  if (narrow) return { summary: '', details: false }
  const room = cells - displayWidth(title) - badgeCells(pct) - 1
  const tries: HeaderFit[] = [
    ...(threshold !== null ? [{ summary: `${used} of ${max} · compacts at ${threshold}`, details: true }] : []),
    { summary: `${used} of ${max}`, details: true },
    { summary: `${used} of ${max}`, details: false },
    { summary: `${used}/${max}`, details: false },
  ]
  for (const t of tries) if (displayWidth(t.summary) + (t.details ? DETAILS_CELLS : 0) <= room) return t
  return { summary: '', details: false }
}
