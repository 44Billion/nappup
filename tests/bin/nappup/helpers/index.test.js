import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { parseArgs, getFiles } from '#bin/nappup/helpers.js'

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
