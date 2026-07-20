import { parseBunkerUrl } from 'libp2r2p/nip46'
import { normalizeClientKey } from '#services/bunker-session-codec.js'

export function parseBunkerSessionUrl (input) {
  let url
  try {
    url = new URL(input)
  } catch {
    throw new Error('Invalid bunker URL')
  }
  if (url.protocol !== 'bunker:') throw new Error('Invalid bunker URL')
  if (url.searchParams.getAll('secret').length > 1) throw new Error('Bunker URL must not contain multiple secrets')
  if (url.searchParams.getAll('relay').length === 0) {
    throw new Error('Bunker URL must include at least one relay (?relay=wss://...)')
  }

  let clientKey = null
  if (url.hash) {
    const fragment = new URLSearchParams(url.hash.slice(1))
    const keys = [...fragment.keys()]
    const values = fragment.getAll('client_key')
    if (keys.some(key => key !== 'client_key') || values.length !== 1) {
      throw new Error('Invalid bunker URL fragment')
    }
    clientKey = normalizeClientKey(values[0])
    url.hash = ''
  }

  const pointer = parseBunkerUrl(url.toString())
  if (!pointer) throw new Error('Invalid bunker URL')
  return { pointer, clientKey }
}
