export const NOSTR_APP_D_TAG_MAX_LENGTH = 260

export const GENERIC_BUILD_FOLDER_NAMES = new Set([
  'build', 'dist', 'out', 'output', 'public', 'www', '_site', '.next', '.output', '.nuxt'
])

export function isNostrAppDTagSafe (string) {
  return typeof string === 'string' && string.length <= NOSTR_APP_D_TAG_MAX_LENGTH
}
