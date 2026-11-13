import { normalizeUrl, type Bookmark, type Library } from './library'

// Fragments, query parameters, schemes and paths remain significant for review.
export function duplicateGroups(library: Library): Bookmark[][] {
  const groups = new Map<string, Bookmark[]>()
  for (const bookmark of library.bookmarks) {
    const key = normalizeUrl(bookmark.url)
    const group = groups.get(key)
    if (group) group.push(bookmark)
    else groups.set(key, [bookmark])
  }
  return [...groups.values()].filter(group => group.length > 1)
}
export function mergeDuplicates(library: Library, ids: string[], survivorId: string, deletedAt = new Date().toISOString()): Library {
  const selected = new Set(ids)
  const rows = library.bookmarks.filter(b => selected.has(b.id))
  const survivor = rows.find(b => b.id === survivorId)
  if (!survivor || rows.length !== selected.size || rows.length < 2 || rows.some(b => normalizeUrl(b.url) !== normalizeUrl(survivor.url))) throw new Error('Choose at least two existing bookmarks with exactly the same normalized URL.')
  const merged = { ...survivor, tags: [...new Set(rows.flatMap(b => b.tags))], collectionIds: [...new Set(rows.flatMap(b => b.collectionIds))], description: [...new Set([survivor, ...rows.filter(b => b.id !== survivorId)].map(b => b.description).filter(Boolean))].join('\n\n') }
  return { ...library, bookmarks: library.bookmarks.filter(b => !selected.has(b.id) || b.id === survivorId).map(b => b.id === survivorId ? merged : b), trash: [...(library.trash ?? []), ...rows.filter(b => b.id !== survivorId).map(b => ({ ...b, deletedAt }))] }
}
