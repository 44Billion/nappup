import { bytesToBase62 } from '#helpers/base62.js'

export const NOSTR_APP_D_TAG_MAX_LENGTH = 19

export function isNostrAppDTagSafe (string) {
  return isSubdomainSafe(string) && string.length <= NOSTR_APP_D_TAG_MAX_LENGTH
}

function isSubdomainSafe (string) {
  return /(?:^[A-Za-z0-9]$)|(?:^(?!.*--)[A-Za-z0-9][A-Za-z0-9-]{0,63}[A-Za-z0-9]$)/.test(string)
}

export function deriveNostrAppDTag (string) {
  return toSubdomainSafe(string, NOSTR_APP_D_TAG_MAX_LENGTH)
}

async function toSubdomainSafe (string, maxStringLength) {
  const byteLength = base62MaxLengthToMaxSourceByteLength(maxStringLength)
  const bytes = (await toSha1(string)).slice(0, byteLength)
  return bytesToBase62(bytes, maxStringLength)
}

async function toSha1 (string) {
  const bytes = new TextEncoder().encode(string)
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))
}

// base62MaxLengthToMaxSourceByteLength(19) === 14 byte length
function base62MaxLengthToMaxSourceByteLength (maxStringLength) {
  const log62 = Math.log(62)
  const log256 = Math.log(256)

  const maxByteLength = (maxStringLength * log62) / log256

  return Math.floor(maxByteLength)
}
