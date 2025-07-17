import assert from 'node:assert/strict'
import { it } from 'node:test'
import Base122Encoder from '#services/base122-encoder.js'
import Base122Decoder from '#services/base122-decoder.js'

it('encodes and decodes', async () => {
  const encodedChunks = ['I', '💞', 'Nostr']
    .map(v => new TextEncoder().encode(v))
    .map(v => new Base122Encoder().update(v).getEncoded())

  let iterator = new Base122Decoder(encodedChunks, { mimeType: 'text/plain' }).getDecoded()
  let whole = []
  for await (const decodedChunk of iterator) whole.push(decodedChunk)
  assert.equal(whole.join(' '), 'I 💞 Nostr')

  function * regularIterator () { for (const chunk of encodedChunks) yield chunk }
  iterator = new Base122Decoder(regularIterator, { mimeType: 'text/plain' }).getDecoded()
  whole = []
  for await (const decodedChunk of iterator) whole.push(decodedChunk)
  assert.equal(whole.join(' '), 'I 💞 Nostr')

  async function * asyncIterator () {
    for (const chunk of encodedChunks) {
      await Promise.resolve()
      yield chunk
    }
  }
  iterator = new Base122Decoder(asyncIterator, { mimeType: 'text/plain' }).getDecoded()
  whole = []
  for await (const decodedChunk of iterator) whole.push(decodedChunk)
  assert.equal(whole.join(' '), 'I 💞 Nostr')
})
