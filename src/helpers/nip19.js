import { bytesToBase16, base16ToBytes } from '#helpers/base16.js'
import { bytesToBase62, base62ToBytes, ALPHABET as base62Alphabet } from '#helpers/base62.js'
import { isNostrAppDTagSafe } from '#helpers/app.js'

const MAX_SIZE = 5000
export const BASE62_ENTITY_REGEX = new RegExp(`^app-[${base62Alphabet}]{,${MAX_SIZE}}$`)
export const kindByChannel = {
  main: 37448,
  next: 37449,
  draft: 37450
}
const channelEnum = Object.keys(kindByChannel)
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function appEncode (ref) {
  if (!isNostrAppDTagSafe(ref.dTag)) { throw new Error('Invalid deduplication tag') }
  const channelIndex = Object.entries(kindByChannel)
    .findIndex(([k, v]) => ref.channel ? k === ref.channel : v === ref.kind)
  if (channelIndex === -1) throw new Error('Wrong channel')
  const tlv = toTlv([
    [textEncoder.encode(ref.dTag)], // type 0 (the array index)
    (ref.relays || []).map(url => textEncoder.encode(url)), // type 1
    [base16ToBytes(ref.pubkey)], // type 2
    [uintToBytes(channelIndex)] // type 3
  ])
  const base62 = bytesToBase62(tlv)
  return `app-${base62}`
}

export function appDecode (entity) {
  const [, base62] = entity.split('-')
  const tlv = tlvToObj(base62ToBytes(base62))
  if (!tlv[0]?.[0]) throw new Error('Missing deduplication tag')
  if (!tlv[2]?.[0]) throw new Error('Missing author pubkey')
  if (tlv[2][0].length !== 32) throw new Error('Author pubkey should be 32 bytes')
  if (!tlv[3]?.[0]) throw new Error('Missing channel enum')
  if (tlv[3][0].length !== 1) throw new Error('Channel enum should be 1 byte')

  const channel = channelEnum[parseInt(tlv[3][0])]
  return {
    dTag: textDecoder.decode(tlv[0][0]),
    pubkey: bytesToBase16(tlv[2][0]),
    kind: kindByChannel[channel],
    channel,
    relays: tlv[1] ? tlv[1].map(url => textDecoder.decode(url)) : []
  }
}

// Return shortest uint8Array size (not fixed size)
function uintToBytes (n, bytes = []) {
  do { bytes.unshift(n & 255) } while ((n >>= 8) > 0)
  return new Uint8Array(bytes)
}

function toTlv (tlvConfig) {
  const arrays = []
  tlvConfig
    .map((v, i) => [i, v])
    .reverse() // if the first type is 0, entity always starts with the '0' char
    .forEach(([type, values]) => {
      // just non-empty values will be included
      values.forEach(v => {
        if (v.length > 255) throw new Error('Value is too big')
        const array = new Uint8Array(v.length + 2)
        array.set([type], 0) // t
        array.set([v.length], 1) // l
        array.set(v, 2) // v
        arrays.push(array)
      })
    })
  return new Uint8Array(arrays.reduce((r, v) => [...r, ...v]))
}

// { 0: [t0v0], 1: [t1v0, t1v2], 3: [t3v0] }
function tlvToObj (tlv) {
  const ret = {}
  let rest = tlv
  let t, l, v
  while (rest.length > 0) {
    t = rest[0]
    l = rest[1]
    v = rest.slice(2, 2 + l)
    rest = rest.slice(2 + l)
    if (v.length < l) throw new Error(`not enough data to read on TLV ${t}`)
    ret[t] ??= []
    ret[t].push(v)
  }
  return ret
}
