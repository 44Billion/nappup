import NMMR from 'nmmr'
import { naddrEncode } from 'nostr-tools/nip19'
import Base122Encoder from '#services/base122-encoder.js'
import nostrRelays from '#services/nostr-relays.js'
import NostrSigner from '#services/nostr-signer.js'
import { streamToChunks } from '#helpers/stream.js'

export default async function toApp (fileList, nostrSigner, { log = () => {}, appId } = {}) {
  if (!nostrSigner && typeof window !== 'undefined') nostrSigner = window.nostr
  if (!nostrSigner) throw new Error('No Nostr signer found')
  if (nostrSigner === window.nostr) {
    nostrSigner.getRelays = NostrSigner.prototype.getRelays
  }

  appId ||= fileList[0].webkitRelativePath.split('/')[0]
  appId = appId.trim().replace(/[\s-]/g, '').toLowerCase().slice(0, 32)
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
      const filename = '/' + file.webkitRelativePath.split('/').slice(1).join('/')
      log(`Uploading ${chunkLength} file parts of ${filename}`)
      await uploadBinaryDataChunks(nmmr, nostrSigner, { mimeType: file.type })
      fileMetadata.push({
        rootHash: nmmr.getRoot(),
        filename,
        mimeType: file.type
      })
    }
  }

  log(`Uploading bundle #${appId}`)
  const bundle = await uploadBundle(appId, fileMetadata, nostrSigner)

  const naddr = naddrEncode({
    identifier: bundle.tags.find(v => v[0] === 'd')[1],
    pubkey: bundle.pubkey,
    relays: [],
    kind: bundle.kind
  })
  log(`Visit at https://44billion.net/${naddr}`)
}

async function uploadBinaryDataChunks (nmmr, signer, { mimeType } = {}) {
  const writeRelays = (await signer.getRelays()).write
  for await (const chunk of nmmr.getChunks()) {
    const binaryDataChunk = {
      kind: 34600,
      tags: [
        ['d', chunk.x],
        ['c', `${chunk.rootX}:${chunk.index}`, chunk.length, ...chunk.proof],
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

async function uploadBundle (appId, fileMetadata, signer) {
  const appBundle = {
    kind: 37448,
    tags: [
      ['d', appId],
      fileMetadata.map(v => ['file', v.rootHash, v.filename, v.mimeType])
    ],
    content: '',
    created_at: Math.floor(Date.now() / 1000)
  }
  const event = await signer.signEvent(appBundle)
  await nostrRelays.sendEvent(event, (await signer.getRelays()).write)
  return event
}
