import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as dotenv from 'dotenv'

const hadNostrSecretKey = Object.hasOwn(process.env, 'NOSTR_SECRET_KEY')

export const dotenvPath = path.resolve(process.env.DOTENV_CONFIG_PATH ?? path.join(process.cwd(), '.env'))

dotenv.config({
  path: dotenvPath,
  quiet: true
})

export const nostrSecretKeySource = hadNostrSecretKey
  ? 'process'
  : Object.hasOwn(process.env, 'NOSTR_SECRET_KEY')
    ? 'dotenv'
    : null

export function readDotenvValues (filePath = dotenvPath) {
  try {
    return dotenv.parse(fs.readFileSync(filePath))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
}

export function setDotenvValue (name, value, {
  filePath = dotenvPath,
  updateProcessEnv = true
} = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid dotenv variable name')
  if (typeof value !== 'string') throw new TypeError('Dotenv value should be a string')

  let contents = ''
  let mode = 0o600
  try {
    contents = fs.readFileSync(filePath, 'utf8')
    mode = fs.statSync(filePath).mode & 0o777
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const eol = contents.includes('\r\n') ? '\r\n' : '\n'
  const lines = contents ? contents.split(/\r?\n/) : []
  if (lines.at(-1) === '') lines.pop()

  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${escapedName}\\s*=`)
  const replacement = `${name}=${JSON.stringify(value)}`
  const nextLines = []
  let replaced = false

  for (const line of lines) {
    if (!assignment.test(line)) {
      nextLines.push(line)
    } else if (!replaced) {
      nextLines.push(replacement)
      replaced = true
    }
  }
  if (!replaced) nextLines.push(replacement)

  const nextContents = `${nextLines.join(eol)}${eol}`
  const directory = path.dirname(filePath)
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)

  try {
    fs.writeFileSync(temporaryPath, nextContents, { encoding: 'utf8', flag: 'wx', mode })
    fs.chmodSync(temporaryPath, mode)
    fs.renameSync(temporaryPath, filePath)
  } finally {
    try {
      fs.unlinkSync(temporaryPath)
    } catch {}
  }

  if (updateProcessEnv) process.env[name] = value
}
