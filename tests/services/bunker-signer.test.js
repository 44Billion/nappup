import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { base16ToBytes } from 'libp2r2p/base16'
import { BunkerSigner } from 'libp2r2p/nip46'
import NostrBunkerSigner from '#services/bunker-signer.js'

const REMOTE_PUBKEY = 'a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5'
const USER_PUBKEY = 'b0b810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5'
const CLIENT_KEY = '0000000000000000000000000000000000000000000000000000000000000007'
const BUNKER_URL = `bunker://${REMOTE_PUBKEY}?relay=wss://relay.example.com&secret=tok`

function temporaryDotenv () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nappup-bunker-'))
  return {
    filePath: path.join(directory, '.env'),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
  }
}

function makeMockBunker (pointer, overrides = {}) {
  return {
    pointer,
    connect: mock.fn(async () => {}),
    getPublicKey: mock.fn(async () => USER_PUBKEY),
    signEvent: mock.fn(async event => ({ ...event, id: 'signed-id' })),
    nip44Encrypt: mock.fn(async (_pubkey, plaintext) => `enc:${plaintext}`),
    nip44Decrypt: mock.fn(async (_pubkey, ciphertext) => `dec:${ciphertext}`),
    close: mock.fn(async () => {}),
    ...overrides
  }
}

function createOptions (filePath, bunkerFactory, extra = {}) {
  return {
    dotenvFilePath: filePath,
    bunkerFactory,
    generateClientKey: () => base16ToBytes(CLIENT_KEY),
    connectTimeout: 50,
    requestTimeout: 50,
    ...extra
  }
}

