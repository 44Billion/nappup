import { bytesToHex, hexToBytes } from '#helpers/byte.js'

export function bytesToBase62 (bytes, padLength) {
  const hex = bytesToHex(bytes)
  return hexToBase62(hex, padLength)
}

export function hexToBase62 (hex, padLength) {
  return bigIntToBase62(BigInt('0x' + hex), padLength)
}

function bigIntToBase62 (num, padLength = 0) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const base = BigInt(alphabet.length)
  if (num === 0n) return alphabet[0].padStart(padLength, alphabet[0])

  let result = ''
  let currentNum = num

  while (currentNum > 0n) {
    const remainder = currentNum % base
    result = alphabet[Number(remainder)] + result
    currentNum = currentNum / base
  }
  return result.padStart(padLength, alphabet[0])
}

export function base62ToBytes (base62Str) {
  const hexString = base62ToHex(base62Str)
  return hexToBytes(hexString)
}

export function base62ToHex (base62Str, padLength = 64 /* nostr hex key */) {
  const bigIntValue = base62ToBigInt(base62Str)
  return bigIntValue.toString(16).padStart(padLength, '0')
}

function base62ToBigInt (base62Str) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const base = BigInt(alphabet.length)
  // Create a lookup map for faster character value retrieval
  const charMap = new Map(
    [...alphabet].map((char, index) => [char, BigInt(index)])
  )

  let result = 0n
  for (const char of base62Str) {
    const value = charMap.get(char)
    if (value === undefined) {
      throw new Error(`Invalid character in Base62 string: ${char}`)
    }
    result = result * base + value
  }

  return result
}
