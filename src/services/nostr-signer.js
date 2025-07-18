import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as dotenv from 'dotenv'
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44'
import nostrRelays, { seedRelays, freeRelays } from '#services/nostr-relays.js'
const __dirname = fileURLToPath(new URL('.', import.meta.url))

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? `${__dirname}/../../.env` })

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

  static async create (skHex) {
    if (skHex) return new this(createToken, hexToBytes(skHex))

    let skBytes
    let isNewSk = false
    if (process.env.NOSTR_SECRET_KEY) {
      skBytes = hexToBytes(process.env.NOSTR_SECRET_KEY)
    } else {
      isNewSk = true
      skHex = generateSecretKey()
      fs.appendFileSync('.env', `NOSTR_SECRET_KEY=${skHex}\n`)
      skBytes = hexToBytes(skHex)
    }
    const ret = new this(createToken, skBytes)
    if (isNewSk) await ret.#initSk(skHex)
    return ret
  }

  async getRelays () {
    if (this.relays) return this.relays

    const relayLists = await nostrRelays.getEvents({ authors: [await this.getPublicKey()], kinds: [10002], limit: 1 }, seedRelays)
    const relayList = relayLists.sort((a, b) => b.created_at - a.created_at)[0]
    const rTags = relayList.tags.filter(v => v[0] === 'r' && /^wss?:\/\//.test(v[1]))
    if (rTags.length === 0) return (this.relays = await this.#initRelays())

    let keys
    const keyAllowList = { read: true, write: true }
    const relays = rTags.reduce((r, v) => {
      keys = [v[2]].filter(v2 => keyAllowList[v2])
      if (keys.length === 0) keys = ['read', 'write']
      keys.forEach(k => r[k].push(v[1]))
      return r
    }, { read: [], write: [] })
    Object.values(relays).forEach(v => { v.length === 0 && v.push(...freeRelays) })
    return (this.relays = relays)
  }

  async #initRelays () {
    const relays = freeRelays.slice(0, 2)
    this.relays = {
      read: relays,
      write: relays
    }
    const relayList = await this.signEvent({
      kind: 10002,
      pubkey: await this.getPublicKey(),
      tags: relays.map(v => ['r', v]),
      content: '',
      created_at: Math.floor(Date.now() / 1000)
    })
    await nostrRelays.sendEvent(relayList, [...new Set([...seedRelays, ...this.relays.write])])
    return this.relays
  }

  async #initSk () {
    const pubkey = this.getPublicKey()
    const profile = this.signEvent({
      kind: 0,
      pubkey,
      tags: [],
      content: JSON.stringify({
        name: `Publisher #${Math.random().toString(36).slice(2)}`,
        about: 'An auto-generated https://44billion.net app publisher'
      }),
      created_at: Math.floor(Date.now() / 1000)
    })
    const writeRelays = (await this.getRelays()).write
    await nostrRelays.sendEvent(profile, writeRelays)
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

function bytesToHex (uint8aBytes) {
  return Array.from(uint8aBytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes (hexString) {
  const arr = new Uint8Array(hexString.length / 2) // create result array
  for (let i = 0; i < arr.length; i++) {
    const j = i * 2
    const h = hexString.slice(j, j + 2)
    const b = Number.parseInt(h, 16) // byte, created from string part
    if (Number.isNaN(b) || b < 0) throw new Error('invalid hex')
    arr[i] = b
  }
  return arr
}

function generateSecretKey () {
  const randomBytes = crypto.getRandomValues(new Uint8Array(40))
  const B256 = 2n ** 256n // secp256k1 is short weierstrass curve
  const N = B256 - 0x14551231950b75fc4402da1732fc9bebfn // curve (group) order
  const bytesToNumber = b => BigInt('0x' + (bytesToHex(b) || '0'))
  const mod = (a, b) => { const r = a % b; return r >= 0n ? r : b + r } // mod division
  const num = mod(bytesToNumber(randomBytes), N - 1n) + 1n // takes at least n+8 bytes
  return num.toString(16).padStart(64, '0')
}
