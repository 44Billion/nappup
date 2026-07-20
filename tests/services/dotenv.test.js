import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readDotenvValues, setDotenvValue } from '#services/dotenv.js'

describe('dotenv persistence', () => {
  it('quotes fragments, preserves unrelated lines and removes duplicate managed assignments', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nappup-dotenv-'))
    const filePath = path.join(directory, '.env')
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    fs.writeFileSync(filePath, '# comment\nOTHER=value\nNOSTR_SECRET_KEY=old\nexport NOSTR_SECRET_KEY=duplicate\n')

    const value = 'bunker://example?relay=wss%3A%2F%2Frelay.example#client_key=abcd'
    setDotenvValue('NOSTR_SECRET_KEY', value, { filePath, updateProcessEnv: false })

    const contents = fs.readFileSync(filePath, 'utf8')
    assert.match(contents, /^# comment\nOTHER=value\nNOSTR_SECRET_KEY=".*#client_key=abcd"\n$/)
    assert.equal(readDotenvValues(filePath).NOSTR_SECRET_KEY, value)
    assert.equal((contents.match(/NOSTR_SECRET_KEY=/g) || []).length, 1)
  })

  it('creates new dotenv files with owner-only permissions', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nappup-dotenv-mode-'))
    const filePath = path.join(directory, '.env')
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

    setDotenvValue('VALUE', 'secret', { filePath, updateProcessEnv: false })

    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
  })
})
