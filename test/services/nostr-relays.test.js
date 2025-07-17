import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'
import { NostrRelays, freeRelays } from '#services/nostr-relays.js'
import NostrSigner from '#services/nostr-signer.js'

describe.skip('relays', () => {
  let relays

  before(() => {
    relays = new NostrRelays()
  })

  after(() => {
    // Close any open connections
    relays.disconnectAll()
  })

  it('should get events from a relay', async () => {
    const events = await relays.getEvents({ kinds: [1], limit: 2 }, freeRelays.slice(0, 1))
    assert.ok(Array.isArray(events))
  })

  it('should send an event to a relay', async () => {
    const nostrSigner = await NostrSigner.create('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2')
    const event = {
      kind: 1,
      content: `test ${Math.random()}`,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: nostrSigner.getPublicKey()
    }
    const signedEvent = nostrSigner.signEvent(event)
    await relays.sendEvent(signedEvent, freeRelays.slice(0, 1))
    const [signedEventCopy] = await relays.getEvents({ ids: [signedEvent.id], limit: 1 }, freeRelays.slice(0, 1))
    assert.deepEqual(
      (({ id, kind, pubkey, tags, content, created_at, sig }) => ({ id, kind, pubkey, tags, content, created_at, sig }))(signedEvent),
      (({ id, kind, pubkey, tags, content, created_at, sig }) => ({ id, kind, pubkey, tags, content, created_at, sig }))(signedEventCopy)
    )
  })
})
