import NMMR from 'nmmr'
import { appEncode } from 'libp2r2p/nip19'
import nostrRelays from '#services/nostr-relays.js'
import { getRelays } from '#helpers/signer.js'
import { streamToChunks, streamToText } from '#helpers/stream.js'
import { isNostrAppDTagSafe, GENERIC_BUILD_FOLDER_NAMES } from '#helpers/app.js'
import { extractHtmlMetadata, findAppIcon, findIndexFile } from '#helpers/app-metadata.js'
import { getBlossomServers, healthCheckServers, uploadFilesToBlossom } from '#services/blossom-upload.js'
import { uploadBinaryDataChunks } from '#services/irfs-upload.js'
import { uploadSiteManifest } from '#services/site-manifest.js'
import { NappupError, NAPPUP_ERROR_CODES, normalizeNappupError } from '#errors.js'

export { NappupError, NAPPUP_ERROR_CODES } from '#errors.js'

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
  try {
    return await toApp(fileList, nostrSigner, opts)
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
 *
 * Every rejected error has a stable `NAPPUP_*` code and may retain its cause.
 */
export async function toApp (fileList, nostrSigner, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null
  let lastProgress = 0
  const publishOptions = onEvent
    ? {
        ...opts,
        onEvent (event) {
          lastProgress = event.progress ?? lastProgress
          onEvent(event)
        }
      }
    : opts
  try {
    return await publishApp(fileList, nostrSigner, publishOptions)
  } catch (error) {
    const normalized = normalizeNappupError(error)
    if (onEvent) {
      try { onEvent({ type: 'error', error: normalized, progress: lastProgress }) } catch (_) {}
    }
    throw normalized
  }
}

// Implements publishing after the public boundary has installed error normalization.
async function publishApp (fileList, nostrSigner, {
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
  if (!nostrSigner) {
    throw new NappupError(NAPPUP_ERROR_CODES.NO_SIGNER, 'No Nostr signer found')
  }
  if (typeof window !== 'undefined' && nostrSigner === window.nostr) nostrSigner.getRelays = getRelays

  fileList = Array.from(fileList || [])
  if (!fileList.length) {
    throw new NappupError(NAPPUP_ERROR_CODES.EMPTY_FILE_LIST, 'No app files were provided')
  }

  if (dTag !== undefined && dTag !== null) {
    if (!isNostrAppDTagSafe(dTag)) {
      throw new NappupError(
        NAPPUP_ERROR_CODES.INVALID_D_TAG,
        'dTag must be a non-empty string with at most 260 characters',
        { details: { dTag } }
      )
    }
  } else {
    const relativePath = typeof fileList[0]?.webkitRelativePath === 'string'
      ? fileList[0].webkitRelativePath
      : ''
    const folderName = relativePath.split('/')[0].trim()
    if (GENERIC_BUILD_FOLDER_NAMES.has(folderName.toLowerCase())) {
      throw new NappupError(
        NAPPUP_ERROR_CODES.GENERIC_FOLDER_NAME,
        `Folder name "${folderName}" is a generic build folder. Please provide a d tag with the -d flag.`,
        { details: { folderName } }
      )
    }
    dTag = folderName
    if (!isNostrAppDTagSafe(dTag)) {
      throw new NappupError(
        NAPPUP_ERROR_CODES.INVALID_FOLDER_NAME,
        'Could not derive a valid d tag from the folder name. Please provide one with the -d flag.',
        { details: { folderName } }
      )
    }
  }

  let signerRelays
  try {
    signerRelays = await nostrSigner.getRelays()
  } catch (error) {
    throw new NappupError(
      NAPPUP_ERROR_CODES.RELAY_LOOKUP_FAILED,
      'Could not read the signer outbox relays',
      { cause: error }
    )
  }
  const writeRelays = [...new Set((Array.isArray(signerRelays?.write) ? signerRelays.write : [])
    .flatMap(relay => typeof relay === 'string' && relay.trim()
      ? [relay.trim().replace(/\/$/, '')]
      : []
    ))]
  log(`Found ${writeRelays.length} outbox relays:\n${writeRelays.join(', ')}`)
  if (!writeRelays.length) {
    throw new NappupError(NAPPUP_ERROR_CODES.NO_OUTBOX_RELAYS, 'No outbox relays found')
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
  let indexHtml = ''
  if (indexFile) {
    try {
      indexHtml = await streamToText(indexFile.stream())
      const { name, description } = extractHtmlMetadata(indexHtml)
      if (!manifestName) manifestName = name
      if (!manifestSummary) manifestSummary = description
    } catch (error) {
      log('Error extracting HTML metadata:', error)
    }
  }

  const faviconFile = await findAppIcon(fileList, indexHtml, indexFile, file => streamToText(file.stream()))
  let iconMetadata
  let isExplicitIcon = false
  let pause = 1000

  log('Checking for blossom servers...')
  let blossomServerUrls = []
  try {
    blossomServerUrls = await getBlossomServers(nostrSigner, writeRelays)
  } catch (error) {
    log('Could not read Blossom server preferences; using relay-based upload instead', error)
  }
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
      isExplicitIcon = Boolean(iconMetadata)
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
    if (failedFiles.length) {
      throw new NappupError(
        NAPPUP_ERROR_CODES.BLOSSOM_UPLOAD_FAILED,
        `${failedFiles.length} file(s) failed to upload to Blossom`,
        {
          details: {
            failedFileCount: failedFiles.length,
            filenames: failedFiles.map(failed => failed.filename).filter(Boolean)
          }
        }
      )
    }

    for (const uploaded of uploadedFiles) {
      const metadata = {
        rootHash: uploaded.sha256,
        filename: uploaded.filename,
        mimeType: uploaded.mimeType,
        size: uploaded.size
      }
      fileMetadata.push(metadata)
      if (!iconMetadata && faviconFile && uploaded.file === faviconFile) iconMetadata = { ...metadata }
      steps++
      emit({ type: 'file-uploaded', filename: uploaded.filename, service: 'blossom' })
    }
  } else {
    for (const file of fileList) {
      const filename = file.webkitRelativePath.split('/').slice(1).join('/')
      try {
        const nmmr = new NMMR()
        let chunkLength = 0
        for await (const chunk of streamToChunks(file.stream(), 51000)) {
          chunkLength++
          await nmmr.append(chunk)
        }
        // Empty IRFS blobs deliberately have no chunks and no manifest reference.
        if (!chunkLength) {
          steps++
          emit({ type: 'file-uploaded', filename, service: 'irfs' })
          continue
        }

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
        if (!iconMetadata && faviconFile && file === faviconFile) iconMetadata = { ...metadata }
        steps++
        emit({ type: 'file-uploaded', filename, service: 'irfs' })
      } catch (error) {
        throw new NappupError(
          NAPPUP_ERROR_CODES.IRFS_UPLOAD_FAILED,
          `Failed to upload "${filename}" to Nostr relays`,
          { cause: error, details: { filename } }
        )
      }
    }
  }

  log(`Uploading unified site manifest ${dTag}`)
  let manifest
  try {
    manifest = await uploadSiteManifest({
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
      isIconAuto: !isExplicitIcon,
      descriptions: nappJson.description,
      keyArt: keyArtMetadata,
      screenshots: screenshotMetadata,
      uploadService,
      sourceRelays: writeRelays,
      blossomServers: healthyBlossomServers,
      signer: nostrSigner,
      log,
      pause,
      shouldReupload,
      self: nappJson.self?.[0]?.[0],
      countries: nappJson.country,
      categories: nappJson.category,
      hashtags: nappJson.hashtag
    })
  } catch (error) {
    throw new NappupError(
      NAPPUP_ERROR_CODES.MANIFEST_UPLOAD_FAILED,
      'Failed to publish the app manifest to Nostr relays',
      { cause: error }
    )
  }

  const appEntity = appEncode({
    dTag: manifest.tags.find(tag => tag[0] === 'd')[1],
    pubkey: manifest.pubkey,
    // Keep empty array to generate the shorter app entity.
    relays: [],
    kind: manifest.kind
  })
  steps++
  emit({ type: 'manifest-published' })
  log(`Visit at https://44billion.net/${appEntity}`)
  emit({ type: 'complete', napp: appEntity })
}
