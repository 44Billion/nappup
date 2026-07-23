import { getPublicKey } from 'libp2r2p/key'
import { base16ToBytes } from 'libp2r2p/base16'
import { base64UrlToBytes, bytesToBase64Url } from 'libp2r2p/base64'

const HEX_32 = /^[0-9a-f]{64}$/
const BASE64_URL = /^[A-Za-z0-9_-]+$/

export function normalizeClientKey (value) {
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

function normalizePubkey (value) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : ''
  if (!HEX_32.test(normalized)) throw new Error('Invalid CLI bunker session')
  return normalized
}

function uniqueStrings (values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value))]
}

export function encodeCliSession (session) {
  const value = JSON.stringify({
    remoteSignerPubkey: session.remoteSignerPubkey,
    relays: session.relays,
    secret: session.secret,
    clientKey: session.clientKey
  })
  return bytesToBase64Url(new TextEncoder().encode(value))
}

export function decodeCliSession (encoded) {
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
  const remoteSignerPubkey = normalizePubkey(value.remoteSignerPubkey)
  const relays = uniqueStrings(Array.isArray(value.relays) ? value.relays : [])
  if (!relays.length) throw new Error('Invalid CLI bunker session')
  let secret = null
  if (value.secret !== null) {
    if (typeof value.secret !== 'string' || !value.secret) throw new Error('Invalid CLI bunker session')
    secret = value.secret
  }
  const clientKey = normalizeClientKey(value.clientKey)

  return { remoteSignerPubkey, relays, secret, clientKey }
}
