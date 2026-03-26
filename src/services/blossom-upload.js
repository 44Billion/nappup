import { sha256 } from '@noble/hashes/sha2.js'
import { BlossomClient } from 'nostr-tools/nipb7'
import nostrRelays from '#services/nostr-relays.js'
import { bytesToBase16 } from '#helpers/base16.js'

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

  return (best.tags ?? [])
    .filter(t => Array.isArray(t) && t[0] === 'server' && /^https?:\/\//.test(t[1]))
    .map(t => t[1].trim().replace(/\/$/, ''))
    .filter(Boolean)
}

/**
 * Health-checks blossom servers using the `check` method with a random sha256 hash.
 * A server is considered healthy if the check call completes without a network-level error.
 * The check is expected to fail with a 404 (blob not found), which is fine — it means the server is up.
 * Returns the subset of servers that are reachable.
 */
export async function healthCheckServers (servers, signer, { log = () => {} } = {}) {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32))
  const hashBuffer = await crypto.subtle.digest('SHA-256', randomBytes)
  const randomHash = bytesToBase16(new Uint8Array(hashBuffer))

  const results = await Promise.allSettled(
    servers.map(async (serverUrl) => {
      const client = new BlossomClient(serverUrl, signer)
      try {
        await client.check(randomHash)
      } catch (err) {
        // check() throws on non-2xx. A 404 means the server is up but blob doesn't exist — that's fine.
        // We only want to filter out servers that are truly unreachable (network errors).
        const message = err?.message ?? ''
        if (message.includes('returned an error')) {
          // Server responded with an HTTP error — it's reachable
          return serverUrl
        }
        throw err
      }
      return serverUrl
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
async function uploadFileToServer (client, file, fileHash, mimeType, { shouldReupload, log, maxRetries = 5 }) {
  // Check if already uploaded
  if (!shouldReupload) {
    try {
      await client.check(fileHash)
      // File already exists on this server
      return { success: true, alreadyExists: true }
    } catch {
      // Not found — proceed to upload
    }
  }

  let pause = 1000
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        log(`Retrying upload to ${client.mediaserver} (attempt ${attempt + 1}/${maxRetries + 1})`)
        await new Promise(resolve => setTimeout(resolve, pause))
        pause += 2000
      }
      const descriptor = await client.httpCall(
        'PUT',
        'upload',
        mimeType,
        () => client.authorizationHeader((evt) => {
          evt.tags.push(['t', 'upload'])
          evt.tags.push(['x', fileHash])
        }),
        file.stream(),
        {}
      )
      return { success: true, descriptor }
    } catch (err) {
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
 * where each uploadedFile has { file, filename, sha256, mimeType }
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
  if (servers.length === 0) return { uploadedFiles: [], failedFiles: [...fileList.map(f => ({ file: f }))] }

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
  const serverTasks = servers.map(async (serverUrl) => {
    const client = new BlossomClient(serverUrl, signer)

    for (let i = 0; i < fileInfos.length; i++) {
      const info = fileInfos[i]
      log(`Uploading ${info.filename} to ${serverUrl}`)
      const result = await uploadFileToServer(client, info.file, info.sha256, info.mimeType, { shouldReupload, log, maxRetries })

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

  await Promise.allSettled(serverTasks)

  const uploadedFiles = []
  const failedFiles = []

  for (let i = 0; i < fileInfos.length; i++) {
    const info = fileInfos[i]
    if (fileServerResults[i].successCount > 0) {
      uploadedFiles.push({
        file: info.file,
        filename: info.filename,
        sha256: info.sha256,
        mimeType: info.mimeType
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
