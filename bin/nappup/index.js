#!/usr/bin/env node
import path from 'node:path'
import NostrSigner from '#services/nostr-signer.js'
import { GENERIC_BUILD_FOLDER_NAMES } from '#helpers/app.js'
import {
  parseArgs,
  confirmArgs,
  toFileList,
  getFiles
} from './helpers.js'
import toApp from '#index.js'

const args = parseArgs(process.argv.slice(2))
await confirmArgs(args)

const { dir, sk, channel, shouldReupload } = args
let { dTag } = args

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

const fileList = await toFileList(getFiles(dir), dir)

await toApp(fileList, await NostrSigner.create(sk), { log: console.log.bind(console), dTag, channel, shouldReupload })
