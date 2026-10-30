// Text width in cells, as a terminal lays it out.

// East Asian wide characters take two cells.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/
const cells = (ch: string) => (WIDE.test(ch) ? 2 : 1)
export const displayWidth = (s: string): number => [...s].reduce((n, ch) => n + cells(ch), 0)

// The longest start of `s` that fits in `width` cells.
export const clipWidth = (s: string, width: number): string => {
  let out = ''
  let n = 0
  for (const ch of s) {
    if (n + cells(ch) > width) break
    out += ch
    n += cells(ch)
  }
  return out
}
