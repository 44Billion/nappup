import NMMR from 'nmmr'
import { appEncode } from '#helpers/nip19.js'
import nostrRelays, { nappRelays } from '#services/nostr-relays.js'
import NostrSigner from '#services/nostr-signer.js'
import { streamToChunks, streamToText } from '#helpers/stream.js'
import { isNostrAppDTagSafe, deriveNostrAppDTag } from '#helpers/app.js'
import { extractHtmlMetadata, findFavicon, findIndexFile } from '#helpers/app-metadata.js'
import { NAPP_CATEGORIES } from '#config/napp-categories.js'
import { getBlossomServers, healthCheckServers, uploadFilesToBlossom } from '#services/blossom-upload.js'
import { uploadBinaryDataChunks, throttledSendEvent } from '#services/irfs-upload.js'

export default async function (...args) {
  try {
    return await toApp(...args)
  } finally {
    await nostrRelays.disconnectAll()
  }
}

export async function toApp (fileList, nostrSigner, { log = () => {}, dTag, dTagRaw, channel = 'main', shouldReupload = false } = {}) {
  if (!nostrSigner && typeof window !== 'undefined') nostrSigner = window.nostr
  if (!nostrSigner) throw new Error('No Nostr signer found')
  if (typeof window !== 'undefined' && nostrSigner === window.nostr) {
    nostrSigner.getRelays = NostrSigner.prototype.getRelays
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
  let nmmr
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
  let stallName = nappJson.stallName?.[0]?.[0]
  let stallSummary = nappJson.stallSummary?.[0]?.[0]

  if (indexFile && (!stallName || !stallSummary)) {
    try {
      const htmlContent = await streamToText(indexFile.stream())
      const { name, description } = extractHtmlMetadata(htmlContent)
      if (!stallName) stallName = name
      if (!stallSummary) stallSummary = description
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

  const useBlossom = healthyBlossomServers.length > 0

  // Upload icon from napp.json if present
  if (nappJson.stallIcon?.[0]?.[0]) {
    try {
      const dataUrl = nappJson.stallIcon[0][0]
      const res = await fetch(dataUrl)
      const blob = await res.blob()
      const mimeType = blob.type
      const extension = mimeType.split('/')[1] || 'bin'
      const filename = `icon.${extension}`

      log('Uploading icon from napp.json')

      if (useBlossom) {
        const { uploadedFiles, failedFiles } = await uploadFilesToBlossom({
          fileList: [Object.assign(blob, { webkitRelativePath: `_/${filename}` })],
          servers: healthyBlossomServers,
          signer: nostrSigner,
          shouldReupload,
          log
        })
        if (uploadedFiles.length > 0) {
          iconMetadata = {
            rootHash: uploadedFiles[0].sha256,
            mimeType,
            service: 'b' // blossom
          }
        } else if (failedFiles.length > 0) {
          log('Blossom icon upload failed, falling back to relay upload')
        }
      }

      if (!iconMetadata) {
        nmmr = new NMMR()
        const stream = blob.stream()
        let chunkLength = 0
        for await (const chunk of streamToChunks(stream, 51000)) {
          chunkLength++
          await nmmr.append(chunk)
        }

        if (chunkLength) {
          ;({ pause } = (await uploadBinaryDataChunks({ nmmr, signer: nostrSigner, filename, chunkLength, log, pause, mimeType, shouldReupload })))
          iconMetadata = {
            rootHash: nmmr.getRoot(),
            mimeType,
            service: 'i' // relay (irfs)
          }
        }
      }
    } catch (e) {
      log('Failed to upload icon from napp.json', e)
    }
  }

  log(`Processing ${fileList.length} files`)

  // Files to upload via relay (irfs) — either all files or blossom failures
  let irfsFileList = fileList

  if (useBlossom) {
    const { uploadedFiles, failedFiles } = await uploadFilesToBlossom({
      fileList,
      servers: healthyBlossomServers,
      signer: nostrSigner,
      shouldReupload,
      log
    })

    for (const uploaded of uploadedFiles) {
      fileMetadata.push({
        rootHash: uploaded.sha256,
        filename: uploaded.filename,
        mimeType: uploaded.mimeType,
        service: 'b'
      })

      if (faviconFile && uploaded.file === faviconFile) {
        iconMetadata = {
          rootHash: uploaded.sha256,
          mimeType: uploaded.mimeType,
          service: 'b'
        }
      }
    }

    if (failedFiles.length > 0) {
      log(`${failedFiles.length} files failed blossom upload, falling back to relay upload (irfs)`)
      irfsFileList = failedFiles.map(f => f.file)
    } else {
      irfsFileList = []
    }
  }

  for (const file of irfsFileList) {
    nmmr = new NMMR()
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
        mimeType: file.type || 'application/octet-stream',
        service: 'i'
      })

      if (faviconFile && file === faviconFile) {
        iconMetadata = {
          rootHash: nmmr.getRoot(),
          mimeType: file.type || 'application/octet-stream',
          service: 'i'
        }
      }
    }
  }

  log(`Uploading stall event for ${dTag}`)
  ;({ pause } = (await maybeUploadStall({
    dTag,
    channel,
    name: stallName,
    nameLang: nappJson.stallName?.[0]?.[1],
    isNameAuto: !nappJson.stallName?.[0]?.[0],
    summary: stallSummary,
    summaryLang: nappJson.stallSummary?.[0]?.[1],
    isSummaryAuto: !nappJson.stallSummary?.[0]?.[0],
    icon: iconMetadata,
    isIconAuto: !nappJson.stallIcon?.[0]?.[0],
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

  log(`Uploading bundle ${dTag}`)
  const bundle = await uploadBundle({ dTag, channel, fileMetadata, signer: nostrSigner, pause, shouldReupload, log })

  const appEntity = appEncode({
    dTag: bundle.tags.find(v => v[0] === 'd')[1],
    pubkey: bundle.pubkey,
    relays: [],
    kind: bundle.kind
  })
  log(`Visit at https://44billion.net/${appEntity}`)
}

async function uploadBundle ({ dTag, channel, fileMetadata, signer, pause = 0, shouldReupload = false, log = () => {} }) {
  const kind = {
    main: 37448, // stable
    next: 37449, // insider
    draft: 37450 // vibe coded preview
  }[channel] ?? 37448

  const fileTags = fileMetadata.map(v => ['file', v.rootHash, v.filename, v.mimeType, v.service || 'i'])
  const tags = [
    ['d', dTag],
    ...fileTags
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
    const recentFileTags = mostRecentEvent.tags
      .filter(t => t[0] === 'file' && t[2] !== '.well-known/napp.json')
      .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))

    const currentFileTags = fileTags
      .filter(t => t[2] !== '.well-known/napp.json')
      .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))

    const isSame = currentFileTags.length === recentFileTags.length && currentFileTags.every((t, i) => {
      const rt = recentFileTags[i]
      return rt.length >= 4 && rt[1] === t[1] && rt[2] === t[2] && rt[3] === t[3] && (rt[4] || 'i') === (t[4] || 'i')
    })

    if (isSame) {
      log(`Bundle based on ${fileTags.length} files is up-to-date (id: ${mostRecentEvent.id} - created_at: ${new Date(mostRecentEvent.created_at * 1000).toISOString()})`)

      const matchingEvents = events.filter(e => e.id === mostRecentEvent.id)
      const coveredRelays = new Set(matchingEvents.map(e => e.meta?.relay).filter(Boolean))
      const missingRelays = writeRelays.filter(r => !coveredRelays.has(r))

      if (missingRelays.length === 0) return mostRecentEvent

      // nostrRelays.getEvents currently doesn't tell us which event came from which relay,
      // so we re-upload to all relays to ensure consistency
      log(`Re-uploading existing bundle event to ${missingRelays.length} missing relays (out of ${writeRelays.length})`)
      await throttledSendEvent(mostRecentEvent, missingRelays, { pause, trailingPause: true, log, minSuccessfulRelays: 0 })
      return mostRecentEvent
    }
  }

  const createdAt = Math.floor(Date.now() / 1000)
  let effectiveCreatedAt = (mostRecentEvent && mostRecentEvent.created_at >= createdAt) ? mostRecentEvent.created_at + 1 : createdAt
  const maxCreatedAt = createdAt + 172800 // 2 days ahead
  if (effectiveCreatedAt > maxCreatedAt) effectiveCreatedAt = maxCreatedAt

  const appBundle = {
    kind,
    tags,
    content: '',
    created_at: effectiveCreatedAt
  }
  const event = await signer.signEvent(appBundle)
  await throttledSendEvent(event, writeRelays, { pause, trailingPause: true, log })
  return event
}

