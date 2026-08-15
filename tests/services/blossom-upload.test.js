import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getBlossomServers,
  healthCheckServers,
  uploadFilesToBlossom,
  computeFileHash
} from '#services/blossom-upload.js'

// Helper to create a mock signer
function createMockSigner (pubkey = 'a'.repeat(64)) {
  return {
    getPublicKey: () => pubkey,
    signEvent: (event) => ({
      ...event,
      id: 'b'.repeat(64),
      pubkey,
      sig: 'c'.repeat(128)
    })
  }
}

// Helper to create a fake File-like object
function createFakeFile (content, filename, mimeType = 'text/plain') {
  const bytes = new TextEncoder().encode(content)
  const blob = new Blob([bytes], { type: mimeType })
  blob.webkitRelativePath = `root/${filename}`
  return blob
}

describe('blossom-upload', () => {
  describe('getBlossomServers', () => {
    it('should return empty array when no kind 10063 event exists', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [],
        errors: [],
        success: true
      }))

      const signer = createMockSigner()
      const servers = await getBlossomServers(signer, ['wss://relay.test'])
      assert.deepEqual(servers, [])
    })

    it('should extract server URLs from kind 10063 event tags', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [{
          id: 'e'.repeat(64),
          pubkey: 'a'.repeat(64),
          kind: 10063,
          created_at: 1700000000,
          content: '',
          tags: [
            ['server', 'https://blossom.self.hosted'],
            ['server', 'https://cdn.blossom.cloud/']
          ],
          sig: 'f'.repeat(128)
        }],
        errors: [],
        success: true
      }))

      const signer = createMockSigner()
      const servers = await getBlossomServers(signer, ['wss://relay.test'])
      assert.deepEqual(servers, [
        'https://blossom.self.hosted',
        'https://cdn.blossom.cloud'
      ])
    })

    it('should return the most recent event when multiple exist', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [
          {
            id: '1'.repeat(64),
            pubkey: 'a'.repeat(64),
            kind: 10063,
            created_at: 1700000000,
            content: '',
            tags: [['server', 'https://old.server']],
            sig: 'f'.repeat(128)
          },
          {
            id: '2'.repeat(64),
            pubkey: 'a'.repeat(64),
            kind: 10063,
            created_at: 1700001000,
            content: '',
            tags: [['server', 'https://new.server']],
            sig: 'f'.repeat(128)
          }
        ],
        errors: [],
        success: true
      }))

      const signer = createMockSigner()
      const servers = await getBlossomServers(signer, ['wss://relay.test'])
      assert.deepEqual(servers, ['https://new.server'])
    })

    it('should filter out non-server tags', async (t) => {
      const nostrRelaysModule = await import('#services/nostr-relays.js')
      const nostrRelays = nostrRelaysModule.default

      t.mock.method(nostrRelays, 'getEvents', async () => ({
        result: [{
          id: 'e'.repeat(64),
          pubkey: 'a'.repeat(64),
          kind: 10063,
          created_at: 1700000000,
          content: '',
          tags: [
            ['server', 'https://VALID.server/'],
            ['server', 'https://valid.server'],
            ['server', 'https://valid.server/path'],
            ['d', 'something'],
            ['server', '']
          ],
          sig: 'f'.repeat(128)
        }],
        errors: [],
        success: true
      }))

      const signer = createMockSigner()
      const servers = await getBlossomServers(signer, ['wss://relay.test'])
      assert.deepEqual(servers, ['https://valid.server'])
    })
  })

  describe('healthCheckServers', () => {
    it('should return all servers when all are reachable', async (t) => {
      // Mock global fetch to simulate server responses
      const originalFetch = globalThis.fetch
      t.after(() => { globalThis.fetch = originalFetch })

      globalThis.fetch = async (url, opts) => {
        if (opts?.method === 'HEAD') {
          return new Response(null, { status: 404 })
        }
        return new Response(null, { status: 200 })
      }

      const signer = createMockSigner()
      const healthy = await healthCheckServers(
        ['https://server1.test', 'https://server2.test'],
        signer
      )
      assert.equal(healthy.length, 2)
      assert.ok(healthy.includes('https://server1.test'))
      assert.ok(healthy.includes('https://server2.test'))
    })

    it('should filter out unreachable servers', async (t) => {
      const originalFetch = globalThis.fetch
      t.after(() => { globalThis.fetch = originalFetch })

      globalThis.fetch = async (url, _opts) => {
        if (url.includes('bad-server')) {
          throw new Error('Network error')
        }
        // Good server returns 404 (blob not found — server is up)
        return new Response(null, { status: 404 })
      }

      const signer = createMockSigner()
      const logs = []
      const healthy = await healthCheckServers(
        ['https://good-server.test', 'https://bad-server.test'],
        signer,
        { log: (msg) => logs.push(msg) }
      )
      assert.equal(healthy.length, 1)
      assert.equal(healthy[0], 'https://good-server.test')
      assert.ok(logs.some(l => l.includes('bad-server.test') && l.includes('unreachable')))
    })

    it('should time out an unresponsive server without delaying healthy servers', async (t) => {
      const originalFetch = globalThis.fetch
      t.after(() => { globalThis.fetch = originalFetch })

      globalThis.fetch = async (url, opts) => {
        if (url.includes('slow-server')) {
          return await new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        }
        return new Response(null, { status: 404 })
      }

      const logs = []
      const healthy = await healthCheckServers(
        ['https://slow-server.test', 'https://healthy-server.test'],
        createMockSigner(),
        { timeoutMs: 5, log: message => logs.push(message) }
      )

      assert.deepEqual(healthy, ['https://healthy-server.test'])
      assert.ok(logs.some(log => log.includes('request timed out after 5ms')))
    })

    it('should treat HTTP error responses as healthy (server is reachable)', async (t) => {
      const originalFetch = globalThis.fetch
      t.after(() => { globalThis.fetch = originalFetch })

      globalThis.fetch = async () => {
        return new Response(null, { status: 403, statusText: 'Forbidden' })
      }

      const signer = createMockSigner()
      const healthy = await healthCheckServers(['https://server.test'], signer)
      assert.equal(healthy.length, 1)
    })

    it('should return empty array when no servers provided', async () => {
      const signer = createMockSigner()
      const healthy = await healthCheckServers([], signer)
      assert.deepEqual(healthy, [])
    })
  })

  describe('computeFileHash', () => {
    it('should compute a valid sha256 hex hash', async () => {
      const file = createFakeFile('hello world', 'test.txt')
      const hash = await computeFileHash(file)
      assert.match(hash, /^[a-f0-9]{64}$/)
    })

    it('should produce different hashes for different content', async () => {
      const file1 = createFakeFile('hello', 'a.txt')
      const file2 = createFakeFile('world', 'b.txt')
      const hash1 = await computeFileHash(file1)
      const hash2 = await computeFileHash(file2)
      assert.notEqual(hash1, hash2)
    })

    it('should produce same hash for same content', async () => {
      const file1 = createFakeFile('identical', 'a.txt')
      const file2 = createFakeFile('identical', 'b.txt')
      const hash1 = await computeFileHash(file1)
      const hash2 = await computeFileHash(file2)
      assert.equal(hash1, hash2)
    })
  })

  describe('uploadFilesToBlossom', () => {
    it('should return all files as failed when no servers provided', async () => {
      const file1 = createFakeFile('content1', 'file1.html')
      const file2 = createFakeFile('content2', 'file2.js')

      const result = await uploadFilesToBlossom({
        fileList: [file1, file2],
        servers: [],
        signer: createMockSigner()
      })

      assert.equal(result.uploadedFiles.length, 0)
      assert.equal(result.failedFiles.length, 2)
    })

    it('should upload files successfully to healthy servers', async (t) => {
      const originalFetch = globalThis.fetch
      t.after(() => { globalThis.fetch = originalFetch })

      const uploadedBlobs = []
      globalThis.fetch = async (url, opts) => {
        const urlStr = url.toString()
        // check (HEAD) — file doesn't exist yet
        if (opts?.method === 'HEAD') {
          return new Response(null, { status: 404, statusText: 'Not Found', headers: { 'X-Reason': 'not found' } })
        }
        // upload (PUT)
        if (opts?.method === 'PUT') {
          uploadedBlobs.push(urlStr)
          return new Response(JSON.stringify({
            url: urlStr,
            sha256: 'a'.repeat(64),
            size: 100,
            type: 'text/plain',
            uploaded: Date.now()
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(null, { status: 200 })
      }

      const file1 = createFakeFile('hello world', 'index.html', 'text/html')
      const signer = createMockSigner()
      const logs = []

      const result = await uploadFilesToBlossom({
        fileList: [file1],
        servers: ['https://server1.test'],
        signer,
        log: (msg) => logs.push(msg)
      })

      assert.equal(result.uploadedFiles.length, 1)
      assert.equal(result.failedFiles.length, 0)
      assert.equal(result.uploadedFiles[0].filename, 'index.html')
      assert.equal(result.uploadedFiles[0].mimeType, 'text/html')
      assert.match(result.uploadedFiles[0].sha256, /^[a-f0-9]{64}$/)
      assert.ok(uploadedBlobs.length > 0)
    })

    it('should upload when the existence check is blocked by CORS', async (t) => {
      const originalFetch = globalThis.fetch
      t.after(() => { globalThis.fetch = originalFetch })

      let uploadCalled = false
      globalThis.fetch = async (_url, opts) => {
        if (opts?.method === 'HEAD') throw new TypeError('Failed to fetch')
        if (opts?.method === 'PUT') {
          uploadCalled = true
          return new Response(JSON.stringify({ sha256: 'a'.repeat(64) }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(null, { status: 200 })
      }

      const logs = []
      const result = await uploadFilesToBlossom({
        fileList: [createFakeFile('hello world', 'index.html', 'text/html')],
        servers: ['https://server.test'],
        signer: createMockSigner(),
        log: message => logs.push(message)
      })

      assert.equal(uploadCalled, true)
      assert.equal(result.uploadedFiles.length, 1)
      assert.equal(result.failedFiles.length, 0)
      assert.ok(logs.some(log => log.includes('uploading it anyway')))
    })

    it('should skip upload when file already exists and shouldReupload is false', async (t) => {
      const originalFetch = globalThis.fetch
      t.after(() => { globalThis.fetch = originalFetch })

      let uploadCalled = false
      globalThis.fetch = async (url, opts) => {
        // check (HEAD) — file exists
        if (opts?.method === 'HEAD') {
          return new Response(null, { status: 200 })
        }
        // upload (PUT) — should not be called
        if (opts?.method === 'PUT') {
          uploadCalled = true
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(null, { status: 200 })
      }

      const file1 = createFakeFile('hello world', 'index.html', 'text/html')
      const logs = []

      const result = await uploadFilesToBlossom({
        fileList: [file1],
        servers: ['https://server1.test'],
        signer: createMockSigner(),
        shouldReupload: false,
        log: (msg) => logs.push(msg)
      })

      assert.equal(result.uploadedFiles.length, 1)
      assert.equal(uploadCalled, false)
      assert.ok(logs.some(l => l.includes('Already exists')))
    })

    it('should reupload when shouldReupload is true even if file exists', async (t) => {
      const originalFetch = globalThis.fetch
      t.after(() => { globalThis.fetch = originalFetch })

      let uploadCalled = false
      globalThis.fetch = async (url, opts) => {
        if (opts?.method === 'PUT') {
          uploadCalled = true
          return new Response(JSON.stringify({
            url: url.toString(),
            sha256: 'a'.repeat(64),
            size: 100,
            type: 'text/html',
            uploaded: Date.now()
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(null, { status: 200 })
      }

      const file1 = createFakeFile('hello', 'index.html', 'text/html')

      const result = await uploadFilesToBlossom({
        fileList: [file1],
        servers: ['https://server1.test'],
        signer: createMockSigner(),
        shouldReupload: true
      })

      assert.equal(result.uploadedFiles.length, 1)
      assert.equal(uploadCalled, true)
    })

    it('should report files as failed when all servers fail', async (t) => {
      const originalFetch = globalThis.fetch
      t.after(() => { globalThis.fetch = originalFetch })

      globalThis.fetch = async (url, opts) => {
        // check — not found
        if (opts?.method === 'HEAD') {
          return new Response(null, { status: 404, statusText: 'Not Found', headers: { 'X-Reason': 'not found' } })
        }
        // upload — always fail
        if (opts?.method === 'PUT') {
          return new Response(null, { status: 500, statusText: 'Internal Server Error', headers: { 'X-Reason': 'server error' } })
        }
        return new Response(null, { status: 200 })
      }

      const file1 = createFakeFile('content', 'app.js', 'application/javascript')
      const logs = []

      const result = await uploadFilesToBlossom({
        fileList: [file1],
        servers: ['https://server1.test'],
        signer: createMockSigner(),
        maxRetries: 0,
        log: (msg) => logs.push(msg)
      })

      assert.equal(result.uploadedFiles.length, 0)
      assert.equal(result.failedFiles.length, 1)
      assert.equal(result.failedFiles[0].filename, 'app.js')
    })

    it('should succeed if at least one server accepts the file', async (t) => {
      const originalFetch = globalThis.fetch
      t.after(() => { globalThis.fetch = originalFetch })

      globalThis.fetch = async (url, opts) => {
        const urlStr = url.toString()
        // check — not found
        if (opts?.method === 'HEAD') {
          return new Response(null, { status: 404, statusText: 'Not Found', headers: { 'X-Reason': 'not found' } })
        }
        // upload — fail on bad-server, succeed on good-server
        if (opts?.method === 'PUT') {
          if (urlStr.includes('bad-server')) {
            return new Response(null, { status: 500, statusText: 'Error', headers: { 'X-Reason': 'error' } })
          }
          return new Response(JSON.stringify({
            url: urlStr,
            sha256: 'd'.repeat(64),
            size: 50,
            type: 'text/plain',
            uploaded: Date.now()
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(null, { status: 200 })
      }

      const file1 = createFakeFile('test', 'style.css', 'text/css')

      const result = await uploadFilesToBlossom({
        fileList: [file1],
        servers: ['https://good-server.test', 'https://bad-server.test'],
        signer: createMockSigner(),
        maxRetries: 0
      })

      assert.equal(result.uploadedFiles.length, 1)
      assert.equal(result.failedFiles.length, 0)
    })

    it('should not retry when the signer denies the auth request', async (t) => {
      const originalFetch = globalThis.fetch
      t.after(() => { globalThis.fetch = originalFetch })

      globalThis.fetch = async (url, opts) => {
        if (opts?.method === 'HEAD') {
          return new Response(null, { status: 404, statusText: 'Not Found' })
        }
        throw new Error('fetch should not be reached for upload')
      }

      let signCalls = 0
      const signer = {
        getPublicKey: () => 'a'.repeat(64),
        signEvent: async () => {
          signCalls++
          throw new Error('Permission denied')
        }
      }

      const result = await uploadFilesToBlossom({
        fileList: [createFakeFile('content', 'app.js', 'application/javascript')],
        servers: ['https://server1.test'],
        signer,
        maxRetries: 5
      })

      assert.equal(signCalls, 1)
      assert.equal(result.failedFiles.length, 1)
      assert.equal(result.failedFiles[0].errors[0].error.message, 'Permission denied')
    })

    it('should upload to multiple servers in parallel', async (t) => {
      const originalFetch = globalThis.fetch
      t.after(() => { globalThis.fetch = originalFetch })

      const serverUploadTimes = {}
      globalThis.fetch = async (url, opts) => {
        const urlStr = url.toString()
        if (opts?.method === 'HEAD') {
          return new Response(null, { status: 404, statusText: 'Not Found', headers: { 'X-Reason': 'not found' } })
        }
        if (opts?.method === 'PUT') {
          const server = new URL(urlStr).origin
          if (!serverUploadTimes[server]) serverUploadTimes[server] = []
          serverUploadTimes[server].push(Date.now())
          return new Response(JSON.stringify({
            url: urlStr,
            sha256: 'd'.repeat(64),
            size: 10,
            type: 'text/plain',
            uploaded: Date.now()
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(null, { status: 200 })
      }

      const file1 = createFakeFile('a', 'a.txt')
      const file2 = createFakeFile('b', 'b.txt')

      const result = await uploadFilesToBlossom({
        fileList: [file1, file2],
        servers: ['https://server1.test', 'https://server2.test'],
        signer: createMockSigner()
      })

      assert.equal(result.uploadedFiles.length, 2)
      // Both servers should have received uploads
      assert.ok(serverUploadTimes['https://server1.test']?.length > 0)
      assert.ok(serverUploadTimes['https://server2.test']?.length > 0)
    })

    it('should preserve original file reference in uploaded results', async (t) => {
      const originalFetch = globalThis.fetch
      t.after(() => { globalThis.fetch = originalFetch })

      globalThis.fetch = async (url, opts) => {
        if (opts?.method === 'HEAD') {
          return new Response(null, { status: 200 })
        }
        return new Response(null, { status: 200 })
      }

      const file1 = createFakeFile('content', 'index.html', 'text/html')

      const result = await uploadFilesToBlossom({
        fileList: [file1],
        servers: ['https://server.test'],
        signer: createMockSigner(),
        shouldReupload: false
      })

      assert.equal(result.uploadedFiles.length, 1)
      assert.equal(result.uploadedFiles[0].file, file1)
    })
  })
})
