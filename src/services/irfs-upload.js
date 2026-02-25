import nostrRelays, { nappRelays } from '#services/nostr-relays.js'
import Base93Encoder from '#services/base93-encoder.js'
import { stringifyEvent } from '#helpers/event.js'

/**
 * Uploads binary data chunks for a file to Nostr relays using the InterRelay File System (IRFS).
 *
 * Splits file content via NMMR (Nostr Merkle Mountain Range) into chunks,
 * encodes each chunk with Base93, and publishes them as kind 34600 events.
 * Supports resume via created_at cursor alignment with previously stored chunks.
 *
 * @param {object} params
 * @param {object} params.nmmr - NMMR instance with chunks already appended
 * @param {object} params.signer - Nostr signer with getPublicKey(), getRelays(), signEvent()
 * @param {string} params.filename - Display name of the file being uploaded
 * @param {number} params.chunkLength - Total number of chunks
 * @param {Function} params.log - Logging function
 * @param {number} [params.pause=0] - Current pause duration in ms (for rate-limit backoff)
 * @param {string} params.mimeType - MIME type of the file
 * @param {boolean} [params.shouldReupload=false] - Whether to force re-upload existing chunks
 * @returns {Promise<{pause: number}>} Updated pause duration
 */
export async function uploadBinaryDataChunks ({ nmmr, signer, filename, chunkLength, log, pause = 0, mimeType, shouldReupload = false }) {
  const pubkey = await signer.getPublicKey()
  const writeRelays = (await signer.getRelays()).write
  const relays = [...new Set([...writeRelays, ...nappRelays].map(r => r.trim().replace(/\/$/, '')))]

  // Find max stored created_at for this file's chunks
  const rootHash = nmmr.getRoot()
  const allCTags = Array.from({ length: chunkLength }, (_, i) => `${rootHash}:${i}`)
  let maxStoredCreatedAt = 0

  for (let i = 0; i < allCTags.length; i += 100) {
    const batch = allCTags.slice(i, i + 100)
    const storedEvents = (await nostrRelays.getEvents({
      kinds: [34600],
      authors: [pubkey],
      '#c': batch,
      limit: 1
    }, relays)).result

    if (storedEvents.length > 0) {
      const batchMaxCreatedAt = storedEvents.reduce((m, e) => Math.max(m, (e && typeof e.created_at === 'number') ? e.created_at : 0), 0)
      if (batchMaxCreatedAt > maxStoredCreatedAt) maxStoredCreatedAt = batchMaxCreatedAt
    }
  }

  // Set initial created_at based on what's higher, maxStoredCreatedAt or current time
  let createdAtCursor = (Math.max(maxStoredCreatedAt, Math.floor(Date.now() / 1000)) + chunkLength)

  let chunkIndex = 0
  for await (const chunk of nmmr.getChunks()) {
    const dTag = chunk.x
    const currentCtag = `${chunk.rootX}:${chunk.index}`
    const { otherCtags, hasCurrentCtag, foundEvent, missingRelays } = await getPreviousCtags(dTag, currentCtag, relays, signer)
    if (!shouldReupload && hasCurrentCtag) {
      // Handling of partial uploads/resumes:
      // If we are observing an existing chunk, we use its created_at to re-align our cursor
      // for the next chunks (so next chunk will be this_chunk_time - 1)
      if (foundEvent) {
        createdAtCursor = foundEvent.created_at - 1
      }

      if (missingRelays.length === 0) {
        log(`${filename}: Skipping chunk ${++chunkIndex} of ${chunkLength} (already uploaded)`)
        continue
      }
      log(`${filename}: Re-uploading chunk ${++chunkIndex} of ${chunkLength} to ${missingRelays.length} missing relays (out of ${relays.length})`)
      ;({ pause } = (await throttledSendEvent(foundEvent, missingRelays, { pause, log, trailingPause: true, minSuccessfulRelays: 0 })))
      continue
    }

    const effectiveCreatedAt = createdAtCursor
    // The lower chunk index, the higher created_at must be
    // for relays to serve chunks in the most efficient order
    createdAtCursor--

    const binaryDataChunk = {
      kind: 34600,
      tags: [
        ['d', dTag],
        ...otherCtags,
        ['c', currentCtag, chunk.length, ...chunk.proof],
        ...(mimeType ? [['m', mimeType]] : [])
      ],
      // These chunks already have the expected size of 51000 bytes
      content: new Base93Encoder().update(chunk.contentBytes).getEncoded(),
      created_at: effectiveCreatedAt
    }

    const event = await signer.signEvent(binaryDataChunk)
    const fallbackRelayCount = relays.length - writeRelays.length
    log(`${filename}: Uploading file part ${++chunkIndex} of ${chunkLength} to ${writeRelays.length} relays${fallbackRelayCount > 0 ? ` (+${fallbackRelayCount} fallback)` : ''}`)
    ;({ pause } = (await throttledSendEvent(event, relays, { pause, log, trailingPause: true })))
  }
  return { pause }
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

/**
 * Checks if a chunk (identified by its d-tag) already exists on relays.
 *
 * Returns info about existing c-tags on the stored event (for deduplication),
 * whether the current c-tag is already present, the found event itself,
 * and which relays are missing the event.
 *
 * @param {string} dTagValue - The d-tag value of the chunk event
 * @param {string} currentCtagValue - The current c-tag value (rootHash:index)
 * @param {string[]} relays - Array of relay URLs to check
 * @param {object} signer - Nostr signer with getPublicKey()
 * @returns {Promise<{otherCtags: Array, hasEvent: boolean, hasCurrentCtag: boolean, foundEvent?: object, missingRelays?: string[]}>}
 */
export async function getPreviousCtags (dTagValue, currentCtagValue, relays, signer) {
  const targetRelays = [...new Set([...relays, ...nappRelays].map(r => r.trim().replace(/\/$/, '')))]
  const storedEvents = (await nostrRelays.getEvents({
    kinds: [34600],
    authors: [await signer.getPublicKey()],
    '#d': [dTagValue],
    limit: 1
  }, targetRelays)).result

  let hasCurrentCtag = false
  const hasEvent = storedEvents.length > 0
  if (!hasEvent) return { otherCtags: [], hasEvent, hasCurrentCtag }

  const cTagValues = { [currentCtagValue]: true }
  storedEvents.sort((a, b) => b.created_at - a.created_at)
  const bestEvent = storedEvents[0]
  const prevTags = bestEvent.tags

  if (!Array.isArray(prevTags)) return { otherCtags: [], hasEvent, hasCurrentCtag }

  hasCurrentCtag = prevTags.some(tag =>
    Array.isArray(tag) &&
    tag[0] === 'c' &&
    tag[1] === currentCtagValue
  )

  const otherCtags = prevTags
    .filter(v => {
      const isCTag =
        Array.isArray(v) &&
        v[0] === 'c' &&
        typeof v[1] === 'string' &&
        /^[0-9a-f]{64}:\d+$/.test(v[1])
      if (!isCTag) return false

      const isntDuplicate = !cTagValues[v[1]]
      cTagValues[v[1]] = true
      return isCTag && isntDuplicate
    })

  const matchingEvents = storedEvents.filter(e => e.id === bestEvent.id)
  const coveredRelays = new Set(matchingEvents.map(e => e.meta?.relay).filter(Boolean))
  const missingRelays = targetRelays.filter(r => !coveredRelays.has(r))

  return { otherCtags, hasEvent, hasCurrentCtag, foundEvent: bestEvent, missingRelays }
}
