export function stringifyEvent (event) {
  event = { ...event }

  if (typeof event.content === 'string' && event.content.length > 70) {
    event.content = `${event.content.slice(0, 70)}...(${event.content.length})`
  }

  if (typeof event.sig === 'string' && event.sig.length > 3) {
    event.sig = `${event.sig.slice(0, 3)}...(${event.sig.length})`
  }

  if (Array.isArray(event.tags)) {
    const totalTagsCount = event.tags.length
    event.tags = event.tags.slice(0, 5).map(tag =>
      Array.isArray(tag)
        ? tag.map(val => typeof val === 'string' && val.length > 64 ? `${val.slice(0, 64)}...(${val.length})` : val)
        : tag
    )

    if (totalTagsCount > 5) {
      event.tags.push(`... and ${totalTagsCount - 5} more tags`)
    }
  }

  return JSON.stringify(event, null, 2)
}
