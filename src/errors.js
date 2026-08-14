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

// Ensures every error crossing nappup's public API has a documented code.
export function normalizeNappupError (error) {
  if (typeof error?.code === 'string' && error.code.startsWith('NAPPUP_')) return error
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return new NappupError(
      NAPPUP_ERROR_CODES.UPLOAD_CANCELLED,
      error?.message || 'Upload cancelled',
      { cause: error }
    )
  }
  return new NappupError(
    NAPPUP_ERROR_CODES.UPLOAD_FAILED,
    error?.message || 'Upload failed',
    { cause: error }
  )
}
