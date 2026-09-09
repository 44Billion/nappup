import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toApp } from '../../src/index.js'
import relays from '#services/nostr-relays.js'

const servers = ['https://a.example', 'https://b.example']
const signer = {
  getPublicKey: async () => 'a'.repeat(64),
  getRelays: async () => ({ write: ['wss://a.example'] }),
  signEvent: async event => ({ ...event, id: 'b'.repeat(64), pubkey: 'a'.repeat(64), sig: 'c'.repeat(128) })
}

// Drives the public uploader with native File bodies and controlled destinations.
function setup (t, statusForUpload, manifestReason) {
  t.mock.method(relays, 'getEvents', async filters => ({
    result: filters.kinds.includes(10063) ? [{ tags: servers.map(server => ['server', server]) }] : [], errors: []
  }))
  t.mock.method(relays, 'sendEvent', async (_event, destinations) => ({
    errors: manifestReason ? destinations.map(relay => ({ relay, reason: manifestReason })) : []
  }))
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'HEAD') return new Response(null, { status: 200 })
    const status = statusForUpload(url, options.body)
    return new Response(status === 201 ? '{}' : null, { status })
  })
  const files = ['index.html', 'app.js'].map(name => Object.assign(
    new File([name === 'index.html' ? '<title>Test</title>' : 'app()'], name, { type: name.endsWith('.js') ? 'text/javascript' : 'text/html' }),
    { webkitRelativePath: `test-app/${name}` }
  ))
  const events = []
  return { events, publish: () => toApp(files, signer, { shouldReupload: true, log: () => {}, onEvent: event => events.push(event) }) }
}

test('different Blossom servers may confirm different files without a user-facing error', async t => {
  const { events, publish } = setup(t, (url, file) => (url.startsWith(servers[0]) === (file.name === 'index.html')) ? 201 : 415)
  await publish()
  assert.equal(events.filter(event => event.type === 'file-uploaded').length, 2)
  assert.equal(events.at(-1).type, 'complete')
  assert.ok(!events.some(event => event.type === 'error'))
})

test('public Blossom error retains only destinations of files with no confirmed copy', async t => {
  const { events, publish } = setup(t, (url, file) => file.name === 'index.html' && url.startsWith(servers[0]) ? 201 : 415)
  await assert.rejects(publish(), error => {
    assert.equal(error.code, 'NAPPUP_BLOSSOM_UPLOAD_FAILED')
    assert.deepEqual(error.details.filenames, ['app.js'])
    assert.equal(error.details.failedFileCount, 1)
    assert.deepEqual(error.details.failures.map(failure => failure.destination).sort(), servers)
    assert.ok(error.details.failures.every(failure => failure.filename === 'app.js' && failure.reason.status === 415))
    assert.deepEqual(error.cause.errors, error.details.failures.map(failure => failure.reason))
    assert.equal(events.at(-1).error, error)
    return true
  })
})

test('manifest failure remains fatal after all files uploaded and exposes relay reasons', async t => {
  const reason = Object.assign(new Error('blocked: upload policy'), { category: 'relay' })
  const { events, publish } = setup(t, () => 201, reason)
  await assert.rejects(publish(), error => {
    assert.equal(error.code, 'NAPPUP_MANIFEST_UPLOAD_FAILED')
    assert.ok(error.details.failures.every(failure => failure.reason === reason && failure.destination.startsWith('wss://')))
    assert.equal(events.at(-1).error, error)
    return true
  })
  assert.equal(events.filter(event => event.type === 'file-uploaded').length, 2)
  assert.ok(!events.some(event => event.type === 'complete'))
})

test('aggregated signer denial reaches the public Blossom boundary with all causes', async t => {
  const { publish } = setup(t, () => 201)
  const reason = Object.assign(new Error(''), { code: 'DENIED_BY_USER' })
  t.mock.method(signer, 'signEvent', async () => { throw reason })
  await assert.rejects(publish(), error => {
    assert.equal(error.code, 'NAPPUP_SIGNER_DENIED')
    assert.equal(error.details.failures.length, 4)
    assert.ok(error.cause.errors.every(child => child === reason))
    return true
  })
})