async function maybeUploadStall ({
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
  const iconService = icon?.service || 'i'
  const hasMetadata = Boolean(trimmedName) || Boolean(trimmedSummary) || Boolean(iconRootHash) ||
    Boolean(self) || (countries && countries.length > 0) || (categories && categories.length > 0) || (hashtags && hashtags.length > 0)

  const relays = [...new Set([...writeRelays, ...nappRelays].map(r => r.trim().replace(/\/$/, '')))]

  const previousResult = await getPreviousStall(dTag, relays, signer, channel)
  const previous = previousResult?.previous
  if (!previous && !hasMetadata) {
    if (shouldReupload) log('Skipping stall event upload: No previous event found and no metadata provided.')
    return { pause }
  }

  const publishStall = async (event) => {
    const signedEvent = await signer.signEvent(event)
    return await throttledSendEvent(signedEvent, relays, { pause, log, trailingPause: true })
  }

  const createdAt = Math.floor(Date.now() / 1000)
  const kind = {
    main: 37348,
    next: 37349,
    draft: 37350
  }[channel] ?? 37348

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

    let hasIcon = false
    let hasName = false
    if (iconRootHash && iconMimeType) {
      hasIcon = true
      tags.push(['icon', iconRootHash, iconMimeType, iconService])
      if (isIconAuto) tags.push(['auto', 'icon'])
    }

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

    if (!hasIcon || !hasName) {
      log(`Skipping stall event creation: Missing required metadata.${!hasName ? ' Name is missing.' : ''}${!hasIcon ? ' Icon is missing.' : ''}`)
      return { pause }
    }

    return await publishStall({
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
        return ['icon', iconRootHash, iconMimeType, iconService]
      })
      if (!isIconAuto) removeAuto('icon')
    }
  }

  if (!changed && !shouldReupload) {
    const { storedEvents } = previousResult

    const matchingEvents = storedEvents.filter(e => e.id === previous.id)
    const coveredRelays = new Set(matchingEvents.map(e => e.meta?.relay).filter(Boolean))
    const missingRelays = relays.filter(r => !coveredRelays.has(r))

    if (missingRelays.length === 0) return { pause }

    log(`Re-uploading existing stall event to ${missingRelays.length} missing relays (out of ${relays.length})`)
    return await throttledSendEvent(previous, missingRelays, { pause, log, trailingPause: true, minSuccessfulRelays: 0 })
  }

  let effectiveCreatedAt = (previous && previous.created_at >= createdAt) ? previous.created_at + 1 : createdAt
  const maxCreatedAt = createdAt + 172800 // 2 days ahead
  if (effectiveCreatedAt > maxCreatedAt) effectiveCreatedAt = maxCreatedAt

  return await publishStall({
    kind,
    tags,
    content: typeof previous.content === 'string' ? previous.content : '',
    created_at: effectiveCreatedAt
  })
}

async function getPreviousStall (dTagValue, relays, signer, channel) {
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
