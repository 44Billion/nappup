import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { toApp } from '../src/index.js'

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
 *   - no previous stall (kind 37348-37350)
 *   - no previous bundle (kind 37448-37450)
 *   - no previous chunks (kind 34600)
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

  return { nostrRelays }
}

describe('onEvent', () => {
  it('should emit init, file-uploaded, stall-published, bundle-published, complete for a single file', async (t) => {
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
    assert.deepEqual(types, ['init', 'file-uploaded', 'stall-published', 'bundle-published', 'complete'])
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

  it('should not emit complete when toApp throws', async (t) => {
    const events = []
    await assert.rejects(
      () => toApp([], null, { onEvent: (e) => events.push(e) }),
      { message: 'No Nostr signer found' }
    )
    const complete = events.find(e => e.type === 'complete')
    assert.equal(complete, undefined, 'should not emit complete on error')
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

  it('should set totalSteps = totalFiles + 2 when no icon', async (t) => {
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
    // 2 files + stall + bundle = 4 steps
    assert.equal(init.totalSteps, 4)
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
