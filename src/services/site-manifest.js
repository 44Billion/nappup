import { NAPP_CATEGORIES } from '#config/napp-categories.js'
import nostrRelays, { nappRelays } from '#services/nostr-relays.js'
import { throttledSendEvent } from '#services/irfs-upload.js'

const MANAGED_MANIFEST_TAGS = new Set([
  'd', 'service', 'path', 'r', 'name', 'summary', 'description', 'self',
  'c', 'l', 't', 'auto', 'icon', 'key_art', 'screenshot'
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

export function buildManifestTags ({
  dTag, uploadService, fileMetadata = [], icon, keyArt = [], screenshots = [],
  previousTags = [], ...metadata
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

  return [
    ['d', dTag],
    ...buildReferenceTags(uploadService, fileMetadata, media),
    ['service', uploadService],
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
  }, relays)).result
  events.sort(newestFirst)
  const previous = events[0]
  const tags = buildManifestTags({
    dTag, uploadService, fileMetadata, previousTags: previous?.tags, ...metadata
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

  const now = Math.floor(Date.now() / 1000)
  const createdAt = Math.max(now, (previous?.created_at ?? -1) + 1)
  if (createdAt > now + 172800) throw new Error('Existing manifest timestamp is too far in the future to replace safely')
  const event = await signer.signEvent({ kind, tags, content: '', created_at: createdAt })
  await throttledSendEvent(event, relays, { pause, trailingPause: true, log })
  return event
}
