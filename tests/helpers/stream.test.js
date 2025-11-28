import { it } from 'node:test'
import assert from 'node:assert/strict'
import { streamToChunks, streamToText } from '#helpers/stream.js'

it('streamToText converts stream to text', async () => {
  const stream = new ReadableStream({
    start (controller) {
      controller.enqueue(new TextEncoder().encode('Hello '))
      controller.enqueue(new TextEncoder().encode('World'))
      controller.close()
    }
  })
  const text = await streamToText(stream)
  assert.strictEqual(text, 'Hello World')
})

it('streamToText handles empty stream', async () => {
  const stream = new ReadableStream({
    start (controller) {
      controller.close()
    }
  })
  const text = await streamToText(stream)
  assert.strictEqual(text, '')
})

it('streamToChunks splits stream into chunks', async () => {
  const stream = new ReadableStream({
    start (controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]))
      controller.close()
    }
  })
  const chunks = []
  for await (const chunk of streamToChunks(stream, 2)) {
    chunks.push(chunk)
  }
  assert.equal(chunks.length, 3)
  assert.deepEqual(chunks[0], new Uint8Array([1, 2]))
  assert.deepEqual(chunks[1], new Uint8Array([3, 4]))
  assert.deepEqual(chunks[2], new Uint8Array([5]))
})

// This confirms that in src/index.js, we should call .stream() twice
it('consuming stream with streamToText locks it for streamToChunks', async () => {
  const stream = new ReadableStream({
    start (controller) {
      controller.enqueue(new TextEncoder().encode('Hello'))
      controller.close()
    }
  })

  await streamToText(stream)

  try {
    for await (const _ of streamToChunks(stream, 2)) {
      // Should not enter here
    }
    assert.fail('Should have thrown')
  } catch (err) {
    assert.match(err.message, /locked/)
  }
})
