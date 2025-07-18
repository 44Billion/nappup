import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { getFiles, toFileList } from '#bin/nappup/helpers.js'

describe('toFileList', () => {
  const testDir = path.resolve('test/fixtures/bin/nappup')

  it('should convert file iterator to file list with correct properties', async () => {
    const filesIterator = getFiles(testDir)
    const fileList = await toFileList(filesIterator, testDir)

    assert.equal(fileList.length, 3, 'Should find all 3 files')

    // Verify file1 properties
    assert.equal(
      fileList[0].webkitRelativePath,
      'nappup/file1.txt',
      'Should have correct relative path for file1'
    )
    assert.equal(
      fileList[0].type,
      'text/plain',
      'Should have correct mime type for file1'
    )
    assert.equal(
      typeof fileList[0].stream,
      'function',
      'Should have stream function'
    )

    // Verify file2 properties
    assert.equal(
      fileList[1].webkitRelativePath,
      'nappup/file2.js',
      'Should have correct relative path for file2'
    )
    assert.equal(
      fileList[1].type,
      'text/javascript',
      'Should have correct mime type for file2'
    )

    // Verify file3 properties (in subdirectory)
    assert.equal(
      fileList[2].webkitRelativePath,
      path.join('nappup', 'subdir', 'file3.css'),
      'Should have correct relative path for file3 in subdir'
    )
    assert.equal(
      fileList[2].type,
      'text/css',
      'Should have correct mime type for file3'
    )
  })

  describe('unknown extension', () => {
    const unknownFile = path.join(testDir, 'file4.unknown')

    before(async () => { await fs.promises.writeFile(unknownFile, 'test content 4') })

    after(async () => { await fs.promises.unlink(unknownFile, { recursive: true, force: true }) })

    it('should handle files with unknown mime-type', async () => {
      const filesIterator = getFiles(testDir)
      const fileList = await toFileList(filesIterator, testDir)

      const unknownFileEntry = fileList.find(f => f.webkitRelativePath === 'nappup/file4.unknown')
      assert.ok(unknownFileEntry, 'Should include file with unknown extension')
      assert.equal(
        unknownFileEntry.type,
        '',
        'Should fall back to empty string if the type could not be determined'
      )
    })
  })

  describe('empty dir', () => {
    const emptyDir = path.join(testDir, 'empty-dir')

    before(async () => { await fs.promises.mkdir(emptyDir) })

    after(async () => { await fs.promises.rm(emptyDir, { recursive: true, force: true }) })

    it('should handle empty directory', async () => {
      const filesIterator = getFiles(emptyDir)
      const fileList = await toFileList(filesIterator, emptyDir)

      assert.equal(fileList.length, 0, 'Should return empty array for empty directory')
    })
  })
})
