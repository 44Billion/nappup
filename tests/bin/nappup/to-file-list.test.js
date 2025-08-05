import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getFiles, toFileList } from '#bin/nappup/helpers.js'

describe('toFileList', () => {
  const testDir = path.resolve('tests/fixtures/bin/nappup')

  it('should convert file iterator to file list with correct properties', async () => {
    const filesIterator = getFiles(testDir)
    const fileList = await toFileList(filesIterator, testDir)

    assert.equal(fileList.length, 4, 'Should find all 4 files')

    const sortedFileList = fileList.sort((a, b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath))

    // Verify file1 properties
    assert.equal(
      sortedFileList[0].webkitRelativePath,
      'nappup/file1.txt',
      'Should have correct relative path for file1'
    )
    assert.equal(
      sortedFileList[0].type,
      'text/plain',
      'Should have correct mime type for file1'
    )
    assert.equal(
      typeof sortedFileList[0].stream,
      'function',
      'Should have stream function'
    )

    // Verify file2 properties
    assert.equal(
      sortedFileList[1].webkitRelativePath,
      'nappup/file2.js',
      'Should have correct relative path for file2'
    )
    assert.equal(
      sortedFileList[1].type,
      'text/javascript',
      'Should have correct mime type for file2'
    )

    // Verify file3 properties (in subdirectory)
    assert.equal(
      sortedFileList[2].webkitRelativePath,
      path.join('nappup', 'subdir', 'file3.css'),
      'Should have correct relative path for file3 in subdir'
    )
    assert.equal(
      sortedFileList[2].type,
      'text/css',
      'Should have correct mime type for file3'
    )

    // Verify file4 properties (unknown extension)
    assert.equal(
      sortedFileList[3].webkitRelativePath,
      path.join('nappup', 'subdir', 'file4.unknown'),
      'Should include file with unknown extension'
    )
    assert.equal(
      sortedFileList[3].type,
      '',
      'Should fall back to empty string if the type could not be determined'
    )
  })

  describe('empty dir', () => {
    const emptyDir = path.join(testDir, 'empty-dir')

    before(async () => { await fs.mkdir(emptyDir) })
    after(async () => { await fs.rm(emptyDir, { recursive: true, force: true }) })

    it('should handle empty directory', async () => {
      const filesIterator = getFiles(emptyDir)
      const fileList = await toFileList(filesIterator, emptyDir)

      assert.equal(fileList.length, 0, 'Should return empty array for empty directory')
    })
  })
})
