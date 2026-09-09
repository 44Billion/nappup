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
  const result = await upload()
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(result.failedFiles[0].errors[0].error.retryAfterMs, 120000)
})

test('Blossom caps network retries and preserves the final cause', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const failure = new TypeError('connection reset')
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw failure })
  const pending = upload({ maxRetries: 2 })
  await flush()
  t.mock.timers.tick(1000)
  await flush()
  t.mock.timers.tick(3000)
  const result = await pending
  assert.equal(fetch.mock.callCount(), 3)
  assert.equal(result.failedFiles[0].errors[0].error, failure)
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
