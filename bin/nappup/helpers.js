import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import mime from 'mime-types'
import { fileTypeFromFile } from 'file-type'

export function parseArgs (args) {
  let dir = null
  let sk = null
  let dTag = null
  let channel = null
  let shouldReupload = false
  let yes = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-s' && args[i + 1]) {
      sk = args[i + 1]
      i++ // Skip the next argument as it's part of -k
    } else if (args[i] === '-d' && args[i + 1]) {
      dTag = args[i + 1]
      i++
    } else if (args[i] === '--main' && channel === null) {
      channel = 'main'
    } else if (args[i] === '--next' && channel === null) {
      channel = 'next'
    } else if (args[i] === '--draft' && channel === null) {
      channel = 'draft'
    } else if (args[i] === '-r') {
      shouldReupload = true
    } else if (args[i] === '-y') {
      yes = true
    } else if (!args[i].startsWith('-') && dir === null) {
      dir = args[i]
    }
  }

  return {
    dir: path.resolve(dir ?? '.'),
    sk,
    dTag,
    channel: channel || 'main',
    shouldReupload,
    yes
  }
}

export async function confirmArgs (args) {
  if (args.yes) return
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  function askQuestion (query) {
    return new Promise(resolve => rl.question(query, resolve))
  }
  const answer = await askQuestion(
    `Publish app from '${args.dir}' to the ${args.channel} release channel? (y/n) `
  )
  if (answer.toLowerCase() !== 'y') {
    console.log('Operation cancelled by user.')
    rl.close()
    process.exit(0)
  }
  rl.close()
}

export async function * getFiles (dir) {
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

export async function toFileList (filesIterator, dir) {
  const fileList = []
  for await (const f of filesIterator) {
    const fileType = mime.lookup(f)
    const file = {
      stream: () => Readable.toWeb(fs.createReadStream(f)),
      webkitRelativePath: path.relative(dir.replace(/\/[^/]*$/, ''), f),
      type: fileType || (await fileTypeFromFile(f))?.mime || ''
    }
    fileList.push(file)
  }
  return fileList
}
