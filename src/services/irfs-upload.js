import nostrRelays, { nappRelays } from '#services/nostr-relays.js'
import NMMR from 'nmmr'
import { decode as base93Decode, encode as base93Encode } from 'libp2r2p/base93'
import { stringifyEvent } from '#helpers/event.js'

/**
 * Uploads binary data chunks for a file to Nostr relays using the InterRelay File System (IRFS).
 *
 * Splits file content via NMMR (Nostr Merkle Mountain Range) into chunks,
 * encodes each chunk with Base93, and publishes them as kind 34601 events.
 * Supports resume by querying the deterministic d tag of each MMR position.
 *
 * @param {object} params
 * @param {object} params.nmmr - NMMR instance with chunks already appended
 * @param {object} params.signer - Nostr signer with getPublicKey(), getRelays(), signEvent()
 * @param {string} params.filename - Display name of the file being uploaded
 * @param {number} params.chunkLength - Total number of chunks
 * @param {Function} params.log - Logging function
 * @param {number} [params.pause=0] - Current pause duration in ms (for rate-limit backoff)
 * @param {boolean} [params.shouldReupload=false] - Whether to force re-upload existing chunks
 * @returns {Promise<{pause: number}>} Updated pause duration
 */
export async function uploadBinaryDataChunks ({ nmmr, signer, filename, chunkLength, log, pause = 0, shouldReupload = false }) {
  const writeRelays = (await signer.getRelays()).write
  const relays = [...new Set([...writeRelays, ...nappRelays].map(r => r.trim().replace(/\/$/, '')))]
  const rootHash = nmmr.getRoot()
  const dTags = Array.from({ length: chunkLength }, (_, index) => NMMR.deriveChunkId(rootHash, index))
  const { eventsByD } = await getPreviousChunks(dTags, relays, signer)

  let chunkIndex = 0
  for await (const chunk of nmmr.getChunks()) {
    if (chunk.total !== chunkLength || chunk.index !== chunkIndex) {
      throw new Error('NMMR yielded inconsistent chunk metadata')
    }
    const dTag = NMMR.deriveChunkId(rootHash, chunk.index)
    const storedEvents = eventsByD.get(dTag) ?? []
    const validEvents = storedEvents.filter(event => isExpectedChunkEvent(event, { rootHash, index: chunk.index, total: chunk.total, dTag }))
      .sort(compareEventsNewestFirst)
    const foundEvent = validEvents[0]
    const coveredRelays = new Set(validEvents.filter(event => event.id === foundEvent?.id).map(event => event.meta?.relay).filter(Boolean))
    const missingRelays = relays.filter(relay => !coveredRelays.has(relay))

    if (!shouldReupload && foundEvent) {
      if (missingRelays.length === 0) {
        log(`${filename}: Skipping chunk ${++chunkIndex} of ${chunkLength} (already uploaded)`)
        continue
      }
      log(`${filename}: Re-uploading chunk ${++chunkIndex} of ${chunkLength} to ${missingRelays.length} missing relays (out of ${relays.length})`)
      ;({ pause } = (await throttledSendEvent(foundEvent, missingRelays, { pause, log, trailingPause: true, minSuccessfulRelays: 0 })))
      continue
    }

    const now = Math.floor(Date.now() / 1000)
    const newestStoredCreatedAt = storedEvents.reduce((latest, event) => Math.max(latest, Number.isSafeInteger(event.created_at) ? event.created_at : 0), 0)
    const effectiveCreatedAt = Math.max(now, newestStoredCreatedAt + 1)
    if (effectiveCreatedAt > now + 172800) throw new Error('Existing chunk timestamp is too far in the future to replace safely')

    const binaryDataChunk = {
      kind: 34601,
      tags: [
        ['d', dTag],
        ['mmr', String(chunk.index), String(chunk.total), base93Encode(chunk.proof)]
      ],
      content: base93Encode(chunk.contentBytes),
      created_at: effectiveCreatedAt
    }

    const event = await signer.signEvent(binaryDataChunk)
    const fallbackRelayCount = relays.length - writeRelays.length
    log(`${filename}: Uploading file part ${++chunkIndex} of ${chunkLength} to ${writeRelays.length} relays${fallbackRelayCount > 0 ? ` (+${fallbackRelayCount} fallback)` : ''}`)
    ;({ pause } = (await throttledSendEvent(event, relays, { pause, log, trailingPause: true })))
  }
  return { pause }
}

function compareEventsNewestFirst (a, b) {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at
  return String(a.id).localeCompare(String(b.id))
}

export function parseChunkEvent (event) {
  if (!event || event.kind !== 34601 || !Array.isArray(event.tags)) throw new Error('Wrong chunk event kind or tags')
  const dTags = event.tags.filter(tag => Array.isArray(tag) && tag[0] === 'd')
  const mmrTags = event.tags.filter(tag => Array.isArray(tag) && tag[0] === 'mmr')
  if (dTags.length !== 1 || dTags[0].length !== 2 || !/^[0-9a-f]{64}$/.test(dTags[0][1])) throw new Error('Wrong chunk d tag')
  if (mmrTags.length !== 1 || mmrTags[0].length !== 4) throw new Error('Wrong chunk mmr tag')

  const [, index, total, encodedProof] = mmrTags[0]
  const contentBytes = base93Decode(event.content)
  const proof = base93Decode(encodedProof)
  const root = NMMR.calculateRoot({ contentBytes, index, total, proof })
  const numericIndex = Number(index)
  const numericTotal = Number(total)
  if (contentBytes.length < 1 || contentBytes.length > 51000 || (numericIndex < numericTotal - 1 && contentBytes.length !== 51000)) {
    throw new Error('Wrong chunk byte length')
  }
  const d = NMMR.deriveChunkId(root, index)
  if (d !== dTags[0][1]) throw new Error('Chunk d tag mismatch')
  return { root, index: numericIndex, total: numericTotal, proof, contentBytes, d }
}

