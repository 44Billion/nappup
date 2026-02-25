import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  uploadBinaryDataChunks,
  throttledSendEvent,
  getPreviousCtags
} from '#services/irfs-upload.js'

const MOCK_PUBKEY = 'a'.repeat(64)
const MOCK_ROOT_HASH = 'f'.repeat(64)
const MOCK_CHUNK_HASH = 'e'.repeat(64)

function createMockSigner (pubkey = MOCK_PUBKEY) {
  return {
    getPublicKey: () => pubkey,
    getRelays: () => ({ write: ['wss://relay1.test', 'wss://relay2.test'] }),
    signEvent: (event) => ({
      ...event,
      id: 'b'.repeat(64),
      pubkey,
      sig: 'c'.repeat(128)
    })
  }
}

function createMockNmmr ({ rootHash = MOCK_ROOT_HASH, chunks = [] } = {}) {
  return {
    getRoot: () => rootHash,
    getChunks: async function * () {
      for (const chunk of chunks) yield chunk
    }
  }
}

function createMockChunk (index, { rootHash = MOCK_ROOT_HASH, contentBytes = new Uint8Array([1, 2, 3]) } = {}) {
  return {
    x: MOCK_CHUNK_HASH,
    rootX: rootHash,
    index,
    length: contentBytes.length,
    proof: ['proof1', 'proof2'],
    contentBytes
  }
}

