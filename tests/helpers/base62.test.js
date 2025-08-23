import { it } from 'node:test'
import assert from 'node:assert/strict'
import { base16ToBytes, bytesToBase16 } from '#helpers/base16.js'
import { bytesToBase62, base62ToBytes } from '#helpers/base62.js'

it('encodes/decodes to/from base62', () => {
  const hexes = ['00', 'ff']
  for (const hex of hexes) {
    const hexBytes = base16ToBytes(hex)
    const base62Encoded = bytesToBase62(hexBytes)
    const base62Bytes = base62ToBytes(base62Encoded)
    const base62Hex = bytesToBase16(base62Bytes)

    assert.deepEqual(base62Bytes, hexBytes)
    assert.equal(base62Hex, hex)
  }
})
