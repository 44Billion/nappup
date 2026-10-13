import { isolateTemporaryDirectory } from './helpers/temporary-directory.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NAPPUP_ERROR_CODES, toApp } from '../src/index.js'
import { getManifestAggregateHash } from '#services/site-manifest.js'
import { nappRelays } from '#services/nostr-relays.js'

const MOCK_PUBKEY = 'a'.repeat(64)
const MOCK_EVENT_ID = 'b'.repeat(64)
const MOCK_SIG = 'c'.repeat(128)

function createMockSigner (pubkey = MOCK_PUBKEY) {
  return {
    getPublicKey: () => pubkey,
    getRelays: () => ({ write: ['wss://relay1.test', 'wss://relay2.test'] }),
    signEvent: (event) => ({
      ...event,
      id: MOCK_EVENT_ID,
      pubkey,
      sig: MOCK_SIG
    })
  }
}

function createFakeFile (content, relativePath, mimeType = 'text/html') {
  const bytes = new TextEncoder().encode(content)
  const blob = new Blob([bytes], { type: mimeType })
  blob.webkitRelativePath = relativePath
  blob.name = relativePath.split('/').pop()
  return blob
}

/**
 * Mocks nostrRelays.getEvents and nostrRelays.sendEvent so that
 * toApp doesn't hit any real relay or blossom server.
 * Returns empty results for all relay queries, meaning:
 *   - no blossom servers (kind 10063)
 *   - no previous site manifest (kind 35128-35130)
 *   - no previous chunks (kind 34601)
 */
async function setupMocks (t) {
  const nostrRelaysModule = await import('#services/nostr-relays.js')
  const nostrRelays = nostrRelaysModule.default

  t.mock.method(nostrRelays, 'getEvents', async () => ({
    result: [],
    errors: []
  }))

  t.mock.method(nostrRelays, 'sendEvent', async () => ({
    errors: []
  }))

  // Make setTimeout resolve immediately to skip the 1000ms trailing pauses
  // inside throttledSendEvent (caused by the hardcoded `pause = 1000` in toApp)
  const origSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, _ms, ...args) => origSetTimeout(fn, 0, ...args)
  t.after(() => { globalThis.setTimeout = origSetTimeout })

  return { nostrRelays }
}

