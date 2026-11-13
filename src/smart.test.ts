import { expect, it } from 'vitest'
import { bulkOrganize, mergeLibrary, validateLibrary, type Library, type SmartRules } from './library'
import { libraryPatch, matchingBookmarks, matchesRules, queryLibrary } from './queries'
const rules: SmartRules = { text: 'guide', tags: ['read'], domain: 'example.com', untagged: false, inbox: true }
const bookmark = { id: 'a', title: 'A GUIDE', url: 'https://www.example.com./guide', description: '', tags: ['read'], collectionIds: [] as string[], createdAt: '2026-01-01' }
const library: Library = { bookmarks: [bookmark], collections: [], smartCollections: [{ id: 's', name: 'Reading', rules }] }
it('ANDs smart rules with exact domains, all tags, inbox and untagged', () => {
  expect(matchesRules(bookmark, rules)).toBe(true)
  for (const change of [{ domain: 'other.example.com' }, { tags: ['read', 'missing'] }, { untagged: true }, { text: 'missing' }]) expect(matchesRules(bookmark, { ...rules, ...change })).toBe(false)
  expect(matchesRules({ ...bookmark, collectionIds: ['c'] }, rules)).toBe(false)
  expect(matchesRules({ ...bookmark, title: 'Ä' }, { ...rules, text: 'ä' })).toBe(false)
  expect(matchesRules(bookmark, { ...rules, text: ' GUIDE ' })).toBe(true)
  expect(matchesRules(bookmark, { ...rules, text: 'GUIDE https:' })).toBe(true)
})
it('persists portable smart records while accepting old backups and incremental changes', () => {
  expect(validateLibrary(JSON.parse(JSON.stringify(library)))).toEqual(library)
  expect(validateLibrary({ bookmarks: [], collections: [] }).smartCollections).toBeUndefined()
  expect(libraryPatch({ bookmarks: [], collections: [] }, library).smartCollections).toEqual(library.smartCollections)
  expect(libraryPatch(library, { ...library, smartCollections: [] }).deletedSmartCollectionIds).toEqual(['s'])
  expect(mergeLibrary(library, library).smartCollections).toHaveLength(1)
  expect(() => validateLibrary({ ...library, smartCollections: [{ ...library.smartCollections![0], rules: { ...rules, domain: 'https://bad' } }] })).toThrow()
})
it('captures every matching id across pages and limits move/remove operations to that snapshot', () => {
  const many: Library = { ...library, collections: [{ id: 'old', name: 'Old', parentId: null }, { id: 'new', name: 'New', parentId: null }], bookmarks: Array.from({ length: 161 }, (_, i) => ({ ...bookmark, id: String(i), collectionIds: ['old'], tags: i < 155 ? ['read', 'keep'] : ['keep'] })) }
  const input = { view: 'all', query: '', tag: 'read', sort: 'newest', page: 0 }
  expect(queryLibrary(many, input).bookmarks).toHaveLength(75)
  expect(queryLibrary(many, { ...input, page: 2 }).bookmarks).toHaveLength(5)
  const ids = new Set(matchingBookmarks(many, input).map(b => b.id))
  expect(ids.size).toBe(155)
  const added = bulkOrganize(many, ids, 'add', ['new'])
  expect(added.bookmarks[0].collectionIds).toEqual(['old', 'new'])
  const moved = bulkOrganize(many, ids, 'move', ['new'])
  expect(moved.bookmarks[154].collectionIds).toEqual(['new'])
  expect(moved.bookmarks[155]).toBe(many.bookmarks[155])
  const removed = bulkOrganize(moved, ids, 'removeTags', ['read'])
  expect(removed.bookmarks[0].tags).toEqual(['keep'])
  expect(many.bookmarks[0].tags).toEqual(['read', 'keep'])
  expect(queryLibrary(library, { ...input, view: 'smart:s', tag: '', query: '' }).total).toBe(1)
  expect(queryLibrary({ ...library, bookmarks: [] }, { ...input, view: 'smart:s' }).total).toBe(0)
})
