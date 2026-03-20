import nostrRelays, { seedRelays, freeRelays } from '#services/nostr-relays.js'

export async function getRelays () {
  if (this.relays) return this.relays

  const relayLists = (await nostrRelays.getEvents({ authors: [await this.getPublicKey()], kinds: [10002], limit: 1 }, seedRelays)).result
  const relayList = relayLists.sort((a, b) => b.created_at - a.created_at)[0]
  const rTags = (relayList?.tags ?? []).filter(v => v[0] === 'r' && /^wss?:\/\//.test(v[1]))
  if (rTags.length === 0) {
    const defaults = freeRelays.slice(0, 2)
    return (this.relays = { read: defaults, write: defaults })
  }

  let keys
  const keyAllowList = { read: true, write: true }
  const relays = rTags.reduce((r, v) => {
    keys = [v[2]].filter(v2 => keyAllowList[v2])
    if (keys.length === 0) keys = ['read', 'write']
    keys.forEach(k => r[k].push(v[1].trim().replace(/\/$/, '')))
    return r
  }, { read: [], write: [] })
  for (const k in relays) {
    if (relays[k].length === 0) relays[k].push(...freeRelays)
    relays[k] = [...new Set(relays[k])]
  }
  return (this.relays = relays)
}
