import NMMR from 'nmmr'
import { appEncode, npubEncode } from 'libp2r2p/nip19'
import nostrRelays from '#services/nostr-relays.js'
import { getRelays } from '#helpers/signer.js'
import { streamToChunks, streamToText } from '#helpers/stream.js'
import { isNostrAppDTagSafe, GENERIC_BUILD_FOLDER_NAMES } from '#helpers/app.js'
import { extractHtmlMetadata, findFavicon, findIndexFile } from '#helpers/app-metadata.js'
import { getBlossomServers, healthCheckServers, uploadFilesToBlossom } from '#services/blossom-upload.js'
import { uploadBinaryDataChunks } from '#services/irfs-upload.js'
import { uploadSiteManifest } from '#services/site-manifest.js'

// TL;DR
// import publishApp from 'nappup'
// await publishApp(
//   fileList,
//   window.nostr,
//   { dTag: 'My app identifier unique to this nsec', onEvent: ({ progress }) => console.log(progress) }
// )
//
// Simple usage -> onEvent: ({ progress, error }) => { if (error) { throw error } else { progressBar.style.width = `${progress}%` } }
// Geek usage ->
// onEvent: (event) => {
//   if (event.type === 'file-uploaded') console.log(`Uploaded ${event.filename} via ${event.service}`)
//   if (event.type === 'complete') console.log(`Done! Access at https://44billion.net/${event.napp}`)
//   if (event.type === 'error') console.error('Error during publishing:', event.error)
// }
//
export default async function (fileList, nostrSigner, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null
  let lastProgress = 0
  try {
    return await toApp(fileList, nostrSigner, onEvent
      ? {
          ...opts,
          onEvent (event) {
            lastProgress = event.progress ?? lastProgress
            onEvent(event)
          }
        }
      : opts)
  } catch (err) {
    if (onEvent) try { onEvent({ type: 'error', error: err, progress: lastProgress }) } catch (_) {}
    throw err
  } finally {
    await nostrRelays.disconnectAll()
  }
}

/**
 * Publishes a site to Nostr relays and/or Blossom servers.
 *
 * The optional `onEvent` callback receives structured progress events.
 * Every event has `type` (string) and `progress` (0–100 integer).
 *
 * Event types:
 *   'init'               — { totalFiles, totalSteps, dTag, relayCount, blossomCount }
 *   'media-uploaded'     — { mediaType: 'icon'|'key_art'|'screenshot', service: 'blossom'|'irfs'|null }
 *   'file-uploaded'      — { filename, service: 'blossom'|'irfs' }
 *   'manifest-published' — unified site manifest and app metadata published
 *   'complete'           — { napp } (terminal, progress === 100)
 *   'error'              — { error } (terminal, error is rethrown)
 */
