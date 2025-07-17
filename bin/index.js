#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import readline from 'node:readline'
import mime from 'mime-types'
import { fileTypeFromFile } from 'file-type'
import NostrSigner from '#services/nostr-signer.js'
import toApp from '#index.js'

const args = process.argv.slice(2)

let dir = null
let sk = null
let appId = null

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-s' && args[i + 1]) {
    sk = args[i + 1]
    i++ // Skip the next argument as it's part of -k
  } else if (args[i] === '-i' && args[i + 1]) {
    appId = args[i + 1]
    i++
  } else if (!args[i].startsWith('-') && dir === null) {
    dir = args[i]
  }
}
dir = path.resolve(dir ?? '.')

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})
function askQuestion (query) {
  return new Promise(resolve => rl.question(query, resolve))
}
const answer = await askQuestion(`Publish app from '${dir}'? (y/n) `)
if (answer.toLowerCase() !== 'y') {
  console.log('Operation cancelled by user.')
  rl.close()
  process.exit(0)
}
rl.close()

async function * getFiles (dir) {
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true })
  for (const dirent of dirents) {
    const res = path.resolve(dir, dirent.name)
    if (dirent.isDirectory()) {
      yield * getFiles(res)
    } else {
      yield res
    }
  }
}

const fileList = []
for await (const f of getFiles(dir)) {
  const fileType = mime.lookup(f)
  const file = {
    stream: () => Readable.toWeb(fs.createReadStream(f)),
    webkitRelativePath: path.relative(dir, f),
    type: fileType || (await fileTypeFromFile(f))?.mime || ''
  }
  fileList.push(file)
}

await toApp(fileList, new NostrSigner(sk), { log: console.log.bind(console), appId })
