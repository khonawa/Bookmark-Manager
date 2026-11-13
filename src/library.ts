export interface Bookmark {
  id: string
  title: string
  url: string
  description: string
  tags: string[]
  collectionIds: string[]
  createdAt: string
}
export interface Collection { id: string; name: string; parentId: string | null }
export interface TrashedBookmark extends Bookmark { deletedAt: string }
export interface SmartRules { text: string; tags: string[]; domain: string; untagged: boolean; inbox: boolean }
export interface SmartCollection { id: string; name: string; rules: SmartRules }
export interface Library { bookmarks: Bookmark[]; collections: Collection[]; trash?: TrashedBookmark[]; smartCollections?: SmartCollection[] }
export function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  if (domain && (!/^[a-z0-9.-]+$/.test(domain) || domain.includes('..') || !new URL(`https://${domain}`).hostname)) throw new Error('Enter a hostname, not a URL or path.')
  return domain
}
export function bulkOrganize(library: Library, ids: Set<string>, action: 'add' | 'move' | 'removeTags', values: string[]): Library {
  if (action !== 'removeTags' && (values.length !== 1 || !library.collections.some(c => c.id === values[0]))) throw new Error('Collection not found.')
  return { ...library, bookmarks: library.bookmarks.map(b => !ids.has(b.id) ? b : action === 'removeTags' ? { ...b, tags: b.tags.filter(t => !values.includes(t)) } : { ...b, collectionIds: action === 'move' ? [...values] : [...new Set([...b.collectionIds, ...values])] }) }
}

export function updateCollection(library: Library, id: string, name: string, parentId: string | null): Library {
  if (!name.trim()) throw new Error('Collection name is required.')
  if (!library.collections.some(c => c.id === id)) throw new Error('Collection not found.')
  return validateLibrary({ ...library, collections: library.collections.map(c => c.id === id ? { ...c, name: name.trim(), parentId } : c) })
}
export function deleteCollection(library: Library, id: string): Library {
  const collection = library.collections.find(c => c.id === id)
  if (!collection) throw new Error('Collection not found.')
  const remove = <T extends Bookmark>(b: T): T => ({ ...b, collectionIds: b.collectionIds.filter(value => value !== id) })
  return { ...library, collections: library.collections.filter(c => c.id !== id).map(c => c.parentId === id ? { ...c, parentId: collection.parentId } : c), bookmarks: library.bookmarks.map(remove), ...(library.trash ? { trash: library.trash.map(remove) } : {}) }
}
export function renameTag(library: Library, source: string, target: string): Library {
  const name = target.trim()
  const change = <T extends Bookmark>(b: T): T => ({ ...b, tags: [...new Set(b.tags.flatMap(t => t === source ? name ? [name] : [] : [t]))] })
  return { ...library, bookmarks: library.bookmarks.map(change), ...(library.trash ? { trash: library.trash.map(change) } : {}) }
}
export function trashBookmarks(library: Library, ids: Set<string>, deletedAt = new Date().toISOString()): Library {
  return { ...library, bookmarks: library.bookmarks.filter(b => !ids.has(b.id)), trash: [...(library.trash ?? []), ...library.bookmarks.filter(b => ids.has(b.id)).map(b => ({ ...b, deletedAt }))] }
}
export function restoreBookmarks(library: Library, ids: Set<string>): Library {
  const bookmarks = library.bookmarks.map(b => ({ ...b }))
  for (const entry of library.trash ?? []) {
    if (!ids.has(entry.id)) continue
    const { deletedAt: _, ...bookmark } = entry
    const collectionIds = bookmark.collectionIds.filter(id => library.collections.some(c => c.id === id))
    const existing = bookmarks.find(b => urlKey(b.url) === urlKey(bookmark.url))
    if (existing) {
      existing.tags = [...new Set([...existing.tags, ...bookmark.tags])]
      existing.collectionIds = [...new Set([...existing.collectionIds, ...collectionIds])]
      if (!existing.description) existing.description = bookmark.description
    } else bookmarks.push({ ...bookmark, id: bookmarks.some(b => b.id === bookmark.id) ? crypto.randomUUID() : bookmark.id, collectionIds })
  }
  return { ...library, bookmarks, trash: (library.trash ?? []).filter(b => !ids.has(b.id)) }
}
export const emptyLibrary: Library = { bookmarks: [], collections: [] }

