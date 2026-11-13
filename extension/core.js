export const HOST = 'com.bookmarkdesk.connector'
const hasControls = value => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
export function capture(tab, defaults = {}) {
  const url = new URL(tab.url ?? '')
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.href.length > 8192) throw new Error('Only HTTP/S pages without embedded credentials can be saved.')
  const title = (tab.title || url.hostname).trim()
  if (title.length > 2048 || hasControls(title)) throw new Error('Page title is invalid or too long. Edit the title first.')
  let favicon = ''
  try {
    const icon = new URL(tab.favIconUrl)
    if (['http:', 'https:'].includes(icon.protocol) && !icon.username && !icon.password && icon.href.length <= 8192) favicon = icon.href
  } catch { /* A missing or browser-internal icon uses the desktop fallback. */ }
  const tags = [...new Set((defaults.tags ?? []).map(t => t.trim()).filter(Boolean))]
  if (tags.length > 32 || tags.some(t => t.length > 100 || hasControls(t))) throw new Error('Use at most 32 tags, each at most 100 characters and without control characters.')
  return { op: 'save', requestId: crypto.randomUUID(), url: url.href, title, favicon, tags, collectionIds: defaults.collectionIds ?? [], createdAt: new Date().toISOString() }
}
export function connectionError(error) {
  const detail = error instanceof Error ? error.message : String(error)
  if (/native messaging host not found|specified native messaging host/i.test(detail)) return 'Native connector is not registered for this browser. Run the per-user setup-native-host.ps1 script, then test again. (' + detail + ')'
  if (/access.*native messaging host.*forbidden/i.test(detail)) return 'The registered connector does not allow this extension ID. Register the same ID shown on this Setup page. (' + detail + ')'
  return detail
}
const retryableConnectionError = error => /Bookmark Desk is not running|Start Bookmark Desk and pair the extension first|Extension origin is not paired|Extension disabled|Unauthorized connector|Desktop closed connection|timed out|os error (10054|10060)/i.test(error)
export async function flushQueue(queue, send) {
  const remaining = []
  let transportError = ''
  for (const entry of queue) {
    if (entry.error && !retryableConnectionError(entry.error)) { remaining.push(entry); continue }
    const { transportError: _previousError, error: _previousRejection, ...pending } = entry
    if (transportError) { remaining.push({ ...pending, transportError }); continue }
    try {
      const response = await send(entry.request)
      if (!response.ok) {
        const error = response.error || 'Desktop rejected this save.'
        if (retryableConnectionError(error)) {
          transportError = connectionError(error)
          remaining.push({ ...pending, transportError })
        } else remaining.push({ ...pending, error })
      }
    } catch (error) {
      transportError = connectionError(error)
      remaining.push({ ...pending, transportError })
    }
  }
  return remaining
}
