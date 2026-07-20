import { BunkerSigner } from 'libp2r2p/nip46'
import { base16ToBytes } from 'libp2r2p/base16'
import { getRelays } from '#helpers/signer.js'
import {
  persistBunkerSession,
  prepareBunkerSession
} from '#services/bunker-session.js'

const createToken = Symbol('createToken')
const DEFAULT_CONNECT_TIMEOUT = 5_000
const DEFAULT_REQUEST_TIMEOUT = 30_000

function alreadyConnected (error) {
  return /already connected/i.test(typeof error === 'string' ? error : error?.message || '')
}

async function closeQuietly (bunker) {
  try {
    await bunker?.close()
  } catch {}
}

async function runWithDeadline (operation, timeout, timeoutMessage, onFailure) {
  const controller = new AbortController()
  let timer
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeout)
  })
  const pending = Promise.resolve().then(() => operation(controller.signal))

  try {
    return await Promise.race([pending, deadline])
  } catch (error) {
    controller.abort()
    await onFailure?.()
    await pending.catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function openBunker (session, secret, {
  bunkerFactory,
  connectTimeout
}) {
  const bunker = bunkerFactory(base16ToBytes(session.clientKey), {
    remoteSignerPubkey: session.remoteSignerPubkey,
    relays: session.relays,
    secret
  })

  await runWithDeadline(async signal => {
    try {
      await bunker.connect({
        clientMetadata: { name: 'nappup' },
        signal
      })
    } catch (error) {
      if (!alreadyConnected(error)) throw error
      await bunker.getPublicKey({ signal })
    }
  }, connectTimeout, 'Bunker connection timed out', () => closeQuietly(bunker))

  return bunker
}

export default class NostrBunkerSigner {
  #bunker
  #publicKey // hex, cached

  constructor (token, bunker, publicKey) {
    if (token !== createToken) throw new Error('Use NostrBunkerSigner.create(bunkerUrl) to instantiate this class.')
    this.#bunker = bunker
    this.#publicKey = publicKey
  }

  static async create (bunkerUrl, {
    source = 'cli',
    dotenvFilePath,
    connectTimeout = DEFAULT_CONNECT_TIMEOUT,
    requestTimeout = DEFAULT_REQUEST_TIMEOUT,
    onWarning = console.warn,
    generateClientKey,
    bunkerFactory = (clientKey, pointer) => BunkerSigner.fromBunker(clientKey, pointer)
  } = {}) {
    const session = prepareBunkerSession(bunkerUrl, {
      source,
      ...(dotenvFilePath ? { filePath: dotenvFilePath } : {}),
      onWarning,
      ...(generateClientKey ? { generateClientKey } : {})
    })

    let bunker
    try {
      if (session.reusedClientKey) {
        try {
          bunker = await openBunker(session, null, { bunkerFactory, connectTimeout })
        } catch (error) {
          if (!session.secret) throw error
          bunker = await openBunker(session, session.secret, { bunkerFactory, connectTimeout })
        }
      } else {
        bunker = await openBunker(session, session.secret, { bunkerFactory, connectTimeout })
      }

      const publicKey = await runWithDeadline(
        signal => bunker.getPublicKey({ timeout: requestTimeout, signal }),
        requestTimeout,
        'Bunker public key request timed out',
        () => closeQuietly(bunker)
      )

      session.relays = [...bunker.pointer.relays]
      session.userPubkey = publicKey
      try {
        persistBunkerSession(session)
      } catch (error) {
        onWarning?.(`Could not persist updated bunker session: ${error.message}`)
      }
      return new this(createToken, bunker, publicKey)
    } catch (error) {
      await closeQuietly(bunker)
      throw error
    }
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
