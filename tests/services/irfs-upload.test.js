import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import NMMR from 'nmmr'
import { encode as base93Encode } from 'libp2r2p/base93'
import {
  getPreviousChunks,
  parseChunkEvent,
  throttledSendEvent,
  uploadBinaryDataChunks
} from '#services/irfs-upload.js'

const PUBKEY = 'a'.repeat(64)

function signer () {
  return {
    getPublicKey: async () => PUBKEY,
    getRelays: async () => ({ write: ['wss://relay1.test', 'wss://relay2.test'] }),
    signEvent: async event => ({
      ...event,
      id: 'b'.repeat(64),
      pubkey: PUBKEY,
      sig: 'c'.repeat(128)
    })
  }
}

async function makeMmr (...chunks) {
  const mmr = new NMMR()
  for (const chunk of chunks) await mmr.append(chunk)
  return mmr
}

describe('IRFS chunk v2', () => {
  it('publishes valid kind 34601 events', async (t) => {
    const nostrRelays = (await import('#services/nostr-relays.js')).default
    t.mock.method(nostrRelays, 'getEvents', async () => ({ result: [], errors: [] }))
    const sent = []
    t.mock.method(nostrRelays, 'sendEvent', async event => {
      sent.push(event)
      return { errors: [] }
    })

    const first = new Uint8Array(51000).fill(7)
    const second = Uint8Array.of(1, 2, 3)
    const mmr = await makeMmr(first, second)
    await uploadBinaryDataChunks({
      nmmr: mmr,
      signer: signer(),
      filename: 'file.bin',
      chunkLength: 2,
      log: () => {},
      pause: 0
    })

    assert.equal(sent.length, 2)
    assert.ok(sent.every(event => event.kind === 34601))
    assert.deepEqual(sent.map(event => parseChunkEvent(event).index), [0, 1])
    assert.ok(sent.every(event => parseChunkEvent(event).root === mmr.getRoot()))
    assert.deepEqual(sent[0].tags.map(tag => tag[0]), ['d', 'mmr'])
  })

  it('uses an empty proof for a single chunk', async () => {
    const bytes = Uint8Array.of(1)
    const mmr = await makeMmr(bytes)
    const [chunk] = await Array.fromAsync(mmr.getChunks())
    const event = {
      kind: 34601,
      tags: [
        ['d', NMMR.deriveChunkId(mmr.getRoot(), chunk.index)],
        ['mmr', '0', '1', '']
      ],
      content: base93Encode(bytes)
    }
    assert.equal(parseChunkEvent(event).root, mmr.getRoot())
  })

  it('rejects mutations and non-final short chunks', async () => {
    const bytes = Uint8Array.of(1, 2, 3)
    const mmr = await makeMmr(bytes)
    const [chunk] = await Array.fromAsync(mmr.getChunks())
    const event = {
      kind: 34601,
      tags: [
        ['d', NMMR.deriveChunkId(mmr.getRoot(), chunk.index)],
        ['mmr', '0', '1', base93Encode(chunk.proof)]
      ],
      content: base93Encode(bytes)
    }
    const wrongD = structuredClone(event)
    wrongD.tags[0][1] = '0'.repeat(64)
    assert.throws(() => parseChunkEvent(wrongD), /mismatch/)

    const shortNonFinal = structuredClone(event)
    shortNonFinal.tags[1][1] = '0'
    shortNonFinal.tags[1][2] = '2'
    assert.throws(() => parseChunkEvent(shortNonFinal), /proof|length/)
  })

  it('queries deterministic d tags in bounded batches', async (t) => {
    const nostrRelays = (await import('#services/nostr-relays.js')).default
    t.mock.method(nostrRelays, 'getEvents', async () => ({ result: [], errors: [] }))
    const ids = Array.from({ length: 205 }, (_, index) => index.toString(16).padStart(64, '0'))
    const result = await getPreviousChunks(ids, ['wss://relay1.test'], signer())
    assert.equal(nostrRelays.getEvents.mock.calls.length, 3)
    assert.deepEqual(nostrRelays.getEvents.mock.calls.map(call => call.arguments[0]['#d'].length), [100, 100, 5])
    assert.equal(result.eventsByD.size, 205)
  })
})

describe('throttledSendEvent', () => {
  it('returns immediately when every relay accepts the event', async (t) => {
    const nostrRelays = (await import('#services/nostr-relays.js')).default
    t.mock.method(nostrRelays, 'sendEvent', async () => ({ errors: [] }))
    assert.deepEqual(await throttledSendEvent({}, ['wss://relay.test'], {
      pause: 0,
      log: () => {}
    }), { pause: 0 })
  })

  it('backs off and retries only rate-limited relays', async (t) => {
    const nostrRelays = (await import('#services/nostr-relays.js')).default
    let calls = 0
    t.mock.method(nostrRelays, 'sendEvent', async () => ++calls === 1
      ? { errors: [{ relay: 'wss://relay.test', reason: { message: 'rate-limited: slow down' } }] }
      : { errors: [] })
    const original = globalThis.setTimeout
    globalThis.setTimeout = (callback, _delay, ...args) => original(callback, 0, ...args)
    t.after(() => { globalThis.setTimeout = original })

    const result = await throttledSendEvent({}, ['wss://relay.test'], {
      pause: 0,
      log: () => {},
      maxRetries: 2
    })
    assert.equal(calls, 2)
    assert.equal(result.pause, 2000)
  })
})
