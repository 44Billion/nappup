import NMMR from 'nmmr'
import { appEncode } from '#helpers/nip19.js'
import nostrRelays, { nappRelays } from '#services/nostr-relays.js'
import { getRelays } from '#helpers/signer.js'
import { streamToChunks, streamToText } from '#helpers/stream.js'
import { isNostrAppDTagSafe, deriveNostrAppDTag } from '#helpers/app.js'
import { extractHtmlMetadata, findFavicon, findIndexFile } from '#helpers/app-metadata.js'
import { NAPP_CATEGORIES } from '#config/napp-categories.js'
import { getBlossomServers, healthCheckServers, uploadFilesToBlossom } from '#services/blossom-upload.js'
import { uploadBinaryDataChunks, throttledSendEvent } from '#services/irfs-upload.js'

// TL;DR
// import publishApp from 'nappup'
// await publishApp(
//   fileList,
//   window.nostr,
//   { dTagRaw: 'My app identifier unique to this nsec', onEvent: ({ progress }) => console.log(progress) }
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
 * Publishes a site to Nostr relays and/or blossom servers.
 *
 * The optional `onEvent` callback receives structured progress events.
 * Every event has `type` (string) and `progress` (0–100 integer).
 *
 * Event types:
 *   'init'               — { totalFiles, totalSteps, dTag, relayCount, blossomCount }
 *   'media-uploaded'     — { mediaType: 'icon'|'key_art'|'screenshot', service: 'blossom'|'irfs'|null }
 *   'file-uploaded'      — { filename, service: 'blossom'|'irfs' }
 *   'listing-published'  — app listing metadata published
 *   'manifest-published' — site manifest published
 *   'complete'           — { napp } (terminal, progress === 100)
 *   'error'              — { error } (terminal, error is rethrown)
 *
 * Terminal events ('complete' or 'error') signal that no more events will follow.
 * The 'error' event is only emitted when using the default export wrapper.
 * Direct `toApp` callers receive the thrown error via normal async/await.
 */
