import { expect, test } from 'claude-code/testing'

import { THIN_BAR_PX, isLightTheme, thinBarSvg, toHex } from './thinbar'

const widths = (svg: string) => [...svg.matchAll(/<rect x="[\d.]+" y="0" width="([\d.]+)"/g)].map(m => Number(m[1]))

test('the markup has a width of its own, wider than any band, and stretches to the row', () => {
  const svg = thinBarSvg([{ weight: 1, color: 'claude' }], false)
  // Without a width of its own an Svg is laid out zero wide (the P2 divider).
  expect(svg).toMatch(/<svg [^>]*width="4000"/)
  expect(svg).toContain(`height="${THIN_BAR_PX}"`)
  expect(svg).toContain('preserveAspectRatio="none"')
})

test('segments sit side by side by weight across the bar', () => {
  const w = widths(
    thinBarSvg(
      [
        { weight: 30, color: 'claude' },
        { weight: 10, color: '#EDC3AE' },
        { weight: 60, color: 'subtle' },
      ],
      false,
    ),
  )
  expect(w).toEqual([300, 100, 600])
  // An empty segment draws nothing.
  expect(widths(thinBarSvg([{ weight: 0, color: 'claude' }, { weight: 5, color: 'subtle' }], false))).toEqual([1000])
})

test('only raw colours reach the Svg: theme keys resolve by a light or dark theme', () => {
  const svg = thinBarSvg([{ weight: 1, color: 'claude' }, { weight: 1, color: 'subtle' }, { weight: 1, color: 'nonsense' }], true)
  for (const fill of svg.match(/fill="[^"]*"/g) ?? []) expect(fill).toMatch(/fill="#[0-9A-Fa-f]{3,8}"/)
  expect(toHex('#EDC3AE', true)).toBe('#EDC3AE')
  expect(toHex('subtle', true)).not.toBe(toHex('subtle', false))
  expect(isLightTheme('light-daltonized')).toBe(true)
  expect(isLightTheme('dark-daltonized')).toBe(false)
  expect(isLightTheme(null)).toBe(false)
})

test('the tick sits at its share of the bar', () => {
  const svg = thinBarSvg([{ weight: 1, color: 'subtle' }], false, { at: 0.5, color: 'warning' })
  expect(svg).toContain('<rect x="496.00" y="0" width="4"')
})
