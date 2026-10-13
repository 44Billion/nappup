import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatManifestVersion } from '#helpers/manifest-version.js'

test('manifest version uses the UTC publication date and the launcher timestamp rules', t => {
  const now = Date.parse('2026-10-13T00:30:00Z') / 1000
  t.mock.method(Date, 'now', () => now * 1000)
  const hash = '1234abcd' + '0'.repeat(56)
  const manifest = value => ({ tags: [['published_at', value]] })
  assert.equal(formatManifestVersion(manifest(String(now)), hash), '2026-10-13-1234abcd')
  assert.equal(formatManifestVersion(manifest('0'), hash), '1970-01-01-1234abcd')
  assert.equal(formatManifestVersion(manifest(String(now + 600)), hash), '2026-10-13-1234abcd')
  for (const value of [undefined, null, 123, '', '-1', '1.5', '01', 'garbage', '9007199254740992', String(now + 601)]) {
    assert.equal(formatManifestVersion(manifest(value), hash), '1234abcd')
  }
  assert.equal(formatManifestVersion({ tags: [] }, hash), '1234abcd')
})
