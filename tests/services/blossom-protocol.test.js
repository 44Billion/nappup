import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { uploadFilesToBlossom, computeFileHash } from '#services/blossom-upload.js'

const signer = { signEvent: async event => ({ ...event, pubkey: 'a'.repeat(64), sig: 'b'.repeat(128) }) }
const file = () => {
  const bytes = new TextEncoder().encode('console.log("á")')
  return { size: bytes.length, type: 'text/javascript', webkitRelativePath: 'app/app.js', stream: () => new ReadableStream({ start (controller) { controller.enqueue(bytes); controller.close() } }) }
}
const response = (status, headers = {}) => new Response(status === 200 || status === 201 ? '{"sha256":"test"}' : null, { status, headers })
const upload = options => uploadFilesToBlossom({ fileList: [file()], servers: ['https://example.test'], signer, shouldReupload: true, ...options })
const flush = () => new Promise(resolve => setImmediate(resolve))

for (const status of [200, 201]) {
  test(`Blossom accepts ${status}`, async t => {
    t.mock.method(globalThis, 'fetch', async () => response(status))
    assert.equal((await upload()).uploadedFiles.length, 1)
  })
}

for (const status of [204, 301, 302, 307, 308, 400, 401, 402, 403, 404, 405, 409, 410, 411, 413, 415, 418, 422, 501, 505]) {
  test(`Blossom does not retry unchanged PUT after ${status}`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => response(status, { 'X-Reason': 'diagnostic only: please retry', 'Retry-After': '0' }))
    const result = await upload()
    assert.equal(fetch.mock.callCount(), 1)
    const error = result.failedFiles[0].errors[0].error
    assert.equal(error.status, status)
    assert.equal(error.retryable, false)
    assert.match(error.message, /diagnostic only/)
  })
}

for (const status of [408, 425, 429, 500, 502, 503, 504, 507, 599]) {
  test(`Blossom retries ${status} with fresh authorization`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let calls = 0; let signs = 0
    t.mock.method(globalThis, 'fetch', async () => response(++calls === 1 ? status : 201, { 'Retry-After': 'not a date' }))
    const pending = upload({ signer: { signEvent: async event => { signs++; return event } } })
    await flush()
    assert.equal(calls, 1)
    t.mock.timers.tick(999)
    await flush()
    assert.equal(calls, 1)
    t.mock.timers.tick(1)
    assert.equal((await pending).uploadedFiles.length, 1)
    assert.equal(calls, 2)
    assert.equal(signs, 2)
  })
}

test('Blossom honors Retry-After seconds and HTTP dates without parsing X-Reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 0, 1) })
  for (const value of ['2', new Date(Date.now() + 2000).toUTCString()]) {
    let calls = 0
    const mock = t.mock.method(globalThis, 'fetch', async () => response(++calls === 1 ? 429 : 200, { 'Retry-After': value }))
    const pending = upload()
    await flush()
    t.mock.timers.tick(1999)
    await flush()
    assert.equal(calls, 1)
    t.mock.timers.tick(1)
    assert.equal((await pending).uploadedFiles.length, 1)
    mock.mock.restore()
    t.mock.timers.setTime(Date.UTC(2026, 0, 1))
  }
})

test('Blossom does not retry earlier than an excessive Retry-After', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => response(429, { 'Retry-After': '120' }))
  const logs = []
  const result = await upload({ log: message => logs.push(message) })
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(result.failedFiles[0].errors[0].error.retryAfterMs, 120000)
  assert.match(logs.at(-1), /app\.js: Failed to upload to https:\/\/example\.test .*\(429\).*no further automatic retry: Retry-After exceeds the 60000ms automatic wait budget/)
  assert.ok(!logs.some(message => message.startsWith('Retrying')))
})

test('Blossom caps network retries and preserves the final cause', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const failure = new TypeError('connection reset')
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw failure })
  const logs = []
  const pending = upload({ maxRetries: 2, log: message => logs.push(message) })
  await flush()
  t.mock.timers.tick(1000)
  await flush()
  t.mock.timers.tick(3000)
  const result = await pending
  assert.equal(fetch.mock.callCount(), 3)
  assert.equal(result.failedFiles[0].errors[0].error, failure)
  assert.match(logs.at(-1), /connection reset; no further automatic retry: attempt limit reached \(3\/3\)/)
})

