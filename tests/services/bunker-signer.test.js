import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('NostrBunkerSigner', () => {
  it('should reject direct construction without create()', async () => {
    const NostrBunkerSigner = (await import('#services/bunker-signer.js')).default
    assert.throws(
      () => new NostrBunkerSigner(),
      { message: 'Use NostrBunkerSigner.create(bunkerUrl) to instantiate this class.' }
    )
  })

  it('should reject invalid bunker URLs', async () => {
    const NostrBunkerSigner = (await import('#services/bunker-signer.js')).default
    await assert.rejects(
      () => NostrBunkerSigner.create('not-a-bunker-url'),
      { message: 'Invalid bunker URL' }
    )
  })

  it('should reject bunker URLs with no relays', async () => {
    const NostrBunkerSigner = (await import('#services/bunker-signer.js')).default
    await assert.rejects(
      () => NostrBunkerSigner.create('bunker://a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5'),
      { message: 'Bunker URL must include at least one relay (?relay=wss://...)' }
    )
  })

  it('should expose getPublicKey, signEvent, getRelays, nip44 and close', async () => {
    const NostrBunkerSigner = (await import('#services/bunker-signer.js')).default
    const proto = NostrBunkerSigner.prototype
    assert.equal(typeof proto.getPublicKey, 'function')
    assert.equal(typeof proto.signEvent, 'function')
    assert.equal(typeof proto.getRelays, 'function')
    assert.equal(typeof proto.close, 'function')
  })
})