export async function toApp (fileList, nostrSigner, { log = () => {}, onEvent = () => {}, dTag, dTagRaw, channel = 'main', shouldReupload = false } = {}) {
  let _steps = 0
  let _totalSteps = 1
  const emit = (event) => { try { onEvent({ ...event, progress: event.type === 'complete' ? 100 : Math.round((_steps / _totalSteps) * 100) }) } catch (_) {} }
  if (!nostrSigner && typeof window !== 'undefined') nostrSigner = window.nostr
  if (!nostrSigner) throw new Error('No Nostr signer found')
  if (typeof window !== 'undefined' && nostrSigner === window.nostr) {
    nostrSigner.getRelays = getRelays
  }
  const writeRelays = [...new Set((await nostrSigner.getRelays()).write.map(r => r.trim().replace(/\/$/, '')))]
  log(`Found ${writeRelays.length} outbox relays for pubkey ${nostrSigner.getPublicKey()}:\n${writeRelays.join(', ')}`)
  if (writeRelays.length === 0) throw new Error('No outbox relays found')

  if (typeof dTag === 'string') {
    if (!isNostrAppDTagSafe(dTag)) throw new Error('dTag should be [A-Za-z0-9] with length ranging from 1 to 19')
  } else {
    dTag = dTagRaw || fileList[0].webkitRelativePath.split('/')[0].trim()
    if (!isNostrAppDTagSafe(dTag)) dTag = await deriveNostrAppDTag(dTag || Math.random().toString(36))
  }
  const fileMetadata = []

  // Check for .well-known/napp.json
  const nappJsonFile = fileList.find(f => f.webkitRelativePath.split('/').slice(1).join('/') === '.well-known/napp.json')
  let nappJson = {}
  if (nappJsonFile) {
    try {
      const text = await streamToText(nappJsonFile.stream())
      nappJson = JSON.parse(text)
      fileList = fileList.filter(f => f !== nappJsonFile)
    } catch (e) {
      log('Failed to parse .well-known/napp.json', e)
    }
  }

  const indexFile = findIndexFile(fileList)
  let listingName = nappJson.name?.[0]?.[0]
  let listingSummary = nappJson.summary?.[0]?.[0]

  if (indexFile && (!listingName || !listingSummary)) {
    try {
      const htmlContent = await streamToText(indexFile.stream())
      const { name, description } = extractHtmlMetadata(htmlContent)
      if (!listingName) listingName = name
      if (!listingSummary) listingSummary = description
    } catch (err) {
      log('Error extracting HTML metadata:', err)
    }
  }
  const faviconFile = findFavicon(fileList)
  let iconMetadata

  let pause = 1000

  // Check for blossom servers
  log('Checking for blossom servers...')
  const blossomServerUrls = await getBlossomServers(nostrSigner, writeRelays)
  let healthyBlossomServers = []
  if (blossomServerUrls.length > 0) {
    log(`Found ${blossomServerUrls.length} blossom servers: ${blossomServerUrls.join(', ')}`)
    healthyBlossomServers = await healthCheckServers(blossomServerUrls, nostrSigner, { log })
    log(`${healthyBlossomServers.length} of ${blossomServerUrls.length} blossom servers are healthy`)
  } else {
    log('No blossom servers configured, will use relay-based file upload (irfs)')
  }

  const uploadService = healthyBlossomServers.length > 0 ? 'blossom' : 'irfs'

  // Helper: upload a data URL to the chosen service, returns { rootHash, mimeType }
  const uploadMediaFromDataUrl = async (dataUrl, mediaName) => {
    const res = await fetch(dataUrl)
    const blob = await res.blob()
    const mimeType = blob.type
    const extension = mimeType.split('/')[1] || 'bin'
    const filename = `${mediaName}.${extension}`

    if (uploadService === 'blossom') {
      const { uploadedFiles, failedFiles } = await uploadFilesToBlossom({
        fileList: [Object.assign(blob, { webkitRelativePath: `_/${filename}` })],
        servers: healthyBlossomServers,
        signer: nostrSigner,
        shouldReupload,
        log
      })
      if (failedFiles.length > 0) throw new Error(`Blossom upload failed for ${mediaName}`)
      return { rootHash: uploadedFiles[0].sha256, mimeType }
    }

    const nmmr = new NMMR()
    const stream = blob.stream()
    let chunkLength = 0
    for await (const chunk of streamToChunks(stream, 51000)) {
      chunkLength++
      await nmmr.append(chunk)
    }
    if (!chunkLength) return null
    ;({ pause } = (await uploadBinaryDataChunks({ nmmr, signer: nostrSigner, filename, chunkLength, log, pause, mimeType, shouldReupload })))
    return { rootHash: nmmr.getRoot(), mimeType }
  }

  // Count media uploads for progress tracking
  const hasIconUpload = Boolean(nappJson.icon?.[0]?.[0])
  const keyArtEntries = nappJson.keyArt || []
  const screenshotEntries = nappJson.screenshot || []
  const mediaUploadCount = (hasIconUpload ? 1 : 0) + keyArtEntries.length + screenshotEntries.length
  _totalSteps = fileList.length + mediaUploadCount + 2
  emit({ type: 'init', totalFiles: fileList.length, totalSteps: _totalSteps, dTag, relayCount: writeRelays.length, blossomCount: healthyBlossomServers.length })

  // Upload icon from napp.json if present
  if (nappJson.icon?.[0]?.[0]) {
    try {
      log('Uploading icon from napp.json')
      iconMetadata = await uploadMediaFromDataUrl(nappJson.icon[0][0], 'icon')
    } catch (e) {
      log('Failed to upload icon from napp.json', e)
    }
    _steps++
    emit({ type: 'media-uploaded', mediaType: 'icon', service: iconMetadata ? uploadService : null })
  }

  // Upload key art from napp.json
  const keyArtMetadata = []
  for (const entry of keyArtEntries) {
    const dataUrl = entry[0]
    const country = entry[1]
    if (!dataUrl) { _steps++; emit({ type: 'media-uploaded', mediaType: 'key_art', service: null }); continue }
    try {
      log(`Uploading key art from napp.json${country ? ` (${country})` : ''}`)
      const uploaded = await uploadMediaFromDataUrl(dataUrl, 'key_art')
      if (uploaded) keyArtMetadata.push({ ...uploaded, country })
    } catch (e) {
      log('Failed to upload key art from napp.json', e)
    }
    _steps++
    emit({ type: 'media-uploaded', mediaType: 'key_art', service: keyArtMetadata.length > 0 ? uploadService : null })
  }

  // Upload screenshots from napp.json
  const screenshotMetadata = []
  for (const entry of screenshotEntries) {
    const dataUrl = entry[0]
    const country = entry[1]
    if (!dataUrl) { _steps++; emit({ type: 'media-uploaded', mediaType: 'screenshot', service: null }); continue }
    try {
      log(`Uploading screenshot from napp.json${country ? ` (${country})` : ''}`)
      const uploaded = await uploadMediaFromDataUrl(dataUrl, 'screenshot')
      if (uploaded) screenshotMetadata.push({ ...uploaded, country })
    } catch (e) {
      log('Failed to upload screenshot from napp.json', e)
    }
    _steps++
    emit({ type: 'media-uploaded', mediaType: 'screenshot', service: screenshotMetadata.length > 0 ? uploadService : null })
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

    if (failedFiles.length > 0) {
      throw new Error(`${failedFiles.length} file(s) failed to upload to blossom`)
    }

    for (const uploaded of uploadedFiles) {
      fileMetadata.push({
        rootHash: uploaded.sha256,
        filename: uploaded.filename,
        mimeType: uploaded.mimeType
      })

      if (faviconFile && uploaded.file === faviconFile) {
        iconMetadata = {
          rootHash: uploaded.sha256,
          mimeType: uploaded.mimeType
        }
      }

      _steps++
      emit({ type: 'file-uploaded', filename: uploaded.filename, service: 'blossom' })
    }
  } else {
    for (const file of fileList) {
      const nmmr = new NMMR()
      const stream = file.stream()

      let chunkLength = 0
      for await (const chunk of streamToChunks(stream, 51000)) {
        chunkLength++
        await nmmr.append(chunk)
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

        if (faviconFile && file === faviconFile) {
          iconMetadata = {
            rootHash: nmmr.getRoot(),
            mimeType: file.type || 'application/octet-stream'
          }
        }

        _steps++
        emit({ type: 'file-uploaded', filename, service: 'irfs' })
      }
    }
  }

  log(`Uploading app listing event for ${dTag}`)
  ;({ pause } = (await maybeUploadAppListing({
    dTag,
    channel,
    name: listingName,
    nameLang: nappJson.name?.[0]?.[1],
    isNameAuto: !nappJson.name?.[0]?.[0],
    summary: listingSummary,
    summaryLang: nappJson.summary?.[0]?.[1],
    isSummaryAuto: !nappJson.summary?.[0]?.[0],
    icon: iconMetadata,
    isIconAuto: !nappJson.icon?.[0]?.[0],
    descriptions: nappJson.description,
    keyArt: keyArtMetadata,
    screenshots: screenshotMetadata,
    uploadService,
    signer: nostrSigner,
    writeRelays,
    log,
    pause,
    shouldReupload,
    self: nappJson.self?.[0]?.[0],
    countries: nappJson.country,
    categories: nappJson.category,
    hashtags: nappJson.hashtag
  })))
  _steps++
  emit({ type: 'listing-published' })

  log(`Uploading site manifest ${dTag}`)
  const manifest = await uploadSiteManifest({ dTag, channel, fileMetadata, uploadService, signer: nostrSigner, pause, shouldReupload, log })

  const appEntity = appEncode({
    dTag: manifest.tags.find(v => v[0] === 'd')[1],
    pubkey: manifest.pubkey,
    relays: [],
    kind: manifest.kind
  })
  _steps++
  emit({ type: 'manifest-published' })

  log(`Visit at https://44billion.net/${appEntity}`)
  emit({ type: 'complete', napp: appEntity })
}

