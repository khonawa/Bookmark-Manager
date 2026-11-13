// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { deleteCollection, updateCollection, renameTag, trashBookmarks, restoreBookmarks, validateLibrary, mergeLibrary, exportHtml, emptyLibrary, type Library } from './library'
import { loadLibrary, saveLibrary } from './storage'
const sample = (): Library => ({
  collections: [{ id: 'a', name: 'Parent', parentId: null }, { id: 'b', name: 'Child', parentId: 'a' }, { id: 'c', name: 'Grandchild', parentId: 'b' }],
  bookmarks: [{ id: 'one', title: 'One', url: 'https://example.com/', description: 'Keep notes', tags: ['old', 'target'], collectionIds: ['b'], createdAt: '2026-01-01T00:00:00Z' }],
})
describe('collection and tag management', () => {
  it('renames and moves collections without changing membership', () => {
    const original = sample()
    const result = updateCollection(original, 'b', ' Renamed ', null)
    expect(result.collections[1]).toEqual({ id: 'b', name: 'Renamed', parentId: null })
    expect(result.bookmarks).toEqual(original.bookmarks)
    expect(original.collections[1]!.name).toBe('Child')
  })
  it('rejects self, descendant and missing parents', () => {
    for (const parent of ['a', 'b', 'c', 'missing']) expect(() => updateCollection(sample(), 'a', 'Parent', parent)).toThrow()
    expect(() => updateCollection(sample(), 'a', ' ', null)).toThrow()
  })
  it('keeps active and trashed bookmarks and reparents children when deleting', () => {
    const original = sample()
    original.trash = [{ ...original.bookmarks[0]!, id: 'trash', deletedAt: '2026-02-01T00:00:00Z' }]
    const result = deleteCollection(original, 'b')
    expect(result.collections.find(c => c.id === 'c')!.parentId).toBe('a')
    expect(result.bookmarks[0]!.collectionIds).toEqual([])
    expect(result.trash![0]!.collectionIds).toEqual([])
    expect(result.bookmarks[0]!.description).toBe('Keep notes')
    expect(deleteCollection(original, 'a').collections.find(c => c.id === 'b')!.parentId).toBeNull()
    expect(validateLibrary(result)).toEqual(result)
  })
  it('renames, merges and removes tags across active and trash without duplicates', () => {
    const original = trashBookmarks(sample(), new Set(['one']))
    const renamed = renameTag(original, 'old', 'target')
    expect(renamed.trash![0]!.tags).toEqual(['target'])
    expect(renameTag(renamed, 'target', '').trash![0]!.tags).toEqual([])
    expect(renameTag(sample(), 'old', 'new').bookmarks[0]!.tags).toEqual(['new', 'target'])
    expect(original.trash![0]!.tags).toEqual(['old', 'target'])
  })
})
describe('persistent trash and backups', () => {
  beforeEach(() => localStorage.clear())
  it('retains browser trash across loads and restores original fields', async () => {
    const original = sample()
    const trashed = trashBookmarks(original, new Set(['one']), '2026-02-01T00:00:00Z')
    await saveLibrary(trashed)
    const loaded = await loadLibrary()
    expect(loaded.bookmarks).toEqual([])
    expect(loaded.trash).toEqual(trashed.trash)
    const restored = restoreBookmarks(loaded, new Set(['one']))
    expect(restored.bookmarks).toEqual(original.bookmarks)
    expect(restored.trash).toEqual([])
    await saveLibrary({ ...loaded, trash: [] })
    expect((await loadLibrary()).trash).toEqual([])
  })
  it('merges restored duplicate URLs and does not mutate undo snapshots', () => {
    const original = sample()
    const deleted = trashBookmarks(original, new Set(['one']))
    const current = { ...deleted, bookmarks: [{ ...original.bookmarks[0]!, id: 'new', tags: ['new'], collectionIds: [], description: '' }] }
    const result = restoreBookmarks(current, new Set(['one']))
    expect(result.bookmarks).toHaveLength(1)
    expect(result.bookmarks[0]!.tags).toEqual(['new', 'old', 'target'])
    expect(result.bookmarks[0]!.collectionIds).toEqual(['b'])
    expect(result.bookmarks[0]!.description).toBe('Keep notes')
    expect(current.bookmarks[0]!.tags).toEqual(['new'])
    expect(deleted.trash).toHaveLength(1)
  })
  it('round trips JSON including trash while HTML excludes trash', () => {
    const original = trashBookmarks(sample(), new Set(['one']))
    const backup = validateLibrary(JSON.parse(JSON.stringify(original)))
    const imported = mergeLibrary(emptyLibrary, backup)
    expect(imported.trash).toEqual(original.trash)
    expect(imported.bookmarks).toEqual([])
    expect(exportHtml(imported)).not.toContain('https://example.com/')
    expect(mergeLibrary(imported, backup).trash).toHaveLength(1)
  })
  it('preserves existing trash, remaps imported memberships, and avoids ID collisions', () => {
    const original = sample()
    const incoming = trashBookmarks(sample(), new Set(['one']))
    const result = mergeLibrary(original, incoming)
    expect(result.bookmarks).toEqual(original.bookmarks)
    expect(result.trash![0]!.id).not.toBe('one')
    expect(result.trash![0]!.collectionIds).toEqual(['b'])
    expect(validateLibrary(result)).toEqual(result)
    expect(mergeLibrary(result, emptyLibrary).trash).toEqual(result.trash)
  })
  it('supports legacy backups and rejects malformed trash without changing storage', async () => {
    expect(validateLibrary(sample()).trash).toBeUndefined()
    const entry = { ...sample().bookmarks[0]!, id: 'trash', deletedAt: '2026-02-01T00:00:00Z' }
    for (const trash of [null, {}, [{ ...entry, deletedAt: 'bad' }], [{ ...entry, url: 'file:///bad' }], [{ ...entry, collectionIds: ['missing'] }], [{ ...entry, id: 'one' }]]) {
      expect(() => validateLibrary({ ...sample(), trash })).toThrow()
    }
    await saveLibrary(sample())
    expect(await loadLibrary()).toEqual(sample())
  })
})
