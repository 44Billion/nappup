import { freeRelays, getRelaysByPubkey } from 'libp2r2p/relay'

export async function getRelays ({ _getRelaysByPubkey = getRelaysByPubkey } = {}) {
  if (this.relays) return this.relays

  const pubkey = await this.getPublicKey()
  const relaysByPubkey = await _getRelaysByPubkey([pubkey])
  const relays = relaysByPubkey[pubkey]
  if (!relays.read.length && !relays.write.length) {
    const defaults = freeRelays.slice(0, 2)
    relays.read.push(...defaults)
    relays.write.push(...defaults)
  }
  for (const k in relays) {
    if (relays[k].length === 0) relays[k].push(...freeRelays)
  }
  return (this.relays = relays)
}
