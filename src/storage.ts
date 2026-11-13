import { invoke, isTauri } from '@tauri-apps/api/core'
import { emptyLibrary, validateLibrary, type Library } from './library'
import { libraryPatch, matchingBookmarks, queryLibrary, type BookmarkPage, type BookmarkQuery } from './queries'
let persisted: Library | undefined
let persistedRevision: string | undefined
export async function libraryChanged(): Promise<boolean> {
  return desktop && persistedRevision !== await invoke<string>('get_library_revision')
}
const key = 'bookmark-desk.library.v1'
export const desktop = isTauri()
export async function loadLibrary(): Promise<Library> {
  if (desktop) {
    const snapshot = await invoke<{ library: Library; revision: string }>('load_library_snapshot')
    persisted = validateLibrary(snapshot.library)
    persistedRevision = snapshot.revision
    return persisted
  }
  const saved = localStorage.getItem(key)
  return saved ? validateLibrary(JSON.parse(saved)) : emptyLibrary
}
export async function saveLibrary(library: Library): Promise<void> {
  if (desktop) {
    if (!persisted) throw new Error('Load the library before saving.')
    persistedRevision = await invoke<string>('apply_library_patch', { patch: libraryPatch(persisted, library), expectedRevision: persistedRevision })
    persisted = library
  } else localStorage.setItem(key, JSON.stringify(library))
}
export async function queryBookmarks(library: Library, input: BookmarkQuery): Promise<BookmarkPage> {
  return desktop ? invoke('query_bookmarks', { input }) : queryLibrary(library, input)
}
export async function queryBookmarkIds(library: Library, input: BookmarkQuery): Promise<string[]> {
  return desktop ? invoke('query_bookmark_ids', { input, expectedRevision: persistedRevision }) : matchingBookmarks(library, input).map(b => b.id)
}
export async function openBookmark(url: string): Promise<void> {
  if (desktop) await invoke('open_bookmark', { url })
  else window.open(url, '_blank', 'noopener,noreferrer')
}
export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
