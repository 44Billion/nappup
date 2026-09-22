import { isolateTemporaryDirectory } from './temporary-directory.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aggregateEventRelays } from '#helpers/event.js'
import { formatRelayFailure } from '#helpers/relay-error.js'
import { throttledSendEvent } from '#services/irfs-upload.js'
import relays from '#services/nostr-relays.js'
import { toApp, NAPPUP_ERROR_CODES } from '../../src/index.js'

test('aggregation keeps versions and origins separate without mutating input metadata', () => {
  const events = [
    { id: 'old', meta: { relay: 'A' } },
    { id: 'new', meta: { relay: 'B' } },
    { id: 'new', meta: { relay: 'C' } },
    { id: 'new', meta: { relay: 'B' } }
  ]
  const before = structuredClone(events)
  assert.deepEqual(aggregateEventRelays(events.map(event => ({ event, relay: event.meta?.relay }))), [
    { id: 'old', meta: { relays: ['A'] } },
    { id: 'new', meta: { relays: ['B', 'C'] } }
  ])
  assert.deepEqual(events, before)
})

test('diagnostics retain empty messages, native codes, close details and nested errors', () => {
  const child = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
  const cause = new AggregateError([child], '')
  const reason = Object.assign(new Error('', { cause }), {
    category: 'transport', code: 'EPIPE', closeCode: 1006, closeReason: '', wasClean: false
  })
  const message = formatRelayFailure({ relay: 'wss://destination.example', reason })
  for (const text of ['wss://destination.example [transport]', 'No error message provided', 'ECONNREFUSED', 'EPIPE', 'closeCode=1006', 'wasClean=false']) {
    assert.ok(message.includes(text), message)
  }
})

test('diagnostic formatting handles cycles, depth limits and unknown failures', () => {
  const cycle = new Error('cycle')
  cycle.cause = cycle
  assert.match(formatRelayFailure({ relay: 'A', reason: cycle }), /circular error reference/)
  let deep = new Error('leaf')
  for (let index = 0; index < 20; index++) deep = new Error('nested', { cause: deep })
  assert.match(formatRelayFailure({ relay: 'A', reason: deep }), /maximum error depth/)
  assert.match(formatRelayFailure({ relay: 'A', reason: {} }), /unclassified.*No error message provided/)
})

test('terminal upload errors retain individual causes and destination relays', async t => {
  const reason = Object.assign(new Error('blocked: denied'), { category: 'relay' })
  t.mock.method(relays, 'sendEvent', async () => ({ errors: [{ relay: 'A', reason }] }))
  const logs = []
  await assert.rejects(throttledSendEvent({ id: 'event-id', kind: 34601, meta: { relay: 'origin' } }, ['A'], {
    pause: 0, log: text => logs.push(text)
  }), error => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors[0], reason)
    assert.equal(error.failures[0].relay, 'A')
    return true
  })
  assert.ok(logs.some(text => text.includes('no further automatic retry')))
  assert.ok(logs.some(text => text.includes('A [relay]')))
  assert.ok(logs.some(text => text.includes('id=event-id kind=34601')))
  assert.ok(logs.every(text => !text.includes('origin') && !text.includes('unretryable')))
})

test('publish timeout is retried once and partial success keeps the threshold policy', async t => {
  let calls = 0
  const reason = Object.assign(new Error('PUBLISH_TIMEOUT'), { category: 'timeout' })
  let rejected = null
  t.mock.method(relays, 'sendEvent', async () => {
    if (rejected) return { errors: [{ relay: 'A', reason: rejected }] }
    return ++calls === 1 ? { errors: [{ relay: 'A', reason }] } : { errors: [] }
  })
  await throttledSendEvent({}, ['A'], { pause: 0, log: () => {} })
  assert.equal(calls, 2)
  rejected = Object.assign(new Error('blocked: denied'), { category: 'relay' })
  await throttledSendEvent({}, ['A', 'B'], { pause: 0, log: () => {}, minSuccessfulRelays: 1 })
  await throttledSendEvent({}, ['A'], { pause: 0, log: () => {}, minSuccessfulRelays: 0 })
})

// Exercises the actual public error boundary instead of constructing its wrapper.
test('public uploader retains terminal relay failures beneath its existing error code', async t => {
  const reason = Object.assign(new Error('blocked: denied'), { category: 'relay' })
  t.mock.method(relays, 'getEvents', async () => ({ result: [], errors: [] }))
  t.mock.method(relays, 'sendEvent', async (event, destinations) => ({
    errors: destinations.map(relay => ({ relay, reason }))
  }))
  const file = new Blob(['<html><title>App</title></html>'], { type: 'text/html' })
  file.name = 'index.html'
  file.webkitRelativePath = 'test-app/index.html'
  const signer = {
    getPublicKey: async () => 'a'.repeat(64),
    getRelays: async () => ({ write: ['wss://a.example'] }),
    signEvent: async event => ({ ...event, id: 'b'.repeat(64), pubkey: 'a'.repeat(64), sig: 'c'.repeat(128) })
  }
  await assert.rejects(toApp([file], signer, { dTag: 'test-app', log: () => {} }), error => {
    assert.equal(error.code, NAPPUP_ERROR_CODES.IRFS_UPLOAD_FAILED)
    assert.ok(error.cause instanceof AggregateError)
    assert.ok(error.cause.errors.length > 0)
    assert.ok(error.cause.errors.every(item => item === reason))
    assert.equal(error.cause.failures[0].relay, 'wss://a.example')
    return true
  })
})

isolateTemporaryDirectory()