async function uploadSiteManifest ({ dTag, channel, fileMetadata, uploadService, signer, pause = 0, shouldReupload = false, log = () => {} }) {
  const kind = {
    main: 35128, // stable
    next: 35129, // insider
    draft: 35130 // vibe coded preview
  }[channel] ?? 35128

  const pathTags = fileMetadata.map(v => ['path', v.rootHash, v.filename, v.mimeType])
  const tags = [
    ['d', dTag],
    ...pathTags,
    ['service', uploadService]
  ]

  const writeRelays = [...new Set([...(await signer.getRelays()).write, ...nappRelays].map(r => r.trim().replace(/\/$/, '')))]

  let mostRecentEvent
  const events = (await nostrRelays.getEvents({
    kinds: [kind],
    authors: [await signer.getPublicKey()],
    '#d': [dTag],
    limit: 1
  }, writeRelays)).result

  if (events.length > 0) {
    events.sort((a, b) => {
      if (b.created_at !== a.created_at) return b.created_at - a.created_at
      if (a.id < b.id) return -1
      if (a.id > b.id) return 1
      return 0
    })
    mostRecentEvent = events[0]
  }

  if (!shouldReupload && mostRecentEvent) {
    const recentPathTags = mostRecentEvent.tags
      .filter(t => t[0] === 'path' && t[2] !== '.well-known/napp.json')
      .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))

    const currentPathTags = pathTags
      .filter(t => t[2] !== '.well-known/napp.json')
      .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))

    const recentServiceTag = mostRecentEvent.tags.find(t => t[0] === 'service')
    const serviceChanged = recentServiceTag?.[1] !== uploadService

    const isSame = !serviceChanged && currentPathTags.length === recentPathTags.length && currentPathTags.every((t, i) => {
      const rt = recentPathTags[i]
      return rt.length >= 4 && rt[1] === t[1] && rt[2] === t[2] && rt[3] === t[3]
    })

    if (isSame) {
      log(`Site manifest based on ${pathTags.length} files is up-to-date (id: ${mostRecentEvent.id} - created_at: ${new Date(mostRecentEvent.created_at * 1000).toISOString()})`)

      const matchingEvents = events.filter(e => e.id === mostRecentEvent.id)
      const coveredRelays = new Set(matchingEvents.map(e => e.meta?.relay).filter(Boolean))
      const missingRelays = writeRelays.filter(r => !coveredRelays.has(r))

      if (missingRelays.length === 0) return mostRecentEvent

      log(`Re-uploading existing site manifest event to ${missingRelays.length} missing relays (out of ${writeRelays.length})`)
      await throttledSendEvent(mostRecentEvent, missingRelays, { pause, trailingPause: true, log, minSuccessfulRelays: 0 })
      return mostRecentEvent
    }
  }

  const createdAt = Math.floor(Date.now() / 1000)
  let effectiveCreatedAt = (mostRecentEvent && mostRecentEvent.created_at >= createdAt) ? mostRecentEvent.created_at + 1 : createdAt
  const maxCreatedAt = createdAt + 172800 // 2 days ahead
  if (effectiveCreatedAt > maxCreatedAt) effectiveCreatedAt = maxCreatedAt

  const siteManifest = {
    kind,
    tags,
    content: '',
    created_at: effectiveCreatedAt
  }
  const event = await signer.signEvent(siteManifest)
  await throttledSendEvent(event, writeRelays, { pause, trailingPause: true, log })
  return event
}

