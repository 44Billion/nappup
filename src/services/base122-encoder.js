import { encode } from '#lib/base122.js'

// Encodes data using base122.
export default class Base122Encoder {
  textDecoder = new TextDecoder()
  // The encoded data.
  encoded = ''

  // Updates the encoded data with the given bytes.
  update (bytes) {
    this.encoded += this.textDecoder.decode(new Uint8Array(encode(bytes)))
    return this
  }

  // Gets the encoded data.
  getEncoded () {
    return this.encoded
  }
}
