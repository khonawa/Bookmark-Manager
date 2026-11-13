import { describe, expect, it } from 'vitest'
import { libraryPatch, queryLibrary } from './queries'
import { duplicateGroups, mergeDuplicates } from './duplicates'
import { mergeLibrary, validateLibrary, type Library } from './library'

function fixture(count: number): Library {
  return { collections: [{ id: 'c', name: 'Research', parentId: null }], bookmarks: Array.from({ length: count }, (_, i) => ({ id: `b${i}`, title: `Bookmark ${String(i).padStart(6, '0')}`, url: `https://example.com/article/${i}?q=1`, description: `Research notes ${i}`, tags: i % 2 ? ['research'] : [], collectionIds: i % 3 ? ['c'] : [], createdAt: '2026-01-01T00:00:00Z' })) }
}
describe('large library and incremental persistence', () => {
  it('imports 25,000 links, deduplicates repeated imports and patches only changed rows', () => {
    const source = fixture(25_000)
    const start = performance.now()
    const imported = mergeLibrary({ bookmarks: [], collections: [] }, source)
    const repeated = mergeLibrary(imported, source)
    expect(repeated.bookmarks).toHaveLength(25_000)
    expect(libraryPatch(imported, repeated).bookmarks).toHaveLength(0)
    const next = { ...imported, bookmarks: imported.bookmarks.map((b, i) => i === 500 ? { ...b, title: 'Changed' } : b) }
    const patch = libraryPatch(imported, next)
    expect(patch.bookmarks).toHaveLength(1)
    expect(patch.deletedBookmarkIds).toEqual([])
    console.info(`25,000-link import + repeat + incremental diff: ${(performance.now() - start).toFixed(1)}ms`)
  }, 15_000)
  it('filters, sorts, clamps pagination and includes trash', () => {
    const library = fixture(180)
    const input = { view: 'all', tag: '', query: '', sort: 'title', page: 1 }
    expect(queryLibrary(library, input).bookmarks[0]!.title).toBe('Bookmark 000075')
    expect(queryLibrary(library, { ...input, page: 99 }).bookmarks).toHaveLength(30)
    expect(queryLibrary(library, { ...input, tag: 'research', view: 'c', page: 0 }).total).toBe(60)
    expect(queryLibrary(library, { ...input, query: 'notes 179', page: 0 }).bookmarks[0]!.id).toBe('b179')
    expect(queryLibrary({ ...library, trash: [{ ...library.bookmarks[0]!, id: 't', deletedAt: '2026-01-02' }] }, { ...input, view: 'trash', page: 0 }).total).toBe(1)
  })
})
describe('explicit conservative duplicate merging', () => {
  it('preserves all notes/tags/memberships, archives originals and leaves undo snapshot intact', () => {
    const original = fixture(2)
    original.bookmarks[1] = { ...original.bookmarks[1]!, url: original.bookmarks[0]!.url, description: 'Other notes' }
    expect(duplicateGroups(original)).toHaveLength(1)
    const result = mergeDuplicates(original, ['b0', 'b1'], 'b0')
    expect(result.bookmarks).toHaveLength(1)
    expect(result.bookmarks[0]!.description).toBe('Research notes 0\n\nOther notes')
    expect(result.bookmarks[0]!.tags).toEqual(['research'])
    expect(result.bookmarks[0]!.collectionIds).toEqual(['c'])
    expect(result.trash![0]!.description).toBe('Other notes')
    expect(original.bookmarks).toHaveLength(2)
    expect(validateLibrary(JSON.parse(JSON.stringify(result)))).toEqual(result)
    const patch = libraryPatch(original, result)
    expect(patch.deletedBookmarkIds).toEqual(['b1'])
    expect(patch.trash).toHaveLength(1)
  })
  it('never conflates fragments, parameters, schemes or different paths and rejects stale selections', () => {
    const original = fixture(2)
    for (const suffix of ['#section', '&extra=2', '/other']) {
      original.bookmarks[1]!.url = original.bookmarks[0]!.url + suffix
      expect(duplicateGroups(original)).toEqual([])
      expect(() => mergeDuplicates(original, ['b0', 'b1'], 'b0')).toThrow()
    }
    expect(() => mergeDuplicates(original, ['b0', 'missing'], 'b0')).toThrow()
  })
})
