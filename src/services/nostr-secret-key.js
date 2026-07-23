import { getPublicKey } from 'libp2r2p/key'
import { base16ToBytes } from 'libp2r2p/base16'
import { nsecDecode } from 'libp2r2p/nip19'
import { parseBunkerSessionUrl } from '#services/bunker-url.js'

const HEX_32 = /^[0-9a-f]{64}$/i

export function validateNostrSecretKey (value) {
  if (typeof value !== 'string' || !value) throw new Error('Invalid NOSTR_SECRET_KEY')
  if (value.startsWith('bunker://')) {
    parseBunkerSessionUrl(value)
    return value
  }

  let hex = value
  try {
    if (value.startsWith('nsec1')) hex = nsecDecode(value)
    if (!HEX_32.test(hex)) throw new Error()
    getPublicKey(base16ToBytes(hex))
  } catch {
    throw new Error('Invalid NOSTR_SECRET_KEY')
  }
  return value
}
