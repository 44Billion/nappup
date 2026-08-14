import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createHash } from 'node:crypto'
import {
  buildManifestTags,
  getManifestAggregateHash,
  normalizeManifestPath,
  uploadSiteManifest
} from '#services/site-manifest.js'

const ROOT_A = 'a'.repeat(64)
const ROOT_B = 'b'.repeat(64)

describe('unified site manifest', () => {
  it('groups IRFS paths and marks sharing root, MIME and size', () => {
    const tags = buildManifestTags({
      dTag: 'app',
      uploadService: 'irfs',
      fileMetadata: [
        { rootHash: ROOT_A, filename: '/index.html', mimeType: 'text/html', size: 12 },
        { rootHash: ROOT_A, filename: 'copy.html', mimeType: 'text/html', size: 12 }
      ],
      icon: { rootHash: ROOT_A, mimeType: 'text/html', size: 12 },
      screenshots: [{ rootHash: ROOT_B, mimeType: 'image/webp', size: 42, country: 'BR' }],
      name: 'App',
      publishedAt: 123
    })
    const references = tags.filter(tag => tag[0] === 'r')
    assert.deepEqual(references[0], [
      'r', ROOT_A, 'path index.html', 'path copy.html', 'mark icon', 'm text/html', 'size 12'
    ])
    assert.deepEqual(references[1], [
      'r', ROOT_B, 'mark screenshot', 'country BR', 'm image/webp', 'size 42'
    ])
    assert.ok(tags.some(tag => tag[0] === 'service' && tag[1] === 'irfs'))
  })

  it('keeps Blossom files as path tags and media as r tags', () => {
    const tags = buildManifestTags({
      dTag: 'app',
      uploadService: 'blossom',
      fileMetadata: [{ rootHash: ROOT_A, filename: '/index.html', mimeType: 'text/html', size: 12 }],
      icon: { rootHash: ROOT_A, mimeType: 'text/html', size: 12 },
      publishedAt: 123
    })
    assert.ok(tags.some(tag => JSON.stringify(tag) === JSON.stringify(['path', 'index.html', ROOT_A])))
    assert.ok(tags.some(tag => tag[0] === 'r' && tag.includes('mark icon')))
  })

  it('publishes normalized relay and Blossom source hints', () => {
    const tags = buildManifestTags({
      dTag: 'app', uploadService: 'blossom', publishedAt: 123,
      fileMetadata: [{ rootHash: ROOT_A, filename: 'index.html', size: 12 }],
      sourceRelays: ['wss://relay.test/', 'wss://relay.test', 'ftp://invalid.test'],
      blossomServers: ['https://blossom.test/', 'ftp://invalid.test']
    })
    assert.deepEqual(tags.filter(tag => tag[0] === 'relay' || tag[0] === 'server'), [
      ['relay', 'wss://relay.test'],
      ['server', 'https://blossom.test']
    ])
  })

  it('preserves only the first ten unknown tags in order', () => {
    const previousTags = [
      ['old-a', '0'], ['name', 'old'],
      ...Array.from({ length: 12 }, (_, index) => ['custom', String(index)])
    ]
    const tags = buildManifestTags({
      dTag: 'app', uploadService: 'irfs', previousTags,
      fileMetadata: [{ rootHash: ROOT_A, filename: 'index.html', mimeType: 'text/html', size: 12 }],
      publishedAt: 123
    })
    assert.deepEqual(tags.filter(tag => tag[0] === 'old-a' || tag[0] === 'custom'), [
      ['old-a', '0'], ...Array.from({ length: 9 }, (_, index) => ['custom', String(index)])
    ])
    assert.ok(!tags.some(tag => tag[0] === 'name'))
    assert.equal(tags.filter(tag => tag[0] === 'x').length, 1)
    assert.deepEqual(tags.find(tag => tag[0] === 'published_at'), ['published_at', '123'])
  })

  it('normalizes one leading slash and rejects unsafe paths', () => {
    assert.equal(normalizeManifestPath('/assets/app.js'), 'assets/app.js')
    for (const path of ['', '//a', 'a//b', '.', '..', 'a/../b', 'a\\b', 'a\u0000b']) {
      assert.throws(() => normalizeManifestPath(path), /Unsafe/)
    }
  })

  it('computes the canonical aggregate independently of order, metadata and service layout', () => {
    const expected = createHash('sha256')
      .update(`${ROOT_A} /index.html\n${ROOT_B} /style.css\n`)
      .digest('hex')
    const blossom = {
      tags: [
        ['name', 'Ignored'],
        ['path', 'style.css', ROOT_B],
        ['x', '0'.repeat(64), 'aggregate'],
        ['published_at', '999'],
        ['path', '/index.html', ROOT_A],
        ['service', 'blossom']
      ]
    }
    const irfs = {
      tags: [
        ['service', 'irfs'],
        ['r', ROOT_A, 'path index.html', 'mark icon', 'm text/html'],
        ['r', ROOT_B, 'size 12', 'path /style.css']
      ]
    }
    assert.equal(getManifestAggregateHash(blossom), expected)
    assert.equal(getManifestAggregateHash(irfs), expected)
  })

  it('changes the aggregate when a route root changes and rejects manifests without routes', () => {
    const first = getManifestAggregateHash({ tags: [['path', 'index.html', ROOT_A]] })
    const second = getManifestAggregateHash({ tags: [['path', 'index.html', ROOT_B]] })
    assert.notEqual(first, second)
    assert.throws(() => getManifestAggregateHash({ tags: [['r', ROOT_A, 'mark icon'], ['service', 'irfs']] }), /at least one file/)
  })

  it('preserves published_at for the same aggregate and changes it for a new aggregate', async (t) => {
    const nostrRelays = (await import('#services/nostr-relays.js')).default
    const previous = {
      id: '1'.repeat(64),
      pubkey: 'f'.repeat(64),
      kind: 35128,
      created_at: 100,
      content: '',
      tags: buildManifestTags({
        dTag: 'app', uploadService: 'blossom', publishedAt: 90,
        fileMetadata: [{ rootHash: ROOT_A, filename: 'index.html', size: 12 }]
      })
    }
    let returnedEvents = [previous]
    t.mock.method(nostrRelays, 'getEvents', async () => ({ result: returnedEvents }))
    t.mock.method(nostrRelays, 'sendEvent', async () => ({ errors: [] }))
    t.mock.method(Date, 'now', () => 200000)
    const signed = []
    const signer = {
      getPublicKey: async () => previous.pubkey,
      getRelays: async () => ({ write: ['wss://relay.test'] }),
      signEvent: async event => {
        signed.push(event)
        return { ...event, id: `${signed.length + 1}`.repeat(64), pubkey: previous.pubkey }
      }
    }

    const metadataRevision = await uploadSiteManifest({
      dTag: 'app', uploadService: 'blossom', signer, pause: 0, name: 'New name',
      fileMetadata: [{ rootHash: ROOT_A, filename: 'index.html', size: 12 }]
    })
    assert.deepEqual(metadataRevision.tags.find(tag => tag[0] === 'published_at'), ['published_at', '90'])

    returnedEvents = [metadataRevision]
    const nextVersion = await uploadSiteManifest({
      dTag: 'app', uploadService: 'blossom', signer, pause: 0,
      fileMetadata: [{ rootHash: ROOT_B, filename: 'index.html', size: 12 }]
    })
    assert.deepEqual(nextVersion.tags.find(tag => tag[0] === 'published_at'), ['published_at', '201'])
    assert.notEqual(getManifestAggregateHash(metadataRevision), getManifestAggregateHash(nextVersion))
  })

  it('uses the previous created_at when adding published_at to a legacy same-version manifest', async (t) => {
    const nostrRelays = (await import('#services/nostr-relays.js')).default
    const previous = {
      id: '1'.repeat(64), pubkey: 'f'.repeat(64), kind: 35128, created_at: 100, content: '',
      tags: [['d', 'app'], ['path', 'index.html', ROOT_A], ['service', 'blossom']]
    }
    t.mock.method(nostrRelays, 'getEvents', async () => ({ result: [previous] }))
    t.mock.method(nostrRelays, 'sendEvent', async () => ({ errors: [] }))
    t.mock.method(Date, 'now', () => 200000)
    const signer = {
      getPublicKey: async () => previous.pubkey,
      getRelays: async () => ({ write: ['wss://relay.test'] }),
      signEvent: async event => ({ ...event, id: '2'.repeat(64), pubkey: previous.pubkey })
    }
    const event = await uploadSiteManifest({
      dTag: 'app', uploadService: 'blossom', signer, pause: 0,
      fileMetadata: [{ rootHash: ROOT_A, filename: 'index.html', size: 12 }]
    })
    assert.deepEqual(event.tags.find(tag => tag[0] === 'published_at'), ['published_at', '100'])
  })

  it('reuses an identical manifest unless force re-upload is enabled', async (t) => {
    const nostrRelays = (await import('#services/nostr-relays.js')).default
    const previous = {
      id: '1'.repeat(64), pubkey: 'f'.repeat(64), kind: 35128, created_at: 100, content: '',
      tags: buildManifestTags({
        dTag: 'app', uploadService: 'blossom', publishedAt: 90,
        fileMetadata: [{ rootHash: ROOT_A, filename: 'index.html', size: 12 }]
      })
    }
    t.mock.method(nostrRelays, 'getEvents', async () => ({ result: [previous] }))
    t.mock.method(nostrRelays, 'sendEvent', async () => ({ errors: [] }))
    t.mock.method(Date, 'now', () => 200000)
    const signed = []
    const signer = {
      getPublicKey: async () => previous.pubkey,
      getRelays: async () => ({ write: ['wss://relay.test'] }),
      signEvent: async event => {
        signed.push(event)
        return { ...event, id: '2'.repeat(64), pubkey: previous.pubkey }
      }
    }
    const options = {
      dTag: 'app', uploadService: 'blossom', signer, pause: 0,
      fileMetadata: [{ rootHash: ROOT_A, filename: 'index.html', size: 12 }]
    }

    assert.equal(await uploadSiteManifest(options), previous)
    assert.equal(signed.length, 0)
    const forced = await uploadSiteManifest({ ...options, shouldReupload: true })
    assert.equal(signed.length, 1)
    assert.deepEqual(forced.tags.find(tag => tag[0] === 'published_at'), ['published_at', '90'])
    assert.equal(getManifestAggregateHash(forced), getManifestAggregateHash(previous))
  })
})
