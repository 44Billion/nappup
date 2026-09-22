import { sha256 } from '@noble/hashes/sha2.js'
import nostrRelays from '#services/nostr-relays.js'
import { bytesToBase16 } from '#helpers/base16.js'
import { normalizeBlossomServerUrl } from 'libp2r2p/url'
import { classifySignerError } from '#errors.js'

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5000
const DEFAULT_EXISTENCE_CHECK_TIMEOUT_MS = 5000
const DEFAULT_UPLOAD_TIMEOUT_MS = 60000
const MAX_RETRY_WAIT_MS = 60000

// Bounds browser fetches whose native network timeout can take minutes.
async function fetchWithTimeout (url, options, timeoutMs, consume = response => response) {
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    return await consume(response)
  } catch (error) {
    if (timedOut) {
      throw Object.assign(new Error(`request timed out after ${timeoutMs}ms`, { cause: error }), { category: 'timeout' })
    }
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
  }, writeRelays)).result.map(({ event }) => event)

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

// Retry-After is advisory timing; X-Reason is diagnostic text, never policy.
function retryAfterMs (value) {
  if (!value) return 0
  const text = value.trim()
  if (/^\d+$/.test(text)) return Number(text) * 1000
  const date = Date.parse(text)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0
}

async function readUploadResponse (response) {
  if (response.status !== 200 && response.status !== 201) {
    const status = response.status
    const reason = response.headers.get('X-Reason') || response.statusText || 'No error message provided'
    const error = new Error(`upload returned an error (${status}): ${reason}`)
    error.code = 'BLOSSOM_HTTP_ERROR'
    error.status = status
    error.retryable = [408, 425, 429].includes(status) || (status >= 500 && status <= 599 && ![501, 505].includes(status))
    error.retryAfterMs = retryAfterMs(response.headers.get('Retry-After'))
    await response.body?.cancel().catch(() => {})
    throw error
  }
  try {
    return await response.json()
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause
    const error = new Error('upload returned an invalid JSON blob descriptor', { cause })
    error.retryable = false
    throw error
  }
}

/**
 * Uploads a single file to a single blossom server with bounded retry+backoff.
 * Returns { success: true, descriptor } or { success: false, error }.
 */
async function uploadFileToServer (serverUrl, signer, file, fileHash, mimeType, { shouldReupload, log, maxRetries = 5, uploadTimeoutMs }) {
  if (!shouldReupload) {
    try {
      const checkResponse = await fetchWithTimeout(
        `${serverUrl}/${fileHash}`,
        { method: 'HEAD' },
        DEFAULT_EXISTENCE_CHECK_TIMEOUT_MS
      )
      if (checkResponse.ok) return { success: true, alreadyExists: true }
    } catch (error) {
      log(`Could not check whether ${fileHash} exists on ${serverUrl}; uploading it anyway: ${error?.message ?? error}`)
    }
  }

  let pause = 1000
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        log(`Retrying upload to ${serverUrl} in ${pause}ms (attempt ${attempt + 1}/${maxRetries + 1})`)
        await new Promise(resolve => setTimeout(resolve, pause))
      }
      const authorization = await createAuthHeader(signer, (evt) => {
        evt.tags.push(['t', 'upload'])
        evt.tags.push(['x', fileHash])
      })
      const headers = { 'Content-Type': mimeType, 'X-SHA-256': fileHash, Authorization: authorization }
      // Browsers own Content-Length. A native Blob/File gives fetch its size;
      // Node's file-like streaming adapter needs the known length explicitly.
      if (globalThis.process?.versions?.node && Number.isSafeInteger(file.size) && file.size >= 0) {
        headers['Content-Length'] = String(file.size)
      }
      const isBlob = typeof Blob !== 'undefined' && file instanceof Blob
      const descriptor = await fetchWithTimeout(`${serverUrl}/upload`, {
        method: 'PUT', headers,
        body: isBlob ? file : file.stream(),
        ...(isBlob ? {} : { duplex: 'half' }),
        redirect: 'manual'
      }, uploadTimeoutMs, readUploadResponse)
      return { success: true, descriptor }
    } catch (error) {
      if (classifySignerError(error) || error.name === 'AbortError' || error.retryable === false || attempt === maxRetries) {
        return { success: false, error }
      }
      if (error.retryAfterMs > MAX_RETRY_WAIT_MS) {
        log(`${serverUrl}: Retry-After exceeds the ${MAX_RETRY_WAIT_MS}ms automatic wait budget; retry in a later operation`)
        return { success: false, error }
      }
      pause = Math.max(1000 + attempt * 2000, error.retryAfterMs || 0)
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
  uploadTimeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
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
      const result = await uploadFileToServer(serverUrl, signer, info.file, info.sha256, info.mimeType, { shouldReupload, log, maxRetries, uploadTimeoutMs })

      if (result.success) {
        fileServerResults[i].successCount++
        if (result.alreadyExists) {
          log(`${info.filename}: Already exists on ${serverUrl}`)
        } else {
          log(`${info.filename}: Uploaded to ${serverUrl}`)
        }
      } else {
        fileServerResults[i].errors.push({ server: serverUrl, error: result.error })
        log(`${info.filename}: Failed to upload to ${serverUrl} (${info.mimeType}, ${info.file.size} bytes): ${result.error?.message ?? result.error}`)
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
