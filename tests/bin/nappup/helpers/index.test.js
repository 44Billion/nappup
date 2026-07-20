import assert from 'node:assert/strict'
import path from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { parseArgs, getFiles, readEnvSetValue } from '#bin/nappup/helpers.js'

describe('bin/index.js', () => {
  const testDir = path.resolve('tests/fixtures/bin/nappup')

  describe('parseArgs()', () => {
    it('should parse the directory argument', () => {
      const { dir } = parseArgs(['/some/path'])
      assert.strictEqual(dir, path.resolve('/some/path'))
    })

    it('should use the current directory if no path is provided', () => {
      const { dir } = parseArgs([])
      assert.strictEqual(dir, path.resolve('.'))
    })

    it('should parse the secret key argument', () => {
      const { sk } = parseArgs(['-s', 'my-secret-key'])
      assert.strictEqual(sk, 'my-secret-key')
    })

    it('should parse the app ID argument', () => {
      const { dTag } = parseArgs(['-d', 'my-app-d-tag'])
      assert.strictEqual(dTag, 'my-app-d-tag')
    })

    it('should parse all arguments together', () => {
      const { dir, sk, dTag } = parseArgs(['/some/path', '-s', 'my-secret-key', '-d', 'my-app-d-tag'])
      assert.strictEqual(dir, path.resolve('/some/path'))
      assert.strictEqual(sk, 'my-secret-key')
      assert.strictEqual(dTag, 'my-app-d-tag')
    })

    it('directory argument is optional', () => {
      const { dir, sk, dTag } = parseArgs(['-s', 'my-secret-key', '-d', 'my-app-d-tag'])
      assert.strictEqual(dir, process.cwd())
      assert.strictEqual(sk, 'my-secret-key')
      assert.strictEqual(dTag, 'my-app-d-tag')
    })

    it('all arguments are optional', () => {
      const { dir, sk, dTag } = parseArgs([])
      assert.strictEqual(dir, process.cwd())
      assert.strictEqual(sk, null)
      assert.strictEqual(dTag, null)
    })

    it('should parse the yes flag', () => {
      const { yes } = parseArgs(['-y'])
      assert.strictEqual(yes, true)
    })

    it('parses the dotenv private key for uploads', () => {
      const { dotenvPrivateKey } = parseArgs(['--dotenv-private-key', 'ABCDEF'])
      assert.equal(dotenvPrivateKey, 'ABCDEF')
    })

    it('parses the encrypted env setter with positional input', () => {
      assert.deepEqual(
        parseArgs(['env', 'set', 'NOSTR_SECRET_KEY', 'nsec1value', '--dotenv-private-key', 'key']),
        {
          command: 'env-set',
          name: 'NOSTR_SECRET_KEY',
          value: 'nsec1value',
          dotenvPrivateKey: 'key'
        }
      )
    })

    it('parses the local dotenv private-key generator', () => {
      assert.deepEqual(parseArgs(['env', 'keygen']), { command: 'env-keygen' })
      assert.throws(() => parseArgs(['env', 'keygen', 'extra']), /Expected: nappup env keygen/)
    })

    it('rejects unsupported env variables and excess values', () => {
      assert.throws(() => parseArgs(['env', 'set', 'OTHER', 'value']), /Only NOSTR_SECRET_KEY/)
      assert.throws(() => parseArgs(['env', 'set', 'NOSTR_SECRET_KEY', 'one', 'two']), /Expected one/)
    })
  })

  describe('readEnvSetValue()', () => {
    it('reads redirected stdin and removes one line ending', async () => {
      const value = await readEnvSetValue({ value: null }, {
        input: Readable.from(['secret\r\n'])
      })
      assert.equal(value, 'secret')
    })

    it('accepts a positional value and writes a warning without exposing it', async () => {
      let warning = ''
      const value = await readEnvSetValue({ value: 'very-secret' }, {
        errorOutput: new Writable({ write (chunk, _encoding, callback) { warning += chunk; callback() } })
      })
      assert.equal(value, 'very-secret')
      assert.match(warning, /shell history/)
      assert.equal(warning.includes('very-secret'), false)
    })

    it('reads and confirms a hidden TTY value without echoing it', async () => {
      const input = new PassThrough()
      input.isTTY = true
      input.isRaw = false
      input.setRawMode = value => { input.isRaw = value }
      let output = ''
      const outputStream = new Writable({ write (chunk, _encoding, callback) { output += chunk; callback() } })
      const promise = readEnvSetValue({ value: null }, { input, output: outputStream })

      setImmediate(() => {
        input.emit('keypress', 's', { name: 's' })
        input.emit('keypress', 'e', { name: 'e' })
        input.emit('keypress', 'c', { name: 'c' })
        input.emit('keypress', '', { name: 'return' })
        setImmediate(() => {
          input.emit('keypress', 's', { name: 's' })
          input.emit('keypress', 'e', { name: 'e' })
          input.emit('keypress', 'c', { name: 'c' })
          input.emit('keypress', '', { name: 'return' })
        })
      })

      assert.equal(await promise, 'sec')
      assert.equal(output.includes('sec'), false)
      assert.equal(input.isRaw, false)
    })

    it('cancels a hidden prompt and restores the terminal mode', async () => {
      const input = new PassThrough()
      input.isTTY = true
      input.isRaw = false
      input.setRawMode = value => { input.isRaw = value }
      const output = new Writable({ write (_chunk, _encoding, callback) { callback() } })
      const promise = readEnvSetValue({ value: null }, { input, output })

      setImmediate(() => input.emit('keypress', '', { name: 'c', ctrl: true }))

      await assert.rejects(promise, { code: 'ABORT_ERR' })
      assert.equal(input.isRaw, false)
    })
  })

  describe('getFiles()', () => {
    it('should recursively find all files in a directory', async () => {
      const files = []
      for await (const f of getFiles(testDir)) {
        files.push(f)
      }

      const expectedFiles = [
        path.join(testDir, 'file1.txt'),
        path.join(testDir, 'file2.js'),
        path.join(testDir, 'subdir', 'file4.unknown'),
        path.join(testDir, 'subdir', 'file3.css')
      ].sort()

      assert.deepStrictEqual(files.sort(), expectedFiles)
    })
  })
})
