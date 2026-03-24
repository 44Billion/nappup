import assert from 'node:assert/strict'
import { it } from 'node:test'
import { isNostrAppDTagSafe, deriveNostrAppDTag } from '#helpers/app.js'

it('#isNostrAppDTagSafe', () => {
  assert.ok(isNostrAppDTagSafe('myapp'))
  assert.ok(!isNostrAppDTagSafe('my-app'))
  assert.ok(isNostrAppDTagSafe('app1'))
  assert.ok(!isNostrAppDTagSafe('my_app'))
  assert.ok(!isNostrAppDTagSafe('my--app'))
  assert.ok(!isNostrAppDTagSafe('my-app-'))
  assert.ok(!isNostrAppDTagSafe('-my-app'))
  assert.ok(!isNostrAppDTagSafe('myappverylonglonglonglong'))
})

it('#deriveNostrAppDTag', async () => {
  const appId = await deriveNostrAppDTag('my_app')
  assert.equal(appId, 'udfi4wf')
  assert.ok(isNostrAppDTagSafe(appId))
})
