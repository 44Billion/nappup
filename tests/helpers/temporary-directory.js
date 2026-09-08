import { before, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let installed = false

// NMMR clears its temporary folder on first write; isolate each test process.
export function isolateTemporaryDirectory () {
  if (installed) return
  installed = true
  let directory
  let previous
  before(() => {
    previous = process.env.TMPDIR
    directory = mkdtempSync(join(tmpdir(), 'nappup-relay-tests-'))
    process.env.TMPDIR = directory
  })
  after(() => {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
    if (directory) rmSync(directory, { recursive: true, force: true })
  })
}
