import NMMR from 'nmmr'
import { appEncode } from '#helpers/nip19.js'
import Base122Encoder from '#services/base122-encoder.js'
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

export async function toApp (fileList, nostrSigner, { log = () => {}, dTag, channel = 'main' } = {}) {
  if (!nostrSigner && typeof window !== 'undefined') nostrSigner = window.nostr
  if (!nostrSigner) throw new Error('No Nostr signer found')
  if (typeof window !== 'undefined' && nostrSigner === window.nostr) {
    nostrSigner.getRelays = NostrSigner.prototype.getRelays
  }

  if (typeof dTag === 'string') {
    if (!isNostrAppDTagSafe(dTag)) throw new Error('dTag should be [A-Za-z0-9] with length ranging from 1 to 19')
  } else {
    dTag = fileList[0].webkitRelativePath.split('/')[0].trim()
    if (!isNostrAppDTagSafe(dTag)) dTag = deriveNostrAppDTag(dTag || Math.random().toString(36))
  }
  let nmmr
  const fileMetadata = []

  log(`Processing ${fileList.length} files`)
  for (const file of fileList) {
    nmmr = new NMMR()
    const stream = file.stream()

    let chunkLength = 0
    for await (const chunk of streamToChunks(stream, 54600)) {
      chunkLength++
      nmmr.append(chunk)
    }
    if (chunkLength) {
      // remove root dir
      const filename = file.webkitRelativePath.split('/').slice(1).join('/')
      log(`Uploading ${chunkLength} file parts of ${filename}`)
      await uploadBinaryDataChunks(nmmr, nostrSigner, { mimeType: file.type || 'application/octet-stream' })
      fileMetadata.push({
        rootHash: nmmr.getRoot(),
        filename,
        mimeType: file.type || 'application/octet-stream'
      })
    }
  }

  log(`Uploading bundle #${dTag}`)
  const bundle = await uploadBundle(dTag, channel, fileMetadata, nostrSigner)

  const appEntity = appEncode({
    dTag: bundle.tags.find(v => v[0] === 'd')[1],
    pubkey: bundle.pubkey,
    relays: [],
    kind: bundle.kind
  })
  log(`Visit at https://44billion.net/${appEntity}`)
}

async function uploadBinaryDataChunks (nmmr, signer, { mimeType } = {}) {
  const writeRelays = (await signer.getRelays()).write
  for await (const chunk of nmmr.getChunks()) {
    const dTag = chunk.x
    const currentCtag = `${chunk.rootX}:${chunk.index}`
    const prevCTags = await getPreviousCtags(dTag, currentCtag, writeRelays, signer)
    const binaryDataChunk = {
      kind: 34600,
      tags: [
        ['d', dTag],
        ...prevCTags,
        ['c', currentCtag, chunk.length, ...chunk.proof],
        ...(mimeType ? [['m', mimeType]] : [])
      ],
      // These chunks already have the expected size of 54600 bytes
      content: new Base122Encoder().update(chunk.contentBytes).getEncoded(),
      created_at: Math.floor(Date.now() / 1000)
    }

    const event = await signer.signEvent(binaryDataChunk)
    await nostrRelays.sendEvent(event, writeRelays)
  }
}

async function getPreviousCtags (dTagValue, currentCtagValue, writeRelays, signer) {
  const storedEvents = await nostrRelays.getEvents({
    kinds: [34600],
    authors: [await signer.getPublicKey()],
    '#d': [dTagValue],
    limit: 1
  }, writeRelays)
  if (storedEvents.length === 0) return []

  const cTagValues = { [currentCtagValue]: true }
  const prevTags = storedEvents.sort((a, b) => b.created_at - a.created_at)[0].tags
  if (!Array.isArray(prevTags)) return []
  return prevTags
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
}

async function uploadBundle (dTag, channel, fileMetadata, signer) {
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
  await nostrRelays.sendEvent(event, (await signer.getRelays()).write)
  return event
}
