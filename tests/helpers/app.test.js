import assert from 'node:assert/strict'
import { it } from 'node:test'
import { isNostrAppDTagSafe, deriveNostrAppDTag } from '#helpers/app.js'

it('#isNostrAppDTagSafe', () => {
  assert.ok(isNostrAppDTagSafe('my-app'))
  assert.ok(isNostrAppDTagSafe('my-app-123'))
  assert.ok(!isNostrAppDTagSafe('my_app'))
  assert.ok(!isNostrAppDTagSafe('my--app'))
  assert.ok(!isNostrAppDTagSafe('my-app-'))
  assert.ok(!isNostrAppDTagSafe('-my-app'))
  assert.ok(!isNostrAppDTagSafe('my-app-very-long-long-long-long'))
})

it('#deriveNostrAppDTag', async () => {
  const appId = await deriveNostrAppDTag('my-app')
  assert.equal(appId, '7qxvr1p3vIL0huYRCpC')
  assert.ok(isNostrAppDTagSafe(appId))
})
