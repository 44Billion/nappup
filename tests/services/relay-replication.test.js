import { isolateTemporaryDirectory } from '../helpers/temporary-directory.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import NMMR from 'nmmr'
import { finalizeEvent } from 'libp2r2p/event'
import { generateSecretKey, getPublicKey } from 'libp2r2p/key'
import { encode as base93Encode } from 'libp2r2p/base93'
import { nappRelays, relayPool } from 'libp2r2p/relay'
import { uploadBinaryDataChunks } from '#services/irfs-upload.js'
import { buildManifestTags, uploadSiteManifest } from '#services/site-manifest.js'

const A = 'wss://a.example'
const B = 'wss://b.example'
const targets = [...new Set([A, B, ...nappRelays])]

// The installed pool and connection are real; no socket can reach the network.
function fixture (t, stored, queryFailures = new Set()) {
  const published = []
  const original = globalThis.WebSocket
  globalThis.WebSocket = class {
    constructor (url) {
      this.url = url.replace(/\/$/, '')
      this.readyState = 0
      queueMicrotask(() => { this.readyState = 1; this.onopen?.() })
    }
    reply (message) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(message) })) }
    send (text) {
      const [type, value, filter] = JSON.parse(text)
      if (type === 'REQ') {
        if (queryFailures.has(this.url)) {
          this.reply(['CLOSED', value, 'error: simulated query failure'])
          return
        }
        const events = (stored.get(this.url) ?? []).filter(event =>
          filter.kinds.includes(event.kind) && filter.authors.includes(event.pubkey) &&
          filter['#d'].includes(event.tags.find(tag => tag[0] === 'd')?.[1])
        )
        for (const event of events) this.reply(['EVENT', value, event])
        this.reply(['EOSE', value])
      } else if (type === 'EVENT') {
        published.push({ relay: this.url, event: value })
        this.reply(['OK', value.id, true, ''])
      }
    }
    close () {
      this.readyState = 3
      queueMicrotask(() => this.onclose?.({ code: 1000, reason: '', wasClean: true }))
    }
  }
  t.after(async () => { await relayPool.disconnectAll(); globalThis.WebSocket = original })
  return published
}

// Signs genuine fixture events so relay validation cannot be bypassed by mocks.
function createSigner () {
  const secretKey = generateSecretKey()
  return {
    getPublicKey: async () => getPublicKey(secretKey),
    getRelays: async () => ({ write: [A, B] }),
    signEvent: async event => finalizeEvent(event, secretKey)
  }
}

// Builds the same version distribution for chunk and manifest replication.
function distribution (scenario, latest, old) {
  const stored = new Map(targets.map(relay => [relay, [latest]]))
  if (scenario === 'missing') stored.set(A, [])
  if (scenario === 'older') stored.set(A, [old])
  return stored
}

for (const scenario of ['complete', 'missing', 'older', 'query-failed']) {
  test(`chunk replication with ${scenario} coverage uses the real pool`, async t => {
    const signer = createSigner()
    const nmmr = new NMMR()
    await nmmr.append(Uint8Array.of(1, 2, 3))
    const [chunk] = await Array.fromAsync(nmmr.getChunks())
    const template = {
      kind: 34601,
      tags: [
        ['d', NMMR.deriveChunkId(nmmr.getRoot(), chunk.index)],
        ['mmr', '0', '1', base93Encode(chunk.proof)]
      ],
      content: base93Encode(chunk.contentBytes)
    }
    const old = await signer.signEvent({ ...template, created_at: 1 })
    const latest = await signer.signEvent({ ...template, created_at: 2 })
    const published = fixture(t, distribution(scenario, latest, old), new Set(scenario === 'query-failed' ? [A] : []))
    const logs = []
    await uploadBinaryDataChunks({ nmmr, signer, filename: 'file.bin', chunkLength: 1, log: message => logs.push(message) })
    assert.deepEqual(published.map(item => item.relay), scenario === 'complete' ? [] : [A])
    assert.ok(published.every(item => item.event.id === latest.id && !Object.hasOwn(item.event, 'meta')))
    if (scenario !== 'complete') assert.ok(logs.some(message => message.includes('without a confirmed copy')))
  })

  test(`manifest replication with ${scenario} coverage uses the real pool`, async t => {
    const signer = createSigner()
    const options = {
      dTag: 'test-app', channel: 'draft', uploadService: 'blossom', signer,
      fileMetadata: [{ rootHash: '1'.repeat(64), filename: 'index.html', size: 12 }]
    }
    const template = { kind: 35130, content: '', tags: buildManifestTags({ ...options, publishedAt: 1 }) }
    const old = await signer.signEvent({ ...template, created_at: 1 })
    const latest = await signer.signEvent({ ...template, created_at: 2 })
    const published = fixture(t, distribution(scenario, latest, old), new Set(scenario === 'query-failed' ? [A] : []))
    const result = await uploadSiteManifest(options)
    assert.equal(result.id, latest.id)
    assert.deepEqual(published.map(item => item.relay), scenario === 'complete' ? [] : [A])
    assert.ok(published.every(item => item.event.id === latest.id && !Object.hasOwn(item.event, 'meta')))
    assert.deepEqual(result.meta.relays, scenario === 'complete' ? targets : targets.filter(relay => relay !== A))
  })
}

isolateTemporaryDirectory()
