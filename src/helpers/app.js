import { isBase36 } from '#helpers/base36.js'

// 63 - (1<channel> + 5<b36loggeduserpkslug> 50<b36pk>)
// <b36loggeduserpkslug> pk chars at positions [7][17][27][37][47]
// to avoid vanity or pow colisions
export const NOSTR_APP_D_TAG_MAX_LENGTH = 7

export function isNostrAppDTagSafe (string) {
  return string.length > 0 && string.length <= NOSTR_APP_D_TAG_MAX_LENGTH && isBase36(string)
}

export function isSubdomainSafe (string) {
  return /(?:^[a-z0-9]$)|(?:^(?!.*--)[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$)/.test(string)
}

// Maps uniformly across all 1–7 char base36 strings (36^1+…+36^7 ≈ 80.6B values)
export async function deriveNostrAppDTag (string) {
  const hash = await toSha1(string)
  // 6 bytes (2^48) >> 80.6B namespace → negligible modulo bias
  const hashNum = bytesToBigInt(hash.slice(0, 6))
  const mapped = hashNum % variableBase36TotalSpace(NOSTR_APP_D_TAG_MAX_LENGTH)
  return variableBase36FromIndex(mapped, NOSTR_APP_D_TAG_MAX_LENGTH)
}

async function toSha1 (string) {
  const bytes = new TextEncoder().encode(string)
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))
}

function bytesToBigInt (bytes) {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  return n
}

function variableBase36TotalSpace (maxLen) {
  let total = 0n
  let power = 1n
  for (let i = 0; i < maxLen; i++) {
    power *= 36n
    total += power
  }
  return total
}

function variableBase36FromIndex (num, maxLen) {
  let cumulative = 0n
  let power = 1n
  for (let len = 1; len <= maxLen; len++) {
    power *= 36n
    if (num < cumulative + power) {
      return (num - cumulative).toString(36).padStart(len, '0')
    }
    cumulative += power
  }
}
