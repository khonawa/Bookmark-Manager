// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { BookmarkPage } from './queries'
import type { Library } from './library'
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('./SiteIcon', () => ({ default: () => null }))
import Workspace from './Workspace'
const base = { id: 'one', title: 'SQL displayed result', url: 'https://example.com/', description: '', tags: [], collectionIds: [], createdAt: '2026-01-01' }
const library: Library = { bookmarks: [{ ...base, title: 'In-memory value must not display' }], collections: [] }
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; mocks.invoke.mockReset() })
it('refreshes external native saves and invalidates stale UI results and Undo', async () => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let currentRevision = '1'
  let current = { ...library, bookmarks: [base] }
  mocks.invoke.mockImplementation((command: string) => {
    if (command === 'load_library_snapshot') return Promise.resolve({ library: current, revision: currentRevision })
    if (command === 'get_library_revision') return Promise.resolve(currentRevision)
    if (command === 'query_bookmarks') return Promise.resolve({ bookmarks: current.bookmarks, total: current.bookmarks.length })
    return Promise.resolve(null)
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<Workspace />))
  await act(async () => vi.advanceTimersByTime(125))
  currentRevision = '2'
  current = { ...library, bookmarks: [{ ...base, id: 'native', title: 'Native extension save' }] }
  await act(async () => vi.advanceTimersByTime(2000))
  await act(async () => vi.advanceTimersByTime(125))
  expect(container.textContent).toContain('Native extension save')
  expect(container.textContent).toContain('Undo cleared to protect external saves')
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'load_library_snapshot')).toHaveLength(2)
  await act(async () => root.unmount())
})
it('renders actual desktop SQL pages and ignores out-of-order responses after search', async () => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const pending: ((page: BookmarkPage) => void)[] = []
  mocks.invoke.mockImplementation((command: string) => command === 'load_library_snapshot' ? Promise.resolve({ library, revision: '1' }) : command === 'get_library_revision' ? Promise.resolve('1') : new Promise<BookmarkPage>(resolve => pending.push(resolve)))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<Workspace />))
  await act(async () => vi.advanceTimersByTime(125))
  expect(pending).toHaveLength(1)
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search bookmarks"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'new')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => vi.advanceTimersByTime(125))
  expect(pending).toHaveLength(2)
  await act(async () => pending[1]!({ bookmarks: [base], total: 1 }))
  expect(container.textContent).toContain('SQL displayed result')
  expect(container.textContent).not.toContain('In-memory value must not display')
  await act(async () => pending[0]!({ bookmarks: [{ ...base, title: 'Stale response' }], total: 500 }))
  expect(container.textContent).not.toContain('Stale response')
  expect(container.textContent).toContain('1–1 of 1 bookmarks')
  await act(async () => root.unmount())
})

it('captures SQL IDs across pages and rejects late selection after filters change', async () => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let resolveIds: (ids: string[]) => void = () => {}
  mocks.invoke.mockImplementation((command: string) => {
    if(command === 'load_library_snapshot') return Promise.resolve({ library: { ...library, bookmarks: [base] }, revision: '1' })
    if(command === 'get_library_revision') return Promise.resolve('1')
    if(command === 'query_bookmark_ids') return new Promise<string[]>(resolve => { resolveIds = resolve })
    if(command === 'query_bookmarks') return Promise.resolve({ bookmarks: [base], total: 160 })
    return Promise.resolve('2')
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<Workspace />))
  await act(async () => vi.advanceTimersByTime(125))
  const button = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Select all 160 matching')!
  await act(async () => button().click())
  await act(async () => resolveIds(Array.from({length:160}, (_,i)=>String(i))))
  expect(container.textContent).toContain('160 selected (across pages)')
  await act(async () => [...container.querySelectorAll('button')].find(b=>b.textContent === 'Next')!.click())
  await act(async () => vi.advanceTimersByTime(125))
  expect(container.textContent).toContain('160 selected (across pages)')
  await act(async () => button().click())
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search bookmarks"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'new')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => resolveIds(['one']))
  expect(container.textContent).toContain('0 selected (across pages)')
  expect(mocks.invoke.mock.calls.find(call=>call[0] === 'query_bookmark_ids')?.[1].expectedRevision).toBe('1')
  await act(async () => root.unmount())
})

it('drags captured cross-page IDs to a normal collection and supports persisted Undo', async () => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const bookmarks = Array.from({ length: 160 }, (_, i) => ({ ...base, id: String(i), collectionIds: ['old'] }))
  const current = { bookmarks, collections: [{ id: 'old', name: 'Old', parentId: null }, { id: 'target', name: 'Target', parentId: null }] }
  mocks.invoke.mockImplementation((command: string) => {
    if (command === 'load_library_snapshot') return Promise.resolve({ library: current, revision: '1' })
    if (command === 'get_library_revision') return Promise.resolve('1')
    if (command === 'query_bookmarks') return Promise.resolve({ bookmarks: [bookmarks[0]], total: 160 })
    if (command === 'query_bookmark_ids') return Promise.resolve(bookmarks.map(b => b.id))
    return Promise.resolve('2')
  })
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<Workspace />))
  await act(async () => vi.advanceTimersByTime(125))
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Select all 160 matching')!.click())
  const transfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
  function dragEvent(type: string) { const event = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: transfer }); return event }
  await act(async () => container.querySelector('article')!.dispatchEvent(dragEvent('dragstart')))
  const target = [...container.querySelectorAll<HTMLButtonElement>(".tree-row .nav-item")].find(b => b.querySelector(".collection-name")?.textContent === "Target")!
  await act(async () => target.dispatchEvent(dragEvent('dragover')))
  expect(target.className).toContain('drop-valid')
  await act(async () => target.dispatchEvent(dragEvent('drop')))
  const writes = () => mocks.invoke.mock.calls.filter(c => c[0] === 'apply_library_patch')
  expect(writes()).toHaveLength(1)
  expect(JSON.stringify(writes()[0])).toContain('target')
  expect(container.textContent).toContain('Moved 160 bookmarks')
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Undo')!.click())
  expect(writes()).toHaveLength(2)
  expect(container.textContent).toContain('Last change undone')
  await act(async () => root.unmount())
})

