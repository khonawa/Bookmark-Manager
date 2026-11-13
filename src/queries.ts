import { type Bookmark, type Library, type SmartRules } from './library'

export interface BookmarkQuery { view: string; tag: string; query: string; domain?: string; sort: string; page: number }
export interface BookmarkPage { bookmarks: Bookmark[]; total: number }
const asciiLower = (value: string) => value.replace(/[A-Z]/g, c => c.toLowerCase())
const domainKey = (value: string) => asciiLower(value.trim()).replace(/^www\./, '').replace(/\.+$/, '')
export function matchesRules(b: Bookmark, rules: SmartRules): boolean {
  return asciiLower(`${b.title} ${b.url} ${b.description} ${b.tags.join(' ')}`).includes(asciiLower(rules.text.trim())) && rules.tags.every(t => b.tags.includes(t)) && (!domainKey(rules.domain) || domainKey(new URL(b.url).hostname) === domainKey(rules.domain)) && (!rules.untagged || !b.tags.length) && (!rules.inbox || !b.collectionIds.length)
}
export function matchingBookmarks(library: Library, input: BookmarkQuery): Bookmark[] {
  const smart = input.view.startsWith('smart:') ? library.smartCollections?.find(c => c.id === input.view.slice(6)) : undefined
  return (input.view === 'trash' ? library.trash ?? [] : library.bookmarks).filter(b => {
    const inView = input.view.startsWith('smart:') ? !!smart && matchesRules(b, smart.rules) : ['all', 'trash'].includes(input.view) || (input.view === 'inbox' ? !b.collectionIds.length : input.view === 'untagged' ? !b.tags.length : b.collectionIds.includes(input.view))
    return inView && matchesRules(b, { text: input.query, tags: input.tag ? [input.tag] : [], domain: input.domain ?? '', untagged: false, inbox: false })
  })
}
export function queryLibrary(library: Library, input: BookmarkQuery): BookmarkPage {
  const rows = matchingBookmarks(library, input).sort((a, b) => (input.sort === 'title' ? a.title.localeCompare(b.title) : input.sort === 'domain' ? new URL(a.url).hostname.localeCompare(new URL(b.url).hostname) : b.createdAt.localeCompare(a.createdAt)) || a.id.localeCompare(b.id))
  const page = Math.max(0, Math.min(input.page, Math.max(0, Math.ceil(rows.length / 75) - 1)))
  return { bookmarks: rows.slice(page * 75, (page + 1) * 75), total: rows.length }
}
export function libraryPatch(previous: Library, next: Library) {
  function diff<T extends { id: string }>(before: T[], after: T[]) {
    const old = new Map(before.map(row => [row.id, row]))
    const ids = new Set(after.map(row => row.id))
    return { changed: after.filter(row => { const prior = old.get(row.id); return prior !== row && JSON.stringify(prior) !== JSON.stringify(row) }), deleted: before.filter(row => !ids.has(row.id)).map(row => row.id) }
  }
  const bookmarks = diff(previous.bookmarks, next.bookmarks)
  const collections = diff(previous.collections, next.collections)
  const trash = diff(previous.trash ?? [], next.trash ?? [])
  const smart = diff(previous.smartCollections ?? [], next.smartCollections ?? [])
  return { bookmarks: bookmarks.changed, collections: collections.changed, trash: trash.changed, deletedBookmarkIds: bookmarks.deleted, deletedCollectionIds: collections.deleted, deletedTrashIds: trash.deleted, ...(smart.changed.length || smart.deleted.length ? { smartCollections: smart.changed, deletedSmartCollectionIds: smart.deleted } : {}) }
}
