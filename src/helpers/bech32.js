const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

const ALPHABET_MAP = {}
for (let z = 0; z < ALPHABET.length; z++) {
  const x = ALPHABET.charAt(z)
  ALPHABET_MAP[x] = z
}

function polymod (values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (let p = 0; p < values.length; ++p) {
    const top = chk >> 25
    chk = (chk & 0x1ffffff) << 5 ^ values[p]
    for (let i = 0; i < 5; ++i) {
      if ((top >> i) & 1) {
        chk ^= GEN[i]
      }
    }
  }
  return chk
}

function hrpExpand (hrp) {
  const ret = []
  for (let p = 0; p < hrp.length; ++p) {
    ret.push(hrp.charCodeAt(p) >> 5)
  }
  ret.push(0)
  for (let p = 0; p < hrp.length; ++p) {
    ret.push(hrp.charCodeAt(p) & 31)
  }
  return ret
}

function verifyChecksum (hrp, data) {
  return polymod(hrpExpand(hrp).concat(data)) === 1
}

function createChecksum (hrp, data) {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0])
  const mod = polymod(values) ^ 1
  const ret = []
  for (let p = 0; p < 6; ++p) {
    ret.push((mod >> 5 * (5 - p)) & 31)
  }
  return ret
}

export function encode (hrp, data) {
  const combined = data.concat(createChecksum(hrp, data))
  let ret = hrp + '1'
  for (let p = 0; p < combined.length; ++p) {
    ret += ALPHABET.charAt(combined[p])
  }
  return ret
}

export function decode (bechString, limit = 90) {
  let p
  let hasLower = false
  let hasUpper = false
  for (p = 0; p < bechString.length; ++p) {
    if (bechString.charCodeAt(p) < 33 || bechString.charCodeAt(p) > 126) {
      return null
    }
    if (bechString.charCodeAt(p) >= 97 && bechString.charCodeAt(p) <= 122) {
      hasLower = true
    }
    if (bechString.charCodeAt(p) >= 65 && bechString.charCodeAt(p) <= 90) {
      hasUpper = true
    }
  }
  if (hasLower && hasUpper) {
    return null
  }
  bechString = bechString.toLowerCase()
  const pos = bechString.lastIndexOf('1')
  if (pos < 1 || pos + 7 > bechString.length || bechString.length > limit) {
    return null
  }
  const hrp = bechString.substring(0, pos)
  const data = []
  for (p = pos + 1; p < bechString.length; ++p) {
    const d = ALPHABET_MAP[bechString.charAt(p)]
    if (d === undefined) {
      return null
    }
    data.push(d)
  }
  if (!verifyChecksum(hrp, data)) {
    return null
  }
  return { hrp, data: data.slice(0, data.length - 6) }
}

export function toWords (data) {
  let value = 0
  let bits = 0
  const maxV = 31
  const result = []
  for (let i = 0; i < data.length; ++i) {
    value = (value << 8) | data[i]
    bits += 8
    while (bits >= 5) {
      bits -= 5
      result.push((value >> bits) & maxV)
    }
  }
  if (bits > 0) {
    result.push((value << (5 - bits)) & maxV)
  }
  return result
}

export function fromWords (data) {
  let value = 0
  let bits = 0
  const maxV = 255
  const result = []
  for (let i = 0; i < data.length; ++i) {
    const element = data[i]
    value = (value << 5) | element
    bits += 5
    while (bits >= 8) {
      bits -= 8
      result.push((value >> bits) & maxV)
    }
  }
  return result
}
