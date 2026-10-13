// Match 44billion's formatManifestVersion, including its published_at validation.
export function formatManifestVersion (manifest, aggregateHash) {
  const shortHash = aggregateHash.slice(0, 8)
  const value = manifest?.tags?.find(tag => Array.isArray(tag) && tag[0] === 'published_at')?.[1]
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return shortHash
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp > Math.floor(Date.now() / 1000) + 600) return shortHash
  const date = new Date(timestamp * 1000).toISOString().split('T')[0]
  return `${date}-${shortHash}`
}
