import assert from 'node:assert/strict'
import { it } from 'node:test'
import { isNostrAppDTagSafe, deriveNostrAppDTag } from '#helpers/app.js'

it('#isNostrAppDTagSafe', () => {
  assert.ok(isNostrAppDTagSafe('my-app'))
  assert.ok(isNostrAppDTagSafe('a-pp-1'))
  assert.ok(!isNostrAppDTagSafe('my_app'))
  assert.ok(!isNostrAppDTagSafe('my--app'))
  assert.ok(!isNostrAppDTagSafe('my-app-'))
  assert.ok(!isNostrAppDTagSafe('-my-app'))
  assert.ok(!isNostrAppDTagSafe('my-app-very-long-long-long-long'))
})

it('#deriveNostrAppDTag', async () => {
  const appId = await deriveNostrAppDTag('my_app')
  assert.equal(appId, '00o1wuh')
  assert.ok(isNostrAppDTagSafe(appId))
})
