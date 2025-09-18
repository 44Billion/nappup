import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToBase16, base16ToBytes } from '#helpers/base16.js'
import { getPublicKey } from 'nostr-tools/pure'

function serializeEvent (event) {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ])
}

function getEventHash (event) {
  return sha256(new TextEncoder().encode(serializeEvent(event)))
}

function getSignature (eventHash, privkey) {
  return bytesToBase16(schnorr.sign(eventHash, privkey))
}

export function finalizeEvent (event, privkey, withSig = true) {
  event.pubkey ??= getPublicKey(privkey)
  const eventHash = event.id ? base16ToBytes(event.id) : getEventHash(event)
  event.id ??= bytesToBase16(eventHash)
  if (withSig) event.sig ??= getSignature(eventHash, privkey)
  else delete event.sig
  return event
}
