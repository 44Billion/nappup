export const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const BASE = BigInt(ALPHABET.length)
const LEADER = ALPHABET[0]
const CHAR_MAP = new Map([...ALPHABET].map((char, index) => [char, BigInt(index)]))

export function bytesToBase62 (bytes, padLength = 0) {
  if (bytes.length === 0) return ''.padStart(padLength, LEADER)

  let num = 0n
  for (const byte of bytes) {
    num = (num << 8n) + BigInt(byte)
  }

  let result = ''
  if (num === 0n) return LEADER.padStart(padLength, LEADER)

  while (num > 0n) {
    const remainder = num % BASE
    result = ALPHABET[Number(remainder)] + result
    num = num / BASE
  }

  for (const byte of bytes) {
    if (byte !== 0) break

    result = LEADER + result
  }

  return result.padStart(padLength, LEADER)
}

export function base62ToBytes (base62Str) {
  if (typeof base62Str !== 'string') { throw new Error('base62ToBytes requires a string argument') }
  if (base62Str.length === 0) return new Uint8Array()

  let leadingZeros = 0
  for (let i = 0; i < base62Str.length; i++) {
    if (base62Str[i] !== LEADER) break

    leadingZeros++
  }

  let num = 0n
  for (const char of base62Str) {
    const value = CHAR_MAP.get(char)
    if (value === undefined) { throw new Error(`Invalid character in Base62 string: ${char}`) }
    num = num * BASE + value
  }

  const bytes = []
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn))
    num = num >> 8n
  }

  const result = new Uint8Array(leadingZeros + bytes.length)
  result.set(bytes, leadingZeros)
  return result
}