describe('onEvent', () => {
  for (const service of ['blossom', 'irfs']) {
    it(`should log the published ${service} version for new, reused and metadata-only manifests`, async t => {
      const { nostrRelays } = await setupMocks(t)
      const now = Date.parse('2026-10-13T00:30:00Z')
      t.mock.method(Date, 'now', () => now)
      const manifests = []
      const signer = createMockSigner()
      const sign = signer.signEvent
      signer.signEvent = event => {
        const signed = sign(event)
        if (event.kind === 35128) {
          signed.id = String(manifests.length + 1).repeat(64)
          manifests.push(signed)
        }
        return signed
      }
      let previous = null
      const relays = [...new Set([...signer.getRelays().write, ...nappRelays])]
      t.mock.method(nostrRelays, 'getEvents', async filter => {
        if (filter.kinds.includes(10063) && service === 'blossom') {
          return { result: [{ event: { tags: [['server', 'https://blossom.test']], created_at: 1 } }] }
        }
        if (filter.kinds.includes(35128) && previous) {
          return { result: relays.map(relay => ({ event: previous, relay })) }
        }
        return { result: [] }
      })
      if (service === 'blossom') {
        t.mock.method(globalThis, 'fetch', async (url, options) => {
          if (options.method === 'HEAD') return new Response(null, { status: new URL(url).pathname === '/' ? 200 : 404 })
          return new Response('{}', { status: 201 })
        })
      }
      const files = [createFakeFile('<html><head><title>My app</title></head></html>', 'myapp/index.html')]
      const publish = async fileList => {
        const logs = []
        await toApp(fileList, signer, { dTag: 'myapp', log: message => logs.push(message) })
        return logs
      }
      const firstLogs = await publish(files)
      assert.equal(manifests.length, 1)
      previous = manifests[0]
      const hash = getManifestAggregateHash(previous)
      const expected = [`Version: v2026-10-13-${hash.slice(0, 8)}`, `Version hash: ${hash}`]
      assert.deepEqual(firstLogs.slice(-3, -1), expected)
      assert.match(firstLogs.at(-1), /^Visit at https:\/\/44billion\.net\//)

      const reusedLogs = await publish(files)
      assert.equal(manifests.length, 1, 'identical manifests must be reused without signing a new manifest')
      assert.deepEqual(reusedLogs.slice(-3, -1), expected)

      const config = createFakeFile(JSON.stringify({ name: [['Changed name']] }), 'myapp/.well-known/napp.json', 'application/json')
      const revisedLogs = await publish([...files, config])
      assert.equal(manifests.length, 2)
      assert.notEqual(manifests[1].id, previous.id)
      assert.ok(manifests[1].created_at > previous.created_at)
      assert.deepEqual(revisedLogs.slice(-3, -1), expected)
    })
  }

  it('should not log a published version when manifest signing fails', async t => {
    await setupMocks(t)
    const signer = createMockSigner()
    const sign = signer.signEvent
    signer.signEvent = event => {
      if (event.kind === 35128) throw new Error('manifest signing failed')
      return sign(event)
    }
    const logs = []
    await assert.rejects(() => toApp([createFakeFile('<html></html>', 'myapp/index.html')], signer, {
      dTag: 'myapp', log: message => logs.push(message)
    }), { code: NAPPUP_ERROR_CODES.MANIFEST_UPLOAD_FAILED })
    assert.ok(!logs.some(message => /^(Version:|Version hash:|Visit at)/.test(message)))
  })

  it('should log the outbox relays without repeating the publisher key', async (t) => {
    await setupMocks(t)

    const logs = []
    const fileList = [createFakeFile('<html></html>', 'myapp/index.html')]

    await toApp(fileList, createMockSigner(), {
      dTag: 'myapp',
      log: message => logs.push(message)
    })

    const relayLog = logs.find(message => message.startsWith('Found 2 outbox relays'))
    assert.match(relayLog, /^Found 2 outbox relays:\n/)
    assert.equal(relayLog.includes(MOCK_PUBKEY), false)
  })

  it('should emit upload phases for a single file', async (t) => {
    await setupMocks(t)

    const events = []
    const fileList = [
      createFakeFile('<html><head><title>My App</title></head><body></body></html>', 'myapp/index.html')
    ]

    await toApp(fileList, createMockSigner(), {
      dTag: 'myapp',
      onEvent: (e) => events.push(e)
    })

    const types = events.map(e => e.type)
    assert.deepEqual(types, [
      'services-checking',
      'init',
      'file-uploaded',
      'manifest-published',
      'complete'
    ])
  })

  it('should include blossomCount, relayCount, totalFiles, dTag in init event', async (t) => {
    await setupMocks(t)

    const events = []
    const fileList = [
      createFakeFile('hello', 'myapp/index.html')
    ]

    await toApp(fileList, createMockSigner(), {
      dTag: 'myapp',
      onEvent: (e) => events.push(e)
    })

    const init = events.find(e => e.type === 'init')
    assert.equal(init.blossomCount, 0)
    assert.equal(init.relayCount, 2)
    assert.equal(init.totalFiles, 1)
    assert.equal(init.dTag, 'myapp')
  })

  it('should have progress as rounded integers from 0 to 100', async (t) => {
    await setupMocks(t)

    const events = []
    const fileList = [
      createFakeFile('<html><head><title>App</title></head></html>', 'myapp/index.html'),
      createFakeFile('body{}', 'myapp/style.css', 'text/css'),
      createFakeFile('x()', 'myapp/app.js', 'application/javascript')
    ]

    await toApp(fileList, createMockSigner(), {
      dTag: 'myapp',
      onEvent: (e) => events.push(e)
    })

    for (const event of events) {
      assert.equal(typeof event.progress, 'number', `progress should be a number for ${event.type}`)
      assert.equal(event.progress, Math.round(event.progress), `progress should be an integer for ${event.type}`)
      assert.ok(event.progress >= 0 && event.progress <= 100, `progress should be 0-100 for ${event.type}, got ${event.progress}`)
    }

    const complete = events.find(e => e.type === 'complete')
    assert.equal(complete.progress, 100)

    const init = events.find(e => e.type === 'init')
    assert.equal(init.progress, 0)
  })

  it('should emit file-uploaded for each file with service and filename', async (t) => {
    await setupMocks(t)

    const events = []
    const fileList = [
      createFakeFile('<html></html>', 'myapp/index.html'),
      createFakeFile('body{}', 'myapp/style.css', 'text/css')
    ]

    await toApp(fileList, createMockSigner(), {
      dTag: 'myapp',
      onEvent: (e) => events.push(e)
    })

    const fileEvents = events.filter(e => e.type === 'file-uploaded')
    assert.equal(fileEvents.length, 2)
    assert.equal(fileEvents[0].service, 'irfs')
    assert.equal(fileEvents[1].service, 'irfs')

    const filenames = fileEvents.map(e => e.filename)
    assert.ok(filenames.includes('index.html'))
    assert.ok(filenames.includes('style.css'))
  })

  it('should have monotonically non-decreasing progress', async (t) => {
    await setupMocks(t)

    const events = []
    const fileList = [
      createFakeFile('<html></html>', 'myapp/index.html'),
      createFakeFile('body{}', 'myapp/a.css', 'text/css'),
      createFakeFile('x()', 'myapp/a.js', 'application/javascript')
    ]

    await toApp(fileList, createMockSigner(), {
      dTag: 'myapp',
      onEvent: (e) => events.push(e)
    })

    for (let i = 1; i < events.length; i++) {
      assert.ok(
        events[i].progress >= events[i - 1].progress,
        `progress should not decrease: ${events[i - 1].type}(${events[i - 1].progress}) -> ${events[i].type}(${events[i].progress})`
      )
    }
  })

  it('should emit complete with napp field as last event', async (t) => {
    await setupMocks(t)

    const events = []
    const fileList = [
      createFakeFile('<html></html>', 'myapp/index.html')
    ]

    await toApp(fileList, createMockSigner(), {
      dTag: 'myapp',
      onEvent: (e) => events.push(e)
    })

    const complete = events.find(e => e.type === 'complete')
    assert.ok(complete, 'should have a complete event')
    assert.equal(typeof complete.napp, 'string')
    assert.ok(complete.napp.length > 0)
    assert.equal(events[events.length - 1].type, 'complete', 'complete should be the last event')
  })

  it('should not emit complete when toApp throws', async () => {
    const events = []
    await assert.rejects(
      () => toApp([], null, { onEvent: (e) => events.push(e) }),
      { message: 'No Nostr signer found' }
    )
    const complete = events.find(e => e.type === 'complete')
    assert.equal(complete, undefined, 'should not emit complete on error')
    const error = events.find(e => e.type === 'error')
    assert.equal(error.error.code, NAPPUP_ERROR_CODES.NO_SIGNER)
    assert.equal(error.progress, 0)
  })

  it('should not break publishing if onEvent callback throws', async (t) => {
    await setupMocks(t)

    const fileList = [
      createFakeFile('<html></html>', 'myapp/index.html')
    ]

    await assert.doesNotReject(
      () => toApp(fileList, createMockSigner(), {
        dTag: 'myapp',
        onEvent: () => { throw new Error('callback exploded') }
      })
    )
  })

  it('should set totalSteps = totalFiles + one unified manifest when no icon', async (t) => {
    await setupMocks(t)

    const events = []
    const fileList = [
      createFakeFile('<html></html>', 'myapp/index.html'),
      createFakeFile('a', 'myapp/a.txt', 'text/plain')
    ]

    await toApp(fileList, createMockSigner(), {
      dTag: 'myapp',
      onEvent: (e) => events.push(e)
    })

    const init = events.find(e => e.type === 'init')
    // 2 files + one unified manifest = 3 steps
    assert.equal(init.totalSteps, 3)
    assert.equal(init.totalFiles, 2)
  })

  it('should work with no onEvent provided (backwards compatible)', async (t) => {
    await setupMocks(t)

    const fileList = [
      createFakeFile('<html></html>', 'myapp/index.html')
    ]

    await assert.doesNotReject(
      () => toApp(fileList, createMockSigner(), { dTag: 'myapp' })
    )
  })
})

isolateTemporaryDirectory()
