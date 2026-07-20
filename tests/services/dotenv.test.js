import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decrypt, derive, encrypt } from '@dotenvx/primitives'
import { nsecEncode } from 'libp2r2p/nip19'
import {
  DEFAULT_DOTENV_PRIVATE_KEY,
  DOTENV_PRIVATE_KEY_NAME,
  DOTENV_PUBLIC_KEY_NAME,
  DotenvDecryptionError,
  initializeDotenv,
  readDotenvValues,
  readEncryptedDotenvValue,
  setDotenvValue,
  setEncryptedDotenvValue
} from '#services/dotenv.js'
import { encodeCliSession } from '#services/bunker-session-codec.js'

const PRIVATE_KEY_2 = '0000000000000000000000000000000000000000000000000000000000000002'
const PRIVATE_KEY_3 = '0000000000000000000000000000000000000000000000000000000000000003'
const NOSTR_KEY = '0000000000000000000000000000000000000000000000000000000000000007'
const SESSION = encodeCliSession({
  remoteSignerPubkey: 'a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5',
  relays: ['wss://relay.example.com'],
  secret: null,
  clientKey: NOSTR_KEY
})

function temporaryDotenv (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nappup-dotenv-'))
  const filePath = path.join(directory, '.env')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return filePath
}

function useFallback (filePath) {
  initializeDotenv({ filePath, processEnv: {}, loadNostrSecretKey: false })
}

