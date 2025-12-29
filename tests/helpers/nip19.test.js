import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appEncode, appDecode, nsecEncode, nsecDecode } from '#helpers/nip19.js'

describe('appEncode/appDecode', () => {
  it('should encode and decode an app reference', () => {
    const ref = {
      dTag: 'dedupe',
      pubkey: 'a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5',
      channel: 'main',
      relays: ['wss://relay.damus.io']
    }

    const encoded = appEncode(ref)
    const decoded = appDecode(encoded)
    const { kind } = decoded
    delete decoded.kind

    assert.ok(encoded.startsWith('+'))
    assert.equal(kind, 37448)
    assert.deepEqual(decoded, ref)
  })

  it('should encode and decode an app reference with a different channel', () => {
    const ref = {
      dTag: 'dedupe2',
      pubkey: 'a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5',
      channel: 'next',
      relays: ['aaddds']
    }

    const encoded = appEncode(ref)
    const decoded = appDecode(encoded)
    const { kind } = decoded
    delete decoded.kind

    assert.ok(encoded.startsWith('++'))
    assert.equal(kind, 37449)
    assert.deepEqual(decoded, ref)
  })

  it('should encode and decode an app reference with kind set instead of channel', () => {
    const ref = {
      dTag: 'dedupe3',
      pubkey: 'a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5',
      kind: 37450,
      relays: ['wss://relay.damus.io', 'wss://relay.44billion.net']
    }

    const encoded = appEncode(ref)
    const decoded = appDecode(encoded)
    const { channel } = decoded
    delete decoded.channel

    assert.ok(encoded.startsWith('+++'))
    assert.equal(channel, 'draft')
    assert.deepEqual(decoded, ref)
  })
})

describe('nsecEncode/nsecDecode', () => {
  it('should encode and decode an nsec', () => {
    const hex = 'a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5'
    const encoded = nsecEncode(hex)
    assert.ok(encoded.startsWith('nsec'))
    const decoded = nsecDecode(encoded)
    assert.equal(decoded, hex)
  })

  it('should decode a known valid nsec and re-encode it correctly', () => {
    const nsec = 'nsec17anezd798fvwv949gcpmrmrqqw22u0xtdh96xevyfe4jm08zzphskqhtpy'
    const expectedHex = 'f7679137c53a58e616a54603b1ec600394ae3ccb6dcba365844e6b2dbce2106f'

    const decoded = nsecDecode(nsec)
    assert.equal(decoded, expectedHex)

    const reEncoded = nsecEncode(decoded)
    assert.equal(reEncoded, nsec)
  })
})
