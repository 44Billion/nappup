import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractHtmlMetadata,
  extractWebManifestIcons,
  findAppIcon,
  findFavicon,
  findIndexFile,
  resolveAppPath
} from '#helpers/app-metadata.js'

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

  it('extracts og:title and og:description fallback', () => {
    const html = `
    <html>
      <head>
        <meta property="og:title" content="My OG App">
        <meta property="og:description" content="This is my OG app">
      </head>
    </html>
  `
    const { name, description } = extractHtmlMetadata(html)
    assert.strictEqual(name, 'My OG App')
    assert.strictEqual(description, 'This is my OG app')
  })

  it('extracts og:title and og:description with name attribute fallback', () => {
    const html = `
    <html>
      <head>
        <meta name="og:title" content="My OG Name App">
        <meta name="og:description" content="This is my OG Name app">
      </head>
    </html>
  `
    const { name, description } = extractHtmlMetadata(html)
    assert.strictEqual(name, 'My OG Name App')
    assert.strictEqual(description, 'This is my OG Name app')
  })

  it('orders icon links before platform and social metadata variants', () => {
    const html = `
      <base href="/assets/">
      <meta content="social.png" property="og:image">
      <link href='touch.png' rel='apple-touch-icon-precomposed'>
      <link sizes=any href="icon.svg?rev=1&amp;mode=dark" rel="shortcut icon">
      <meta name="twitter:image:src" content="twitter.png">
    `
    const metadata = extractHtmlMetadata(html)

    assert.equal(metadata.baseHref, '/assets/')
    assert.deepEqual(metadata.iconSources, [
      { href: 'icon.svg?rev=1&mode=dark', kind: 'icon' },
      { href: 'touch.png', kind: 'apple-touch-icon' },
      { href: 'social.png', kind: 'social-image' },
      { href: 'twitter.png', kind: 'social-image' }
    ])
  })
})

describe('app icon discovery', () => {
  const file = (path, content = '') => ({
    name: path.split('/').pop(),
    webkitRelativePath: `app/${path}`,
    text: async () => content
  })

  it('resolves an HTML icon relative to base href', async () => {
    const index = file('index.html')
    const icon = file('assets/icon.svg')
    const found = await findAppIcon(
      [index, icon, file('favicon.ico')],
      '<base href="/assets/"><link rel="icon" href="icon.svg">',
      index
    )
    assert.equal(found, icon)
  })

  it('follows a local Web App Manifest before social and conventional fallbacks', async () => {
    const index = file('index.html')
    const manifest = file('site.webmanifest', JSON.stringify({
      icons: [{ src: 'mask.png', purpose: 'maskable' }, { src: 'icon.png', purpose: 'any' }]
    }))
    const icon = file('icon.png')
    const found = await findAppIcon(
      [index, manifest, icon, file('social.png'), file('favicon.ico')],
      '<link rel="manifest" href="site.webmanifest"><meta property="og:image" content="social.png">',
      index
    )
    assert.equal(found, icon)
  })

  it('uses a conventional favicon before social preview images', async () => {
    const index = file('index.html')
    const favicon = file('favicon.ico')
    const found = await findAppIcon(
      [index, file('social.png'), favicon],
      '<meta property="og:image" content="social.png">',
      index
    )
    assert.equal(found, favicon)
  })

  it('parses Web App Manifest purposes and safely resolves paths', () => {
    assert.deepEqual(extractWebManifestIcons({
      icons: [
        { src: 'mono.svg', purpose: 'monochrome' },
        { src: 'any.png' },
        { src: 'mask.png', purpose: 'maskable' }
      ]
    }), [
      { href: 'any.png', kind: 'web-app-manifest' },
      { href: 'mask.png', kind: 'web-app-manifest' },
      { href: 'mono.svg', kind: 'web-app-manifest' }
    ])
    assert.equal(resolveAppPath('../icon.png', 'nested/index.html'), 'icon.png')
    assert.equal(resolveAppPath('data:image/png;base64,x'), null)
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
