import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import NostrSigner from '#services/nostr-signer.js'
import { nsecEncode } from 'libp2r2p/nip19'
import { initializeDotenv } from '#services/dotenv.js'

describe('NostrSigner', () => {
  it('should create a signer from a hex secret key', async () => {
    const sk = 'a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5'
    const signer = await NostrSigner.create(sk)
    assert.ok(signer)
  })

  it('should create a signer from an nsec secret key', async () => {
    const sk = 'a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5'
    const nsec = nsecEncode(sk)
    const signer = await NostrSigner.create(nsec)
    assert.ok(signer)
  })

  it('defers persisting and publishing a generated identity', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nappup-deferred-signer-'))
    const filePath = path.join(directory, '.env')
    const previousSecretKey = process.env.NOSTR_SECRET_KEY
    delete process.env.NOSTR_SECRET_KEY
    t.after(() => {
      if (previousSecretKey === undefined) delete process.env.NOSTR_SECRET_KEY
      else process.env.NOSTR_SECRET_KEY = previousSecretKey
      fs.rmSync(directory, { recursive: true, force: true })
    })
    initializeDotenv({ filePath, processEnv: process.env, loadNostrSecretKey: false })

    const signer = await NostrSigner.create(undefined, {
      deferInitialization: true,
      dotenvFilePath: filePath
    })

    assert.match(signer.getPublicKey(), /^[0-9a-f]{64}$/)
    assert.equal(fs.existsSync(filePath), false)
  })

  it('uses the public NIP-44 plaintext/ciphertext argument order', async () => {
    const alice = await NostrSigner.create('a0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5')
    const bob = await NostrSigner.create('b0a810b0fa6499358355d353884e5633c1a237c81e58044c531639590817dfa5')
    const ciphertext = alice.nip44Encrypt(bob.getPublicKey(), 'hello')
    assert.equal(bob.nip44Decrypt(alice.getPublicKey(), ciphertext), 'hello')
  })
})
