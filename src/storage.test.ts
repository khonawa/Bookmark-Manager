// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
import { loadLibrary, saveLibrary, queryBookmarks, libraryChanged } from './storage'
it('uses patches, retains baseline after failed save, and forwards desktop query without in-memory fallback', async () => {
  const before = { bookmarks: [{ id: 'b', title: 'Before', url: 'https://example.com/', tags: [], collectionIds: [], description: '', createdAt: '2026-01-01' }], collections: [] }
  mocks.invoke.mockResolvedValueOnce({ library: before, revision: '1' })
  await loadLibrary()
  const next = { ...before, bookmarks: [{ ...before.bookmarks[0]!, title: 'After' }] }
  mocks.invoke.mockRejectedValueOnce(new Error('disk failure'))
  await expect(saveLibrary(next)).rejects.toThrow('disk failure')
  mocks.invoke.mockResolvedValueOnce('2')
  await saveLibrary(next)
  expect(mocks.invoke.mock.calls[1]).toEqual(mocks.invoke.mock.calls[2])
  expect(mocks.invoke.mock.calls[2]![0]).toBe('apply_library_patch')
  expect(mocks.invoke.mock.calls[2]![1].patch.bookmarks).toEqual(next.bookmarks)
  mocks.invoke.mockResolvedValueOnce(undefined)
  await saveLibrary(next)
  expect(mocks.invoke.mock.calls[3]![1].patch.bookmarks).toEqual([])
  expect(mocks.invoke.mock.calls[1]![1].expectedRevision).toBe('1')
  expect(mocks.invoke.mock.calls[3]![1].expectedRevision).toBe('2')
  const input = { view: 'all', tag: '', query: 'server only', sort: 'newest', page: 0 }
  mocks.invoke.mockResolvedValueOnce({ bookmarks: [], total: 0 })
  expect(await queryBookmarks(before, input)).toEqual({ bookmarks: [], total: 0 })
  expect(mocks.invoke).toHaveBeenLastCalledWith('query_bookmarks', { input })
  mocks.invoke.mockResolvedValueOnce('3')
  expect(await libraryChanged()).toBe(true)
  expect(mocks.invoke).toHaveBeenLastCalledWith('get_library_revision')
})
