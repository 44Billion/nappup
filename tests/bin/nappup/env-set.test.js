import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import dotenv from 'dotenv'
import { decrypt, derive } from '@dotenvx/primitives'

const PRIVATE_KEY = '0000000000000000000000000000000000000000000000000000000000000002'
const NOSTR_KEY = '0000000000000000000000000000000000000000000000000000000000000007'

function runCli (filePath, args) {
  const env = { ...process.env, DOTENV_CONFIG_PATH: filePath }
  delete env.NOSTR_SECRET_KEY
  delete env.DOTENV_PRIVATE_KEY_NAPPUP
  delete env.DOTENV_PUBLIC_KEY_NAPPUP
  return spawnSync(process.execPath, [
    path.resolve('bin/nappup/index.js'),
    ...args
  ], { cwd: process.cwd(), env, encoding: 'utf8' })
}

function runEnvSet (filePath, value) {
  return runCli(filePath, ['env', 'set', 'NOSTR_SECRET_KEY', value])
}

describe('nappup env set', () => {
  it('stores a positional value encrypted with the public key only', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nappup-env-set-'))
    const filePath = path.join(directory, '.env')
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    fs.writeFileSync(filePath, `DOTENV_PUBLIC_KEY_NAPPUP=${derive(PRIVATE_KEY)}\nOTHER=value\n`)

    const result = runEnvSet(filePath, NOSTR_KEY)
    const values = dotenv.parse(fs.readFileSync(filePath))

    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /shell history/)
    assert.equal(result.stderr.includes(NOSTR_KEY), false)
    assert.equal(values.OTHER, 'value')
    assert.equal(decrypt(PRIVATE_KEY, values.NOSTR_SECRET_KEY), NOSTR_KEY)
  })

  it('does not modify the file when the supplied value is invalid', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nappup-env-invalid-'))
    const filePath = path.join(directory, '.env')
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    fs.writeFileSync(filePath, 'OTHER=value\n')
    const before = fs.readFileSync(filePath, 'utf8')

    const result = runEnvSet(filePath, 'invalid')

    assert.equal(result.error, undefined)
    assert.notEqual(result.status, 0)
    assert.equal(fs.readFileSync(filePath, 'utf8'), before)
  })
})

describe('nappup env keygen', () => {
  it('generates a local private key without reading or modifying dotenv', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nappup-env-keygen-'))
    const filePath = path.join(directory, 'missing', '.env')
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

    const first = runCli(filePath, ['env', 'keygen'])
    const second = runCli(filePath, ['env', 'keygen'])
    const firstKey = first.stdout.trim()
    const secondKey = second.stdout.trim()

    assert.equal(first.error, undefined)
    assert.equal(first.status, 0, first.stderr)
    assert.match(firstKey, /^[0-9a-f]{64}$/)
    assert.match(first.stderr, /not stored/)
    assert.equal(first.stderr.includes(firstKey), false)
    assert.notEqual(firstKey, secondKey)
    assert.equal(derive(firstKey).length, 66)
    assert.equal(fs.existsSync(filePath), false)
  })
})