export async function toApp (fileList, nostrSigner, {
  log = () => {}, onEvent = () => {}, dTag, channel = 'main', shouldReupload = false
} = {}) {
  let steps = 0
  let totalSteps = 1
  const emit = (event) => {
    try {
      onEvent({
        ...event,
        progress: event.type === 'complete' ? 100 : Math.round((steps / totalSteps) * 100)
      })
    } catch (_) {}
  }
  if (!nostrSigner && typeof window !== 'undefined') nostrSigner = window.nostr
  if (!nostrSigner) throw new Error('No Nostr signer found')
  if (typeof window !== 'undefined' && nostrSigner === window.nostr) nostrSigner.getRelays = getRelays

  const writeRelays = [...new Set((await nostrSigner.getRelays()).write
    .map(relay => relay.trim().replace(/\/$/, '')))]
  const npub = npubEncode(await nostrSigner.getPublicKey())
  log(`Found ${writeRelays.length} outbox relays for pubkey ${npub}:\n${writeRelays.join(', ')}`)
  if (!writeRelays.length) throw new Error('No outbox relays found')

  if (typeof dTag === 'string') {
    if (!isNostrAppDTagSafe(dTag)) throw new Error('dTag must be a non-empty string with at most 260 characters')
  } else {
    const folderName = fileList[0].webkitRelativePath.split('/')[0].trim()
    if (GENERIC_BUILD_FOLDER_NAMES.has(folderName.toLowerCase())) {
      throw new Error(`Folder name "${folderName}" is a generic build folder. Please provide a d tag with the -d flag.`)
    }
    dTag = folderName
    if (!isNostrAppDTagSafe(dTag)) {
      throw new Error('Could not derive a valid d tag from the folder name. Please provide one with the -d flag.')
    }
  }

  const fileMetadata = []
  const nappJsonFile = fileList.find(file => file.webkitRelativePath.split('/').slice(1).join('/') === '.well-known/napp.json')
  let nappJson = {}
  if (nappJsonFile) {
    try {
      nappJson = JSON.parse(await streamToText(nappJsonFile.stream()))
      fileList = fileList.filter(file => file !== nappJsonFile)
    } catch (error) {
      log('Failed to parse .well-known/napp.json', error)
    }
  }

  const indexFile = findIndexFile(fileList)
  let manifestName = nappJson.name?.[0]?.[0]
  let manifestSummary = nappJson.summary?.[0]?.[0]
  if (indexFile && (!manifestName || !manifestSummary)) {
    try {
      const { name, description } = extractHtmlMetadata(await streamToText(indexFile.stream()))
      if (!manifestName) manifestName = name
      if (!manifestSummary) manifestSummary = description
    } catch (error) {
      log('Error extracting HTML metadata:', error)
    }
  }

  const faviconFile = findFavicon(fileList)
  let iconMetadata
  let pause = 1000

  log('Checking for blossom servers...')
  const blossomServerUrls = await getBlossomServers(nostrSigner, writeRelays)
  let healthyBlossomServers = []
  if (blossomServerUrls.length) {
    log(`Found ${blossomServerUrls.length} blossom servers: ${blossomServerUrls.join(', ')}`)
    healthyBlossomServers = await healthCheckServers(blossomServerUrls, nostrSigner, { log })
    log(`${healthyBlossomServers.length} of ${blossomServerUrls.length} blossom servers are healthy`)
  } else {
    log('No blossom servers configured, will use relay-based file upload (irfs)')
  }
  const uploadService = healthyBlossomServers.length ? 'blossom' : 'irfs'

  const uploadMediaFromDataUrl = async (dataUrl, mediaName) => {
    const response = await fetch(dataUrl)
    const blob = await response.blob()
    const mimeType = blob.type || 'application/octet-stream'
    const filename = `${mediaName}.${mimeType.split('/')[1] || 'bin'}`

    if (uploadService === 'blossom') {
      const { uploadedFiles, failedFiles } = await uploadFilesToBlossom({
        fileList: [Object.assign(blob, { webkitRelativePath: `_/${filename}` })],
        servers: healthyBlossomServers,
        signer: nostrSigner,
        shouldReupload,
        log
      })
      if (failedFiles.length) throw new Error(`Blossom upload failed for ${mediaName}`)
      return { rootHash: uploadedFiles[0].sha256, mimeType, size: blob.size }
    }

    const nmmr = new NMMR()
    let chunkLength = 0
    for await (const chunk of streamToChunks(blob.stream(), 51000)) {
      chunkLength++
      await nmmr.append(chunk)
    }
    if (!chunkLength) return null
    ;({ pause } = await uploadBinaryDataChunks({
      nmmr, signer: nostrSigner, filename, chunkLength, log, pause, shouldReupload
    }))
    return { rootHash: nmmr.getRoot(), mimeType, size: blob.size }
  }

  const hasIconUpload = Boolean(nappJson.icon?.[0]?.[0])
  const keyArtEntries = Array.isArray(nappJson.keyArt) ? nappJson.keyArt : []
  const screenshotEntries = Array.isArray(nappJson.screenshot) ? nappJson.screenshot : []
  totalSteps = fileList.length + (hasIconUpload ? 1 : 0) + keyArtEntries.length + screenshotEntries.length + 1
  emit({
    type: 'init', totalFiles: fileList.length, totalSteps, dTag,
    relayCount: writeRelays.length, blossomCount: healthyBlossomServers.length
  })

  if (hasIconUpload) {
    try {
      log('Uploading icon from napp.json')
      iconMetadata = await uploadMediaFromDataUrl(nappJson.icon[0][0], 'icon')
    } catch (error) {
      log('Failed to upload icon from napp.json', error)
    }
    steps++
    emit({ type: 'media-uploaded', mediaType: 'icon', service: iconMetadata ? uploadService : null })
  }

  const keyArtMetadata = []
  for (const entry of keyArtEntries) {
    const [dataUrl, country] = entry
    if (dataUrl) {
      try {
        log(`Uploading key art from napp.json${country ? ` (${country})` : ''}`)
        const uploaded = await uploadMediaFromDataUrl(dataUrl, 'key_art')
        if (uploaded) keyArtMetadata.push({ ...uploaded, country })
      } catch (error) {
        log('Failed to upload key art from napp.json', error)
      }
    }
    steps++
    emit({
      type: 'media-uploaded', mediaType: 'key_art',
      service: dataUrl && keyArtMetadata.length ? uploadService : null
    })
  }

  const screenshotMetadata = []
  for (const entry of screenshotEntries) {
    const [dataUrl, country] = entry
    if (dataUrl) {
      try {
        log(`Uploading screenshot from napp.json${country ? ` (${country})` : ''}`)
        const uploaded = await uploadMediaFromDataUrl(dataUrl, 'screenshot')
        if (uploaded) screenshotMetadata.push({ ...uploaded, country })
      } catch (error) {
        log('Failed to upload screenshot from napp.json', error)
      }
    }
    steps++
    emit({
      type: 'media-uploaded', mediaType: 'screenshot',
      service: dataUrl && screenshotMetadata.length ? uploadService : null
    })
  }

  log(`Processing ${fileList.length} files`)
  if (uploadService === 'blossom') {
    const { uploadedFiles, failedFiles } = await uploadFilesToBlossom({
      fileList,
      servers: healthyBlossomServers,
      signer: nostrSigner,
      shouldReupload,
      log
    })
    if (failedFiles.length) throw new Error(`${failedFiles.length} file(s) failed to upload to blossom`)

    for (const uploaded of uploadedFiles) {
      const metadata = {
        rootHash: uploaded.sha256,
        filename: uploaded.filename,
        mimeType: uploaded.mimeType,
        size: uploaded.size
      }
      fileMetadata.push(metadata)
      if (faviconFile && uploaded.file === faviconFile) iconMetadata = { ...metadata }
      steps++
      emit({ type: 'file-uploaded', filename: uploaded.filename, service: 'blossom' })
    }
  } else {
    for (const file of fileList) {
      const nmmr = new NMMR()
      let chunkLength = 0
      for await (const chunk of streamToChunks(file.stream(), 51000)) {
        chunkLength++
        await nmmr.append(chunk)
      }
      // Empty IRFS blobs deliberately have no chunks and no manifest reference.
      if (!chunkLength) {
        steps++
        emit({ type: 'file-uploaded', filename: file.webkitRelativePath.split('/').slice(1).join('/'), service: 'irfs' })
        continue
      }

      const filename = file.webkitRelativePath.split('/').slice(1).join('/')
      log(`Uploading ${chunkLength} file parts of ${filename}`)
      ;({ pause } = await uploadBinaryDataChunks({
        nmmr, signer: nostrSigner, filename, chunkLength, log, pause, shouldReupload
      }))
      const metadata = {
        rootHash: nmmr.getRoot(),
        filename,
        mimeType: file.type || 'application/octet-stream',
        size: file.size
      }
      fileMetadata.push(metadata)
      if (faviconFile && file === faviconFile) iconMetadata = { ...metadata }
      steps++
      emit({ type: 'file-uploaded', filename, service: 'irfs' })
    }
  }

  log(`Uploading unified site manifest ${dTag}`)
  const manifest = await uploadSiteManifest({
    dTag,
    channel,
    fileMetadata,
    name: manifestName,
    nameLang: nappJson.name?.[0]?.[1],
    isNameAuto: !nappJson.name?.[0]?.[0],
    summary: manifestSummary,
    summaryLang: nappJson.summary?.[0]?.[1],
    isSummaryAuto: !nappJson.summary?.[0]?.[0],
    icon: iconMetadata,
    isIconAuto: !nappJson.icon?.[0]?.[0],
    descriptions: nappJson.description,
    keyArt: keyArtMetadata,
    screenshots: screenshotMetadata,
    uploadService,
    signer: nostrSigner,
    log,
    pause,
    shouldReupload,
    self: nappJson.self?.[0]?.[0],
    countries: nappJson.country,
    categories: nappJson.category,
    hashtags: nappJson.hashtag
  })

  const appEntity = appEncode({
    dTag: manifest.tags.find(tag => tag[0] === 'd')[1],
    pubkey: manifest.pubkey,
    relays: [],
    kind: manifest.kind
  })
  steps++
  emit({ type: 'manifest-published' })
  log(`Visit at https://44billion.net/${appEntity}`)
  emit({ type: 'complete', napp: appEntity })
}
