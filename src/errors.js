const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/

export const NAPPUP_ERROR_CODES = Object.freeze({
  UPLOAD_CANCELLED: 'NAPPUP_UPLOAD_CANCELLED',
  NO_SIGNER: 'NAPPUP_NO_SIGNER',
  EMPTY_FILE_LIST: 'NAPPUP_EMPTY_FILE_LIST',
  RELAY_LOOKUP_FAILED: 'NAPPUP_RELAY_LOOKUP_FAILED',
  NO_OUTBOX_RELAYS: 'NAPPUP_NO_OUTBOX_RELAYS',
  INVALID_D_TAG: 'NAPPUP_INVALID_D_TAG',
  GENERIC_FOLDER_NAME: 'NAPPUP_GENERIC_FOLDER_NAME',
  INVALID_FOLDER_NAME: 'NAPPUP_INVALID_FOLDER_NAME',
  BLOSSOM_UPLOAD_FAILED: 'NAPPUP_BLOSSOM_UPLOAD_FAILED',
  IRFS_UPLOAD_FAILED: 'NAPPUP_IRFS_UPLOAD_FAILED',
  MANIFEST_UPLOAD_FAILED: 'NAPPUP_MANIFEST_UPLOAD_FAILED',
  SIGNER_LOCKED: 'NAPPUP_SIGNER_LOCKED',
  SIGNER_DENIED: 'NAPPUP_SIGNER_DENIED',
  UPLOAD_FAILED: 'NAPPUP_UPLOAD_FAILED'
})

// Carries a stable machine-readable code while retaining technical context.
export class NappupError extends Error {
  constructor (code, messageOrOptions = code, causeOrOptions) {
    if (typeof code !== 'string' || !ERROR_CODE.test(code)) {
      throw new TypeError('Nappup error code should be uppercase snake case')
    }
    const objectOptions = messageOrOptions && typeof messageOrOptions === 'object'
      ? messageOrOptions
      : null
    const trailingOptions = !objectOptions && causeOrOptions && typeof causeOrOptions === 'object' &&
      (Object.hasOwn(causeOrOptions, 'cause') || Object.hasOwn(causeOrOptions, 'details'))
      ? causeOrOptions
      : null
    const options = objectOptions || trailingOptions
    const message = objectOptions
      ? (objectOptions.message ?? code)
      : (messageOrOptions ?? code)
    const cause = objectOptions
      ? objectOptions.cause
      : trailingOptions
        ? trailingOptions.cause
        : causeOrOptions
    super(message, cause === undefined ? undefined : { cause })
    Object.defineProperty(this, 'name', {
      configurable: true,
      value: 'NappupError',
      writable: true
    })
    Object.defineProperty(this, 'code', {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false
    })
    if (options?.details !== undefined) {
      Object.defineProperty(this, 'details', {
        configurable: false,
        enumerable: true,
        value: options.details,
        writable: false
      })
    }
  }
}

const SIGNER_LOCKED_PATTERNS = [
  /^VAULT_LOCKED$/,
  /vault (?:is )?locked/i,
  /account (?:is )?locked/i,
  /wallet (?:is )?locked/i
]

const SIGNER_DENIED_PATTERNS = [
  /permission denied/i,
  /user (?:rejected|denied)/i,
  /sign(?:ing)? request (?:rejected|denied)/i
]

// Traverses native error trees without looping through cycles or unbounded causes.
function * errorTree (error, seen = new Set(), depth = 0) {
  if (!error || typeof error !== 'object' || seen.has(error) || depth >= 12) return
  seen.add(error)
  yield error
  yield * errorTree(error.cause, seen, depth + 1)
  if (Array.isArray(error.errors)) {
    for (const child of error.errors) yield * errorTree(child, seen, depth + 1)
  }
}

// Classifies original signer failures, not diagnostic text from servers or aggregates.
export function classifySignerError (error) {
  for (const current of errorTree(error)) {
    if (current.name === 'NotAllowedError' || current.code === 'DENIED_BY_USER') {
      return NAPPUP_ERROR_CODES.SIGNER_DENIED
    }
    if (current.code === NAPPUP_ERROR_CODES.SIGNER_LOCKED || current.code === NAPPUP_ERROR_CODES.SIGNER_DENIED) {
      return current.code
    }
    if (Array.isArray(current.errors) || current.category || current.code === 'BLOSSOM_HTTP_ERROR') continue
    const message = typeof current.message === 'string' ? current.message : ''
    if (SIGNER_LOCKED_PATTERNS.some(pattern => pattern.test(message))) {
      return NAPPUP_ERROR_CODES.SIGNER_LOCKED
    }
    if (SIGNER_DENIED_PATTERNS.some(pattern => pattern.test(message))) {
      return NAPPUP_ERROR_CODES.SIGNER_DENIED
    }
  }
  return null
}

// Retains only failures of files with no confirmed Blossom copy.
export function blossomUploadError (failedFiles) {
  const failures = failedFiles.flatMap(file => (file.errors ?? []).map(({ server, error }) => ({
    filename: file.filename, destination: server, reason: error
  })))
  return new NappupError(NAPPUP_ERROR_CODES.BLOSSOM_UPLOAD_FAILED,
    `${failedFiles.length} file(s) failed to upload to Blossom`, {
      cause: new AggregateError(failures.map(failure => failure.reason), 'Blossom destinations failed'),
      details: {
        failedFileCount: failedFiles.length,
        filenames: failedFiles.map(file => file.filename).filter(Boolean),
        failures
      }
    })
}

// Exposes destination failures consistently across Blossom and relay publication.
function failureDetails (error) {
  if (error?.details?.failures) return error.details
  const failures = []
  for (const current of errorTree(error)) {
    if (!Array.isArray(current.failures)) continue
    for (const { relay, reason } of current.failures) {
      failures.push({ destination: relay, reason, ...(error?.details?.filename ? { filename: error.details.filename } : {}) })
    }
  }
  return failures.length ? { ...error.details, failures } : error?.details
}

// Ensures every error crossing nappup's public API has a documented code.
export function normalizeNappupError (error) {
  const details = failureDetails(error)
  if (typeof error?.code === 'string' && error.code.startsWith('NAPPUP_')) {
    const code = classifySignerError(error) ?? error.code
    if (code !== error.code || details !== error.details) {
      return new NappupError(code, error.message, { cause: error.cause, details })
    }
    return error
  }
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return new NappupError(
      NAPPUP_ERROR_CODES.UPLOAD_CANCELLED,
      error?.message || 'Upload cancelled',
      { cause: error, details }
    )
  }
  return new NappupError(
    classifySignerError(error) ?? NAPPUP_ERROR_CODES.UPLOAD_FAILED,
    error?.message || 'Upload failed',
    { cause: error, details }
  )
}