function isExpectedChunkEvent (event, expected) {
  try {
    const parsed = parseChunkEvent(event)
    return parsed.root === expected.rootHash && parsed.index === expected.index && parsed.total === expected.total && parsed.d === expected.dTag
  } catch (_) {
    return false
  }
}

/**
 * Sends a signed Nostr event to relays with retry logic and rate-limit backoff.
 *
 * Handles three error categories:
 * - Rate-limit errors: retries with increasing pause (+2000ms per retry)
 * - Timeout errors: one-time immediate retry
 * - Unretryable errors: logged and counted against success threshold
 *
 * @param {object} event - Signed Nostr event to send
 * @param {string[]} relays - Array of relay URLs
 * @param {object} opts
 * @param {number} opts.pause - Current pause duration in ms
 * @param {Function} opts.log - Logging function
 * @param {number} [opts.retries=0] - Current retry count (used internally)
 * @param {number} [opts.maxRetries=10] - Maximum number of retries
 * @param {number} [opts.minSuccessfulRelays=1] - Minimum relays that must accept the event
 * @param {boolean} [opts.leadingPause=false] - Whether to pause before sending
 * @param {boolean} [opts.trailingPause=false] - Whether to pause after successful send
 * @returns {Promise<{pause: number}>} Updated pause duration
 */
export async function throttledSendEvent (event, relays, {
  pause, log,
  retries = 0, maxRetries = 10,
  minSuccessfulRelays = 1,
  leadingPause = false, trailingPause = false
}) {
  if (pause && leadingPause) await new Promise(resolve => setTimeout(resolve, pause))
  if (retries > 0) log(`Retrying upload to ${relays.length} relays: ${relays.join(', ')}`)

  const { errors } = (await nostrRelays.sendEvent(event, relays, 15000))
  if (errors.length === 0) {
    if (pause && trailingPause) await new Promise(resolve => setTimeout(resolve, pause))
    return { pause }
  }

  const [rateLimitErrors, maybeUnretryableErrors, unretryableErrors] =
    errors.reduce((r, v) => {
      const message = v.reason?.message ?? ''
      if (message.startsWith('rate-limited:')) r[0].push(v)
      // https://github.com/nbd-wtf/nostr-tools/blob/28f7553187d201088c8a1009365db4ecbe03e568/abstract-relay.ts#L311
      else if (message === 'publish timed out') r[1].push(v)
      else r[2].push(v)
      return r
    }, [[], [], []])

  // One-time special retry
  if (maybeUnretryableErrors.length > 0) {
    const timedOutRelays = maybeUnretryableErrors.map(v => v.relay)
    log(`${maybeUnretryableErrors.length} timeout errors, retrying once after ${pause}ms:\n${maybeUnretryableErrors.map(v => `${v.relay}: ${v.reason.message}`).join('; ')}`)
    if (pause) await new Promise(resolve => setTimeout(resolve, pause))
    const { errors: timeoutRetryErrors } = await nostrRelays.sendEvent(event, timedOutRelays, 15000)
    unretryableErrors.push(...timeoutRetryErrors)
  }

  if (unretryableErrors.length > 0) {
    log(`${unretryableErrors.length} unretryable errors:\n${unretryableErrors.map(v => `${v.relay}: ${v.reason.message}`).join('; ')}`)
    console.log('Erroed event:', stringifyEvent(event))
  }
  const maybeSuccessfulRelays = relays.length - unretryableErrors.length
  const hasReachedMaxRetries = retries > maxRetries
  if (
    hasReachedMaxRetries ||
    maybeSuccessfulRelays < minSuccessfulRelays
  ) {
    const finalErrors = [...rateLimitErrors, ...unretryableErrors]
    throw new Error(finalErrors.map(v => `\n${v.relay}: ${v.reason}`).join('\n'))
  }

  if (rateLimitErrors.length === 0) {
    if (pause && trailingPause) await new Promise(resolve => setTimeout(resolve, pause))
    return { pause }
  }

  const erroedRelays = rateLimitErrors.map(v => v.relay)
  log(`Rate limited by ${erroedRelays.length} relays, pausing for ${pause + 2000} ms`)
  await new Promise(resolve => setTimeout(resolve, (pause += 2000)))

  // Subtracts the successful publishes from the original minSuccessfulRelays goal
  minSuccessfulRelays = Math.max(0, minSuccessfulRelays - (relays.length - erroedRelays.length - unretryableErrors.length))
  return await throttledSendEvent(event, erroedRelays, {
    pause, log, retries: ++retries, maxRetries, minSuccessfulRelays, leadingPause: false, trailingPause
  })
}

export async function getPreviousChunks (dTagValues, relays, signer) {
  const targetRelays = [...new Set([...relays, ...nappRelays].map(r => r.trim().replace(/\/$/, '')))]
  const eventsByD = new Map(dTagValues.map(dTag => [dTag, []]))
  const pubkey = await signer.getPublicKey()

  for (let offset = 0; offset < dTagValues.length; offset += 100) {
    const batch = dTagValues.slice(offset, offset + 100)
    const storedEvents = (await nostrRelays.getEvents({
      kinds: [34601],
      authors: [pubkey],
      '#d': batch,
      limit: batch.length
    }, targetRelays)).result

    for (const event of storedEvents) {
      const dTag = event.tags?.find(tag => tag[0] === 'd')?.[1]
      if (eventsByD.has(dTag)) eventsByD.get(dTag).push(event)
    }
  }

  return { eventsByD, targetRelays }
}
