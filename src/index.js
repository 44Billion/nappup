import NMMR from 'nmmr'
import { appEncode } from '#helpers/nip19.js'
import Base93Encoder from '#services/base93-encoder.js'
import nostrRelays from '#services/nostr-relays.js'
import NostrSigner from '#services/nostr-signer.js'
import { streamToChunks } from '#helpers/stream.js'
import { isNostrAppDTagSafe, deriveNostrAppDTag } from '#helpers/app.js'

export default async function (...args) {
  try {
    return await toApp(...args)
  } finally {
    await nostrRelays.disconnectAll()
  }
}

export async function toApp (fileList, nostrSigner, { log = () => {}, dTag, channel = 'main', shouldReupload = false } = {}) {
  if (!nostrSigner && typeof window !== 'undefined') nostrSigner = window.nostr
  if (!nostrSigner) throw new Error('No Nostr signer found')
  if (typeof window !== 'undefined' && nostrSigner === window.nostr) {
    nostrSigner.getRelays = NostrSigner.prototype.getRelays
  }
  const writeRelays = (await nostrSigner.getRelays()).write
  log(`Found ${writeRelays.length} outbox relays for pubkey ${nostrSigner.getPublicKey()}:\n${writeRelays.join(', ')}`)
  if (writeRelays.length === 0) throw new Error('No outbox relays found')

  if (typeof dTag === 'string') {
    if (!isNostrAppDTagSafe(dTag)) throw new Error('dTag should be [A-Za-z0-9] with length ranging from 1 to 19')
  } else {
    dTag = fileList[0].webkitRelativePath.split('/')[0].trim()
    if (!isNostrAppDTagSafe(dTag)) dTag = deriveNostrAppDTag(dTag || Math.random().toString(36))
  }
  let nmmr
  const fileMetadata = []

  log(`Processing ${fileList.length} files`)
  let pause = 1000
  for (const file of fileList) {
    nmmr = new NMMR()
    const stream = file.stream()

    let chunkLength = 0
    for await (const chunk of streamToChunks(stream, 51000)) {
      chunkLength++
      nmmr.append(chunk)
    }
    if (chunkLength) {
      // remove root dir
      const filename = file.webkitRelativePath.split('/').slice(1).join('/')
      log(`Uploading ${chunkLength} file parts of ${filename}`)
      ;({ pause } = (await uploadBinaryDataChunks({ nmmr, signer: nostrSigner, filename, chunkLength, log, pause, mimeType: file.type || 'application/octet-stream', shouldReupload })))
      fileMetadata.push({
        rootHash: nmmr.getRoot(),
        filename,
        mimeType: file.type || 'application/octet-stream'
      })
    }
  }

  log(`Uploading bundle #${dTag}`)
  const bundle = await uploadBundle({ dTag, channel, fileMetadata, signer: nostrSigner, pause })

  const appEntity = appEncode({
    dTag: bundle.tags.find(v => v[0] === 'd')[1],
    pubkey: bundle.pubkey,
    relays: [],
    kind: bundle.kind
  })
  log(`Visit at https://44billion.net/${appEntity}`)
}

async function uploadBinaryDataChunks ({ nmmr, signer, filename, chunkLength, log, pause = 0, mimeType, shouldReupload = false }) {
  const writeRelays = (await signer.getRelays()).write
  let chunkIndex = 0
  for await (const chunk of nmmr.getChunks()) {
    const dTag = chunk.x
    const currentCtag = `${chunk.rootX}:${chunk.index}`
    const { otherCtags, hasCurrentCtag } = await getPreviousCtags(dTag, currentCtag, writeRelays, signer)
    if (!shouldReupload && hasCurrentCtag) {
      log(`${filename}: Skipping chunk ${++chunkIndex} of ${chunkLength} (already uploaded)`)
      continue
    }
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
      created_at: Math.floor(Date.now() / 1000)
    }

    const event = await signer.signEvent(binaryDataChunk)
    log(`${filename}: Uploading file part ${++chunkIndex} of ${chunkLength} to ${writeRelays.length} relays`)
    ;({ pause } = (await throttledSendEvent(event, writeRelays, { pause, log, trailingPause: true })))
  }
  return { pause }
}

async function throttledSendEvent (event, relays, {
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

  const [rateLimitErrors, unretryableErrors] =
    errors.reduce((r, v) => {
      if ((v.reason?.message ?? '').startsWith('rate-limited:')) r[0].push(v)
      else r[1].push(v)
      return r
    }, [[], []])
  log(`${unretryableErrors.length} Unretryable errors\n: ${unretryableErrors.map(v => `${v.relay}: ${v.reason.message}`).join('; ')}`)
  const unretryableErrorsLength = errors.length - rateLimitErrors.length
  const maybeSuccessfulRelays = relays.length - unretryableErrorsLength
  const hasReachedMaxRetries = retries > maxRetries
  if (
    hasReachedMaxRetries ||
    maybeSuccessfulRelays < minSuccessfulRelays
  ) throw new Error(errors.map(v => `\n${v.relay}: ${v.reason}`).join('\n'))

  if (rateLimitErrors.length === 0) {
    if (pause && trailingPause) await new Promise(resolve => setTimeout(resolve, pause))
    return { pause }
  }

  const erroedRelays = rateLimitErrors.map(v => v.relay)
  log(`Rate limited by ${erroedRelays.length} relays, pausing for ${pause + 2000} ms`)
  await new Promise(resolve => setTimeout(resolve, (pause += 2000)))

  minSuccessfulRelays = Math.max(0, minSuccessfulRelays - (relays.length - erroedRelays.length))
  return await throttledSendEvent(event, erroedRelays, {
    pause, log, retries: ++retries, maxRetries, minSuccessfulRelays, leadingPause: false, trailingPause
  })
}

async function getPreviousCtags (dTagValue, currentCtagValue, writeRelays, signer) {
  const storedEvents = (await nostrRelays.getEvents({
    kinds: [34600],
    authors: [await signer.getPublicKey()],
    '#d': [dTagValue],
    limit: 1
  }, writeRelays)).result

  let hasCurrentCtag = false
  const hasEvent = storedEvents.length > 0
  if (!hasEvent) return { otherCtags: [], hasEvent, hasCurrentCtag }

  const cTagValues = { [currentCtagValue]: true }
  const prevTags = storedEvents.sort((a, b) => b.created_at - a.created_at)[0].tags
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

  return { otherCtags, hasEvent, hasCurrentCtag }
}

async function uploadBundle ({ dTag, channel, fileMetadata, signer, pause = 0 }) {
  const kind = {
    main: 37448, // stable
    next: 37449, // insider
    draft: 37450 // vibe coded preview
  }[channel] ?? 37448
  const appBundle = {
    kind,
    tags: [
      ['d', dTag],
      ...fileMetadata.map(v => ['file', v.rootHash, v.filename, v.mimeType])
    ],
    content: '',
    created_at: Math.floor(Date.now() / 1000)
  }
  const event = await signer.signEvent(appBundle)
  await throttledSendEvent(event, (await signer.getRelays()).write, { pause, trailingPause: true })
  return event
}
