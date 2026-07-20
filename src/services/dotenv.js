import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as dotenv from 'dotenv'
import { decrypt, derive, encrypt } from '@dotenvx/primitives'
import { base64ToBytes, bytesToBase64 } from 'libp2r2p/base64'
import { decodeCliSession } from '#services/bunker-session-codec.js'
import { validateNostrSecretKey } from '#services/nostr-secret-key.js'

export const DOTENV_PRIVATE_KEY_NAME = 'DOTENV_PRIVATE_KEY_NAPPUP'
export const DOTENV_PUBLIC_KEY_NAME = 'DOTENV_PUBLIC_KEY_NAPPUP'
export const LAST_CLI_BUNKER_SESSION = 'LAST_CLI_BUNKER_SESSION'
export const DEFAULT_DOTENV_PRIVATE_KEY = '0000000000000000000000000000000000000000000000000000000000000001'
export const dotenvPath = path.resolve(process.env.DOTENV_CONFIG_PATH ?? path.join(process.cwd(), '.env'))

const MANAGED_NAMES = new Set(['NOSTR_SECRET_KEY', LAST_CLI_BUNKER_SESSION])
const ENCRYPTED_PREFIX = 'encrypted:'
const MIN_ECIES_PAYLOAD_BYTES = 97

let configuration = {
  privateKey: DEFAULT_DOTENV_PRIVATE_KEY,
  privateKeyExplicit: false,
  externalPublicKey: null,
  processEnv: process.env,
  initialized: false
}

export class DotenvDecryptionError extends Error {
  constructor (name, cause) {
    super(`Unable to decrypt ${name} with the selected dotenv private key`, { cause })
    this.name = 'DotenvDecryptionError'
    this.code = 'DOTENV_DECRYPTION_FAILED'
  }
}

function normalizePrivateKey (value) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error('Invalid dotenv private key')
  try {
    derive(normalized)
  } catch {
    throw new Error('Invalid dotenv private key')
  }
  return normalized
}

function normalizePublicKey (value) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : ''
  if (!/^(02|03)[0-9a-f]{64}$/.test(normalized)) throw new Error('Invalid dotenv public key')
  try {
    encrypt(normalized, '')
  } catch {
    throw new Error('Invalid dotenv public key')
  }
  return normalized
}

function isEncrypted (value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX)
}

function validateEncryptedValue (value) {
  if (!isEncrypted(value)) throw new Error('Invalid encrypted dotenv value')
  const encoded = value.slice(ENCRYPTED_PREFIX.length)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid encrypted dotenv value')
  let bytes
  try {
    bytes = base64ToBytes(encoded)
  } catch {
    throw new Error('Invalid encrypted dotenv value')
  }
  if (bytes.length < MIN_ECIES_PAYLOAD_BYTES || bytesToBase64(bytes) !== encoded) {
    throw new Error('Invalid encrypted dotenv value')
  }
}

function validateManagedValue (name, value) {
  if (name === 'NOSTR_SECRET_KEY') return validateNostrSecretKey(value)
  if (name === LAST_CLI_BUNKER_SESSION) {
    decodeCliSession(value)
    return value
  }
  throw new Error(`Unsupported managed dotenv variable: ${name}`)
}

