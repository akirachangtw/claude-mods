// The project label on the context header: a name the person set, or one made
// from the project folder's name, at most NAME_MAX cells and never another
// project's.

import type { ProjectNames } from '../../types'
import { NARROW_COLUMNS } from '../layout'
import { clipWidth, displayWidth } from '../text'

export { clipWidth, displayWidth }

export const NAME_MAX = 8
// The first word an abbreviation keeps, in cells.
const HEAD_MAX = 6
// A narrow band (under NARROW_COLUMNS) keeps a shorter label.
const NARROW_MAX = 6

export const emptyNames = (): ProjectNames => ({ auto: {}, custom: {}, off: [] })

// Same project whatever the slashes or, on a drive path, the case.
export const projectKey = (path: string): string | null => {
  const p = path.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (p === '' || p === '.') return null
  return /^[A-Za-z]:\//.test(p) || /^[A-Za-z]:$/.test(p) ? p.toLowerCase() : p
}

export const folderName = (path: string): string => {
  const p = path.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return p.slice(p.lastIndexOf('/') + 1)
}

// `SmartCameraApp1` → Smart Camera App 1; `mcp-ticket-platform` → mcp ticket platform;
// `MCPServer` → MCP Server.
export const splitWords = (name: string): string[] =>
  name
    .split(/[-_.\s]+/)
    .flatMap(part => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+|[^A-Za-z\d]+/g) ?? [])
    .filter(w => w !== '')

// Short names stay whole; a long one keeps its first word and the initials
// (digits whole) of the rest: `SmartCameraApp1` → `SmartCA1`.
export const autoName = (folder: string, max = NAME_MAX): string => {
  if (displayWidth(folder) <= max) return folder
  const words = splitWords(folder)
  if (words.length < 2) return clipWidth(folder, max)
  const tail = words
    .slice(1)
    .map(w => (/^\d+$/.test(w) ? w : [...w][0]!.toUpperCase()))
    .join('')
  const head = clipWidth(words[0]!, Math.min(HEAD_MAX, Math.max(1, max - displayWidth(tail))))
  return clipWidth(head + tail, max)
}

// `base`, or `base` cut short with 2, 3… after it, whichever no one else holds.
export const uniqueName = (base: string, taken: ReadonlySet<string>, max = NAME_MAX): string => {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const tag = String(n)
    const name = clipWidth(base, max - tag.length) + tag
    if (!taken.has(name)) return name
  }
}

const others = (names: ProjectNames, key: string) =>
  new Set(
    [...Object.entries(names.auto), ...Object.entries(names.custom)].filter(([k]) => k !== key).map(([, v]) => v),
  )

// The project's label and the names to keep: a label once given never changes,
// so a later project with the same abbreviation takes the numbered one.
export const resolveName = (
  names: ProjectNames,
  key: string,
  folder: string,
): { label: string | null; names: ProjectNames } => {
  if (names.off.includes(key)) return { label: null, names }
  const custom = names.custom[key]
  if (custom !== undefined) return { label: custom, names }
  const known = names.auto[key]
  if (known !== undefined) return { label: known, names }
  const base = autoName(folder)
  if (base === '') return { label: null, names }
  const label = uniqueName(base, others(names, key))
  return { label, names: { ...names, auto: { ...names.auto, [key]: label } } }
}

// A name typed after /project-name: no brackets, trimmed, at most NAME_MAX cells.
export const cleanName = (text: string): { name: string; cut: boolean } => {
  const raw = text.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim()
  const name = clipWidth(raw, NAME_MAX).trim()
  return { name, cut: name !== raw }
}

export const labelFor = (label: string, columns: number): string =>
  clipWidth(label, columns < NARROW_COLUMNS ? NARROW_MAX : NAME_MAX)

// Store values come back as JSON of any shape; keep only what fits.
export const readNames = (v: unknown): ProjectNames => {
  const out = emptyNames()
  if (typeof v !== 'object' || v === null) return out
  const o = v as Record<string, unknown>
  for (const field of ['auto', 'custom'] as const) {
    const m = o[field]
    if (typeof m !== 'object' || m === null) continue
    for (const [k, s] of Object.entries(m)) if (typeof s === 'string' && s !== '') out[field][k] = s
  }
  if (Array.isArray(o.off)) out.off = o.off.filter((k): k is string => typeof k === 'string')
  return out
}