export function normalizeUrl(value: string): string {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http or https URL.')
  return url.href
}
export function urlKey(value: string): string {
  const url = new URL(normalizeUrl(value))
  url.hash = ''
  return url.href
}
export function mergeLibrary(current: Library, incoming: Library): Library {
  const collections = [...current.collections]
  const mapping = new Map<string, string>()
  function mapCollection(collection: Collection): string {
    const mapped = mapping.get(collection.id)
    if (mapped) return mapped
    const parent = incoming.collections.find(c => c.id === collection.parentId)
    const parentId = parent ? mapCollection(parent) : null
    const existing = collections.find(c => c.name === collection.name && c.parentId === parentId)
    const id = existing?.id ?? (collections.some(c => c.id === collection.id) ? crypto.randomUUID() : collection.id)
    mapping.set(collection.id, id)
    if (!existing) collections.push({ ...collection, id, parentId })
    return id
  }
  incoming.collections.forEach(mapCollection)
  const bookmarks = current.bookmarks.map(b => ({ ...b, tags: [...b.tags], collectionIds: [...b.collectionIds] }))
  const byUrl = new Map(bookmarks.map(b => [urlKey(b.url), b]))
  for (const source of incoming.bookmarks) {
    const collectionIds = source.collectionIds.map(id => mapping.get(id) ?? id).filter(id => collections.some(c => c.id === id))
    const existing = byUrl.get(urlKey(source.url))
    if (existing) {
      existing.tags = [...new Set([...existing.tags, ...source.tags])]
      existing.collectionIds = [...new Set([...existing.collectionIds, ...collectionIds])]
      if (!existing.description) existing.description = source.description
    } else {
      const bookmark = { ...source, id: crypto.randomUUID(), url: normalizeUrl(source.url), collectionIds }
      bookmarks.push(bookmark)
      byUrl.set(urlKey(bookmark.url), bookmark)
    }
  }
  const trash = (current.trash ?? []).map(b => ({ ...b }))
  for (const source of incoming.trash ?? []) {
    const collectionIds = source.collectionIds.map(id => mapping.get(id) ?? id).filter(id => collections.some(c => c.id === id))
    const existing = trash.find(b => b.deletedAt === source.deletedAt && urlKey(b.url) === urlKey(source.url))
    if (existing) {
      existing.tags = [...new Set([...existing.tags, ...source.tags])]
      existing.collectionIds = [...new Set([...existing.collectionIds, ...collectionIds])]
    } else trash.push({ ...source, id: [...bookmarks, ...trash].some(b => b.id === source.id) ? crypto.randomUUID() : source.id, collectionIds })
  }
  const smartCollections = [...(current.smartCollections ?? [])]
  for (const smart of incoming.smartCollections ?? []) {
    if (smartCollections.some(c => c.name === smart.name && JSON.stringify(c.rules) === JSON.stringify(smart.rules))) continue
    smartCollections.push({ ...smart, id: smartCollections.some(c => c.id === smart.id) ? crypto.randomUUID() : smart.id })
  }
  return { bookmarks, collections, ...(smartCollections.length || current.smartCollections || incoming.smartCollections ? { smartCollections } : {}), ...(trash.length || current.trash || incoming.trash ? { trash } : {}) }
}
export function validateLibrary(value: unknown): Library {
  if (!value || typeof value !== 'object') throw new Error('Invalid backup.')
  const lib = value as Library
  if (!Array.isArray(lib.bookmarks) || !Array.isArray(lib.collections)) throw new Error('Invalid backup format.')
  if (lib.smartCollections !== undefined && !Array.isArray(lib.smartCollections)) throw new Error('Invalid smart collections.')
  const smartIds = new Set<string>()
  for (const c of lib.smartCollections ?? []) {
    const r = c?.rules
    if (!c || typeof c.id !== 'string' || !c.id || smartIds.has(c.id) || typeof c.name !== 'string' || !c.name.trim() || !r || typeof r.text !== 'string' || typeof r.domain !== 'string' || !Array.isArray(r.tags) || !r.tags.every(t => typeof t === 'string' && t.trim()) || typeof r.untagged !== 'boolean' || typeof r.inbox !== 'boolean') throw new Error('Invalid smart collection.')
    normalizeDomain(r.domain)
    smartIds.add(c.id)
  }
  const ids = new Set<string>()
  for (const c of lib.collections) {
    if (!c || typeof c.id !== 'string' || !c.id || ids.has(c.id) || typeof c.name !== 'string' || !c.name.trim() || !(c.parentId === null || typeof c.parentId === 'string')) throw new Error('Invalid collection.')
    ids.add(c.id)
  }
  for (const c of lib.collections) {
    const visited = new Set([c.id])
    let parent = c.parentId
    while (parent !== null) {
      if (!ids.has(parent) || visited.has(parent)) throw new Error('Invalid collection hierarchy.')
      visited.add(parent)
      parent = lib.collections.find(c => c.id === parent)!.parentId
    }
  }
  if (lib.trash !== undefined && !Array.isArray(lib.trash)) throw new Error('Invalid trash.')
  for (const entry of lib.trash ?? []) {
    if (!entry || typeof entry.deletedAt !== 'string' || !Number.isFinite(Date.parse(entry.deletedAt))) throw new Error('Invalid trash timestamp.')
  }
  const bookmarkIds = new Set<string>()
  for (const b of [...lib.bookmarks, ...(lib.trash ?? [])]) {
    if (!b || typeof b.id !== 'string' || !b.id || bookmarkIds.has(b.id) || typeof b.title !== 'string' || typeof b.url !== 'string' || typeof b.description !== 'string' || typeof b.createdAt !== 'string' || !Array.isArray(b.tags) || !b.tags.every(t => typeof t === 'string') || !Array.isArray(b.collectionIds) || !b.collectionIds.every(id => ids.has(id))) throw new Error('Invalid bookmark.')
    normalizeUrl(b.url)
    bookmarkIds.add(b.id)
  }
  return lib
}
export function parseBookmarkHtml(html: string): Library {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const library: Library = { bookmarks: [], collections: [] }
  const folders = new Map<Element, string>()
  for (const link of doc.querySelectorAll('a[href]')) {
    let url: string
    try { url = normalizeUrl(link.getAttribute('href')!) } catch { continue }
    const ancestors: Element[] = []
    let node: Element | null = link.parentElement
    while (node) {
      if (node.tagName === 'DL') ancestors.unshift(node)
      node = node.parentElement
    }
    let parentId: string | null = null
    for (const list of ancestors) {
      let heading = list.previousElementSibling
      if (heading?.tagName !== 'H3') heading = list.parentElement?.querySelector(':scope > h3') ?? null
      if (!heading) continue
      let id = folders.get(list)
      if (!id) {
        id = crypto.randomUUID()
        folders.set(list, id)
        library.collections.push({ id, name: heading.textContent?.trim() || 'Imported', parentId })
      }
      parentId = id
    }
    library.bookmarks.push({ id: crypto.randomUUID(), title: link.textContent?.trim() || url, url, description: '', tags: [], collectionIds: parentId ? [parentId] : [], createdAt: new Date().toISOString() })
  }
  return mergeLibrary(emptyLibrary, library)
}
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export function exportHtml(library: Library): string {
  const links = (id: string | null) => library.bookmarks.filter(b => id === null ? !b.collectionIds.length : b.collectionIds.includes(id)).map(b => `<DT><A HREF="${escapeHtml(b.url)}">${escapeHtml(b.title)}</A>`).join('\n')
  const folder = (parentId: string | null): string => library.collections.filter(c => c.parentId === parentId).map(c => `<DT><H3>${escapeHtml(c.name)}</H3>\n<DL><p>\n${links(c.id)}\n${folder(c.id)}\n</DL><p>`).join('\n')
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${links(null)}\n${folder(null)}\n</DL><p>`
}