export function readDotenvValues (filePath = dotenvPath) {
  try {
    return dotenv.parse(fs.readFileSync(filePath))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
}

function readDotenvFile (filePath) {
  try {
    return {
      contents: fs.readFileSync(filePath, 'utf8'),
      mode: fs.statSync(filePath).mode & 0o777
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { contents: '', mode: 0o600 }
    throw error
  }
}

function writeDotenvChanges (changes, { filePath = dotenvPath } = {}) {
  const { contents, mode } = readDotenvFile(filePath)
  const eol = contents.includes('\r\n') ? '\r\n' : '\n'
  const lines = contents ? contents.split(/\r?\n/) : []
  if (lines.at(-1) === '') lines.pop()

  const names = [...changes.keys()]
  const assignments = new Map(names.map(name => [
    name,
    new RegExp(`^\\s*(?:export\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`)
  ]))
  const written = new Set()
  const nextLines = []

  for (const line of lines) {
    const name = names.find(candidate => assignments.get(candidate).test(line))
    if (!name) {
      nextLines.push(line)
      continue
    }
    if (written.has(name)) continue
    written.add(name)
    const value = changes.get(name)
    if (value !== null) nextLines.push(`${name}=${JSON.stringify(value)}`)
  }
  for (const [name, value] of changes) {
    if (!written.has(name) && value !== null) nextLines.push(`${name}=${JSON.stringify(value)}`)
  }

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
}

function decryptManagedValue (name, value, privateKey) {
  try {
    validateEncryptedValue(value)
    return decrypt(privateKey, value)
  } catch (error) {
    throw new DotenvDecryptionError(name, error)
  }
}

function warnKeyMismatch (names, onWarning, replacingName) {
  const details = []
  if (replacingName) details.push(`${replacingName} will be replaced by the supplied value`)
  if (names.includes('NOSTR_SECRET_KEY')) {
    details.push('a new publisher identity will be generated unless -s or an environment NOSTR_SECRET_KEY is provided')
  }
  if (names.includes(LAST_CLI_BUNKER_SESSION)) {
    details.push('the next CLI bunker connection will generate a new client key and may require authorization')
  }
  const discarded = names.length ? ` Inaccessible values reset: ${names.join(', ')}.` : ''
  const consequences = details.length ? ` ${details.join('; ')}.` : ''
  onWarning?.(`The explicit dotenv private key does not match the stored public key; adopting the explicit key.${discarded}${consequences}`)
}

function reconcileExplicitPrivateKey (filePath, onWarning, replacement) {
  if (!configuration.privateKeyExplicit) return false
  const values = readDotenvValues(filePath)
  const derivedPublicKey = derive(configuration.privateKey)
  const existingPublicValue = values[DOTENV_PUBLIC_KEY_NAME]
  if (!existingPublicValue) return false

  let existingPublicKey
  try {
    existingPublicKey = normalizePublicKey(existingPublicValue)
  } catch {
    existingPublicKey = null
  }
  if (existingPublicKey === derivedPublicKey) {
    if (existingPublicValue !== derivedPublicKey) {
      writeDotenvChanges(new Map([[DOTENV_PUBLIC_KEY_NAME, derivedPublicKey]]), { filePath })
    }
    return false
  }

  const fallbackPublicKey = derive(DEFAULT_DOTENV_PRIVATE_KEY)
  const fallbackUpgrade = existingPublicKey === fallbackPublicKey
  const changes = new Map([[DOTENV_PUBLIC_KEY_NAME, derivedPublicKey]])
  const discarded = []

  for (const name of MANAGED_NAMES) {
    const stored = values[name]
    if (stored === undefined) continue
    if (replacement?.name === name) continue
    let plaintext
    try {
      if (isEncrypted(stored)) {
        try {
          plaintext = decryptManagedValue(name, stored, configuration.privateKey)
        } catch (error) {
          if (!fallbackUpgrade) throw error
          plaintext = decryptManagedValue(name, stored, DEFAULT_DOTENV_PRIVATE_KEY)
        }
      } else {
        plaintext = stored
      }
      validateManagedValue(name, plaintext)
      changes.set(name, encrypt(derivedPublicKey, plaintext))
    } catch (error) {
      if (fallbackUpgrade) throw error
      changes.set(name, null)
      discarded.push(name)
    }
  }

  if (replacement) changes.set(replacement.name, encrypt(derivedPublicKey, replacement.value))
  if (!fallbackUpgrade) warnKeyMismatch(discarded, onWarning, replacement?.name)
  writeDotenvChanges(changes, { filePath })
  return true
}

function getPublicKeyForFile (filePath) {
  const values = readDotenvValues(filePath)
  const stored = values[DOTENV_PUBLIC_KEY_NAME]
  if (stored) return normalizePublicKey(stored)
  if (configuration.externalPublicKey) return configuration.externalPublicKey
  return derive(configuration.privateKey)
}

export function setDotenvValue (name, value, {
  filePath = dotenvPath,
  updateProcessEnv = true
} = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid dotenv variable name')
  if (MANAGED_NAMES.has(name)) throw new Error(`Use setEncryptedDotenvValue for ${name}`)
  if (typeof value !== 'string') throw new TypeError('Dotenv value should be a string')
  writeDotenvChanges(new Map([[name, value]]), { filePath })
  if (updateProcessEnv) configuration.processEnv[name] = value
}

export function setEncryptedDotenvValue (name, value, {
  filePath = dotenvPath,
  updateProcessEnv = true,
  onWarning = console.warn
} = {}) {
  if (!MANAGED_NAMES.has(name)) throw new Error(`Unsupported managed dotenv variable: ${name}`)
  if (typeof value !== 'string') throw new TypeError('Dotenv value should be a string')
  validateManagedValue(name, value)
  const reconciled = reconcileExplicitPrivateKey(filePath, onWarning, { name, value })
  if (reconciled) {
    if (updateProcessEnv) configuration.processEnv[name] = value
    return
  }
  const publicKey = getPublicKeyForFile(filePath)
  writeDotenvChanges(new Map([
    [DOTENV_PUBLIC_KEY_NAME, publicKey],
    [name, encrypt(publicKey, value)]
  ]), { filePath })
  if (updateProcessEnv) configuration.processEnv[name] = value
}

export function readEncryptedDotenvValue (name, {
  filePath = dotenvPath,
  migratePlaintext = true,
  onWarning = console.warn
} = {}) {
  if (!MANAGED_NAMES.has(name)) throw new Error(`Unsupported managed dotenv variable: ${name}`)
  reconcileExplicitPrivateKey(filePath, onWarning)
  const values = readDotenvValues(filePath)
  const stored = values[name]
  if (stored === undefined) return null

  if (!isEncrypted(stored)) {
    validateManagedValue(name, stored)
    if (migratePlaintext) {
      setEncryptedDotenvValue(name, stored, { filePath, updateProcessEnv: false, onWarning })
    }
    return stored
  }

  const publicKey = values[DOTENV_PUBLIC_KEY_NAME]
    ? normalizePublicKey(values[DOTENV_PUBLIC_KEY_NAME])
    : derive(configuration.privateKey)
  if (derive(configuration.privateKey) !== publicKey) {
    throw new DotenvDecryptionError(name, new Error('The selected private key does not match DOTENV_PUBLIC_KEY_NAPPUP'))
  }
  const plaintext = decryptManagedValue(name, stored, configuration.privateKey)
  validateManagedValue(name, plaintext)
  return plaintext
}

export function initializeDotenv ({
  privateKey,
  filePath = dotenvPath,
  processEnv = process.env,
  loadNostrSecretKey = true,
  reconcilePrivateKey = true,
  onWarning = console.warn
} = {}) {
  const hadNostrSecretKey = Object.hasOwn(processEnv, 'NOSTR_SECRET_KEY')
  const environmentPrivateKey = Object.hasOwn(processEnv, DOTENV_PRIVATE_KEY_NAME)
    ? processEnv[DOTENV_PRIVATE_KEY_NAME]
    : null
  const environmentPublicKey = Object.hasOwn(processEnv, DOTENV_PUBLIC_KEY_NAME)
    ? processEnv[DOTENV_PUBLIC_KEY_NAME]
    : null
  const selectedPrivateKey = normalizePrivateKey(privateKey ?? environmentPrivateKey ?? DEFAULT_DOTENV_PRIVATE_KEY)

  const initialValues = readDotenvValues(filePath)
  if (Object.hasOwn(initialValues, DOTENV_PRIVATE_KEY_NAME)) {
    throw new Error(`${DOTENV_PRIVATE_KEY_NAME} must not be stored in ${filePath}`)
  }

  configuration = {
    privateKey: selectedPrivateKey,
    privateKeyExplicit: (privateKey !== undefined && privateKey !== null) || environmentPrivateKey !== null,
    externalPublicKey: environmentPublicKey ? normalizePublicKey(environmentPublicKey) : null,
    processEnv,
    initialized: true
  }

  if (reconcilePrivateKey) reconcileExplicitPrivateKey(filePath, onWarning)
  const values = readDotenvValues(filePath)
  for (const [name, value] of Object.entries(values)) {
    if (name === DOTENV_PRIVATE_KEY_NAME || MANAGED_NAMES.has(name)) continue
    if (!Object.hasOwn(processEnv, name)) processEnv[name] = value
  }

  let nostrSecretKeySource = hadNostrSecretKey ? 'process' : null
  if (!hadNostrSecretKey && loadNostrSecretKey) {
    const value = readEncryptedDotenvValue('NOSTR_SECRET_KEY', { filePath, onWarning })
    if (value !== null) {
      processEnv.NOSTR_SECRET_KEY = value
      nostrSecretKeySource = 'dotenv'
    }
  }

  return {
    filePath,
    nostrSecretKeySource,
    privateKeyExplicit: configuration.privateKeyExplicit,
    publicKey: getPublicKeyForFile(filePath)
  }
}

export function ensureDotenvInitialized (options) {
  if (!configuration.initialized) return initializeDotenv(options)
  return null
}
