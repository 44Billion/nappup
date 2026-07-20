import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { derive, encrypt } from '@dotenvx/primitives'
import { base16ToBytes } from 'libp2r2p/base16'
import {
  LAST_CLI_BUNKER_SESSION,
  parseBunkerSessionUrl,
  prepareBunkerSession
} from '#services/bunker-session.js'
import { decodeCliSession } from '#services/bunker-session-codec.js'
import {
  DotenvDecryptionError,
  readEncryptedDotenvValue
} from '#services/dotenv.js'

const REMOTE_PUBKEY = 'a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5'
const CLIENT_KEY = '0000000000000000000000000000000000000000000000000000000000000007'
const OTHER_CLIENT_KEY = '0000000000000000000000000000000000000000000000000000000000000008'
const BUNKER_URL = `bunker://${REMOTE_PUBKEY}?relay=wss://relay.example.com&secret=tok`

function temporaryDotenv () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nappup-session-'))
  return {
    filePath: path.join(directory, '.env'),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
  }
}

function decodeSession (filePath) {
  return decodeCliSession(readEncryptedDotenvValue(LAST_CLI_BUNKER_SESSION, { filePath }))
}

describe('bunker session persistence', () => {
  it('parses one client_key fragment and rejects ambiguous fields', () => {
    const parsed = parseBunkerSessionUrl(`${BUNKER_URL}#client_key=${CLIENT_KEY}`)
    assert.equal(parsed.clientKey, CLIENT_KEY)

    assert.throws(
      () => parseBunkerSessionUrl(`${BUNKER_URL}&secret=other`),
      { message: 'Bunker URL must not contain multiple secrets' }
    )
    assert.throws(
      () => parseBunkerSessionUrl(`${BUNKER_URL}#client_key=${CLIENT_KEY}&client_key=${OTHER_CLIENT_KEY}`),
      { message: 'Invalid bunker URL fragment' }
    )
  })

  it('stores a quoted NOSTR_SECRET_KEY with secret and client key for dotenv input', t => {
    const temporary = temporaryDotenv()
    t.after(temporary.cleanup)

    const session = prepareBunkerSession(BUNKER_URL, {
      source: 'dotenv',
      filePath: temporary.filePath,
      generateClientKey: () => base16ToBytes(CLIENT_KEY)
    })
    const raw = fs.readFileSync(temporary.filePath, 'utf8')
    const stored = readEncryptedDotenvValue('NOSTR_SECRET_KEY', { filePath: temporary.filePath })

    assert.equal(session.reusedClientKey, false)
    assert.match(raw, /^DOTENV_PUBLIC_KEY_NAPPUP=".*"\nNOSTR_SECRET_KEY="encrypted:/)
    assert.match(stored, /[?&]secret=tok/)
    assert.match(stored, new RegExp(`#client_key=${CLIENT_KEY}$`))
  })

  it('stores an unversioned Base64URL JSON session for CLI input without a secret', t => {
    const temporary = temporaryDotenv()
    t.after(temporary.cleanup)
    const url = `bunker://${REMOTE_PUBKEY}?relay=wss://relay.example.com`

    prepareBunkerSession(url, {
      filePath: temporary.filePath,
      generateClientKey: () => base16ToBytes(CLIENT_KEY)
    })
    const stored = decodeSession(temporary.filePath)

    assert.deepEqual(stored, {
      remoteSignerPubkey: REMOTE_PUBKEY,
      relays: ['wss://relay.example.com'],
      secret: null,
      clientKey: CLIENT_KEY
    })
    assert.equal(Object.hasOwn(stored, 'version'), false)
  })

  it('accepts legacy sessions while dropping their persisted user pubkey', () => {
    const encoded = Buffer.from(JSON.stringify({
      remoteSignerPubkey: REMOTE_PUBKEY,
      relays: ['wss://relay.example.com'],
      secret: null,
      clientKey: CLIENT_KEY,
      userPubkey: OTHER_CLIENT_KEY
    })).toString('base64url')

    assert.deepEqual(decodeCliSession(encoded), {
      remoteSignerPubkey: REMOTE_PUBKEY,
      relays: ['wss://relay.example.com'],
      secret: null,
      clientKey: CLIENT_KEY
    })
  })

  it('reuses a secretless CLI session by remote signer pubkey and merges relay hints', t => {
    const temporary = temporaryDotenv()
    t.after(temporary.cleanup)
    prepareBunkerSession(BUNKER_URL, {
      filePath: temporary.filePath,
      generateClientKey: () => base16ToBytes(CLIENT_KEY)
    })

    const session = prepareBunkerSession(
      `bunker://${REMOTE_PUBKEY}?relay=wss://new.example.com`,
      {
        filePath: temporary.filePath,
        generateClientKey: () => { throw new Error('should not generate') }
      }
    )

    assert.equal(session.clientKey, CLIENT_KEY)
    assert.equal(session.secret, 'tok')
    assert.equal(session.reusedClientKey, true)
    assert.deepEqual(session.relays, ['wss://new.example.com', 'wss://relay.example.com'])
  })

  it('starts a new session when the same remote signer has a different secret', t => {
    const temporary = temporaryDotenv()
    t.after(temporary.cleanup)
    prepareBunkerSession(BUNKER_URL, {
      filePath: temporary.filePath,
      generateClientKey: () => base16ToBytes(CLIENT_KEY)
    })

    const session = prepareBunkerSession(
      `bunker://${REMOTE_PUBKEY}?relay=wss://relay.example.com&secret=other`,
      {
        filePath: temporary.filePath,
        generateClientKey: () => base16ToBytes(OTHER_CLIENT_KEY)
      }
    )

    assert.equal(session.clientKey, OTHER_CLIENT_KEY)
    assert.equal(session.secret, 'other')
    assert.equal(session.reusedClientKey, false)
  })

  it('ignores a malformed cached session and reports it once', t => {
    const temporary = temporaryDotenv()
    t.after(temporary.cleanup)
    fs.writeFileSync(temporary.filePath, `${LAST_CLI_BUNKER_SESSION}="not base64"\n`)
    const warnings = []

    const session = prepareBunkerSession(BUNKER_URL, {
      filePath: temporary.filePath,
      onWarning: warning => warnings.push(warning),
      generateClientKey: () => base16ToBytes(CLIENT_KEY)
    })

    assert.equal(session.clientKey, CLIENT_KEY)
    assert.equal(warnings.length, 1)
  })

  it('does not mistake an undecryptable session for a malformed cache', t => {
    const temporary = temporaryDotenv()
    t.after(temporary.cleanup)
    const privateKey = '0000000000000000000000000000000000000000000000000000000000000002'
    const encoded = Buffer.from(JSON.stringify({ ignored: true })).toString('base64url')
    fs.writeFileSync(temporary.filePath, [
      `DOTENV_PUBLIC_KEY_NAPPUP=${derive(privateKey)}`,
      `LAST_CLI_BUNKER_SESSION=${JSON.stringify(encrypt(derive(privateKey), encoded))}`,
      ''
    ].join('\n'))
    const warnings = []

    assert.throws(() => prepareBunkerSession(BUNKER_URL, {
      filePath: temporary.filePath,
      onWarning: warning => warnings.push(warning),
      generateClientKey: () => base16ToBytes(CLIENT_KEY)
    }), DotenvDecryptionError)
    assert.equal(warnings.length, 0)
  })

  it('does not proceed when the session cannot be persisted', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nappup-session-missing-'))
    try {
      assert.throws(() => prepareBunkerSession(BUNKER_URL, {
        filePath: path.join(directory, 'missing', '.env'),
        generateClientKey: () => base16ToBytes(CLIENT_KEY)
      }), { code: 'ENOENT' })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