async function maybeUploadAppListing ({
  dTag,
  channel,
  name,
  nameLang,
  isNameAuto,
  summary,
  summaryLang,
  isSummaryAuto,
  icon,
  isIconAuto,
  descriptions,
  keyArt,
  screenshots,
  uploadService,
  signer,
  writeRelays,
  log,
  pause,
  shouldReupload,
  self,
  countries,
  categories,
  hashtags
}) {
  const trimmedName = typeof name === 'string' ? name.trim() : ''
  const trimmedSummary = typeof summary === 'string' ? summary.trim() : ''
  const iconRootHash = icon?.rootHash
  const iconMimeType = icon?.mimeType
  const hasMetadata = Boolean(trimmedName) || Boolean(trimmedSummary) || Boolean(iconRootHash) ||
    Boolean(self) || (countries && countries.length > 0) || (categories && categories.length > 0) || (hashtags && hashtags.length > 0) ||
    (descriptions && descriptions.length > 0) || (keyArt && keyArt.length > 0) || (screenshots && screenshots.length > 0)

  const relays = [...new Set([...writeRelays, ...nappRelays].map(r => r.trim().replace(/\/$/, '')))]

  const previousResult = await getPreviousAppListing(dTag, relays, signer, channel)
  const previous = previousResult?.previous
  if (!previous && !hasMetadata) {
    if (shouldReupload) log('Skipping app listing event upload: No previous event found and no metadata provided.')
    return { pause }
  }

  const publishListing = async (event) => {
    const signedEvent = await signer.signEvent(event)
    return await throttledSendEvent(signedEvent, relays, { pause, log, trailingPause: true })
  }

  const createdAt = Math.floor(Date.now() / 1000)
  const kind = {
    main: 37348,
    next: 37349,
    draft: 37350
  }[channel] ?? 37348

  // Helper to push media-related tags (icon, key_art, screenshot, service)
  const pushMediaTags = (tags) => {
    let hasMedia = false

    if (iconRootHash && iconMimeType) {
      tags.push(['icon', iconRootHash, iconMimeType])
      if (isIconAuto) tags.push(['auto', 'icon'])
      hasMedia = true
    }

    if (keyArt && keyArt.length > 0) {
      for (const ka of keyArt) {
        const row = ['key_art', ka.rootHash, ka.mimeType]
        if (ka.country) row.push(ka.country)
        tags.push(row)
      }
      hasMedia = true
    }

    if (screenshots && screenshots.length > 0) {
      for (const ss of screenshots) {
        const row = ['screenshot', ss.rootHash, ss.mimeType]
        if (ss.country) row.push(ss.country)
        tags.push(row)
      }
      hasMedia = true
    }

    if (hasMedia) tags.push(['service', uploadService])

    return { hasIcon: Boolean(iconRootHash && iconMimeType) }
  }

  if (!previous) {
    const tags = [
      ['d', dTag]
    ]

    if (countries && countries.length > 0) {
      countries.forEach(c => tags.push(['c', c]))
    } else {
      tags.push(['c', '*'])
    }

    if (self) tags.push(['self', self])

    if (categories) {
      let count = 0
      for (const [cat, subcats] of categories) {
        if (count >= 3) break
        if (Array.isArray(subcats)) {
          for (const sub of subcats) {
            if (count >= 3) break
            if (NAPP_CATEGORIES[cat] && NAPP_CATEGORIES[cat].includes(sub)) {
              tags.push(['l', `napp.${cat}:${sub}`])
              count++
            }
          }
        }
      }
    }

    if (hashtags) {
      hashtags.slice(0, 3).forEach(([tag, label]) => {
        const t = tag.replace(/\s/g, '').toLowerCase()
        const row = ['t', t]
        if (label) row.push(label)
        tags.push(row)
      })
    }

    const { hasIcon } = pushMediaTags(tags)

    let hasName = false
    if (trimmedName) {
      hasName = true
      const row = ['name', trimmedName]
      if (nameLang) row.push(nameLang)
      tags.push(row)
      if (isNameAuto) tags.push(['auto', 'name'])
    }

    if (trimmedSummary) {
      const row = ['summary', trimmedSummary]
      if (summaryLang) row.push(summaryLang)
      tags.push(row)
      if (isSummaryAuto) tags.push(['auto', 'summary'])
    }

    if (descriptions) {
      for (const [text, lang] of descriptions) {
        if (text) {
          const row = ['description', text]
          if (lang) row.push(lang)
          tags.push(row)
        }
      }
    }

    if (!hasIcon || !hasName) {
      log(`Skipping app listing event creation: Missing required metadata.${!hasName ? ' Name is missing.' : ''}${!hasIcon ? ' Icon is missing.' : ''}`)
      return { pause }
    }

    return await publishListing({
      kind,
      tags,
      content: '',
      created_at: createdAt
    })
  }

  const tags = Array.isArray(previous.tags)
    ? previous.tags.map(tag => (Array.isArray(tag) ? [...tag] : tag))
    : []
  let changed = false

  // Helper to remove tags by key
  const removeTags = (key) => {
    let idx
    while ((idx = tags.findIndex(t => Array.isArray(t) && t[0] === key)) !== -1) {
      tags.splice(idx, 1)
      changed = true
    }
  }

  // Helper to remove 'l' tags with specific prefix
  const removeLTags = (prefix) => {
    let idx
    while ((idx = tags.findIndex(t => Array.isArray(t) && t[0] === 'l' && t[1].startsWith(prefix))) !== -1) {
      tags.splice(idx, 1)
      changed = true
    }
  }

  // Update self
  if (self) {
    removeTags('self')
    tags.push(['self', self])
    changed = true
  }

  // Update countries
  if (countries) {
    removeTags('c')
    if (countries.length === 0) {
      tags.push(['c', '*'])
    } else {
      countries.forEach(c => tags.push(['c', c]))
    }
    changed = true
  }

  // Update categories
  if (categories) {
    removeLTags('napp.')
    let count = 0
    for (const [cat, subcats] of categories) {
      if (count >= 3) break
      if (Array.isArray(subcats)) {
        for (const sub of subcats) {
          if (count >= 3) break
          if (NAPP_CATEGORIES[cat] && NAPP_CATEGORIES[cat].includes(sub)) {
            tags.push(['l', `napp.${cat}:${sub}`])
            count++
          }
        }
      }
    }
    changed = true
  }

  // Update hashtags
  if (hashtags) {
    removeTags('t')
    hashtags.slice(0, 3).forEach(([tag, label]) => {
      const t = tag.replace(/\s/g, '').toLowerCase()
      const row = ['t', t]
      if (label) row.push(label)
      tags.push(row)
    })
    changed = true
  }

  // Update descriptions
  if (descriptions) {
    removeTags('description')
    for (const [text, lang] of descriptions) {
      if (text) {
        const row = ['description', text]
        if (lang) row.push(lang)
        tags.push(row)
      }
    }
    changed = true
  }

  // Update key art
  if (keyArt && keyArt.length > 0) {
    removeTags('key_art')
    for (const ka of keyArt) {
      const row = ['key_art', ka.rootHash, ka.mimeType]
      if (ka.country) row.push(ka.country)
      tags.push(row)
    }
    changed = true
  }

  // Update screenshots
  if (screenshots && screenshots.length > 0) {
    removeTags('screenshot')
    for (const ss of screenshots) {
      const row = ['screenshot', ss.rootHash, ss.mimeType]
      if (ss.country) row.push(ss.country)
      tags.push(row)
    }
    changed = true
  }

  const ensureTagValue = (key, updater) => {
    const index = tags.findIndex(tag => Array.isArray(tag) && tag[0] === key)
    if (index === -1) {
      const next = updater(null)
      if (!next) return
      tags.push(next)
      changed = true
      return
    }

    const next = updater(tags[index])
    if (!next) return
    if (!tags[index] || tags[index].some((value, idx) => value !== next[idx])) {
      tags[index] = next
      changed = true
    }
  }

  ensureTagValue('d', (existing) => {
    if (existing && existing[1] === dTag) return existing
    return ['d', dTag]
  })

  if (!countries) {
    ensureTagValue('c', (existing) => {
      if (!existing) return ['c', '*']
      const currentValue = typeof existing[1] === 'string' ? existing[1].trim() : ''
      if (currentValue === '') return ['c', '*']
      return existing
    })
  }

  const hasAuto = (field) => tags.some(tag => Array.isArray(tag) && tag[0] === 'auto' && tag[1] === field)
  const removeAuto = (field) => {
    const idx = tags.findIndex(tag => Array.isArray(tag) && tag[0] === 'auto' && tag[1] === field)
    if (idx !== -1) {
      tags.splice(idx, 1)
      changed = true
    }
  }

  if (trimmedName) {
    if (!isNameAuto || hasAuto('name')) {
      ensureTagValue('name', (_) => {
        const row = ['name', trimmedName]
        if (nameLang) row.push(nameLang)
        return row
      })
      if (!isNameAuto) removeAuto('name')
    }
  }

  if (trimmedSummary) {
    if (!isSummaryAuto || hasAuto('summary')) {
      ensureTagValue('summary', (_) => {
        const row = ['summary', trimmedSummary]
        if (summaryLang) row.push(summaryLang)
        return row
      })
      if (!isSummaryAuto) removeAuto('summary')
    }
  }

  if (iconRootHash && iconMimeType) {
    if (!isIconAuto || hasAuto('icon')) {
      ensureTagValue('icon', (_) => {
        return ['icon', iconRootHash, iconMimeType]
      })
      if (!isIconAuto) removeAuto('icon')
    }
  }

  // Update service tag if any media exists
  const hasMedia = Boolean(iconRootHash) || (keyArt && keyArt.length > 0) || (screenshots && screenshots.length > 0)
  if (hasMedia) {
    ensureTagValue('service', () => ['service', uploadService])
  }

  if (!changed && !shouldReupload) {
    const { storedEvents } = previousResult

    const matchingEvents = storedEvents.filter(e => e.id === previous.id)
    const coveredRelays = new Set(matchingEvents.map(e => e.meta?.relay).filter(Boolean))
    const missingRelays = relays.filter(r => !coveredRelays.has(r))

    if (missingRelays.length === 0) return { pause }

    log(`Re-uploading existing app listing event to ${missingRelays.length} missing relays (out of ${relays.length})`)
    return await throttledSendEvent(previous, missingRelays, { pause, log, trailingPause: true, minSuccessfulRelays: 0 })
  }

  let effectiveCreatedAt = (previous && previous.created_at >= createdAt) ? previous.created_at + 1 : createdAt
  const maxCreatedAt = createdAt + 172800 // 2 days ahead
  if (effectiveCreatedAt > maxCreatedAt) effectiveCreatedAt = maxCreatedAt

  return await publishListing({
    kind,
    tags,
    content: typeof previous.content === 'string' ? previous.content : '',
    created_at: effectiveCreatedAt
  })
}

async function getPreviousAppListing (dTagValue, relays, signer, channel) {
  const kind = {
    main: 37348,
    next: 37349,
    draft: 37350
  }[channel] ?? 37348

  const storedEvents = (await nostrRelays.getEvents({
    kinds: [kind],
    authors: [await signer.getPublicKey()],
    '#d': [dTagValue],
    limit: 1
  }, relays)).result

  if (storedEvents.length === 0) return null

  storedEvents.sort((a, b) => b.created_at - a.created_at)

  return {
    previous: storedEvents[0],
    storedEvents,
    targetRelayCount: relays.length
  }
}
