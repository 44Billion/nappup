#!/usr/bin/env node
import path from 'node:path'
import { GENERIC_BUILD_FOLDER_NAMES } from '#helpers/app.js'
import {
  parseArgs,
  confirmArgs,
  readEnvSetValue,
  toFileList,
  getFiles
} from './helpers.js'

const args = parseArgs(process.argv.slice(2))

if (args.command === 'env-keygen') {
  const { keypair } = await import('@dotenvx/primitives')
  const { privateKey } = keypair()
  console.error('Keep this dotenv private key secret; nappup has not stored it.')
  process.stdout.write(`${privateKey}\n`)
} else {
  const dotenv = await import('#services/dotenv.js')
  const dotenvState = dotenv.initializeDotenv({
    privateKey: args.dotenvPrivateKey,
    loadNostrSecretKey: args.command === 'upload' && !args.sk,
    reconcilePrivateKey: args.command === 'upload'
  })

  if (args.command === 'env-set') {
    const { validateNostrSecretKey } = await import('#services/nostr-secret-key.js')
    const value = await readEnvSetValue(args)
    validateNostrSecretKey(value)
    dotenv.setEncryptedDotenvValue(args.name, value, {
      filePath: dotenvState.filePath,
      updateProcessEnv: false
    })
    console.log(`Set encrypted ${args.name} in ${dotenvState.filePath}`)
  } else {
    await upload(args, dotenvState)
  }
}

async function upload (args, dotenvState) {
  let { dTag } = args
  const { dir, sk, channel, shouldReupload } = args

  if (!dTag) {
    let folderName = path.basename(dir)
    if (GENERIC_BUILD_FOLDER_NAMES.has(folderName.toLowerCase())) {
      const parentName = path.basename(path.dirname(dir))
      if (parentName && parentName !== '.' && parentName !== '/' && !GENERIC_BUILD_FOLDER_NAMES.has(parentName.toLowerCase())) {
        folderName = parentName
      } else {
        console.error(`Directory name "${folderName}" is a generic build folder. Please provide a d tag with -d.`)
        process.exit(1)
      }
    }
    dTag = folderName
  }
  args.dTag = dTag

  await confirmArgs(args)
  const fileList = await toFileList(getFiles(dir), dir)
  const bunkerUrl = sk?.startsWith('bunker://')
    ? sk
    : !sk && process.env.NOSTR_SECRET_KEY?.startsWith('bunker://')
        ? process.env.NOSTR_SECRET_KEY
        : null

  let signer
  if (bunkerUrl) {
    const { default: NostrBunkerSigner } = await import('#services/bunker-signer.js')
    signer = await NostrBunkerSigner.create(bunkerUrl, {
      source: sk ? 'cli' : dotenvState.nostrSecretKeySource === 'dotenv' ? 'dotenv' : 'cli'
    })
  } else {
    const { default: NostrSigner } = await import('#services/nostr-signer.js')
    signer = await NostrSigner.create(sk)
  }

  try {
    const { default: toApp } = await import('#index.js')
    await toApp(fileList, signer, { log: console.log.bind(console), dTag, channel, shouldReupload })
  } finally {
    await signer.close?.()
  }
}
