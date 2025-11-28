export function extractHtmlMetadata (htmlContent) {
  let name
  let description

  try {
    const titleRegex = /<title[^>]*>([\s\S]*?)<\/title>/i
    const titleMatch = htmlContent.match(titleRegex)
    if (titleMatch && titleMatch[1]) {
      name = titleMatch[1].trim()
    }

    const metaDescRegex = /<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i
    const metaDescMatch = htmlContent.match(metaDescRegex)
    if (metaDescMatch && metaDescMatch[1]) {
      description = metaDescMatch[1].trim()
    }

    if (!description) {
      const altMetaDescRegex = /<meta\s+[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']description["'][^>]*>/i
      const altMetaDescMatch = htmlContent.match(altMetaDescRegex)
      if (altMetaDescMatch && altMetaDescMatch[1]) {
        description = altMetaDescMatch[1].trim()
      }
    }
  } catch (_) {
    // ignore
  }

  return { name, description }
}

export function findFavicon (fileList) {
  const faviconExtensions = ['ico', 'svg', 'webp', 'png', 'jpg', 'jpeg', 'gif']
  for (const file of fileList) {
    const filename = (file.webkitRelativePath || file.name || '').split('/').pop().toLowerCase()
    if (filename.startsWith('favicon.')) {
      const ext = filename.split('.').pop()
      if (faviconExtensions.includes(ext)) {
        return file
      }
    }
  }
  return null
}

export function findIndexFile (fileList) {
  for (const file of fileList) {
    const filename = (file.webkitRelativePath || file.name || '').split('/').pop().toLowerCase()
    if (filename === 'index.html' || filename === 'index.htm') {
      return file
    }
  }
  return null
}
