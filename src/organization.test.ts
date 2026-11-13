import { expect, it } from 'vitest'
import { organizationDrop, type OrganizationDrag } from './organization'
import type { Library } from './library'
const library: Library = { collections: [{ id: 'a', name: 'A', parentId: null }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'c', name: 'C', parentId: null }], bookmarks: Array.from({ length: 160 }, (_, i) => ({ id: String(i), title: 'Link', url: `https://example.com/${i}`, tags: [], collectionIds: ['a', 'b'], description: '', createdAt: '2026-01-01' })) }
const bookmarks: OrganizationDrag = { kind: 'bookmarks', ids: library.bookmarks.map(b => b.id), scope: 'scope', baseline: library }
it('moves explicit multi-page selection, replacing memberships, and leaves Undo baseline intact', () => {
  const next = organizationDrop(library, bookmarks, 'scope', 'c')
  expect(next.bookmarks).toHaveLength(160)
  expect(next.bookmarks.every(b => b.collectionIds.join() === 'c')).toBe(true)
  expect(library.bookmarks.every(b => b.collectionIds.join() === 'a,b')).toBe(true)
  expect(bookmarks.baseline).toBe(library)
})
it('rejects unknown IDs, smart targets, root bookmark drops, stale scope and revision snapshots', () => {
  for (const target of ['smart:saved', 'missing', null]) expect(() => organizationDrop(library, bookmarks, 'scope', target)).toThrow()
  expect(() => organizationDrop(library, { ...bookmarks, ids: ['missing'] }, 'scope', 'a')).toThrow()
  expect(() => organizationDrop(library, bookmarks, 'new scope', 'a')).toThrow()
  expect(() => organizationDrop({ ...library }, bookmarks, 'scope', 'a')).toThrow()
})
it('reparents collections and prevents self and descendant cycles; supports top level', () => {
  const drag: OrganizationDrag = { kind: 'collection', id: 'a', scope: 'scope', baseline: library }
  for (const target of ['a', 'b']) expect(() => organizationDrop(library, drag, 'scope', target)).toThrow()
  expect(organizationDrop(library, drag, 'scope', 'c').collections[0].parentId).toBe('c')
  expect(organizationDrop(library, { ...drag, id: 'b' }, 'scope', null).collections[1].parentId).toBeNull()
})
