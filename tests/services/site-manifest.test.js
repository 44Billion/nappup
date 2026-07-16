import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildManifestTags, normalizeManifestPath } from '#services/site-manifest.js'

const ROOT_A = 'a'.repeat(64)
const ROOT_B = 'b'.repeat(64)

describe('unified site manifest', () => {
  it('groups IRFS paths and marks sharing root, MIME and size', () => {
    const tags = buildManifestTags({
      dTag: 'app',
      uploadService: 'irfs',
      fileMetadata: [
        { rootHash: ROOT_A, filename: '/index.html', mimeType: 'text/html', size: 12 },
        { rootHash: ROOT_A, filename: 'copy.html', mimeType: 'text/html', size: 12 }
      ],
      icon: { rootHash: ROOT_A, mimeType: 'text/html', size: 12 },
      screenshots: [{ rootHash: ROOT_B, mimeType: 'image/webp', size: 42, country: 'BR' }],
      name: 'App'
    })
    const references = tags.filter(tag => tag[0] === 'r')
    assert.deepEqual(references[0], [
      'r', ROOT_A, 'path index.html', 'path copy.html', 'mark icon', 'm text/html', 'size 12'
    ])
    assert.deepEqual(references[1], [
      'r', ROOT_B, 'mark screenshot', 'country BR', 'm image/webp', 'size 42'
    ])
    assert.ok(tags.some(tag => tag[0] === 'service' && tag[1] === 'irfs'))
  })

  it('keeps Blossom files as path tags and media as r tags', () => {
    const tags = buildManifestTags({
      dTag: 'app',
      uploadService: 'blossom',
      fileMetadata: [{ rootHash: ROOT_A, filename: '/index.html', mimeType: 'text/html', size: 12 }],
      icon: { rootHash: ROOT_A, mimeType: 'text/html', size: 12 }
    })
    assert.ok(tags.some(tag => JSON.stringify(tag) === JSON.stringify(['path', 'index.html', ROOT_A])))
    assert.ok(tags.some(tag => tag[0] === 'r' && tag.includes('mark icon')))
  })

  it('preserves only the first ten unknown tags in order', () => {
    const previousTags = [
      ['old-a', '0'], ['name', 'old'],
      ...Array.from({ length: 12 }, (_, index) => ['x', String(index)])
    ]
    const tags = buildManifestTags({
      dTag: 'app', uploadService: 'irfs', previousTags
    })
    assert.deepEqual(tags.filter(tag => tag[0] === 'old-a' || tag[0] === 'x'), [
      ['old-a', '0'], ...Array.from({ length: 9 }, (_, index) => ['x', String(index)])
    ])
    assert.ok(!tags.some(tag => tag[0] === 'name'))
  })

  it('normalizes one leading slash and rejects unsafe paths', () => {
    assert.equal(normalizeManifestPath('/assets/app.js'), 'assets/app.js')
    for (const path of ['', '//a', 'a//b', '.', '..', 'a/../b', 'a\\b', 'a\u0000b']) {
      assert.throws(() => normalizeManifestPath(path), /Unsafe/)
    }
  })
})