describe('dotenv persistence', () => {
  it('encrypts managed values, preserves unrelated lines and removes duplicates', t => {
    const filePath = temporaryDotenv(t)
    fs.writeFileSync(filePath, '# comment\nOTHER=value\nNOSTR_SECRET_KEY=old\nexport NOSTR_SECRET_KEY=duplicate\n')
    useFallback(filePath)

    setEncryptedDotenvValue('NOSTR_SECRET_KEY', NOSTR_KEY, { filePath, updateProcessEnv: false })

    const contents = fs.readFileSync(filePath, 'utf8')
    const values = readDotenvValues(filePath)
    assert.match(contents, /^# comment\nOTHER=value\nNOSTR_SECRET_KEY="encrypted:/)
    assert.equal((contents.match(/NOSTR_SECRET_KEY=/g) || []).length, 1)
    assert.equal(values[DOTENV_PUBLIC_KEY_NAME], derive(DEFAULT_DOTENV_PRIVATE_KEY))
    assert.equal(decrypt(DEFAULT_DOTENV_PRIVATE_KEY, values.NOSTR_SECRET_KEY), NOSTR_KEY)
    assert.equal(contents.includes(NOSTR_KEY), false)
  })

  it('keeps the generic setter for unrelated values and protects managed names', t => {
    const filePath = temporaryDotenv(t)
    useFallback(filePath)
    setDotenvValue('VALUE', 'secret', { filePath, updateProcessEnv: false })

    assert.equal(readDotenvValues(filePath).VALUE, 'secret')
    assert.throws(
      () => setDotenvValue('NOSTR_SECRET_KEY', NOSTR_KEY, { filePath }),
      { message: 'Use setEncryptedDotenvValue for NOSTR_SECRET_KEY' }
    )
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
  })

  it('migrates a manually edited plaintext NOSTR_SECRET_KEY before returning it', t => {
    const filePath = temporaryDotenv(t)
    fs.writeFileSync(filePath, `NOSTR_SECRET_KEY=${NOSTR_KEY}\n`)
    const processEnv = {}

    const state = initializeDotenv({ filePath, processEnv })
    const stored = readDotenvValues(filePath).NOSTR_SECRET_KEY

    assert.equal(state.nostrSecretKeySource, 'dotenv')
    assert.equal(processEnv.NOSTR_SECRET_KEY, NOSTR_KEY)
    assert.match(stored, /^encrypted:/)
    assert.equal(decrypt(DEFAULT_DOTENV_PRIVATE_KEY, stored), NOSTR_KEY)
  })

  it('migrates every supported NOSTR_SECRET_KEY plaintext format', t => {
    const values = [
      nsecEncode(NOSTR_KEY),
      'bunker://a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5?relay=wss%3A%2F%2Frelay.example.com'
    ]

    for (const value of values) {
      const filePath = temporaryDotenv(t)
      fs.writeFileSync(filePath, `NOSTR_SECRET_KEY=${value}\n`)
      initializeDotenv({ filePath, processEnv: {} })
      assert.equal(decrypt(DEFAULT_DOTENV_PRIVATE_KEY, readDotenvValues(filePath).NOSTR_SECRET_KEY), value)
    }
  })

  it('migrates a valid plaintext CLI bunker session only when it is read', t => {
    const filePath = temporaryDotenv(t)
    fs.writeFileSync(filePath, `LAST_CLI_BUNKER_SESSION=${SESSION}\n`)
    initializeDotenv({ filePath, processEnv: {}, loadNostrSecretKey: false })
    assert.equal(readDotenvValues(filePath).LAST_CLI_BUNKER_SESSION, SESSION)

    assert.equal(readEncryptedDotenvValue('LAST_CLI_BUNKER_SESSION', { filePath }), SESSION)
    assert.equal(decrypt(
      DEFAULT_DOTENV_PRIVATE_KEY,
      readDotenvValues(filePath).LAST_CLI_BUNKER_SESSION
    ), SESSION)
  })

  it('does not rewrite an invalid plaintext NOSTR_SECRET_KEY before adopting an explicit key', t => {
    const filePath = temporaryDotenv(t)
    fs.writeFileSync(filePath, 'NOSTR_SECRET_KEY=invalid\n')
    const before = fs.readFileSync(filePath, 'utf8')

    assert.throws(() => initializeDotenv({
      filePath,
      privateKey: PRIVATE_KEY_2,
      processEnv: {}
    }), /Invalid NOSTR_SECRET_KEY/)
    assert.equal(fs.readFileSync(filePath, 'utf8'), before)
  })

  it('does not rewrite a file value shadowed by the process environment', t => {
    const filePath = temporaryDotenv(t)
    fs.writeFileSync(filePath, `NOSTR_SECRET_KEY=${NOSTR_KEY}\n`)
    const external = PRIVATE_KEY_2

    const state = initializeDotenv({
      filePath,
      processEnv: { NOSTR_SECRET_KEY: external }
    })

    assert.equal(state.nostrSecretKeySource, 'process')
    assert.equal(readDotenvValues(filePath).NOSTR_SECRET_KEY, NOSTR_KEY)
  })

  it('encrypts with only the public key from the dotenv file', t => {
    const filePath = temporaryDotenv(t)
    const publicKey = derive(PRIVATE_KEY_2)
    fs.writeFileSync(filePath, `${DOTENV_PUBLIC_KEY_NAME}=${publicKey}\n`)
    useFallback(filePath)

    setEncryptedDotenvValue('NOSTR_SECRET_KEY', NOSTR_KEY, { filePath, updateProcessEnv: false })

    const stored = readDotenvValues(filePath).NOSTR_SECRET_KEY
    assert.equal(decrypt(PRIVATE_KEY_2, stored), NOSTR_KEY)
    assert.throws(
      () => readEncryptedDotenvValue('NOSTR_SECRET_KEY', { filePath }),
      DotenvDecryptionError
    )
  })

  it('uses private-key CLI, environment and fallback precedence', t => {
    const environmentFile = temporaryDotenv(t)
    initializeDotenv({
      filePath: environmentFile,
      processEnv: { [DOTENV_PRIVATE_KEY_NAME]: PRIVATE_KEY_2 },
      loadNostrSecretKey: false
    })
    setEncryptedDotenvValue('NOSTR_SECRET_KEY', NOSTR_KEY, {
      filePath: environmentFile,
      updateProcessEnv: false
    })
    assert.equal(readDotenvValues(environmentFile)[DOTENV_PUBLIC_KEY_NAME], derive(PRIVATE_KEY_2))

    const cliFile = temporaryDotenv(t)
    initializeDotenv({
      filePath: cliFile,
      privateKey: PRIVATE_KEY_3,
      processEnv: { [DOTENV_PRIVATE_KEY_NAME]: PRIVATE_KEY_2 },
      loadNostrSecretKey: false
    })
    setEncryptedDotenvValue('NOSTR_SECRET_KEY', NOSTR_KEY, {
      filePath: cliFile,
      updateProcessEnv: false
    })
    assert.equal(readDotenvValues(cliFile)[DOTENV_PUBLIC_KEY_NAME], derive(PRIVATE_KEY_3))

    const fallbackFile = temporaryDotenv(t)
    useFallback(fallbackFile)
    setEncryptedDotenvValue('NOSTR_SECRET_KEY', NOSTR_KEY, {
      filePath: fallbackFile,
      updateProcessEnv: false
    })
    assert.equal(readDotenvValues(fallbackFile)[DOTENV_PUBLIC_KEY_NAME], derive(DEFAULT_DOTENV_PRIVATE_KEY))
  })

  it('uses an environment public key when the dotenv file has no marker', t => {
    const filePath = temporaryDotenv(t)
    initializeDotenv({
      filePath,
      processEnv: { [DOTENV_PUBLIC_KEY_NAME]: derive(PRIVATE_KEY_2) },
      loadNostrSecretKey: false
    })
    setEncryptedDotenvValue('NOSTR_SECRET_KEY', NOSTR_KEY, { filePath, updateProcessEnv: false })

    const values = readDotenvValues(filePath)
    assert.equal(values[DOTENV_PUBLIC_KEY_NAME], derive(PRIVATE_KEY_2))
    assert.equal(decrypt(PRIVATE_KEY_2, values.NOSTR_SECRET_KEY), NOSTR_KEY)
  })

  it('upgrades fallback ciphertext atomically when an explicit key is introduced', t => {
    const filePath = temporaryDotenv(t)
    useFallback(filePath)
    setEncryptedDotenvValue('NOSTR_SECRET_KEY', NOSTR_KEY, { filePath, updateProcessEnv: false })
    setEncryptedDotenvValue('LAST_CLI_BUNKER_SESSION', SESSION, { filePath, updateProcessEnv: false })

    const state = initializeDotenv({
      filePath,
      privateKey: PRIVATE_KEY_2,
      processEnv: {},
      loadNostrSecretKey: false
    })
    const values = readDotenvValues(filePath)

    assert.equal(state.publicKey, derive(PRIVATE_KEY_2))
    assert.equal(decrypt(PRIVATE_KEY_2, values.NOSTR_SECRET_KEY), NOSTR_KEY)
    assert.equal(decrypt(PRIVATE_KEY_2, values.LAST_CLI_BUNKER_SESSION), SESSION)
  })

  it('resets only inaccessible values when a different explicit key becomes authoritative', t => {
    const filePath = temporaryDotenv(t)
    const secretValue = 'do-not-log-this-value'
    fs.writeFileSync(filePath, [
      `${DOTENV_PUBLIC_KEY_NAME}=${derive(PRIVATE_KEY_2)}`,
      `NOSTR_SECRET_KEY=${encrypt(derive(PRIVATE_KEY_2), secretValue)}`,
      `LAST_CLI_BUNKER_SESSION=${SESSION}`,
      'OTHER=preserved',
      ''
    ].join('\n'))
    const warnings = []

    initializeDotenv({
      filePath,
      privateKey: PRIVATE_KEY_3,
      processEnv: {},
      loadNostrSecretKey: false,
      onWarning: warning => warnings.push(warning)
    })
    const values = readDotenvValues(filePath)

    assert.equal(values[DOTENV_PUBLIC_KEY_NAME], derive(PRIVATE_KEY_3))
    assert.equal(Object.hasOwn(values, 'NOSTR_SECRET_KEY'), false)
    assert.equal(decrypt(PRIVATE_KEY_3, values.LAST_CLI_BUNKER_SESSION), SESSION)
    assert.equal(values.OTHER, 'preserved')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /NOSTR_SECRET_KEY/)
    assert.equal(warnings[0].includes(secretValue), false)
  })

  it('adopts an explicit key while replacing the requested value and preserving recoverable values', t => {
    const filePath = temporaryDotenv(t)
    fs.writeFileSync(filePath, [
      `${DOTENV_PUBLIC_KEY_NAME}=${derive(PRIVATE_KEY_2)}`,
      `NOSTR_SECRET_KEY=${encrypt(derive(PRIVATE_KEY_2), 'inaccessible')}`,
      `LAST_CLI_BUNKER_SESSION=${SESSION}`,
      'OTHER=preserved',
      ''
    ].join('\n'))
    const warnings = []

    initializeDotenv({
      filePath,
      privateKey: PRIVATE_KEY_3,
      processEnv: {},
      loadNostrSecretKey: false,
      reconcilePrivateKey: false
    })
    setEncryptedDotenvValue('NOSTR_SECRET_KEY', NOSTR_KEY, {
      filePath,
      updateProcessEnv: false,
      onWarning: warning => warnings.push(warning)
    })
    const values = readDotenvValues(filePath)

    assert.equal(values[DOTENV_PUBLIC_KEY_NAME], derive(PRIVATE_KEY_3))
    assert.equal(decrypt(PRIVATE_KEY_3, values.NOSTR_SECRET_KEY), NOSTR_KEY)
    assert.equal(decrypt(PRIVATE_KEY_3, values.LAST_CLI_BUNKER_SESSION), SESSION)
    assert.equal(values.OTHER, 'preserved')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /NOSTR_SECRET_KEY will be replaced/)
    assert.equal(warnings[0].includes('inaccessible'), false)
  })

  it('fails without rewriting authenticated ciphertext that was tampered with', t => {
    const filePath = temporaryDotenv(t)
    const publicKey = derive(PRIVATE_KEY_2)
    const encrypted = encrypt(publicKey, NOSTR_KEY)
    const tampered = `${encrypted.slice(0, -2)}AA`
    fs.writeFileSync(filePath, `${DOTENV_PUBLIC_KEY_NAME}=${publicKey}\nNOSTR_SECRET_KEY=${tampered}\n`)
    const before = fs.readFileSync(filePath, 'utf8')

    assert.throws(() => initializeDotenv({
      filePath,
      privateKey: PRIVATE_KEY_2,
      processEnv: {}
    }), DotenvDecryptionError)
    assert.equal(fs.readFileSync(filePath, 'utf8'), before)
  })

  it('rejects a private encryption key stored in the dotenv file', t => {
    const filePath = temporaryDotenv(t)
    fs.writeFileSync(filePath, `${DOTENV_PRIVATE_KEY_NAME}=${PRIVATE_KEY_2}\n`)
    assert.throws(
      () => initializeDotenv({ filePath, processEnv: {}, loadNostrSecretKey: false }),
      new RegExp(`${DOTENV_PRIVATE_KEY_NAME} must not be stored`)
    )
  })

  it('decrypts the fixture published by dotenvx primitives', () => {
    const privateKey = 'a4547dcd9d3429615a3649bb79e87edb62ee6a74b007075e9141ae44f5fb412c'
    const encrypted = 'encrypted:BE9Y7LKANx77X1pv1HnEoil93fPa5c9rpL/1ps48uaRT9zM8VR6mHx9yM+HktKdsPGIZELuZ7rr2mn1gScsmWitppAgE/1lVprNYBCqiYeaTcKXjDUXU5LfsEsflnAsDhT/kWG1l'
    assert.equal(decrypt(privateKey, encrypted), 'World')
  })

  it('uses a new ephemeral key for each encryption', t => {
    const filePath = temporaryDotenv(t)
    useFallback(filePath)
    setEncryptedDotenvValue('NOSTR_SECRET_KEY', NOSTR_KEY, { filePath, updateProcessEnv: false })
    const first = readDotenvValues(filePath).NOSTR_SECRET_KEY
    setEncryptedDotenvValue('NOSTR_SECRET_KEY', NOSTR_KEY, { filePath, updateProcessEnv: false })
    const second = readDotenvValues(filePath).NOSTR_SECRET_KEY

    assert.notEqual(first, second)
    assert.equal(decrypt(DEFAULT_DOTENV_PRIVATE_KEY, first), NOSTR_KEY)
    assert.equal(decrypt(DEFAULT_DOTENV_PRIVATE_KEY, second), NOSTR_KEY)
  })
})
