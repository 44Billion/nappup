import { relayPool } from 'libp2r2p/relay'
export { freeRelays, nappRelays, seedRelays } from 'libp2r2p/relay'

// sendEvent returns quickly after the first successful publish. Upload flows
// need the terminal per-relay report so retries and replication stay correct.
export async function sendEventReport (event, relays, options) {
  const result = await relayPool.sendEvent(event, relays, options)
  return await (result?.promise ?? result)
}

export default relayPool
