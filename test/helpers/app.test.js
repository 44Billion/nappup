
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { isNostrAppIdSafe, deriveNostrAppId } from '#helpers/app.js'

it.only('#isNostrAppIdSafe', () => {
  assert.ok(isNostrAppIdSafe('my-app'))
  assert.ok(isNostrAppIdSafe('my-app-123'))
  assert.ok(!isNostrAppIdSafe('my_app'))
  assert.ok(!isNostrAppIdSafe('my--app'))
  assert.ok(!isNostrAppIdSafe('my-app-'))
  assert.ok(!isNostrAppIdSafe('-my-app'))
  assert.ok(!isNostrAppIdSafe('my-app-very-long-long-long-long'))
})

it('#deriveNostrAppId', async () => {
  const appId = await deriveNostrAppId('my-app')
  assert.equal(appId, '7qxvr1p3vIL0huYRCpC')
  assert.ok(isNostrAppIdSafe(appId))
})
