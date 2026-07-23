import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relayPool } from 'libp2r2p/relay'

import relays, { freeRelays, nappRelays, seedRelays, sendEventReport } from '#services/nostr-relays.js'

test('uses the shared libp2r2p relay pool and keeps local relay lists', () => {
  assert.equal(relays, relayPool)
  assert.ok(freeRelays.length > 0)
  assert.ok(seedRelays.length > 0)
  assert.deepEqual(nappRelays, ['wss://relay.44billion.net'])
})

test('sendEventReport waits for the terminal per-relay report', async t => {
  let finish
  const report = new Promise(resolve => { finish = resolve })
  t.mock.method(relayPool, 'sendEvent', async () => ({
    success: true,
    promise: report
  }))

  const pending = sendEventReport({ id: 'event' }, ['wss://relay.example'])
  let settled = false
  pending.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)

  finish({ success: true, fulfilled: 1, errors: [] })
  assert.deepEqual(await pending, { success: true, fulfilled: 1, errors: [] })
})
