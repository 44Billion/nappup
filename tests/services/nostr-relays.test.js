import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  freeRelays as sharedFreeRelays,
  nappRelays as sharedNappRelays,
  relayPool,
  seedRelays as sharedSeedRelays
} from 'libp2r2p/relay'

import relays, { freeRelays, nappRelays, seedRelays, sendEventReport } from '#services/nostr-relays.js'

test('uses the shared libp2r2p relay pool and relay lists', () => {
  assert.equal(relays, relayPool)
  assert.equal(freeRelays, sharedFreeRelays)
  assert.equal(seedRelays, sharedSeedRelays)
  assert.equal(nappRelays, sharedNappRelays)
  assert.deepEqual(nappRelays, [
    'wss://relay.44billion.net',
    'wss://relay.ditto.pub',
    'wss://relay.dreamith.to'
  ])
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
