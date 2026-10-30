import { expect, test } from 'claude-code/testing'

import { NARROW_COLUMNS, fitHeader, fitText, fitTitle, isNarrow, textCells } from './layout'
import { displayWidth } from './text'

test('narrow is under 60 columns, the same width the project label shortens at', () => {
  expect(NARROW_COLUMNS).toBe(60)
  expect(isNarrow(59)).toBe(true)
  expect(isNarrow(60)).toBe(false)
})

test('a desktop keeps a share of the cells for text; small text keeps them all', () => {
  expect(textCells(100, 'terminal')).toBe(96)
  expect(textCells(100, 'desktop')).toBe(81)
  expect(textCells(50, 'desktop')).toBe(46)
  expect(textCells(2, 'terminal')).toBe(0)
})

test('text is cut with an ellipsis, never through a wide character', () => {
  expect(fitText('context', 10)).toBe('context')
  expect(fitText('ADV-CONSTRSRC-01', 8)).toBe('ADV-CON…')
  expect(fitText('回流無模型', 6)).toBe('回流…')
  expect(displayWidth(fitText('回流無模型', 6))).toBeLessThanOrEqual(6)
  expect(fitText('abc', 0)).toBe('')
})

test('the title drops the stage first, then cuts the label; the count is not its to cut', () => {
  const right = '0/6  0%'
  expect(fitTitle('ticket-author', 'Mission', right, 60)).toEqual({ label: 'ticket-author', detail: 'Mission' })
  const long = 'ADV-CONSTRSRC-01 BLOCKED 回流（無模型啟動）'
  expect(fitTitle(long, 'N6 通知語義查核', right, 60)).toEqual({ label: long, detail: null })
  const cut = fitTitle(long, 'N6 通知語義查核', right, 30)
  expect(cut.detail).toBeNull()
  expect(cut.label.endsWith('…')).toBe(true)
  // mark (2) + label + gap (2) + count fit the row.
  for (const cells of [20, 30, 47, 81]) {
    const f = fitTitle(long, 'N6 通知語義查核', right, cells)
    const used = 2 + displayWidth(f.label) + (f.detail !== null ? 3 + displayWidth(f.detail) : 0) + 2 + displayWidth(right)
    expect(used).toBeLessThanOrEqual(cells)
  }
})

test('the header leaves out the compaction point, details, the long count, then the count; the badge stays', () => {
  const t = '◆ [Cuesho] context'
  const at = (cells: number) => fitHeader(t, '582k', '1M', '967k', 58, cells, false)
  expect(at(81)).toEqual({ summary: '582k of 1M · compacts at 967k', details: true })
  expect(at(55)).toEqual({ summary: '582k of 1M', details: true })
  expect(at(42)).toEqual({ summary: '582k of 1M', details: false })
  expect(at(34)).toEqual({ summary: '582k/1M', details: false })
  expect(at(26)).toEqual({ summary: '', details: false })
  expect(fitHeader(t, '582k', '1M', null, 58, 81, false)).toEqual({ summary: '582k of 1M', details: true })
  // Narrow: the title and the badge alone.
  expect(fitHeader(t, '582k', '1M', '967k', 58, 200, true)).toEqual({ summary: '', details: false })
})
