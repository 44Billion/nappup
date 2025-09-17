#!/usr/bin/env node
import NostrSigner from '#services/nostr-signer.js'
import {
  parseArgs,
  confirmArgs,
  toFileList,
  getFiles
} from './helpers.js'
import toApp from '#index.js'

const args = parseArgs(process.argv.slice(2))
await confirmArgs(args)

const { dir, sk, dTag, channel, shouldReupload } = args
const fileList = await toFileList(getFiles(dir), dir)

await toApp(fileList, await NostrSigner.create(sk), { log: console.log.bind(console), dTag, channel, shouldReupload })
