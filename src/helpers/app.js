import { bytesToBase36 } from '#helpers/base36.js'

// 63 - (1<channel> + 5<b36loggeduserpkslug> 50<b36pk>)
// <b36loggeduserpkslug> pk chars at positions [7][17][27][37][47]
// to avoid vanity or pow colisions
export const NOSTR_APP_D_TAG_MAX_LENGTH = 7

export function isNostrAppDTagSafe (string) {
  return isSubdomainSafe(string) && string.length <= NOSTR_APP_D_TAG_MAX_LENGTH
}

function isSubdomainSafe (string) {
  return /(?:^[a-z0-9]$)|(?:^(?!.*--)[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$)/.test(string)
}

export function deriveNostrAppDTag (string) {
  return toSubdomainSafe(string, NOSTR_APP_D_TAG_MAX_LENGTH)
}

async function toSubdomainSafe (string, maxStringLength) {
  const byteLength = baseMaxLengthToMaxSourceByteLength(maxStringLength, 36)
  const bytes = (await toSha1(string)).slice(0, byteLength)
  return bytesToBase36(bytes, maxStringLength)
}

async function toSha1 (string) {
  const bytes = new TextEncoder().encode(string)
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))
}

// baseMaxLengthToMaxSourceByteLength(19, 62) === 14 byte length
// baseMaxLengthToMaxSourceByteLength(7, 36) === 4 byte length
function baseMaxLengthToMaxSourceByteLength (maxStringLength, base) {
  if (!base) throw new Error('Which base?')
  const baseLog = Math.log(base)
  const log256 = Math.log(256)

  const maxByteLength = (maxStringLength * baseLog) / log256

  return Math.floor(maxByteLength)
}
