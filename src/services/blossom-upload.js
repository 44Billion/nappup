import { sha256 } from '@noble/hashes/sha2.js'
import nostrRelays from '#services/nostr-relays.js'
import { bytesToBase16 } from '#helpers/base16.js'
import { normalizeBlossomServerUrl } from 'libp2r2p/url'
import { classifySignerError } from '#errors.js'

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5000
const DEFAULT_EXISTENCE_CHECK_TIMEOUT_MS = 5000

// Bounds browser fetches whose native network timeout can take minutes.
async function fetchWithTimeout (url, options, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (timedOut) throw new Error(`request timed out after ${timeoutMs}ms`)
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

async function createAuthHeader (signer, modify) {
  const now = Math.floor(Date.now() / 1000)
  const event = {
    created_at: now,
    kind: 24242,
    content: 'blossom stuff',
    tags: [['expiration', String(now + 60)]]
  }
  if (modify) modify(event)
  const signedEvent = await signer.signEvent(event)
  return 'Nostr ' + btoa(JSON.stringify(signedEvent))
}

/**
 * Fetches the user's blossom server list from their kind 10063 event.
 * Returns an array of server URLs, or empty array if none configured.
 */
export async function getBlossomServers (signer, writeRelays) {
  const pubkey = await signer.getPublicKey()
  const events = (await nostrRelays.getEvents({
    kinds: [10063],
    authors: [pubkey],
    limit: 1
  }, writeRelays)).result

  if (events.length === 0) return []

  events.sort((a, b) => b.created_at - a.created_at)
  const best = events[0]

  return [...new Set((best.tags ?? [])
    .filter(t => Array.isArray(t) && t[0] === 'server')
    .flatMap(tag => {
      try { return [normalizeBlossomServerUrl(tag[1])] } catch (_) { return [] }
    }))]
}

/**
 * Health-checks blossom servers with a simple HEAD request.
 * A server is considered healthy if fetch resolves (any HTTP status).
 * Network errors and timeouts mark a server as unreachable.
 */
export async function healthCheckServers (servers, signer, {
  log = () => {},
  timeoutMs = DEFAULT_HEALTH_CHECK_TIMEOUT_MS
} = {}) {
  const results = await Promise.allSettled(
    servers.map(async (serverUrl) => {
      const normalized = normalizeBlossomServerUrl(serverUrl)
      await fetchWithTimeout(normalized, { method: 'HEAD', mode: 'no-cors' }, timeoutMs)
      return normalized
    })
  )

  const healthy = []
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      healthy.push(results[i].value)
    } else {
      log(`Blossom server ${servers[i]} is unreachable: ${results[i].reason?.message ?? results[i].reason}`)
    }
  }
  return healthy
}

/**
 * Computes the sha256 hex hash of a File/Blob using streaming for memory efficiency.
 */
export async function computeFileHash (file) {
  const hash = sha256.create()
  const reader = file.stream().getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    hash.update(value)
  }
  return bytesToBase16(hash.digest())
}

/**
 * Uploads a single file to a single blossom server with retry+backoff.
 * Returns { success: true, descriptor } or { success: false, error }.
 */
