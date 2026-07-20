import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { base16ToBytes, bytesToBase16 } from 'libp2r2p/base16'
import { base64UrlToBytes, bytesToBase64Url } from 'libp2r2p/base64'
import { parseBunkerUrl, toBunkerUrl } from 'libp2r2p/nip46'
import {
  dotenvPath,
  readDotenvValues,
  setDotenvValue
} from '#services/dotenv.js'

export const LAST_CLI_BUNKER_SESSION = 'LAST_CLI_BUNKER_SESSION'

const HEX_32 = /^[0-9a-f]{64}$/
const BASE64_URL = /^[A-Za-z0-9_-]+$/

function normalizeClientKey (value) {
  if (typeof value !== 'string') throw new Error('Invalid bunker client key')
  const normalized = value.toLowerCase()
  if (!HEX_32.test(normalized)) throw new Error('Invalid bunker client key')
  try {
    getPublicKey(base16ToBytes(normalized))
  } catch {
    throw new Error('Invalid bunker client key')
  }
  return normalized
}

function normalizePubkey (value, label = 'Invalid bunker public key') {
  const normalized = typeof value === 'string' ? value.toLowerCase() : ''
  if (!HEX_32.test(normalized)) throw new Error(label)
  return normalized
}

function uniqueStrings (values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value))]
}

export function parseBunkerSessionUrl (input) {
  let url
  try {
    url = new URL(input)
  } catch {
    throw new Error('Invalid bunker URL')
  }
  if (url.protocol !== 'bunker:') throw new Error('Invalid bunker URL')
  if (url.searchParams.getAll('secret').length > 1) throw new Error('Bunker URL must not contain multiple secrets')
  if (url.searchParams.getAll('relay').length === 0) {
    throw new Error('Bunker URL must include at least one relay (?relay=wss://...)')
  }

  let clientKey = null
  if (url.hash) {
    const fragment = new URLSearchParams(url.hash.slice(1))
    const keys = [...fragment.keys()]
    const values = fragment.getAll('client_key')
    if (keys.some(key => key !== 'client_key') || values.length !== 1) {
      throw new Error('Invalid bunker URL fragment')
    }
    clientKey = normalizeClientKey(values[0])
    url.hash = ''
  }

  const pointer = parseBunkerUrl(url.toString())
  if (!pointer) throw new Error('Invalid bunker URL')
  return { pointer, clientKey }
}

function encodeCliSession (session) {
  const value = JSON.stringify({
    remoteSignerPubkey: session.remoteSignerPubkey,
    relays: session.relays,
    secret: session.secret,
    clientKey: session.clientKey,
    userPubkey: session.userPubkey
  })
  return bytesToBase64Url(new TextEncoder().encode(value))
}

function decodeCliSession (encoded) {
  if (typeof encoded !== 'string' || !BASE64_URL.test(encoded)) throw new Error('Invalid CLI bunker session')
  const bytes = base64UrlToBytes(encoded)
  if (bytesToBase64Url(bytes) !== encoded) throw new Error('Invalid CLI bunker session')

  let value
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('Invalid CLI bunker session')
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid CLI bunker session')
  const remoteSignerPubkey = normalizePubkey(value.remoteSignerPubkey, 'Invalid CLI bunker session')
  const relays = uniqueStrings(Array.isArray(value.relays) ? value.relays : [])
  if (!relays.length) throw new Error('Invalid CLI bunker session')
  let secret = null
  if (value.secret !== null) {
    if (typeof value.secret !== 'string' || !value.secret) throw new Error('Invalid CLI bunker session')
    secret = value.secret
  }
  const clientKey = normalizeClientKey(value.clientKey)
  const userPubkey = value.userPubkey === null
    ? null
    : normalizePubkey(value.userPubkey, 'Invalid CLI bunker session')

  return { remoteSignerPubkey, relays, secret, clientKey, userPubkey }
}

function readCliSession (filePath, onWarning) {
  const encoded = readDotenvValues(filePath)[LAST_CLI_BUNKER_SESSION]
  if (!encoded) return null
  try {
    return decodeCliSession(encoded)
  } catch (error) {
    onWarning?.(`Ignoring invalid ${LAST_CLI_BUNKER_SESSION}: ${error.message}`)
    return null
  }
}

function cacheMatchesInput (cache, parsed) {
  if (!cache || cache.remoteSignerPubkey !== parsed.pointer.remoteSignerPubkey) return false
  if (parsed.clientKey) return cache.clientKey === parsed.clientKey
  return parsed.pointer.secret ? cache.secret === parsed.pointer.secret : true
}

export function persistBunkerSession (session) {
  if (session.source === 'dotenv') {
    const url = new URL(toBunkerUrl({
      remoteSignerPubkey: session.remoteSignerPubkey,
      relays: session.relays,
      secret: session.secret
    }))
    url.hash = new URLSearchParams({ client_key: session.clientKey }).toString()
    setDotenvValue('NOSTR_SECRET_KEY', url.toString(), {
      filePath: session.filePath,
      updateProcessEnv: true
    })
    return
  }

  setDotenvValue(LAST_CLI_BUNKER_SESSION, encodeCliSession(session), {
    filePath: session.filePath,
    updateProcessEnv: true
  })
}

export function prepareBunkerSession (bunkerUrl, {
  source = 'cli',
  filePath = dotenvPath,
  onWarning = console.warn,
  generateClientKey = generateSecretKey
} = {}) {
  if (source !== 'cli' && source !== 'dotenv') throw new Error('Invalid bunker session source')
  const parsed = parseBunkerSessionUrl(bunkerUrl)
  const cache = source === 'cli' ? readCliSession(filePath, onWarning) : null
  const matchingCache = cacheMatchesInput(cache, parsed) ? cache : null

  let clientKey = parsed.clientKey || matchingCache?.clientKey || null
  const reusedClientKey = Boolean(clientKey)
  if (!clientKey) clientKey = normalizeClientKey(bytesToBase16(generateClientKey()))

  const session = {
    source,
    filePath,
    remoteSignerPubkey: parsed.pointer.remoteSignerPubkey,
    relays: uniqueStrings([...parsed.pointer.relays, ...(matchingCache?.relays || [])]),
    secret: parsed.pointer.secret || matchingCache?.secret || null,
    clientKey,
    userPubkey: matchingCache?.userPubkey || null,
    reusedClientKey
  }
  persistBunkerSession(session)
  return session
}
