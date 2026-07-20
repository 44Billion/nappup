import { generateSecretKey } from 'nostr-tools/pure'
import { bytesToBase16 } from 'libp2r2p/base16'
import { toBunkerUrl } from 'libp2r2p/nip46'
import {
  dotenvPath,
  DotenvDecryptionError,
  readEncryptedDotenvValue,
  setEncryptedDotenvValue
} from '#services/dotenv.js'
import {
  decodeCliSession,
  encodeCliSession,
  normalizeClientKey
} from '#services/bunker-session-codec.js'
import { parseBunkerSessionUrl } from '#services/bunker-url.js'

export const LAST_CLI_BUNKER_SESSION = 'LAST_CLI_BUNKER_SESSION'

function uniqueStrings (values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value))]
}

function readCliSession (filePath, onWarning) {
  let encoded
  try {
    encoded = readEncryptedDotenvValue(LAST_CLI_BUNKER_SESSION, { filePath, onWarning })
  } catch (error) {
    if (error instanceof DotenvDecryptionError) throw error
    onWarning?.(`Ignoring invalid ${LAST_CLI_BUNKER_SESSION}: ${error.message}`)
    return null
  }
  if (!encoded) return null
  try {
    return decodeCliSession(encoded)
  } catch (error) {
    onWarning?.(`Ignoring invalid ${LAST_CLI_BUNKER_SESSION}: ${error.message}`)
    return null
  }
}

function cacheMatchesInput (cache, parsed) {
  if (!cache || cache.remoteSignerPubkey !== parsed.pointer.remoteSignerPubkey) return false
  if (parsed.clientKey) return cache.clientKey === parsed.clientKey
  return parsed.pointer.secret ? cache.secret === parsed.pointer.secret : true
}

export function persistBunkerSession (session) {
  if (session.source === 'dotenv') {
    const url = new URL(toBunkerUrl({
      remoteSignerPubkey: session.remoteSignerPubkey,
      relays: session.relays,
      secret: session.secret
    }))
    url.hash = new URLSearchParams({ client_key: session.clientKey }).toString()
    setEncryptedDotenvValue('NOSTR_SECRET_KEY', url.toString(), {
      filePath: session.filePath,
      updateProcessEnv: true
    })
    return
  }

  setEncryptedDotenvValue(LAST_CLI_BUNKER_SESSION, encodeCliSession(session), {
    filePath: session.filePath,
    updateProcessEnv: true
  })
}

export { parseBunkerSessionUrl } from '#services/bunker-url.js'

export function prepareBunkerSession (bunkerUrl, {
  source = 'cli',
  filePath = dotenvPath,
  onWarning = console.warn,
  generateClientKey = generateSecretKey
} = {}) {
  if (source !== 'cli' && source !== 'dotenv') throw new Error('Invalid bunker session source')
  const parsed = parseBunkerSessionUrl(bunkerUrl)
  const cache = source === 'cli' ? readCliSession(filePath, onWarning) : null
  const matchingCache = cacheMatchesInput(cache, parsed) ? cache : null

  let clientKey = parsed.clientKey || matchingCache?.clientKey || null
  const reusedClientKey = Boolean(clientKey)
  if (!clientKey) clientKey = normalizeClientKey(bytesToBase16(generateClientKey()))

  const session = {
    source,
    filePath,
    remoteSignerPubkey: parsed.pointer.remoteSignerPubkey,
    relays: uniqueStrings([...parsed.pointer.relays, ...(matchingCache?.relays || [])]),
    secret: parsed.pointer.secret || matchingCache?.secret || null,
    clientKey,
    reusedClientKey
  }
  persistBunkerSession(session)
  return session
}
