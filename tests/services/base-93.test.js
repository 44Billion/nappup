import assert from 'node:assert/strict'
import { it } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import NMMR from 'nmmr'
import Base93Encoder from '#services/base93-encoder.js'
import Base93Decoder from '#services/base93-decoder.js'
import { streamToChunks } from '#helpers/stream.js'

// Get current file directory (equivalent to __dirname in CommonJS)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

it('encodes and decodes', async () => {
  const encodedChunks = ['I', '💞', 'Nostr']
    .map(v => new TextEncoder().encode(v))
    .map(v => new Base93Encoder().update(v).getEncoded())

  let iterator = new Base93Decoder(encodedChunks, { mimeType: 'text/plain' }).getDecoded()
  let whole = []
  for await (const decodedChunk of iterator) whole.push(decodedChunk)
  assert.equal(whole.join(' '), 'I 💞 Nostr')

  function * regularIterator () { for (const chunk of encodedChunks) yield chunk }
  iterator = new Base93Decoder(regularIterator, { mimeType: 'text/plain' }).getDecoded()
  whole = []
  for await (const decodedChunk of iterator) whole.push(decodedChunk)
  assert.equal(whole.join(' '), 'I 💞 Nostr')

  async function * asyncIterator () {
    for (const chunk of encodedChunks) {
      await Promise.resolve()
      yield chunk
    }
  }
  iterator = new Base93Decoder(asyncIterator, { mimeType: 'text/plain' }).getDecoded()
  whole = []
  for await (const decodedChunk of iterator) whole.push(decodedChunk)
  assert.equal(whole.join(' '), 'I 💞 Nostr')
})

it('encodes and decodes large CSS file in chunks', async () => {
  const fixturePath = path.resolve(__dirname, '../fixtures/services/base93/index-DCrdpmpY.css')

  // Read the original file content
  const originalContent = await fs.promises.readFile(fixturePath, 'utf8')
  const originalBytes = new TextEncoder().encode(originalContent)

  // Create a stream from the file
  const fileStream = fs.createReadStream(fixturePath)

  // Step 1: Read file into chunks
  const chunkSize = 51000
  const rawChunks = []
  for await (const chunk of streamToChunks(fileStream, chunkSize)) {
    rawChunks.push(chunk)
  }

  // Step 2: Add chunks to NMMR
  const nmmr = new NMMR()
  for (const chunk of rawChunks) {
    nmmr.append(chunk)
  }

  // Step 3: Get chunks from NMMR and encode them
  const encodedChunks = []
  for await (const chunk of nmmr.getChunks()) {
    const encoded = new Base93Encoder().update(chunk.contentBytes).getEncoded()
    encodedChunks.push(encoded)
  }

  // Step 4: Decode the encoded chunks
  const decoder = new Base93Decoder(encodedChunks, { mimeType: 'text/css', preferTextStreamDecoding: true })
  const decodedChunks = []

  for await (const chunk of decoder.getDecoded()) {
    decodedChunks.push(chunk)
  }

  // Combine the decoded chunks
  const decodedContent = decodedChunks.join('')
  const decodedBytes = new TextEncoder().encode(decodedContent)

  // Verify the byte counts match
  assert.equal(decodedBytes.length, originalBytes.length, 'Decoded and original byte lengths should match')

  // Verify each byte matches
  let allBytesMatch = true
  for (let i = 0; i < originalBytes.length; i++) {
    if (originalBytes[i] !== decodedBytes[i]) {
      allBytesMatch = false
      console.error(`Byte mismatch at position ${i}: original=${originalBytes[i]}, decoded=${decodedBytes[i]}`)
      break
    }
  }
  assert.ok(allBytesMatch, 'All bytes should match between original and decoded content')

  // Verify the final string content matches
  assert.equal(decodedContent, originalContent, 'Decoded content should match original content')
})
