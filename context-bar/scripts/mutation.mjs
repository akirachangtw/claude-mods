// Mutation check for the progress reducer and the project label: removes one guard at a time, runs
// `claude plugin test`, and expects the suite to fail. A mutant the tests let
// through means that guard is untested.
//
//   node context-bar/scripts/mutation.mjs
//
// Each source file is restored after every mutant, also on error.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const reducer = join(pluginDir, 'hooks', 'progress', 'reducer.ts')
const names = join(pluginDir, 'hooks', 'project', 'name.ts')

// Each mutant is a list of source lines to find in `file` (the reducer unless
// named) and the lines to put instead.
const MUTANTS = [
  {
    name: 'sequence guard removed',
    from: ['  if (ev.sequence <= r.lastSequence) {'],
    to: ['  if (false) {'],
  },
  {
    name: 'checkpoint dedupe removed',
    from: ["      if (done.includes(ev.checkpointId!)) return ignore(s, at, 'duplicate-checkpoint', r.runId, `${st.id}/${ev.checkpointId}`)"],
    to: [],
  },
  {
    name: 'paused guard removed (a workflow event resumes a pause)',
    from: ["  if (r.base === 'waiting-user' || r.base === 'orphaned') {"],
    to: ["  if (r.base === 'waiting-user' || r.base === 'orphaned' || r.base === 'paused') {"],
  },
  {
    name: 'paused guard removed (a tool call resumes a pause)',
    from: ['      r.liveness.currentActivity = action.name', '      touch(r, action.at)'],
    to: ['      r.liveness.currentActivity = action.name', "      if (r.base === 'paused') r.base = 'running'", '      touch(r, action.at)'],
  },
  {
    name: 'buffer ceiling removed',
    from: ['  const ceiling = stageCeiling(r)', '  if (r.buffer.stageId !== r.currentStageId) {'],
    to: ['  const ceiling = 100', '  if (r.buffer.stageId !== r.currentStageId) {'],
  },
  {
    name: 'tool calls commit the current stage',
    from: ['      r.buffer.activityCount += 1', '      r.liveness.currentActivity = action.name'],
    to: [
      '      r.buffer.activityCount += 1',
      '      if (r.currentStageId !== null) completeStage(r, r.currentStageId)',
      '      r.liveness.currentActivity = action.name',
    ],
  },
  {
    name: 'project label: a taken abbreviation is reused',
    file: names,
    from: ['  if (!taken.has(base)) return base'],
    to: ['  return base'],
  },
  {
    name: 'project label: the custom name no longer wins',
    file: names,
    from: ['  if (custom !== undefined) return { label: custom, names }'],
    to: [],
  },
]

const originals = new Map([reducer, names].map(f => [f, readFileSync(f, 'utf8')]))
const restore = () => originals.forEach((text, f) => writeFileSync(f, text))

const runTests = () => {
  try {
    execFileSync('claude', ['plugin', 'test', pluginDir], { stdio: 'pipe', shell: process.platform === 'win32' })
    return true
  } catch {
    return false
  }
}

let survived = 0
try {
  if (!runTests()) throw new Error('the unmutated suite fails; fix it first')
  for (const m of MUTANTS) {
    const file = m.file ?? reducer
    const original = originals.get(file)
    const eol = original.includes(String.fromCharCode(13, 10)) ? String.fromCharCode(13, 10) : String.fromCharCode(10)
    const from = m.from.join(eol)
    if (!original.includes(from)) throw new Error(`mutant "${m.name}": source text not found`)
    writeFileSync(file, original.replace(from, m.to.join(eol)))
    const passed = runTests()
    restore()
    console.log(`${passed ? 'SURVIVED' : 'killed  '}  ${m.name}`)
    if (passed) survived++
  }
} finally {
  restore()
}
console.log(survived === 0 ? `all ${MUTANTS.length} mutants killed` : `${survived} mutant(s) survived`)
process.exit(survived === 0 ? 0 : 1)