describe('NostrBunkerSigner', () => {
  it('rejects direct construction and malformed URLs', async () => {
    assert.throws(
      () => new NostrBunkerSigner(),
      { message: 'Use NostrBunkerSigner.create(bunkerUrl) to instantiate this class.' }
    )
    await assert.rejects(
      () => NostrBunkerSigner.create('not-a-bunker-url'),
      { message: 'Invalid bunker URL' }
    )
    await assert.rejects(
      () => NostrBunkerSigner.create(`bunker://${REMOTE_PUBKEY}`),
      { message: 'Bunker URL must include at least one relay (?relay=wss://...)' }
    )
  })

  it('persists a new client key before connecting and uses the secret immediately', async t => {
    const temporary = temporaryDotenv()
    t.after(temporary.cleanup)
    let persistedBeforeConnect = false
    const factory = mock.fn((clientKey, pointer) => makeMockBunker(pointer, {
      connect: mock.fn(async () => {
        persistedBeforeConnect = fs.readFileSync(temporary.filePath, 'utf8').includes('LAST_CLI_BUNKER_SESSION=')
      })
    }))

    const signer = await NostrBunkerSigner.create(
      BUNKER_URL,
      createOptions(temporary.filePath, factory)
    )

    assert.equal(persistedBeforeConnect, true)
    assert.deepEqual(factory.mock.calls[0].arguments[0], base16ToBytes(CLIENT_KEY))
    assert.equal(factory.mock.calls[0].arguments[1].secret, 'tok')
    assert.equal(signer.getPublicKey(), USER_PUBKEY)
    await signer.close()
  })

  it('does not create a bunker when persistence fails', async t => {
    const temporary = temporaryDotenv()
    t.after(temporary.cleanup)
    const factory = mock.fn(() => makeMockBunker({}))

    await assert.rejects(() => NostrBunkerSigner.create(BUNKER_URL, createOptions(
      path.join(path.dirname(temporary.filePath), 'missing', '.env'),
      factory
    )), { code: 'ENOENT' })

    assert.equal(factory.mock.calls.length, 0)
  })

  it('allows a first connection without a secret', async t => {
    const temporary = temporaryDotenv()
    t.after(temporary.cleanup)
    const factory = mock.fn((_clientKey, pointer) => makeMockBunker(pointer))
    const url = `bunker://${REMOTE_PUBKEY}?relay=wss://relay.example.com`

    await NostrBunkerSigner.create(url, createOptions(temporary.filePath, factory))

    assert.equal(factory.mock.calls.length, 1)
    assert.equal(factory.mock.calls[0].arguments[1].secret, null)
    assert.match(fs.readFileSync(temporary.filePath, 'utf8'), /LAST_CLI_BUNKER_SESSION=/)
  })

  it('tries a reused key without a secret before falling back with the same key', async t => {
    const temporary = temporaryDotenv()
    t.after(temporary.cleanup)
    const initialFactory = mock.fn((_clientKey, pointer) => makeMockBunker(pointer))
    await NostrBunkerSigner.create(BUNKER_URL, createOptions(temporary.filePath, initialFactory))

    const failed = makeMockBunker({}, {
      connect: mock.fn(async () => { throw new Error('not authorized') })
    })
    const recovered = makeMockBunker({
      remoteSignerPubkey: REMOTE_PUBKEY,
      relays: ['wss://preferred.example.com'],
      secret: 'tok'
    })
    const factory = mock.fn((_clientKey, pointer) => pointer.secret === null ? failed : recovered)

    await NostrBunkerSigner.create(BUNKER_URL, createOptions(temporary.filePath, factory, {
      generateClientKey: () => { throw new Error('should reuse the persisted key') }
    }))

    assert.equal(factory.mock.calls.length, 2)
    assert.equal(factory.mock.calls[0].arguments[1].secret, null)
    assert.equal(factory.mock.calls[1].arguments[1].secret, 'tok')
    assert.deepEqual(factory.mock.calls[0].arguments[0], factory.mock.calls[1].arguments[0])
    assert.equal(failed.close.mock.calls.length, 1)
  })

  it('accepts an already-connected response when the session still answers', async t => {
    const temporary = temporaryDotenv()
    t.after(temporary.cleanup)
    const bunker = makeMockBunker({
      remoteSignerPubkey: REMOTE_PUBKEY,
      relays: ['wss://relay.example.com'],
      secret: null
    }, {
      connect: mock.fn(async () => { throw new Error('already connected') })
    })
    const factory = mock.fn(() => bunker)
    const url = `${BUNKER_URL}#client_key=${CLIENT_KEY}`

    await NostrBunkerSigner.create(url, createOptions(temporary.filePath, factory))

    assert.equal(factory.mock.calls.length, 1)
    assert.equal(bunker.getPublicKey.mock.calls.length, 2)
  })

  it('aborts, closes and reports a connection timeout', async t => {
    const temporary = temporaryDotenv()
    t.after(temporary.cleanup)
    let signal
    const bunker = makeMockBunker({}, {
      connect: mock.fn(({ signal: receivedSignal }) => {
        signal = receivedSignal
        return new Promise((resolve, reject) => {
          receivedSignal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
        })
      })
    })
    const factory = mock.fn(() => bunker)

    await assert.rejects(
      () => NostrBunkerSigner.create(BUNKER_URL, createOptions(temporary.filePath, factory, { connectTimeout: 10 })),
      { message: 'Bunker connection timed out' }
    )
    assert.equal(signal.aborted, true)
    assert.equal(bunker.close.mock.calls.length, 1)
  })

  it('preserves the nappup signer interface', async t => {
    const temporary = temporaryDotenv()
    t.after(temporary.cleanup)
    const bunker = makeMockBunker({
      remoteSignerPubkey: REMOTE_PUBKEY,
      relays: ['wss://relay.example.com'],
      secret: 'tok'
    })
    const signer = await NostrBunkerSigner.create(
      BUNKER_URL,
      createOptions(temporary.filePath, () => bunker)
    )
    const event = { kind: 1, content: 'hi', tags: [], created_at: 123 }

    assert.equal((await signer.signEvent(event)).id, 'signed-id')
    assert.equal(await signer.nip44.encrypt('peer', 'hello'), 'enc:hello')
    assert.equal(await signer.nip44.decrypt('peer', 'cipher'), 'dec:cipher')
    await signer.close()

    assert.deepEqual(bunker.signEvent.mock.calls[0].arguments, [event])
    assert.equal(bunker.close.mock.calls.length, 1)
  })

  it('uses the libp2r2p NIP-46 API', () => {
    assert.equal(typeof BunkerSigner.fromBunker, 'function')
    for (const method of ['connect', 'getPublicKey', 'signEvent', 'nip44Encrypt', 'nip44Decrypt', 'close']) {
      assert.equal(typeof BunkerSigner.prototype[method], 'function')
    }
  })
})
