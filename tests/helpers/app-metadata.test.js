import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractHtmlMetadata, findFavicon, findIndexFile } from '#helpers/app-metadata.js'

describe('extractHtmlMetadata', () => {
  it('extracts title and description', () => {
    const html = `
    <html>
      <head>
        <title>My App</title>
        <meta name="description" content="This is my app">
      </head>
    </html>
  `
    const { name, description } = extractHtmlMetadata(html)
    assert.strictEqual(name, 'My App')
    assert.strictEqual(description, 'This is my app')
  })

  it('handles missing metadata', () => {
    const html = '<html></html>'
    const { name, description } = extractHtmlMetadata(html)
    assert.strictEqual(name, undefined)
    assert.strictEqual(description, undefined)
  })

  it('handles alternative meta description format', () => {
    const html = `
    <html>
      <head>
        <meta content="Alt description" name="description">
      </head>
    </html>
  `
    const { description } = extractHtmlMetadata(html)
    assert.strictEqual(description, 'Alt description')
  })
})

describe('findFavicon', () => {
  it('finds favicon file', () => {
    const files = [
      { name: 'index.html' },
      { name: 'favicon.ico' },
      { name: 'style.css' }
    ]
    const favicon = findFavicon(files)
    assert.strictEqual(favicon.name, 'favicon.ico')
  })

  it('returns null if not found', () => {
    const files = [
      { name: 'index.html' },
      { name: 'style.css' }
    ]
    const favicon = findFavicon(files)
    assert.strictEqual(favicon, null)
  })
})

describe('findIndexFile', () => {
  it('finds index.html', () => {
    const files = [
      { name: 'style.css' },
      { name: 'index.html' }
    ]
    const index = findIndexFile(files)
    assert.strictEqual(index.name, 'index.html')
  })

  it('finds index.htm', () => {
    const files = [
      { name: 'style.css' },
      { name: 'index.htm' }
    ]
    const index = findIndexFile(files)
    assert.strictEqual(index.name, 'index.htm')
  })

  it('returns null if not found', () => {
    const files = [
      { name: 'style.css' },
      { name: 'app.js' }
    ]
    const index = findIndexFile(files)
    assert.strictEqual(index, null)
  })
})
