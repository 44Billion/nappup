const MAX_ERROR_DEPTH = 6

// Formats only diagnostic fields, retaining nested native errors without cycles.
function formatError (error, seen = new Set(), depth = 0) {
  if (depth >= MAX_ERROR_DEPTH) return '[maximum error depth reached]'
  if (error === null || typeof error !== 'object') return String(error || 'No error message provided')
  if (seen.has(error)) return '[circular error reference]'
  seen.add(error)
  const fields = ['code', 'closeCode', 'closeReason', 'wasClean']
    .filter(key => error[key] !== undefined)
    .map(key => `${key}=${String(error[key])}`)
  let text = `${error.name || 'Error'}: ${error.message || 'No error message provided'}`
  if (fields.length) text += ` (${fields.join(', ')})`
  if (error.cause !== undefined) text += `; cause: ${formatError(error.cause, seen, depth + 1)}`
  if (Array.isArray(error.errors)) {
    text += `; errors: [${error.errors.map(child => formatError(child, seen, depth + 1)).join('; ')}]`
  }
  seen.delete(error)
  return text
}

// Keeps the destination relay separate from any event provenance metadata.
export function formatRelayFailure ({ relay, reason }) {
  return `${relay} [${reason?.category || 'unclassified'}]: ${formatError(reason)}`
}
