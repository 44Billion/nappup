import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

const FAKE_PUBKEY = 'b0b810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5'
const FAKE_CLIENT_SK = new Uint8Array(32).fill(7)

function makeMockBunker () {
  return {
    connect: mock.fn(async () => {}),
    getPublicKey: mock.fn(async () => FAKE_PUBKEY),
    signEvent: mock.fn(async (e) => ({ ...e, id: 'signed-id', sig: 'signed-sig', pubkey: FAKE_PUBKEY })),
    nip44Encrypt: mock.fn(async (_pk, text) => `enc:${text}`),
    nip44Decrypt: mock.fn(async (_pk, ct) => `dec:${ct}`),
    close: mock.fn(async () => {})
  }
}

describe('NostrBunkerSigner', () => {
  describe('constructor guard', () => {
    it('should reject direct construction without create()', async () => {
      const { default: NostrBunkerSigner } = await import('#services/bunker-signer.js')
      assert.throws(
        () => new NostrBunkerSigner(),
        { message: 'Use NostrBunkerSigner.create(bunkerUrl) to instantiate this class.' }
      )
    })
  })

  describe('create() error paths (real nostr-tools)', () => {
    it('should reject invalid bunker URLs', async () => {
      const { default: NostrBunkerSigner } = await import('#services/bunker-signer.js')
      await assert.rejects(
        () => NostrBunkerSigner.create('not-a-bunker-url'),
        { message: 'Invalid bunker URL' }
      )
    })

    it('should reject bunker URLs with no relays', async () => {
      const { default: NostrBunkerSigner } = await import('#services/bunker-signer.js')
      await assert.rejects(
        () => NostrBunkerSigner.create('bunker://a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5'),
        { message: 'Bunker URL must include at least one relay (?relay=wss://...)' }
      )
    })
  })

  describe('delegation to nostr-tools (mocked)', () => {
    let mockBunker
    let parsedBp
    let fromBunkerMock
    let parseBunkerInputMock
    let generateSecretKeyMock
    let nip46Ctx
    let pureCtx
    // Cache-bust dynamic imports so each test re-evaluates bunker-signer.js
    // against the fresh mock.module() bindings set up in beforeEach.
    let importSeq = 0

    beforeEach(() => {
      parsedBp = { pubkey: FAKE_PUBKEY, relays: ['wss://relay.example.com'], secret: 'tok' }
      mockBunker = makeMockBunker()
      fromBunkerMock = mock.fn(() => mockBunker)
      parseBunkerInputMock = mock.fn(async () => parsedBp)
      generateSecretKeyMock = mock.fn(() => FAKE_CLIENT_SK)

      nip46Ctx = mock.module('nostr-tools/nip46', {
        namedExports: {
          parseBunkerInput: parseBunkerInputMock,
          BunkerSigner: { fromBunker: fromBunkerMock }
        }
      })
      pureCtx = mock.module('nostr-tools/pure', {
        namedExports: { generateSecretKey: generateSecretKeyMock }
      })
    })

    afterEach(() => {
      nip46Ctx.restore()
      pureCtx.restore()
    })

    const loadSigner = () => import(`#services/bunker-signer.js?v=${++importSeq}`).then(m => m.default)

    it('should call parseBunkerInput with the raw bunker URL', async () => {
      const NostrBunkerSigner = await loadSigner()
      await NostrBunkerSigner.create('bunker://anything')
      assert.equal(parseBunkerInputMock.mock.calls.length, 1)
      assert.deepEqual(parseBunkerInputMock.mock.calls[0].arguments, ['bunker://anything'])
    })

    it('should call BunkerSigner.fromBunker with the generated client key and parsed pointer', async () => {
      const NostrBunkerSigner = await loadSigner()
      await NostrBunkerSigner.create('bunker://x')
      assert.equal(fromBunkerMock.mock.calls.length, 1)
      assert.equal(fromBunkerMock.mock.calls[0].arguments[0], FAKE_CLIENT_SK)
      assert.deepEqual(fromBunkerMock.mock.calls[0].arguments[1], parsedBp)
    })

    it('should call connect() and getPublicKey() on the bunker', async () => {
      const NostrBunkerSigner = await loadSigner()
      const signer = await NostrBunkerSigner.create('bunker://x')
      assert.equal(mockBunker.connect.mock.calls.length, 1)
      assert.equal(mockBunker.getPublicKey.mock.calls.length, 1)
      assert.equal(signer.getPublicKey(), FAKE_PUBKEY)
    })

    it('should reject if connect() hangs longer than connectTimeout', async () => {
      mockBunker.connect = mock.fn(() => new Promise(() => {})) // never resolves
      const NostrBunkerSigner = await loadSigner()
      await assert.rejects(
        () => NostrBunkerSigner.create('bunker://x', { connectTimeout: 20 }),
        { message: 'Bunker connection timed out' }
      )
    })

    it('should delegate signEvent to the underlying bunker', async () => {
      const NostrBunkerSigner = await loadSigner()
      const signer = await NostrBunkerSigner.create('bunker://x')
      const event = { kind: 1, content: 'hi', tags: [], created_at: 123 }
      const signed = await signer.signEvent(event)
      assert.equal(mockBunker.signEvent.mock.calls.length, 1)
      assert.deepEqual(mockBunker.signEvent.mock.calls[0].arguments, [event])
      assert.equal(signed.id, 'signed-id')
    })

    it('should delegate nip44.encrypt/decrypt to the underlying bunker', async () => {
      const NostrBunkerSigner = await loadSigner()
      const signer = await NostrBunkerSigner.create('bunker://x')
      assert.equal(await signer.nip44.encrypt('peer', 'hello'), 'enc:hello')
      assert.equal(await signer.nip44.decrypt('peer', 'cipher'), 'dec:cipher')
      assert.deepEqual(mockBunker.nip44Encrypt.mock.calls[0].arguments, ['peer', 'hello'])
      assert.deepEqual(mockBunker.nip44Decrypt.mock.calls[0].arguments, ['peer', 'cipher'])
    })

    it('should delegate close() to the underlying bunker', async () => {
      const NostrBunkerSigner = await loadSigner()
      const signer = await NostrBunkerSigner.create('bunker://x')
      await signer.close()
      assert.equal(mockBunker.close.mock.calls.length, 1)
    })

    it('should return cached pubkey synchronously after create()', async () => {
      const NostrBunkerSigner = await loadSigner()
      const signer = await NostrBunkerSigner.create('bunker://x')
      assert.equal(signer.getPublicKey(), FAKE_PUBKEY)
      assert.equal(signer.getPublicKey(), FAKE_PUBKEY)
      // bunker.getPublicKey() should only be called once (during create())
      assert.equal(mockBunker.getPublicKey.mock.calls.length, 1)
    })
  })

  describe('nostr-tools API shape (real)', () => {
    it('BunkerSigner should still expose fromBunker static method', async () => {
      const { BunkerSigner } = await import('nostr-tools/nip46')
      assert.equal(typeof BunkerSigner.fromBunker, 'function')
    })

    it('BunkerSigner instances should still expose expected methods', async () => {
      const { BunkerSigner } = await import('nostr-tools/nip46')
      const proto = BunkerSigner.prototype
      assert.equal(typeof proto.connect, 'function')
      assert.equal(typeof proto.getPublicKey, 'function')
      assert.equal(typeof proto.signEvent, 'function')
      assert.equal(typeof proto.nip44Encrypt, 'function')
      assert.equal(typeof proto.nip44Decrypt, 'function')
      assert.equal(typeof proto.close, 'function')
    })

    it('parseBunkerInput should still parse a well-formed bunker URL', async () => {
      const { parseBunkerInput } = await import('nostr-tools/nip46')
      const bp = await parseBunkerInput('bunker://a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5?relay=wss://relay.example.com&secret=tok')
      assert.ok(bp)
      assert.equal(bp.pubkey, 'a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5')
      assert.deepEqual(bp.relays, ['wss://relay.example.com'])
      assert.equal(bp.secret, 'tok')
    })
  })
})
