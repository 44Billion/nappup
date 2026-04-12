import { generateSecretKey } from 'nostr-tools/pure'
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46'
import { getRelays } from '#helpers/signer.js'

const createToken = Symbol('createToken')

export default class NostrBunkerSigner {
  #bunker
  #publicKey // hex, cached

  constructor (token, bunker, publicKey) {
    if (token !== createToken) throw new Error('Use NostrBunkerSigner.create(bunkerUrl) to instantiate this class.')
    this.#bunker = bunker
    this.#publicKey = publicKey
  }

  static async create (bunkerUrl, { connectTimeout = 30_000 } = {}) {
    const bp = await parseBunkerInput(bunkerUrl)
    if (!bp) throw new Error('Invalid bunker URL')
    if (bp.relays.length === 0) throw new Error('Bunker URL must include at least one relay (?relay=wss://...)')

    const clientSk = generateSecretKey()
    const bunker = BunkerSigner.fromBunker(clientSk, bp)

    let timeoutHandle
    try {
      await Promise.race([
        bunker.connect(),
        new Promise((resolve, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Bunker connection timed out')), connectTimeout)
        })
      ])
    } finally {
      clearTimeout(timeoutHandle)
    }

    const publicKey = await bunker.getPublicKey()
    return new this(createToken, bunker, publicKey)
  }

  getPublicKey () {
    return this.#publicKey
  }

  signEvent (event) {
    return this.#bunker.signEvent(event)
  }

  async getRelays () {
    return getRelays.call(this)
  }

  nip44 = {
    encrypt: (pubkey, plaintext) => this.#bunker.nip44Encrypt(pubkey, plaintext),
    decrypt: (pubkey, ciphertext) => this.#bunker.nip44Decrypt(pubkey, ciphertext)
  }

  async close () {
    await this.#bunker.close()
  }
}
