import { expect, test } from 'claude-code/testing'

import {
  autoName,
  cleanName,
  displayWidth,
  emptyNames,
  folderName,
  labelFor,
  projectKey,
  readNames,
  resolveName,
  splitWords,
  uniqueName,
} from './name'

test('words split at separators, case changes and digits', () => {
  expect(splitWords('SmartCameraApp1')).toEqual(['Smart', 'Camera', 'App', '1'])
  expect(splitWords('mcp-ticket-platform')).toEqual(['mcp', 'ticket', 'platform'])
  expect(splitWords('MCPServer')).toEqual(['MCP', 'Server'])
  expect(splitWords('my_app.v2 beta')).toEqual(['my', 'app', 'v', '2', 'beta'])
  expect(splitWords('相機-App')).toEqual(['相機', 'App'])
})

test('a short name stays whole; a long one keeps its first word and the initials of the rest', () => {
  expect(autoName('projman')).toBe('projman')
  expect(autoName('SmartCameraApp1')).toBe('SmartCA1')
  expect(autoName('claude-mods')).toBe('claudeM')
  expect(autoName('mcp-ticket-platform')).toBe('mcpTP')
  expect(autoName('AndroidStudioProjects')).toBe('AndroiSP')
  expect(autoName('Supercalifragilistic')).toBe('Supercal')
  for (const f of ['a-b-c-d-e-f-g-h-i-j-k', '我的相機應用程式專案', 'x1234567890y']) {
    expect(displayWidth(autoName(f))).toBeLessThanOrEqual(8)
  }
})

test('wide characters count two cells', () => {
  expect(displayWidth('相機')).toBe(4)
  expect(autoName('相機專案')).toBe('相機專案')
  expect(displayWidth(autoName('我的相機應用程式'))).toBeLessThanOrEqual(8)
})

test('a name someone holds gets a number, still within 8 cells', () => {
  expect(uniqueName('SmartCA1', new Set())).toBe('SmartCA1')
  expect(uniqueName('SmartCA1', new Set(['SmartCA1']))).toBe('SmartCA2')
  expect(uniqueName('mcpTP', new Set(['mcpTP', 'mcpTP2']))).toBe('mcpTP3')
})

test('project keys ignore slashes and, on a drive, case', () => {
  expect(projectKey('D:\\DevSources\\claude-mods\\')).toBe('d:/devsources/claude-mods')
  expect(projectKey('d:/DevSources/Claude-Mods')).toBe('d:/devsources/claude-mods')
  expect(projectKey('/home/me/App')).toBe('/home/me/App')
  expect(projectKey('.')).toBeNull()
  expect(folderName('D:\\DevSources\\claude-mods\\')).toBe('claude-mods')
})

test('a label once given stays; a later project with the same abbreviation is numbered', () => {
  let names = emptyNames()
  const a = resolveName(names, 'd:/a/smartcameraapp1', 'SmartCameraApp1')
  expect(a.label).toBe('SmartCA1')
  names = a.names
  const b = resolveName(names, 'd:/b/smartcameraapp1', 'SmartCameraApp1')
  expect(b.label).toBe('SmartCA2')
  names = b.names
  expect(resolveName(names, 'd:/a/smartcameraapp1', 'SmartCameraApp1').label).toBe('SmartCA1')
  // Resolving a known project changes nothing to store.
  expect(resolveName(names, 'd:/b/smartcameraapp1', 'SmartCameraApp1').names).toBe(names)
})

test('a custom name wins, other projects avoid it, off shows none', () => {
  const names = { auto: {}, custom: { 'd:/x': 'claudeM' }, off: ['d:/y'] }
  expect(resolveName(names, 'd:/x', 'whatever').label).toBe('claudeM')
  expect(resolveName(names, 'd:/z/claude-mods', 'claude-mods').label).toBe('claudeM2')
  expect(resolveName(names, 'd:/y', 'claude-mods').label).toBeNull()
})

test('a typed name loses brackets and is cut to 8 cells', () => {
  expect(cleanName('  Cam  ')).toEqual({ name: 'Cam', cut: false })
  expect(cleanName('[Cam]')).toEqual({ name: 'Cam', cut: false })
  expect(cleanName('VeryLongName')).toEqual({ name: 'VeryLong', cut: true })
  expect(cleanName('[]').name).toBe('')
})

test('a narrow band keeps a shorter label', () => {
  expect(labelFor('SmartCA1', 100)).toBe('SmartCA1')
  expect(labelFor('SmartCA1', 59)).toBe('SmartC')
})

test('stored names of the wrong shape read as empty', () => {
  expect(readNames(undefined)).toEqual(emptyNames())
  expect(readNames({ auto: { a: 'A', b: 3 }, custom: null, off: ['x', 1] })).toEqual({
    auto: { a: 'A' },
    custom: {},
    off: ['x'],
  })
})
