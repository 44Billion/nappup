import { NAPP_CATEGORIES } from '#config/napp-categories.js'
import nostrRelays, { nappRelays } from '#services/nostr-relays.js'
import { throttledSendEvent } from '#services/irfs-upload.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToBase16 } from '#helpers/base16.js'
import { normalizeBlossomServerUrl, normalizeRelayUrl } from 'libp2r2p/url'

const MANAGED_MANIFEST_TAGS = new Set([
  'd', 'service', 'path', 'r', 'name', 'summary', 'description', 'self',
  'c', 'l', 't', 'auto', 'icon', 'key_art', 'screenshot', 'relay', 'server',
  'x', 'published_at'
])

export function normalizeManifestPath (value) {
  if (typeof value !== 'string') throw new TypeError('Manifest path must be a string')
  const path = value.startsWith('/') ? value.slice(1) : value
  // eslint-disable-next-line no-control-regex
  if (!path || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error(`Unsafe manifest path: ${JSON.stringify(value)}`)
  }
  const segments = path.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe manifest path: ${JSON.stringify(value)}`)
  }
  return path
}

function validRoot (root) {
  return typeof root === 'string' && /^[0-9a-f]{64}$/.test(root)
}

function manifestAggregateLines (manifest) {
  const tags = Array.isArray(manifest?.tags) ? manifest.tags : []
  const service = tags.find(tag => Array.isArray(tag) && tag[0] === 'service')?.[1]
  const lines = []

  if (service === 'irfs') {
    for (const tag of tags) {
      if (!Array.isArray(tag) || tag[0] !== 'r' || !validRoot(tag[1])) continue
      for (const field of tag.slice(2)) {
        if (typeof field !== 'string' || !field.startsWith('path ')) continue
        const path = normalizeManifestPath(field.slice(5))
        lines.push(`${tag[1]} /${path}\n`)
      }
    }
  } else {
    for (const tag of tags) {
      if (!Array.isArray(tag) || tag[0] !== 'path' || !validRoot(tag[2])) continue
      const path = normalizeManifestPath(tag[1])
      lines.push(`${tag[2]} /${path}\n`)
    }
  }

  return lines
}

export function getManifestAggregateHash (manifest) {
  const lines = manifestAggregateLines(manifest)
  if (!lines.length) throw new Error('Site manifest must reference at least one file')
  return bytesToBase16(sha256(new TextEncoder().encode(lines.sort().join(''))))
}

function decimalSize (size) {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('Asset size must be a non-negative safe integer')
  }
  return String(size)
}

function addField (fields, type, value) {
  if (typeof value === 'string' && value) fields.push(`${type} ${value}`)
}

function buildReferenceTags (uploadService, files, media) {
  const tags = []
  if (uploadService === 'blossom') {
    for (const file of files) {
      if (!validRoot(file.rootHash)) throw new Error('Invalid Blossom SHA-256 hash')
      tags.push(['path', normalizeManifestPath(file.filename), file.rootHash])
    }
  }

  const groups = new Map()
  const addToGroup = (asset, fieldType, fieldValue, country) => {
    if (!asset) return
    if (!validRoot(asset.rootHash)) throw new Error('Invalid asset root hash')
    const mimeType = typeof asset.mimeType === 'string' && asset.mimeType
      ? asset.mimeType
      : 'application/octet-stream'
    const size = decimalSize(asset.size)
    const key = `${asset.rootHash}\u0000${mimeType}\u0000${size}`
    let group = groups.get(key)
    if (!group) {
      group = { root: asset.rootHash, mimeType, size, fields: [] }
      groups.set(key, group)
    }
    addField(group.fields, fieldType, fieldValue)
    if (fieldType === 'mark' && country) addField(group.fields, 'country', country)
  }

  if (uploadService === 'irfs') {
    for (const file of files) addToGroup(file, 'path', normalizeManifestPath(file.filename))
  }
  for (const { asset, mark, country } of media) addToGroup(asset, 'mark', mark, country)

  for (const group of groups.values()) {
    tags.push(['r', group.root, ...group.fields, `m ${group.mimeType}`, `size ${group.size}`])
  }
  return tags
}

function buildMetadataTags ({
  name, nameLang, isNameAuto, summary, summaryLang, isSummaryAuto,
  isIconAuto, hasIcon, descriptions, self, countries, categories, hashtags
}) {
  const tags = []
  const trimmedName = typeof name === 'string' ? name.trim() : ''
  const trimmedSummary = typeof summary === 'string' ? summary.trim() : ''

  if (Array.isArray(countries) && countries.length) {
    for (const country of countries) {
      if (typeof country === 'string' && country) tags.push(['c', country])
    }
  } else {
    tags.push(['c', '*'])
  }
  if (typeof self === 'string' && self) tags.push(['self', self])

  let categoryCount = 0
  for (const entry of Array.isArray(categories) ? categories : []) {
    if (categoryCount >= 3) break
    if (!Array.isArray(entry)) continue
    const [category, subcategories] = entry
    for (const subcategory of Array.isArray(subcategories) ? subcategories : []) {
      if (categoryCount >= 3) break
      if (NAPP_CATEGORIES[category]?.includes(subcategory)) {
        tags.push(['l', `napp.${category}:${subcategory}`])
        categoryCount++
      }
    }
  }

  for (const entry of (Array.isArray(hashtags) ? hashtags : []).slice(0, 3)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
    const value = entry[0].replace(/\s/g, '').toLowerCase()
    if (!value) continue
    const tag = ['t', value]
    if (typeof entry[1] === 'string' && entry[1]) tag.push(entry[1])
    tags.push(tag)
  }

  if (trimmedName) {
    const tag = ['name', trimmedName]
    if (typeof nameLang === 'string' && nameLang) tag.push(nameLang)
    tags.push(tag)
    if (isNameAuto) tags.push(['auto', 'name'])
  }
  if (trimmedSummary) {
    const tag = ['summary', trimmedSummary]
    if (typeof summaryLang === 'string' && summaryLang) tag.push(summaryLang)
    tags.push(tag)
    if (isSummaryAuto) tags.push(['auto', 'summary'])
  }
  for (const entry of Array.isArray(descriptions) ? descriptions : []) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[0]) continue
    const tag = ['description', entry[0]]
    if (typeof entry[1] === 'string' && entry[1]) tag.push(entry[1])
    tags.push(tag)
  }
  if (isIconAuto && hasIcon) tags.push(['auto', 'icon'])
  return tags
}

function normalizeServiceUrls (values, normalizer) {
  const urls = []
  for (const value of Array.isArray(values) ? values : []) {
    try {
      const normalized = normalizer(value)
      if (!urls.includes(normalized)) urls.push(normalized)
    } catch (_) {}
  }
  return urls
}

function buildSourceHintTags (sourceRelays, blossomServers) {
  return [
    ...normalizeServiceUrls(sourceRelays, normalizeRelayUrl)
      .map(relay => ['relay', relay]),
    ...normalizeServiceUrls(blossomServers, normalizeBlossomServerUrl)
      .map(server => ['server', server])
  ]
}

export function buildManifestTags ({
  dTag, uploadService, fileMetadata = [], icon, keyArt = [], screenshots = [],
  previousTags = [], publishedAt, sourceRelays = [], blossomServers = [], ...metadata
}) {
  if (uploadService !== 'irfs' && uploadService !== 'blossom') {
    throw new Error('Unknown upload service')
  }
  const media = []
  if (icon) media.push({ asset: icon, mark: 'icon' })
  for (const asset of keyArt) media.push({ asset, mark: 'key_art', country: asset.country })
  for (const asset of screenshots) media.push({ asset, mark: 'screenshot', country: asset.country })

  const unknownTags = (Array.isArray(previousTags) ? previousTags : [])
    .filter(tag => Array.isArray(tag) && !MANAGED_MANIFEST_TAGS.has(tag[0]))
    .slice(0, 10)
    .map(tag => [...tag])

  if (!Number.isSafeInteger(publishedAt) || publishedAt < 0) {
    throw new Error('published_at must be a non-negative safe integer')
  }

  const referenceTags = buildReferenceTags(uploadService, fileMetadata, media)
  const aggregateHash = getManifestAggregateHash({
    tags: [...referenceTags, ['service', uploadService]]
  })

  return [
    ['d', dTag],
    ...referenceTags,
    ['service', uploadService],
    ...buildSourceHintTags(sourceRelays, blossomServers),
    ['x', aggregateHash, 'aggregate'],
    ['published_at', String(publishedAt)],
    ...buildMetadataTags({ ...metadata, hasIcon: Boolean(icon) }),
    ...unknownTags
  ]
}

function manifestKind (channel) {
  return {
    main: 35128,
    next: 35129,
    draft: 35130
  }[channel] ?? 35128
}

function newestFirst (a, b) {
  if (b.created_at !== a.created_at) return b.created_at - a.created_at
  return String(a.id).localeCompare(String(b.id))
}

export async function uploadSiteManifest ({
  dTag, channel, fileMetadata, uploadService, signer, pause = 0,
  shouldReupload = false, log = () => {}, ...metadata
}) {
  const kind = manifestKind(channel)
  const relays = [...new Set([...(await signer.getRelays()).write, ...nappRelays]
    .map(relay => relay.trim().replace(/\/$/, '')))]
  const events = (await nostrRelays.getEvents({
    kinds: [kind],
    authors: [await signer.getPublicKey()],
    '#d': [dTag],
    limit: 1
  }, relays, { timeoutAfterFirstEose: null })).result
  events.sort(newestFirst)
  const previous = events[0]

  const now = Math.floor(Date.now() / 1000)
  const createdAt = Math.max(now, (previous?.created_at ?? -1) + 1)
  if (createdAt > now + 172800) throw new Error('Existing manifest timestamp is too far in the future to replace safely')

  const prospectiveTags = buildManifestTags({
    dTag, uploadService, fileMetadata, previousTags: previous?.tags,
    publishedAt: createdAt, ...metadata
  })
  const aggregateHash = getManifestAggregateHash({ tags: prospectiveTags })
  let previousAggregateHash = null
  try {
    if (previous) previousAggregateHash = getManifestAggregateHash(previous)
  } catch (_) {}
  const isSameVersion = previousAggregateHash === aggregateHash
  const previousPublishedAt = previous?.tags?.find(tag => tag[0] === 'published_at')?.[1]
  const parsedPreviousPublishedAt = typeof previousPublishedAt === 'string' && /^(0|[1-9][0-9]*)$/.test(previousPublishedAt)
    ? Number(previousPublishedAt)
    : null
  const fallbackPublishedAt = Number.isSafeInteger(previous?.created_at) && previous.created_at >= 0
    ? previous.created_at
    : createdAt
  const publishedAt = isSameVersion && Number.isSafeInteger(parsedPreviousPublishedAt)
    ? parsedPreviousPublishedAt
    : (isSameVersion ? fallbackPublishedAt : createdAt)
  const tags = buildManifestTags({
    dTag, uploadService, fileMetadata, previousTags: previous?.tags,
    publishedAt, ...metadata
  })

  if (!shouldReupload && previous && previous.content === '' && JSON.stringify(previous.tags) === JSON.stringify(tags)) {
    const coveredRelays = new Set(events
      .filter(event => event.id === previous.id)
      .map(event => event.meta?.relay)
      .filter(Boolean))
    const missingRelays = relays.filter(relay => !coveredRelays.has(relay))
    if (!missingRelays.length) return previous
    log(`Re-uploading existing site manifest to ${missingRelays.length} missing relays`)
    await throttledSendEvent(previous, missingRelays, {
      pause, trailingPause: true, log, minSuccessfulRelays: 0
    })
    return previous
  }

  const event = await signer.signEvent({ kind, tags, content: '', created_at: createdAt })
  await throttledSendEvent(event, relays, { pause, trailingPause: true, log })
  return event
}
