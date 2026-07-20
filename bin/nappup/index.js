#!/usr/bin/env node
import path from 'node:path'
import NostrSigner from '#services/nostr-signer.js'
import { nostrSecretKeySource } from '#services/dotenv.js'
import { GENERIC_BUILD_FOLDER_NAMES } from '#helpers/app.js'
import {
  parseArgs,
  confirmArgs,
  toFileList,
  getFiles
} from './helpers.js'
import toApp from '#index.js'

const args = parseArgs(process.argv.slice(2))

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

const bunkerUrl = sk?.startsWith('bunker://') ? sk : (!sk && process.env.NOSTR_SECRET_KEY?.startsWith('bunker://')) ? process.env.NOSTR_SECRET_KEY : null

let signer
if (bunkerUrl) {
  const { default: NostrBunkerSigner } = await import('#services/bunker-signer.js')
  signer = await NostrBunkerSigner.create(bunkerUrl, {
    source: sk ? 'cli' : nostrSecretKeySource === 'dotenv' ? 'dotenv' : 'cli'
  })
} else {
  signer = await NostrSigner.create(sk)
}

try {
  await toApp(fileList, signer, { log: console.log.bind(console), dTag, channel, shouldReupload })
} finally {
  await signer.close?.()
}
