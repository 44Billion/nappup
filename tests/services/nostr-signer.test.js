
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import NostrSigner from '#services/nostr-signer.js'
import { nsecEncode } from '#helpers/nip19.js'

describe('NostrSigner', () => {
  it('should create a signer from a hex secret key', async () => {
    const sk = 'a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5'
    const signer = await NostrSigner.create(sk)
    assert.ok(signer)
  })

  it('should create a signer from an nsec secret key', async () => {
    const sk = 'a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5'
    const nsec = nsecEncode(sk)
    const signer = await NostrSigner.create(nsec)
    assert.ok(signer)
  })
})
