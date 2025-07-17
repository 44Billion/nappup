import { decode } from '#lib/base122.js'

// Decodes data from base122.
export default class Base122Decoder {
  textEncoder = new TextEncoder()

  constructor (source, { mimeType = '' } = {}) {
    this.sourceIterator = source?.[Symbol.iterator]?.() || source?.[Symbol.asyncIterator]?.() || source()
    this.isText = mimeType.startsWith('text/')
    if (this.isText) this.textDecoder = new TextDecoder()
  }

  // decoder generator
  * [Symbol.iterator] (base122String) {
    let bytes
    if (this.isText) {
      while (base122String) {
        bytes = this.textEncoder.encode(base122String) // from string to UInt8Array
        // stream=true avoids cutting a multi-byte character
        base122String = yield this.textDecoder.decode(new Uint8Array(decode(bytes)), { stream: true })
      }
    } else {
      while (base122String) {
        bytes = this.textEncoder.encode(base122String)
        base122String = yield new Uint8Array(decode(bytes))
      }
    }
  }

  // Gets the decoded data.
  getDecoded () { return iteratorToStream(this, this.sourceIterator) }
}

function iteratorToStream (decoder, sourceIterator) {
  return new ReadableStream({
    decoderIterator: null,
    async start (controller) {
      const { value: chunk, done } = await sourceIterator.next()
      if (done) return controller.close()

      // Pass first chunk when instantiating the decoder generator
      this.decoderIterator = decoder[Symbol.iterator](chunk)
      const { value } = this.decoderIterator.next()
      if (value) controller.enqueue(value)
    },
    async pull (controller) {
      if (!this.decoderIterator) return

      const { value: chunk, done: sourceDone } = await sourceIterator.next()
      const { value, done } = this.decoderIterator.next(chunk)

      if (value) controller.enqueue(value)
      if (done || sourceDone) controller.close()
    }
  })
}
