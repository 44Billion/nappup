import assert from 'node:assert/strict'
import { it } from 'node:test'
import { isNostrAppDTagSafe } from '#helpers/app.js'

it('#isNostrAppDTagSafe', () => {
  assert.ok(isNostrAppDTagSafe('myapp'))
  assert.ok(isNostrAppDTagSafe('my-app'))
  assert.ok(isNostrAppDTagSafe('app1'))
  assert.ok(isNostrAppDTagSafe('my_app'))
  assert.ok(isNostrAppDTagSafe('My App Name'))
  assert.ok(isNostrAppDTagSafe('emoji 🎉'))
  assert.ok(!isNostrAppDTagSafe(''))
  assert.ok(!isNostrAppDTagSafe('a'.repeat(261)))
  assert.ok(isNostrAppDTagSafe('a'.repeat(260)))
})
