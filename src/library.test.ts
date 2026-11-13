// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { emptyLibrary, exportHtml, mergeLibrary, normalizeUrl, parseBookmarkHtml, validateLibrary, type Library } from './library'
const fixture: Library = {
  collections: [{ id: 'a', name: 'Work & learning', parentId: null }, { id: 'b', name: 'Rust', parentId: 'a' }],
  bookmarks: [{ id: '1', title: 'Rust <guide>', url: 'https://example.com/guide?a=1&b=2', description: 'Notes', tags: ['code'], collectionIds: ['b'], createdAt: '2026-01-01T00:00:00Z' }],
}
describe('library', () => {
  it('only accepts web URLs', () => {
    expect(normalizeUrl(' https://example.com ')).toBe('https://example.com/')
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow()
    expect(() => normalizeUrl('file:///secret')).toThrow()
  })
  it('validates backups and rejects cycles or dangling membership', () => {
    expect(validateLibrary(fixture)).toEqual(fixture)
    expect(() => validateLibrary({ ...fixture, collections: [{ id: 'a', name: 'A', parentId: 'a' }] })).toThrow()
    expect(() => validateLibrary({ ...fixture, collections: [] })).toThrow()
  })
  it('merges duplicates without losing memberships or tags', () => {
    const incoming = { ...fixture, bookmarks: [{ ...fixture.bookmarks[0]!, url: fixture.bookmarks[0]!.url + '#section', tags: ['new'] }] }
    const result = mergeLibrary(fixture, incoming)
    expect(result.bookmarks).toHaveLength(1)
    expect(result.bookmarks[0]!.tags).toEqual(['code', 'new'])
    expect(fixture.bookmarks[0]!.tags).toEqual(['code'])
  })
  it('round trips nested browser HTML and escapes content', () => {
    const html = exportHtml(fixture)
    expect(html).toContain('Rust &lt;guide&gt;')
    const result = parseBookmarkHtml(html)
    expect(result.bookmarks).toHaveLength(1)
    expect(result.bookmarks[0]!.title).toBe('Rust <guide>')
    expect(result.bookmarks[0]!.url).toBe(fixture.bookmarks[0]!.url)
    const nested = result.collections.find(c => c.name === 'Rust')!
    expect(result.collections.find(c => c.id === nested.parentId)?.name).toBe('Work & learning')
    expect(result.bookmarks[0]!.collectionIds).toEqual([nested.id])
  })
  it('ignores unsafe links and merges repeated imported URLs', () => {
    const result = parseBookmarkHtml('<DL><p><DT><A HREF="javascript:alert(1)">Bad</A><DT><A HREF="https://example.com">One</A><DT><A HREF="https://example.com/">Two</A></DL>')
    expect(result.bookmarks).toHaveLength(1)
  })
  it('reuses collection paths on repeated HTML imports', () => {
    const first = parseBookmarkHtml(exportHtml(fixture))
    const second = parseBookmarkHtml(exportHtml(fixture))
    const result = mergeLibrary(first, second)
    expect(result.collections).toHaveLength(2)
    expect(result.bookmarks).toHaveLength(1)
    expect(result.bookmarks[0]!.collectionIds).toHaveLength(1)
  })
  it('preserves backup data on import into an empty library', () => {
    const result = mergeLibrary(emptyLibrary, validateLibrary(JSON.parse(JSON.stringify(fixture))))
    expect(result.bookmarks[0]!.description).toBe('Notes')
    expect(result.bookmarks[0]!.tags).toEqual(['code'])
    expect(result.collections).toEqual(fixture.collections)
  })
})
