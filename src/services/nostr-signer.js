import { getPublicKey } from 'nostr-tools/pure'
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44'
import nostrRelays, { seedRelays, freeRelays } from '#services/nostr-relays.js'
import { getRelays } from '#helpers/signer.js'
import { bytesToBase16, base16ToBytes } from '#helpers/base16.js'
import { finalizeEvent } from '#helpers/nip01.js'
import { nsecDecode, nsecEncode } from 'libp2r2p/nip19'
import { ensureDotenvInitialized, setEncryptedDotenvValue } from '#services/dotenv.js'

const nip44 = {
  getConversationKey,
  encrypt,
  decrypt
}

const createToken = Symbol('createToken')

export default class NostrSigner {
  #secretKey // bytes
  #publicKey // hex

  constructor (token, skBytes) {
    if (token !== createToken) throw new Error('Use NostrSigner.create(?sk) to instantiate this class.')
    if (!skBytes) throw new Error('Secret key missing.')

    this.#secretKey = skBytes
  }

  static async create (sk) {
    if (sk) {
      if (sk.startsWith('nsec')) sk = nsecDecode(sk)
      return new this(createToken, base16ToBytes(sk))
    }

    ensureDotenvInitialized()
    let skBytes
    let isNewSk = false
    if (process.env.NOSTR_SECRET_KEY) {
      let envSk = process.env.NOSTR_SECRET_KEY
      if (envSk.startsWith('bunker://')) throw new Error('bunker:// URLs are not supported by NostrSigner. Use NostrBunkerSigner.create() instead.')
      if (envSk.startsWith('nsec')) envSk = nsecDecode(envSk)
      skBytes = base16ToBytes(envSk)
    } else {
      isNewSk = true
      sk = generateSecretKey()
      setEncryptedDotenvValue('NOSTR_SECRET_KEY', nsecEncode(sk))
      skBytes = base16ToBytes(sk)
    }
    const ret = new this(createToken, skBytes)
    if (isNewSk) await ret.#initSk(sk)
    return ret
  }

  async getRelays () {
    return getRelays.call(this)
  }

  async #initSk () {
    const relays = freeRelays.slice(0, 2)
    this.relays = { read: relays, write: relays }
    const relayList = await this.signEvent({
      kind: 10002,
      pubkey: this.getPublicKey(),
      tags: relays.map(v => ['r', v]),
      content: '',
      created_at: Math.floor(Date.now() / 1000)
    })
    await nostrRelays.sendEvent(relayList, [...new Set([...seedRelays, ...relays].map(r => r.trim().replace(/\/$/, '')))])

    const profile = await this.signEvent({
      kind: 0,
      pubkey: this.getPublicKey(),
      tags: [],
      content: JSON.stringify({
        name: `Publisher #${Math.random().toString(36).slice(2)}`,
        about: 'An auto-generated https://44billion.net app publisher'
      }),
      created_at: Math.floor(Date.now() / 1000)
    })
    await nostrRelays.sendEvent(profile, relays)
  }

  // hex
  getPublicKey () {
    if (this.#publicKey) {
      return this.#publicKey
    }
    this.#publicKey = getPublicKey(this.#secretKey)
    return this.#publicKey
  }

  signEvent (event) {
    return finalizeEvent(event, this.#secretKey)
  }

  nip44 = {
    encrypt: this.nip44Encrypt.bind(this),
    decrypt: this.nip44Decrypt.bind(this)
  }

  nip44Encrypt (pubkey, plaintext) {
    const conversationKey = nip44.getConversationKey(this.#secretKey, pubkey)
    return nip44.encrypt(conversationKey, plaintext)
  }

  nip44Decrypt (pubkey, ciphertext) {
    const conversationKey = nip44.getConversationKey(this.#secretKey, pubkey)
    return nip44.decrypt(conversationKey, ciphertext)
  }
}

function generateSecretKey () {
  const randomBytes = crypto.getRandomValues(new Uint8Array(40))
  const B256 = 2n ** 256n // secp256k1 is short weierstrass curve
  const N = B256 - 0x14551231950b75fc4402da1732fc9bebfn // curve (group) order
  const bytesToNumber = b => BigInt('0x' + (bytesToBase16(b) || '0'))
  const mod = (a, b) => { const r = a % b; return r >= 0n ? r : b + r } // mod division
  const num = mod(bytesToNumber(randomBytes), N - 1n) + 1n // takes at least n+8 bytes
  return num.toString(16).padStart(64, '0')
}
