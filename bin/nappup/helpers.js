import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import mime from 'mime-types'
import { fileTypeFromFile } from 'file-type'

export function parseArgs (args) {
  if (args[0] === 'env') return parseEnvArgs(args)

  let dir = null
  let sk = null
  let dTag = null
  let channel = null
  let shouldReupload = false
  let yes = false
  let dotenvPrivateKey = null

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
    } else if (args[i] === '--dotenv-private-key' && args[i + 1]) {
      dotenvPrivateKey = args[i + 1]
      i++
    } else if (args[i] === '--dotenv-private-key') {
      throw new Error('--dotenv-private-key requires a value')
    } else if (!args[i].startsWith('-') && dir === null) {
      dir = args[i]
    }
  }

  return {
    command: 'upload',
    dir: path.resolve(dir ?? '.'),
    sk,
    dTag,
    channel: channel || 'main',
    shouldReupload,
    yes,
    dotenvPrivateKey
  }
}

function parseEnvArgs (args) {
  if (args[1] === 'keygen') {
    if (args.length !== 2) throw new Error('Expected: nappup env keygen')
    return { command: 'env-keygen' }
  }
  if (args[1] !== 'set') throw new Error('Expected: nappup env set NOSTR_SECRET_KEY [value]')
  if (args[2] !== 'NOSTR_SECRET_KEY') throw new Error('Only NOSTR_SECRET_KEY can be set')

  let value = null
  let dotenvPrivateKey = null
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--dotenv-private-key') {
      if (!args[i + 1]) throw new Error('--dotenv-private-key requires a value')
      dotenvPrivateKey = args[++i]
    } else if (args[i] === '--') {
      if (value !== null || !args[i + 1] || i + 2 !== args.length) throw new Error('Expected one NOSTR_SECRET_KEY value')
      value = args[++i]
    } else if (value === null) {
      value = args[i]
    } else {
      throw new Error('Expected one NOSTR_SECRET_KEY value')
    }
  }

  return {
    command: 'env-set',
    name: 'NOSTR_SECRET_KEY',
    value,
    dotenvPrivateKey
  }
}

function hiddenQuestion (query, { input, output }) {
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(input.isRaw)
    const wasPaused = input.isPaused?.() ?? false
    let value = ''

    function cleanup () {
      input.off('keypress', onKeypress)
      input.setRawMode(wasRaw)
      if (wasPaused) input.pause()
    }

    function onKeypress (text, key = {}) {
      if (key.ctrl && key.name === 'c') {
        cleanup()
        output.write('\n')
        const error = new Error('Operation cancelled by user')
        error.code = 'ABORT_ERR'
        reject(error)
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup()
        output.write('\n')
        resolve(value)
      } else if (key.name === 'backspace') {
        value = value.slice(0, -1)
      } else if (text && !key.ctrl && !key.meta) {
        value += text
      }
    }

    readline.emitKeypressEvents(input)
    input.setRawMode(true)
    input.resume()
    input.on('keypress', onKeypress)
    output.write(query)
  })
}

async function readPipedValue (input) {
  let value = ''
  for await (const chunk of input) {
    value += chunk
    if (value.length > 65536) throw new Error('NOSTR_SECRET_KEY input is too large')
  }
  return value.replace(/(?:\r\n|\n)$/, '')
}

export async function readEnvSetValue (args, {
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr
} = {}) {
  if (args.value !== null) {
    errorOutput.write('Warning: a plaintext value passed as an argument may be visible in shell history and process listings.\n')
    return args.value
  }
  if (!input.isTTY) return readPipedValue(input)
  if (typeof input.setRawMode !== 'function') throw new Error('Cannot hide input on this terminal')

  const first = await hiddenQuestion('NOSTR_SECRET_KEY: ', { input, output })
  const second = await hiddenQuestion('Confirm NOSTR_SECRET_KEY: ', { input, output })
  if (first !== second) throw new Error('NOSTR_SECRET_KEY values do not match')
  return first
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
    `Publish app from '${args.dir}' as '${args.dTag}' to the ${args.channel} release channel? (y/n) `
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
    const { size } = await fs.promises.stat(f)
    const file = {
      stream: () => Readable.toWeb(fs.createReadStream(f)),
      webkitRelativePath: path.relative(dir.replace(/\/[^/]*$/, ''), f),
      type: fileType || (await fileTypeFromFile(f))?.mime || '',
      size
    }
    fileList.push(file)
  }
  return fileList
}
