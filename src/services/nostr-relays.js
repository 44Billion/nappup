import { relayPool } from 'libp2r2p/relay'

export const seedRelays = [
  'wss://relay.44billion.net',
  'wss://purplepag.es',
  'wss://user.kindpag.es',
  'wss://relay.nos.social',
  'wss://nostr.land',
  'wss://indexer.coracle.social'
]
export const freeRelays = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.damus.io'
]
export const nappRelays = ['wss://relay.44billion.net']

// sendEvent returns quickly after the first successful publish. Upload flows
// need the terminal per-relay report so retries and replication stay correct.
export async function sendEventReport (event, relays, options) {
  const result = await relayPool.sendEvent(event, relays, options)
  return await (result?.promise ?? result)
}

export default relayPool
