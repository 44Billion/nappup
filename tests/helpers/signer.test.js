import assert from 'node:assert/strict'
import { test } from 'node:test'

import { freeRelays } from 'libp2r2p/relay'
import { getRelays } from '#helpers/signer.js'

test('getRelays delegates NIP-65 discovery and preserves missing-type fallbacks', async () => {
  const pubkey = 'a'.repeat(64)
  let calls = 0
  const signer = {
    async getPublicKey () { return pubkey }
  }
  const options = {
    async _getRelaysByPubkey (pubkeys) {
      calls++
      assert.deepEqual(pubkeys, [pubkey])
      return { [pubkey]: { read: [], write: ['wss://author.example'] } }
    }
  }

  const first = await getRelays.call(signer, options)
  const cached = await getRelays.call(signer, options)

  assert.equal(calls, 1)
  assert.equal(first, cached)
  assert.deepEqual(first, {
    read: freeRelays,
    write: ['wss://author.example']
  })
})

test('getRelays uses two default relays when a published list has no usable URLs', async () => {
  const pubkey = 'b'.repeat(64)
  const signer = { async getPublicKey () { return pubkey } }
  const relays = await getRelays.call(signer, {
    async _getRelaysByPubkey () {
      return { [pubkey]: { read: [], write: [] } }
    }
  })

  assert.deepEqual(relays, {
    read: freeRelays.slice(0, 2),
    write: freeRelays.slice(0, 2)
  })
})
