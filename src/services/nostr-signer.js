import { finalizeEvent } from 'libp2r2p/event'
import { generateSecretKey, getPublicKey } from 'libp2r2p/key'
import * as nip44 from 'libp2r2p/nip44'
import { seedRelays, freeRelays, sendEventReport } from '#services/nostr-relays.js'
import { getRelays } from '#helpers/signer.js'
import { bytesToBase16, base16ToBytes } from '#helpers/base16.js'
import { nsecDecode, nsecEncode } from 'libp2r2p/nip19'
import { ensureDotenvInitialized, setEncryptedDotenvValue } from '#services/dotenv.js'

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
      skBytes = generateSecretKey()
      setEncryptedDotenvValue('NOSTR_SECRET_KEY', nsecEncode(bytesToBase16(skBytes)))
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
    await sendEventReport(relayList, [...new Set([...seedRelays, ...relays].map(r => r.trim().replace(/\/$/, '')))])

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
    await sendEventReport(profile, relays)
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
    return nip44.encrypt(plaintext, conversationKey)
  }

  nip44Decrypt (pubkey, ciphertext) {
    const conversationKey = nip44.getConversationKey(this.#secretKey, pubkey)
    return nip44.decrypt(ciphertext, conversationKey)
  }
}