test('Blossom retry logs retain file paths and causes across parallel servers and stop at 415', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const logs = []
  const calls = { 'example.test': 0, 'replica.test': 0 }
  t.mock.method(globalThis, 'fetch', async url => {
    const host = new URL(url).hostname
    const attempt = ++calls[host]
    if (attempt === 1) throw new TypeError(host === 'example.test' ? 'fetch failed' : 'connection reset')
    if (host === 'example.test' && attempt <= 3) {
      return response(attempt === 2 ? 503 : 415, { 'X-Reason': attempt === 2 ? 'temporarily unavailable' : 'Unsupported Media Type' })
    }
    return response(201)
  })
  const script = { ...file(), webkitRelativePath: 'app/assets/app.js' }
  const index = { ...file(), type: 'text/html', webkitRelativePath: 'app/index.html' }
  const pending = upload({
    fileList: [script, index], servers: ['https://example.test', 'https://replica.test'],
    log: message => logs.push(message)
  })
  await flush()
  t.mock.timers.tick(1000)
  await flush()
  t.mock.timers.tick(3000)
  const result = await pending
  assert.deepEqual(calls, { 'example.test': 4, 'replica.test': 3 })
  assert.equal(result.uploadedFiles.length, 2)
  assert.equal(result.failedFiles.length, 0)
  assert.deepEqual(logs.filter(message => message.startsWith('Retrying')), [
    'Retrying upload of assets/app.js to https://example.test in 1000ms (attempt 2/6): fetch failed',
    'Retrying upload of assets/app.js to https://replica.test in 1000ms (attempt 2/6): connection reset',
    'Retrying upload of assets/app.js to https://example.test in 3000ms (attempt 3/6): upload returned an error (503): temporarily unavailable'
  ])
  assert.ok(logs.includes(`assets/app.js: Failed to upload to https://example.test (text/javascript, ${script.size} bytes): upload returned an error (415): Unsupported Media Type; no further automatic retry: non-retryable error`))
  assert.ok(logs.includes('index.html: Uploaded to https://example.test'))
})

test('Blossom logs cancellation without retrying or replacing the original error', async t => {
  const error = new DOMException('request aborted', 'AbortError')
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw error })
  const logs = []
  const result = await upload({ log: message => logs.push(message) })
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(result.failedFiles[0].errors[0].error, error)
  assert.match(logs.at(-1), /request aborted; no further automatic retry: upload cancelled/)
})

test('Blossom timeout covers the response body and releases the request', async t => {
  let aborted = false
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({
    status: 200,
    json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('body aborted')) }, { once: true }))
  }))
  const result = await upload({ uploadTimeoutMs: 5, maxRetries: 0 })
  assert.equal(aborted, true)
  assert.match(result.failedFiles[0].errors[0].error.message, /timed out/)
  assert.equal(result.failedFiles[0].errors[0].error.cause.message, 'body aborted')
})

test('Blossom stops malformed success JSON', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('not json', { status: 200 }))
  const result = await upload()
  assert.equal(fetch.mock.callCount(), 1)
  assert.ok(result.failedFiles[0].errors[0].error.cause instanceof SyntaxError)
})

test('real Node HTTP receives the exact byte length, MIME, hash and reusable body', async t => {
  const original = Object.assign(new Blob(['console.log("á")'], { type: 'text/javascript' }), { webkitRelativePath: 'app/app.js' })
  const bytes = new Uint8Array(await original.arrayBuffer())
  const streamFile = { size: bytes.length, type: original.type, webkitRelativePath: original.webkitRelativePath, stream: () => Readable.toWeb(Readable.from([bytes])) }
  const received = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received.push({ headers: req.headers, bytes: Buffer.concat(chunks) })
    res.writeHead(201, { 'Content-Type': 'application/json' }).end('{"sha256":"test"}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  for (const body of [streamFile, original]) {
    const result = await upload({ fileList: [body], servers: [`http://127.0.0.1:${server.address().port}`] })
    assert.equal(result.uploadedFiles.length, 1)
  }
  for (const request of received) {
    assert.equal(request.headers['content-length'], String(bytes.length))
    assert.equal(request.headers['transfer-encoding'], undefined)
    assert.equal(request.headers['content-type'], 'text/javascript')
    assert.equal(request.headers['x-sha-256'], await computeFileHash(original))
    assert.deepEqual(request.bytes, Buffer.from(bytes))
    const auth = JSON.parse(Buffer.from(request.headers.authorization.slice(6), 'base64'))
    assert.ok(auth.tags.some(tag => tag[0] === 'x' && tag[1] === request.headers['x-sha-256']))
  }
})