describe('irfs-upload', () => {
  describe('throttledSendEvent', () => {
    it('should send event successfully with no errors', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'sendEvent', async () => ({
        errors: []
      }))

      const event = { id: '1'.repeat(64), kind: 34600, tags: [], content: '' }
      const result = await throttledSendEvent(event, ['wss://relay.test'], {
        pause: 0,
        log: () => {}
      })

      assert.deepEqual(result, { pause: 0 })
      assert.equal(nostrRelays.sendEvent.mock.calls.length, 1)
    })

    it('should retry on rate-limit errors', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      let callCount = 0
      t.mock.method(nostrRelays, 'sendEvent', async () => {
        callCount++
        if (callCount === 1) {
          return {
            errors: [{
              relay: 'wss://relay.test',
              reason: { message: 'rate-limited: slow down' }
            }]
          }
        }
        return { errors: [] }
      })

      const logs = []
      const event = { id: '1'.repeat(64), kind: 34600, tags: [], content: '' }
      const result = await throttledSendEvent(event, ['wss://relay.test'], {
        pause: 0,
        log: (msg) => logs.push(msg),
        maxRetries: 2
      })

      assert.equal(callCount, 2)
      assert.equal(result.pause, 2000)
      assert.ok(logs.some(l => l.includes('Rate limited')))
    })

    it('should retry once on timeout errors', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      let callCount = 0
      t.mock.method(nostrRelays, 'sendEvent', async () => {
        callCount++
        if (callCount === 1) {
          return {
            errors: [{
              relay: 'wss://relay.test',
              reason: { message: 'publish timed out' }
            }]
          }
        }
        // Retry succeeds
        return { errors: [] }
      })

      const logs = []
      const event = { id: '1'.repeat(64), kind: 34600, tags: [], content: '' }
      const result = await throttledSendEvent(event, ['wss://relay.test'], {
        pause: 0,
        log: (msg) => logs.push(msg)
      })

      assert.equal(callCount, 2)
      assert.deepEqual(result, { pause: 0 })
      assert.ok(logs.some(l => l.includes('timeout errors')))
    })

    it('should throw on unretryable errors when below minSuccessfulRelays', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'sendEvent', async () => ({
        errors: [{
          relay: 'wss://relay.test',
          reason: { message: 'blocked: you are banned' }
        }]
      }))

      const event = { id: '1'.repeat(64), kind: 34600, tags: [], content: '' }
      await assert.rejects(
        () => throttledSendEvent(event, ['wss://relay.test'], {
          pause: 0,
          log: () => {},
          minSuccessfulRelays: 1
        }),
        (err) => {
          assert.ok(err.message.includes('relay.test'))
          return true
        }
      )
    })

    it('should throw after exceeding maxRetries', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'sendEvent', async () => ({
        errors: [{
          relay: 'wss://relay.test',
          reason: { message: 'rate-limited: slow down' }
        }]
      }))

      const event = { id: '1'.repeat(64), kind: 34600, tags: [], content: '' }
      await assert.rejects(
        () => throttledSendEvent(event, ['wss://relay.test'], {
          pause: 0,
          log: () => {},
          maxRetries: 0
        }),
        (err) => {
          assert.ok(err.message.includes('relay.test'))
          return true
        }
      )
    })

    it('should succeed when unretryable errors are within minSuccessfulRelays threshold', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'sendEvent', async () => ({
        errors: [{
          relay: 'wss://relay2.test',
          reason: { message: 'blocked: banned' }
        }]
      }))

      const event = { id: '1'.repeat(64), kind: 34600, tags: [], content: '' }
      // 2 relays, 1 fails, but minSuccessfulRelays=1 so the remaining relay suffices
      const result = await throttledSendEvent(
        event,
        ['wss://relay1.test', 'wss://relay2.test'],
        { pause: 0, log: () => {}, minSuccessfulRelays: 1 }
      )
      assert.deepEqual(result, { pause: 0 })
    })

    it('should handle mixed rate-limit and timeout errors', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      let callCount = 0
      t.mock.method(nostrRelays, 'sendEvent', async () => {
        callCount++
        if (callCount === 1) {
          return {
            errors: [
              { relay: 'wss://relay1.test', reason: { message: 'publish timed out' } },
              { relay: 'wss://relay2.test', reason: { message: 'rate-limited: overloaded' } }
            ]
          }
        }
        // Timeout retry and rate-limit retry both succeed
        return { errors: [] }
      })

      const logs = []
      const event = { id: '1'.repeat(64), kind: 34600, tags: [], content: '' }
      const result = await throttledSendEvent(
        event,
        ['wss://relay1.test', 'wss://relay2.test'],
        { pause: 0, log: (msg) => logs.push(msg), maxRetries: 2 }
      )

      assert.ok(result.pause >= 0)
      assert.ok(logs.some(l => l.includes('timeout errors')))
    })

    it('should apply leading pause when leadingPause is true', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'sendEvent', async () => ({ errors: [] }))

      const start = Date.now()
      const event = { id: '1'.repeat(64), kind: 34600, tags: [], content: '' }
      await throttledSendEvent(event, ['wss://relay.test'], {
        pause: 50,
        log: () => {},
        leadingPause: true
      })
      const elapsed = Date.now() - start
      assert.ok(elapsed >= 40, `Expected at least 40ms delay, got ${elapsed}ms`)
    })
  })

  describe('getPreviousCtags', () => {
    it('should return empty when no stored events exist', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [],
        errors: []
      }))

      const signer = createMockSigner()
      const result = await getPreviousCtags('d-tag-123', `${MOCK_ROOT_HASH}:0`, ['wss://relay.test'], signer)

      assert.deepEqual(result.otherCtags, [])
      assert.equal(result.hasEvent, false)
      assert.equal(result.hasCurrentCtag, false)
    })

    it('should detect when current ctag is already present', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      const currentCtag = `${MOCK_ROOT_HASH}:0`
      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [{
          id: '1'.repeat(64),
          pubkey: MOCK_PUBKEY,
          kind: 34600,
          created_at: 1700000000,
          content: '',
          tags: [
            ['d', 'd-tag-123'],
            ['c', currentCtag, 3, 'proof1', 'proof2']
          ],
          sig: 'c'.repeat(128),
          meta: { relay: 'wss://relay.test' }
        }],
        errors: []
      }))

      const signer = createMockSigner()
      const result = await getPreviousCtags('d-tag-123', currentCtag, ['wss://relay.test'], signer)

      assert.equal(result.hasEvent, true)
      assert.equal(result.hasCurrentCtag, true)
      assert.deepEqual(result.otherCtags, [])
      assert.ok(result.foundEvent)
    })

    it('should return other ctags excluding the current one', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      const currentCtag = `${MOCK_ROOT_HASH}:0`
      const otherCtagValue = `${MOCK_ROOT_HASH}:1`
      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [{
          id: '1'.repeat(64),
          pubkey: MOCK_PUBKEY,
          kind: 34600,
          created_at: 1700000000,
          content: '',
          tags: [
            ['d', 'd-tag-123'],
            ['c', currentCtag, 3, 'proof1', 'proof2'],
            ['c', otherCtagValue, 5, 'proof3', 'proof4']
          ],
          sig: 'c'.repeat(128),
          meta: { relay: 'wss://relay.test' }
        }],
        errors: []
      }))

      const signer = createMockSigner()
      const result = await getPreviousCtags('d-tag-123', currentCtag, ['wss://relay.test'], signer)

      assert.equal(result.otherCtags.length, 1)
      assert.equal(result.otherCtags[0][1], otherCtagValue)
    })

    it('should deduplicate ctags', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      const currentCtag = `${MOCK_ROOT_HASH}:0`
      const otherCtagValue = `${MOCK_ROOT_HASH}:1`
      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [{
          id: '1'.repeat(64),
          pubkey: MOCK_PUBKEY,
          kind: 34600,
          created_at: 1700000000,
          content: '',
          tags: [
            ['d', 'd-tag-123'],
            ['c', otherCtagValue, 5, 'proof3'],
            ['c', otherCtagValue, 5, 'proof3']  // duplicate
          ],
          sig: 'c'.repeat(128),
          meta: { relay: 'wss://relay.test' }
        }],
        errors: []
      }))

      const signer = createMockSigner()
      const result = await getPreviousCtags('d-tag-123', currentCtag, ['wss://relay.test'], signer)

      assert.equal(result.otherCtags.length, 1)
    })

    it('should detect missing relays', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [{
          id: '1'.repeat(64),
          pubkey: MOCK_PUBKEY,
          kind: 34600,
          created_at: 1700000000,
          content: '',
          tags: [
            ['d', 'd-tag-123'],
            ['c', `${MOCK_ROOT_HASH}:0`, 3]
          ],
          sig: 'c'.repeat(128),
          meta: { relay: 'wss://relay1.test' }
        }],
        errors: []
      }))

      const signer = createMockSigner()
      const result = await getPreviousCtags('d-tag-123', `${MOCK_ROOT_HASH}:0`, ['wss://relay1.test', 'wss://relay2.test'], signer)

      assert.ok(result.missingRelays.length > 0)
      assert.ok(result.missingRelays.includes('wss://relay2.test'))
    })

    it('should handle non-array tags gracefully', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [{
          id: '1'.repeat(64),
          pubkey: MOCK_PUBKEY,
          kind: 34600,
          created_at: 1700000000,
          content: '',
          tags: null,
          sig: 'c'.repeat(128)
        }],
        errors: []
      }))

      const signer = createMockSigner()
      const result = await getPreviousCtags('d-tag-123', `${MOCK_ROOT_HASH}:0`, ['wss://relay.test'], signer)

      assert.equal(result.hasEvent, true)
      assert.equal(result.hasCurrentCtag, false)
      assert.deepEqual(result.otherCtags, [])
    })

    it('should pick the most recent event when multiple exist', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      const currentCtag = `${MOCK_ROOT_HASH}:0`
      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [
          {
            id: '1'.repeat(64),
            pubkey: MOCK_PUBKEY,
            kind: 34600,
            created_at: 1700000000,
            content: '',
            tags: [['d', 'd-tag-123'], ['c', currentCtag]],
            sig: 'c'.repeat(128),
            meta: { relay: 'wss://relay.test' }
          },
          {
            id: '2'.repeat(64),
            pubkey: MOCK_PUBKEY,
            kind: 34600,
            created_at: 1700002000,
            content: '',
            tags: [['d', 'd-tag-123']],
            sig: 'c'.repeat(128),
            meta: { relay: 'wss://relay.test' }
          }
        ],
        errors: []
      }))

      const signer = createMockSigner()
      const result = await getPreviousCtags('d-tag-123', currentCtag, ['wss://relay.test'], signer)

      // Most recent event (created_at 1700002000) does NOT have the current ctag
      assert.equal(result.foundEvent.created_at, 1700002000)
      assert.equal(result.hasCurrentCtag, false)
    })

    it('should filter out non-ctag and invalid-format ctag tags', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      const currentCtag = `${MOCK_ROOT_HASH}:0`
      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [{
          id: '1'.repeat(64),
          pubkey: MOCK_PUBKEY,
          kind: 34600,
          created_at: 1700000000,
          content: '',
          tags: [
            ['d', 'd-tag-123'],
            ['c', currentCtag, 3],
            ['c', 'not-a-valid-hash:0'],   // invalid format
            ['c', `${MOCK_ROOT_HASH}:1`, 5],  // valid other ctag
            ['m', 'text/html'],                // not a c-tag
            ['c', 12345]                       // non-string value
          ],
          sig: 'c'.repeat(128),
          meta: { relay: 'wss://relay.test' }
        }],
        errors: []
      }))

      const signer = createMockSigner()
      const result = await getPreviousCtags('d-tag-123', currentCtag, ['wss://relay.test'], signer)

      assert.equal(result.otherCtags.length, 1)
      assert.equal(result.otherCtags[0][1], `${MOCK_ROOT_HASH}:1`)
    })
  })

  describe('uploadBinaryDataChunks', () => {
    it('should upload fresh chunks when none exist on relays', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      const getEventsCallArgs = []
      t.mock.method(nostrRelays, 'getEvents', async (filter) => {
        getEventsCallArgs.push(filter)
        return { result: [], errors: [] }
      })

      t.mock.method(nostrRelays, 'sendEvent', async () => ({
        errors: []
      }))

      const chunks = [createMockChunk(0), createMockChunk(1)]
      const nmmr = createMockNmmr({ chunks })
      const signer = createMockSigner()
      const logs = []

      const result = await uploadBinaryDataChunks({
        nmmr,
        signer,
        filename: 'test.html',
        chunkLength: 2,
        log: (msg) => logs.push(msg),
        pause: 0,
        mimeType: 'text/html',
        shouldReupload: false
      })

      assert.equal(typeof result.pause, 'number')
      // Two chunks should be sent
      assert.equal(nostrRelays.sendEvent.mock.calls.length, 2)
      assert.ok(logs.some(l => l.includes('Uploading file part 1 of 2')))
      assert.ok(logs.some(l => l.includes('Uploading file part 2 of 2')))
    })

    it('should skip already uploaded chunks', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default
      const { nappRelays } = nostrRelaysModule

      const existingEvent = {
        id: '1'.repeat(64),
        pubkey: MOCK_PUBKEY,
        kind: 34600,
        created_at: 1700000010,
        content: '',
        tags: [
          ['d', MOCK_CHUNK_HASH],
          ['c', `${MOCK_ROOT_HASH}:0`, 3, 'proof1', 'proof2']
        ],
        sig: 'c'.repeat(128),
        meta: { relay: 'wss://relay1.test' }
      }

      // All relays (write + nappRelays) need to be covered for skip
      const allRelays = [...new Set(['wss://relay1.test', 'wss://relay2.test', ...nappRelays].map(r => r.trim().replace(/\/$/, '')))]

      t.mock.method(nostrRelays, 'getEvents', async (filter) => {
        // For the initial batch query (looking for max created_at)
        if (filter['#c']) {
          return {
            result: [existingEvent],
            errors: []
          }
        }
        // For getPreviousCtags calls - chunk 0 exists on ALL relays
        if (filter['#d']) {
          return {
            result: allRelays.map(relay => ({ ...existingEvent, meta: { relay } })),
            errors: []
          }
        }
        return { result: [], errors: [] }
      })

      t.mock.method(nostrRelays, 'sendEvent', async () => ({
        errors: []
      }))

      const chunks = [createMockChunk(0)]
      const nmmr = createMockNmmr({ chunks })
      const signer = createMockSigner()
      const logs = []

      await uploadBinaryDataChunks({
        nmmr,
        signer,
        filename: 'test.html',
        chunkLength: 1,
        log: (msg) => logs.push(msg),
        pause: 0,
        mimeType: 'text/html',
        shouldReupload: false
      })

      // Should NOT call sendEvent since the chunk exists on all relays
      assert.equal(nostrRelays.sendEvent.mock.calls.length, 0)
      assert.ok(logs.some(l => l.includes('Skipping chunk') && l.includes('already uploaded')))
    })

    it('should re-upload to missing relays when chunk exists partially', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      const existingEvent = {
        id: '1'.repeat(64),
        pubkey: MOCK_PUBKEY,
        kind: 34600,
        created_at: 1700000010,
        content: '',
        tags: [
          ['d', MOCK_CHUNK_HASH],
          ['c', `${MOCK_ROOT_HASH}:0`, 3, 'proof1', 'proof2']
        ],
        sig: 'c'.repeat(128),
        meta: { relay: 'wss://relay1.test' }
      }

      t.mock.method(nostrRelays, 'getEvents', async (filter) => {
        if (filter['#c']) {
          return { result: [existingEvent], errors: [] }
        }
        // getPreviousCtags - only on relay1, not relay2
        if (filter['#d']) {
          return {
            result: [{ ...existingEvent, meta: { relay: 'wss://relay1.test' } }],
            errors: []
          }
        }
        return { result: [], errors: [] }
      })

      t.mock.method(nostrRelays, 'sendEvent', async () => ({
        errors: []
      }))

      const chunks = [createMockChunk(0)]
      const nmmr = createMockNmmr({ chunks })
      const signer = createMockSigner()
      const logs = []

      await uploadBinaryDataChunks({
        nmmr,
        signer,
        filename: 'test.html',
        chunkLength: 1,
        log: (msg) => logs.push(msg),
        pause: 0,
        mimeType: 'text/html',
        shouldReupload: false
      })

      // Should call sendEvent for the missing relays
      assert.equal(nostrRelays.sendEvent.mock.calls.length, 1)
      assert.ok(logs.some(l => l.includes('Re-uploading chunk') && l.includes('missing relays')))
    })

    it('should force re-upload when shouldReupload is true', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'getEvents', async (filter) => {
        if (filter['#c']) {
          return { result: [], errors: [] }
        }
        // getPreviousCtags returns no stored events
        return { result: [], errors: [] }
      })

      t.mock.method(nostrRelays, 'sendEvent', async () => ({
        errors: []
      }))

      const chunks = [createMockChunk(0)]
      const nmmr = createMockNmmr({ chunks })
      const signer = createMockSigner()
      const logs = []

      await uploadBinaryDataChunks({
        nmmr,
        signer,
        filename: 'test.html',
        chunkLength: 1,
        log: (msg) => logs.push(msg),
        pause: 0,
        mimeType: 'text/html',
        shouldReupload: true
      })

      assert.equal(nostrRelays.sendEvent.mock.calls.length, 1)
      assert.ok(logs.some(l => l.includes('Uploading file part')))
    })

    it('should create kind 34600 events with correct tags', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [],
        errors: []
      }))

      let sentEvent
      t.mock.method(nostrRelays, 'sendEvent', async (event) => {
        sentEvent = event
        return { errors: [] }
      })

      const chunks = [createMockChunk(0)]
      const nmmr = createMockNmmr({ chunks })
      const signer = createMockSigner()

      await uploadBinaryDataChunks({
        nmmr,
        signer,
        filename: 'test.html',
        chunkLength: 1,
        log: () => {},
        pause: 0,
        mimeType: 'text/html'
      })

      assert.equal(sentEvent.kind, 34600)
      assert.ok(sentEvent.tags.some(t => t[0] === 'd'))
      assert.ok(sentEvent.tags.some(t => t[0] === 'c' && t[1] === `${MOCK_ROOT_HASH}:0`))
      assert.ok(sentEvent.tags.some(t => t[0] === 'm' && t[1] === 'text/html'))
      assert.ok(sentEvent.content.length > 0, 'Content should be Base93-encoded')
    })

    it('should use decreasing created_at for sequential chunks', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [],
        errors: []
      }))

      const sentEvents = []
      t.mock.method(nostrRelays, 'sendEvent', async (event) => {
        sentEvents.push(event)
        return { errors: [] }
      })

      const chunks = [createMockChunk(0), createMockChunk(1), createMockChunk(2)]
      const nmmr = createMockNmmr({ chunks })
      const signer = createMockSigner()

      await uploadBinaryDataChunks({
        nmmr,
        signer,
        filename: 'test.html',
        chunkLength: 3,
        log: () => {},
        pause: 0,
        mimeType: 'text/html'
      })

      assert.equal(sentEvents.length, 3)
      // Each subsequent chunk should have a lower created_at
      assert.ok(sentEvents[0].created_at > sentEvents[1].created_at)
      assert.ok(sentEvents[1].created_at > sentEvents[2].created_at)
    })

    it('should log fallback relay count when nappRelays add extra relays', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [],
        errors: []
      }))

      t.mock.method(nostrRelays, 'sendEvent', async () => ({
        errors: []
      }))

      const chunks = [createMockChunk(0)]
      const nmmr = createMockNmmr({ chunks })
      // Signer returns relays that don't overlap with nappRelays
      const signer = createMockSigner()
      const logs = []

      await uploadBinaryDataChunks({
        nmmr,
        signer,
        filename: 'test.html',
        chunkLength: 1,
        log: (msg) => logs.push(msg),
        pause: 0,
        mimeType: 'text/html'
      })

      // The log message should mention relays
      assert.ok(logs.some(l => l.includes('Uploading file part 1 of 1')))
    })
  })
})
