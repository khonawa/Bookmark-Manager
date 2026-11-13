import { invoke } from '@tauri-apps/api/core'
import { desktop } from './storage'
import { normalizeUrl } from './library'

export interface PageMetadata { title: string | null; icon: string | null }
const cacheKey = 'bookmark-desk.metadata.v1'
const cache = new Map<string, PageMetadata>()
const pending = new Map<string, Promise<PageMetadata>>()
const queue: (() => void)[] = []
let active = 0
try {
  const saved = JSON.parse(localStorage.getItem(cacheKey) || '[]')
  if (Array.isArray(saved)) for (const [url, value] of saved.slice(-100)) {
    if (typeof url === 'string' && value && (value.title === null || typeof value.title === 'string') && (value.icon === null || typeof value.icon === 'string' && /^data:image\/(png|jpeg|gif|webp|x-icon|vnd.microsoft.icon);base64,/.test(value.icon))) cache.set(url, value)
  }
} catch { /* An unavailable cache must not prevent opening the library. */ }

export function getMetadata(value: string, refresh = false): Promise<PageMetadata> {
  const url = normalizeUrl(value)
  if (!refresh && cache.has(url)) return Promise.resolve(cache.get(url)!)
  if (pending.has(url)) return pending.get(url)!
  const result = new Promise<PageMetadata>((resolve, reject) => {
    const run = () => {
      active++
      const request = desktop ? invoke<PageMetadata>('fetch_metadata', { url }) : fetch(`/api/metadata?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(20000) }).then(async response => {
        if (!response.ok) throw new Error('Website metadata unavailable')
        return await response.json() as PageMetadata
      })
      request.then(data => {
        cache.delete(url); cache.set(url, data)
        while (cache.size > 100) cache.delete(cache.keys().next().value!)
        try { localStorage.setItem(cacheKey, JSON.stringify([...cache])) } catch { /* The in-memory cache still works when storage is full. */ }
        resolve(data)
      }, reject).finally(() => { active--; pending.delete(url); queue.shift()?.() })
    }
    if (active < 2) run()
    else queue.push(run)
  })
  pending.set(url, result)
  return result
}
