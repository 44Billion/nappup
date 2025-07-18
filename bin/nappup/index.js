#!/usr/bin/env node
import NostrSigner from '#services/nostr-signer.js'
import {
  parseArgs,
  confirmDir,
  toFileList,
  getFiles
} from './helpers.js'
import toApp from '#index.js'

const { dir, sk, appId } = parseArgs(process.argv.slice(2))
await confirmDir(dir)

const fileList = await toFileList(getFiles(dir), dir)

await toApp(fileList, new NostrSigner(sk), { log: console.log.bind(console), appId })
