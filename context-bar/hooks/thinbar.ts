// The narrow band's half-height bars. A Box is at least one row tall, so a
// thinner bar is an Svg. The P2 divider Svg drew nothing because its markup had
// no width and was laid out zero wide: this markup is very wide and the slot
// holds it to the row's width, while the element's height stays fixed.

// Switch the thin bars off (a desktop draws one-row blocks instead) if a host
// lays the Svg out wrong.
export const THIN_BARS = true

// CSS pixels, about half a row.
export const THIN_BAR_PX = 8
// The markup's own width: wider than any band, so the slot is what limits it.
const MARKUP_WIDTH = 4000
// Units across the viewBox: segment widths are shares of this.
const SPAN = 1000

// An Svg holds raw colours only, so theme keys are resolved here, by the
// person's theme: a light one, else dark.
const DARK: Record<string, string> = {
  claude: '#D77757',
  success: '#4EBA65',
  warning: '#FFC107',
  error: '#FF6B80',
  permission: '#B1B9F9',
  suggestion: '#B1B9F9',
  ide: '#4782C8',
  promptBorder: '#888888',
  inactive: '#999999',
  subtle: '#505050',
  text: '#FFFFFF',
}
const LIGHT: Record<string, string> = {
  claude: '#D77757',
  success: '#2C7A39',
  warning: '#966C1E',
  error: '#AB2B3F',
  permission: '#5769F7',
  suggestion: '#5769F7',
  ide: '#4782C8',
  promptBorder: '#999999',
  inactive: '#666666',
  subtle: '#AFAFAF',
  text: '#000000',
}

export const isLightTheme = (theme: string | null): boolean => theme !== null && /light/i.test(theme)

// A theme key as hex; a raw colour as it is; an unknown key as the inactive grey.
export const toHex = (color: string, light: boolean): string => {
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color
  const table = light ? LIGHT : DARK
  return table[color] ?? table.inactive!
}

export type ThinSegment = { weight: number; color: string }

// One bar: the segments side by side by weight, and an optional tick (a share
// of the bar, 0 to 1) drawn over them.
export const thinBarSvg = (
  segments: readonly ThinSegment[],
  light: boolean,
  tick?: { at: number; color: string },
): string => {
  const total = segments.reduce((n, s) => n + Math.max(0, s.weight), 0)
  let x = 0
  const rects: string[] = []
  for (const s of segments) {
    if (s.weight <= 0 || total <= 0) continue
    const w = (s.weight / total) * SPAN
    rects.push(`<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${THIN_BAR_PX}" fill="${toHex(s.color, light)}"/>`)
    x += w
  }
  if (tick !== undefined) {
    const at = Math.min(SPAN - 4, Math.max(0, tick.at * SPAN - 4))
    rects.push(`<rect x="${at.toFixed(2)}" y="0" width="4" height="${THIN_BAR_PX}" fill="${toHex(tick.color, light)}"/>`)
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MARKUP_WIDTH}" height="${THIN_BAR_PX}" ` +
    `viewBox="0 0 ${SPAN} ${THIN_BAR_PX}" preserveAspectRatio="none" shape-rendering="crispEdges">${rects.join('')}</svg>`
  )
}
