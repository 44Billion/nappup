// Receives a stream and yields Uint8Array binary chunks of a given size.
// The last chunk may be smaller than the chunkSize.
export async function * streamToChunks (stream, chunkSize) {
  let buffer = new Uint8Array(0)

  for await (const chunk of stream) {
    const newBuffer = new Uint8Array(buffer.length + chunk.length)
    newBuffer.set(buffer)
    newBuffer.set(chunk, buffer.length)
    buffer = newBuffer

    while (buffer.length >= chunkSize) {
      const chunkToYield = buffer.slice(0, chunkSize)
      buffer = buffer.slice(chunkSize)
      yield chunkToYield
    }
  }

  if (buffer.length > 0) yield buffer
}
