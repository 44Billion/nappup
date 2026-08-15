import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import publishApp, {
  NappupError,
  NAPPUP_ERROR_CODES,
  toApp
} from '../src/index.js'
import { classifySignerError, normalizeNappupError } from '../src/errors.js'

function createSigner (getRelays = async () => ({ write: ['wss://relay.test'] })) {
  return { getRelays }
}

function createFile (relativePath) {
  return {
    name: relativePath.split('/').pop(),
    webkitRelativePath: relativePath
  }
}

describe('public nappup errors', () => {
  it('exports unique prefixed error codes', () => {
    const codes = Object.values(NAPPUP_ERROR_CODES)
    assert.equal(new Set(codes).size, codes.length)
    assert.equal(codes.every(code => code.startsWith('NAPPUP_')), true)
    assert.throws(() => new NappupError('invalid-code'), /uppercase snake case/)
  })

  it('exposes an immutable code while preserving cause and details', () => {
    const cause = new Error('relay refused the event')
    const error = new NappupError(NAPPUP_ERROR_CODES.MANIFEST_UPLOAD_FAILED, {
      message: 'Could not publish manifest',
      cause,
      details: { relay: 'wss://relay.test' }
    })

    assert.equal(error.name, 'NappupError')
    assert.equal(error.message, 'Could not publish manifest')
    assert.equal(error.cause, cause)
    assert.deepEqual(error.details, { relay: 'wss://relay.test' })
    assert.equal(Object.keys(error).includes('code'), true)
    assert.throws(() => { error.code = 'NAPPUP_UPLOAD_FAILED' }, TypeError)
  })

  it('codes missing signer and empty file-list errors', async () => {
    await assert.rejects(
      () => toApp([], null),
      error => error instanceof NappupError && error.code === NAPPUP_ERROR_CODES.NO_SIGNER
    )
    await assert.rejects(
      () => toApp([], createSigner()),
      error => error instanceof NappupError && error.code === NAPPUP_ERROR_CODES.EMPTY_FILE_LIST
    )
  })

  it('keeps CLI guidance while coding generic folder errors for other consumers', async () => {
    await assert.rejects(
      () => toApp([createFile('dist/index.html')], createSigner()),
      error => {
        assert.equal(error.code, NAPPUP_ERROR_CODES.GENERIC_FOLDER_NAME)
        assert.equal(error.details.folderName, 'dist')
        assert.match(error.message, /-d flag/)
        return true
      }
    )
  })

  it('codes invalid explicit and derived app identifiers', async () => {
    await assert.rejects(
      () => toApp([createFile('app/index.html')], createSigner(), { dTag: '' }),
      { code: NAPPUP_ERROR_CODES.INVALID_D_TAG }
    )
    await assert.rejects(
      () => toApp([createFile('app/index.html')], createSigner(), { dTag: 42 }),
      { code: NAPPUP_ERROR_CODES.INVALID_D_TAG }
    )
    await assert.rejects(
      () => toApp([createFile('/index.html')], createSigner()),
      { code: NAPPUP_ERROR_CODES.INVALID_FOLDER_NAME }
    )
  })

  it('distinguishes relay lookup failure from an empty relay list', async () => {
    const cause = new Error('extension unavailable')
    await assert.rejects(
      () => toApp([createFile('app/index.html')], createSigner(async () => { throw cause })),
      error => error.code === NAPPUP_ERROR_CODES.RELAY_LOOKUP_FAILED && error.cause === cause
    )
    await assert.rejects(
      () => toApp([createFile('app/index.html')], createSigner(async () => ({ write: [] }))),
      { code: NAPPUP_ERROR_CODES.NO_OUTBOX_RELAYS }
    )
  })

  it('emits the same coded error through the default API callback', async () => {
    const events = []
    await assert.rejects(
      () => publishApp([], null, { onEvent: event => events.push(event) }),
      { code: NAPPUP_ERROR_CODES.NO_SIGNER }
    )
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'error')
    assert.equal(events[0].error.code, NAPPUP_ERROR_CODES.NO_SIGNER)
    assert.equal(events[0].progress, 0)
  })

  it('classifies locked and denied signer failures through the cause chain', () => {
    assert.equal(
      classifySignerError(new Error('VAULT_LOCKED')),
      NAPPUP_ERROR_CODES.SIGNER_LOCKED
    )
    assert.equal(
      classifySignerError(new Error('Permission denied')),
      NAPPUP_ERROR_CODES.SIGNER_DENIED
    )
    assert.equal(
      classifySignerError(new Error('User rejected request')),
      NAPPUP_ERROR_CODES.SIGNER_DENIED
    )
    const wrapped = new NappupError(
      NAPPUP_ERROR_CODES.MANIFEST_UPLOAD_FAILED,
      'Failed to publish the app manifest to Nostr relays',
      { cause: new Error('VAULT_LOCKED') }
    )
    assert.equal(
      classifySignerError(wrapped),
      NAPPUP_ERROR_CODES.SIGNER_LOCKED
    )
    assert.equal(classifySignerError(new Error('relay refused the event')), null)
  })

  it('upgrades generic signer-step codes when the vault is locked', () => {
    const cause = new Error('VAULT_LOCKED')
    const error = new NappupError(
      NAPPUP_ERROR_CODES.MANIFEST_UPLOAD_FAILED,
      'Failed to publish the app manifest to Nostr relays',
      { cause, details: { relay: 'wss://relay.test' } }
    )

    const normalized = normalizeNappupError(error)
    assert.equal(normalized.code, NAPPUP_ERROR_CODES.SIGNER_LOCKED)
    assert.equal(normalized.message, error.message)
    assert.equal(normalized.cause, cause)
    assert.deepEqual(normalized.details, { relay: 'wss://relay.test' })
  })

  it('upgrades generic signer-step codes when the prompt was denied', () => {
    const cause = new Error('Permission denied')
    const error = new NappupError(
      NAPPUP_ERROR_CODES.IRFS_UPLOAD_FAILED,
      'Failed to upload "app.js" to Nostr relays',
      { cause }
    )

    const normalized = normalizeNappupError(error)
    assert.equal(normalized.code, NAPPUP_ERROR_CODES.SIGNER_DENIED)
    assert.equal(normalized.message, error.message)
    assert.equal(normalized.cause, cause)
  })

  it('keeps unrelated coded errors unchanged', () => {
    const error = new NappupError(
      NAPPUP_ERROR_CODES.MANIFEST_UPLOAD_FAILED,
      'Failed to publish the app manifest to Nostr relays',
      { cause: new Error('relay refused the event') }
    )
    assert.equal(normalizeNappupError(error), error)
  })
})