async function uploadFileToServer (serverUrl, signer, file, fileHash, mimeType, { shouldReupload, log, maxRetries = 5 }) {
  // Check if already uploaded
  if (!shouldReupload) {
    try {
      const checkResponse = await fetchWithTimeout(
        `${serverUrl}/${fileHash}`,
        { method: 'HEAD' },
        DEFAULT_EXISTENCE_CHECK_TIMEOUT_MS
      )
      if (checkResponse.ok) {
        return { success: true, alreadyExists: true }
      }
    } catch (error) {
      log(`Could not check whether ${fileHash} exists on ${serverUrl}; uploading it anyway: ${error?.message ?? error}`)
    }
  }

  let pause = 1000
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        log(`Retrying upload to ${serverUrl} (attempt ${attempt + 1}/${maxRetries + 1})`)
        await new Promise(resolve => setTimeout(resolve, pause))
        pause += 2000
      }
      const authorization = await createAuthHeader(signer, (evt) => {
        evt.tags.push(['t', 'upload'])
        evt.tags.push(['x', fileHash])
      })
      const response = await fetch(`${serverUrl}/upload`, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType, Authorization: authorization },
        body: file.stream(),
        duplex: 'half'
      })
      if (response.status >= 300) {
        const reason = response.headers.get('X-Reason') || response.statusText
        throw new Error(`upload returned an error (${response.status}): ${reason}`)
      }
      const descriptor = await response.json()
      return { success: true, descriptor }
    } catch (err) {
      if (classifySignerError(err)) {
        // Signer-level failures (locked vault, rejected prompt) are not
        // transient upload errors: retrying would just re-prompt or fail
        // again, so surface them immediately.
        return { success: false, error: err }
      }
      if (attempt === maxRetries) {
        return { success: false, error: err }
      }
    }
  }
  return { success: false, error: new Error('Max retries exceeded') }
}

/**
 * Uploads all files to blossom servers.
 *
 * For each server, files are uploaded one at a time (sequentially).
 * Different servers run in parallel.
 *
 * Returns { uploadedFiles: [...], failedFiles: [...] }
 * where each uploadedFile has { file, filename, sha256, mimeType, size }
 * and each failedFile has { file, filename, mimeType, errors }.
 */
export async function uploadFilesToBlossom ({
  fileList,
  servers,
  signer,
  shouldReupload = false,
  maxRetries = 5,
  log = () => {}
}) {
  const normalizedServers = [...new Set(servers.flatMap(server => {
    try { return [normalizeBlossomServerUrl(server)] } catch (_) { return [] }
  }))]
  if (normalizedServers.length === 0) {
    return { uploadedFiles: [], failedFiles: [...fileList.map(f => ({ file: f }))] }
  }

  // Pre-compute file info
  const fileInfos = await Promise.all(
    fileList.map(async (file) => {
      const filename = file.webkitRelativePath.split('/').slice(1).join('/')
      const mimeType = file.type || 'application/octet-stream'
      const fileHash = await computeFileHash(file)
      return { file, filename, mimeType, sha256: fileHash }
    })
  )

  // For each file, track which servers accepted it
  const fileServerResults = fileInfos.map(() => ({ successCount: 0, errors: [] }))

  // Upload to each server in parallel, but within a server, upload files sequentially
  const serverTasks = normalizedServers.map(async (serverUrl) => {
    for (let i = 0; i < fileInfos.length; i++) {
      const info = fileInfos[i]
      log(`Uploading ${info.filename} to ${serverUrl}`)
      const result = await uploadFileToServer(serverUrl, signer, info.file, info.sha256, info.mimeType, { shouldReupload, log, maxRetries })

      if (result.success) {
        fileServerResults[i].successCount++
        if (result.alreadyExists) {
          log(`${info.filename}: Already exists on ${serverUrl}`)
        } else {
          log(`${info.filename}: Uploaded to ${serverUrl}`)
        }
      } else {
        fileServerResults[i].errors.push({ server: serverUrl, error: result.error })
        log(`${info.filename}: Failed to upload to ${serverUrl}: ${result.error?.message ?? result.error}`)
      }
    }
  })

  // Unexpected task errors indicate a programming failure and must reach the caller.
  await Promise.all(serverTasks)

  const uploadedFiles = []
  const failedFiles = []

  for (let i = 0; i < fileInfos.length; i++) {
    const info = fileInfos[i]
    if (fileServerResults[i].successCount > 0) {
      uploadedFiles.push({
        file: info.file,
        filename: info.filename,
        sha256: info.sha256,
        mimeType: info.mimeType,
        size: info.file.size
      })
    } else {
      failedFiles.push({
        file: info.file,
        filename: info.filename,
        mimeType: info.mimeType,
        errors: fileServerResults[i].errors
      })
    }
  }

  return { uploadedFiles, failedFiles }
}
