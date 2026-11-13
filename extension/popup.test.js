// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const field = id => document.getElementById(id)
const edit = (id, value) => {
  field(id).value = value
  field(id).dispatchEvent(new Event('input', { bubbles: true }))
}
const harness = (initial = {}) => {
  const data = structuredClone(initial)
  const tab = { id: 42, url: 'https://example.com/page', title: 'Browser title' }
  const sendMessage = vi.fn(async message => message.op === 'catalog'
    ? { ok: true, collections: [{ id: 'work', name: 'Work' }, { id: 'read', name: 'Reading' }], tags: [] }
    : message.op === 'check' ? { ok: true, saved: false } : { ok: true, status: 'queued' })
  const storage = {
    get: vi.fn(async () => structuredClone(data)),
    set: vi.fn(async values => { Object.assign(data, structuredClone(values)) }),
    remove: vi.fn(async key => { delete data[key] }),
  }
  const openOptionsPage = vi.fn()
  const removeTab = vi.fn()
  vi.stubGlobal('chrome', { tabs: { query: vi.fn(async () => [{ ...tab }]), remove: removeTab }, runtime: { sendMessage, openOptionsPage }, storage: { local: storage } })
  const reopen = async () => {
    vi.resetModules()
    document.body.innerHTML = readFileSync('extension\\popup.html', 'utf8')
    await import('./popup.js')
  }
  return { data, tab, sendMessage, storage, openOptionsPage, removeTab, reopen }
}

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.resetModules() })
it('retains cached collection choices offline and never claims a queued save is confirmed', async () => {
  document.body.innerHTML = readFileSync('extension\\popup.html', 'utf8')
  vi.stubGlobal('chrome', {
    tabs: { query: async () => [{ url: 'https://example.com', title: 'Offline page' }] },
    runtime: { openOptionsPage: vi.fn(), sendMessage: async message => message.op === 'catalog' ? { ok: false, error: 'Desktop offline' } : { ok: true, status: 'queued' } },
    storage: { local: { get: async () => ({ defaults: { tags: ['later'], collectionIds: ['a'] }, catalogCollections: [{ id: 'a', name: 'Reading' }] }), set: vi.fn() } },
  })
  await import('./popup.js')
  expect(document.getElementById('connection').textContent).toContain('Desktop unavailable')
  expect(document.getElementById('collections').selectedOptions[0].textContent).toBe('Reading')
  await document.getElementById('save').onsubmit({ preventDefault() {} })
  expect(document.getElementById('status').textContent).toContain('Queued locally')
  expect(document.getElementById('status').textContent).not.toContain('Desktop confirmed')
})
it('shows actual already-saved detection and submits selected title, tags and collection', async () => {
  document.body.innerHTML = readFileSync('extension\\popup.html', 'utf8')
  const tab = { url: 'https://example.com/page', title: 'Actual browser title', favIconUrl: 'https://example.com/favicon.ico' }
  const sendMessage = vi.fn(async message => {
    if (message.op === 'catalog') return { ok: true, collections: [{ id: 'work', name: 'Work' }], tags: ['read'] }
    if (message.op === 'check') return { ok: true, saved: true }
    return { ok: true, status: 'queued' }
  })
  vi.stubGlobal('chrome', {
    tabs: { query: async () => [tab] },
    runtime: { sendMessage, openOptionsPage: vi.fn() },
    storage: { local: { get: async () => ({ defaults: { collectionIds: ['work'], tags: ['read'] } }), set: vi.fn() } },
  })
  await import('./popup.js')
  expect(document.getElementById('connection').textContent).toContain('Already saved')
  expect(document.getElementById('title').value).toBe('Actual browser title')
  await document.getElementById('save').onsubmit({ preventDefault() {} })
  expect(sendMessage).toHaveBeenLastCalledWith({ op: 'saveTab', tab, defaults: { collectionIds: ['work'], tags: ['read'] } })
  expect(document.getElementById('status').textContent).toContain('Queued locally')
})

it('persists each edit and restores drafts only for the same original tab and source URL', async () => {
  const h = harness()
  await h.reopen()
  edit('title', 'My title')
  await vi.waitFor(() => expect(h.data['popupDraft:42']?.title).toBe('My title'))
  edit('url', 'https://example.com/custom')
  edit('tags', ' personal, later ')
  edit('collections', 'read')
  await vi.waitFor(() => expect(h.data['popupDraft:42']?.collectionIds).toEqual(['read']))
  expect(h.data['popupDraft:42']).toEqual({ tabId: 42, sourceUrl: 'https://example.com/page', title: 'My title', url: 'https://example.com/custom', tags: ' personal, later ', collectionIds: ['read'] })
  await h.reopen()
  expect(field('title').value).toBe('My title')
  expect(field('url').value).toBe('https://example.com/custom')
  expect(field('tags').value).toBe(' personal, later ')
  expect(field('collections').selectedOptions[0].value).toBe('read')
  h.tab.id = 99
  await h.reopen()
  expect(field('title').value).toBe('Browser title')
  h.tab.id = 42
  h.tab.url = 'https://example.com/navigated'
  await h.reopen()
  expect(field('title').value).toBe('Browser title')
  expect(field('url').value).toBe(h.tab.url)
  h.tab.url = 'https://example.com/page'
  h.data['popupDraft:42'].tabId = 99
  await h.reopen()
  expect(field('title').value).toBe('Browser title')
})

it('does not overwrite edits while tab and storage initialization are pending', async () => {
  const h = harness({ defaults: { tags: ['default'], collectionIds: ['work'] } })
  const query = deferred()
  const storage = deferred()
  chrome.tabs.query.mockReturnValueOnce(query.promise)
  h.storage.get.mockReturnValueOnce(storage.promise)
  const opening = h.reopen()
  await vi.waitFor(() => expect(chrome.tabs.query).toHaveBeenCalledOnce())
  edit('title', 'Early title')
  edit('url', 'https://edited.example')
  edit('tags', 'early')
  field('collections').append(new Option('Early', 'early', true, true))
  field('collections').dispatchEvent(new Event('change'))
  query.resolve([h.tab])
  storage.resolve({ defaults: { tags: ['default'], collectionIds: ['work'] } })
  await opening
  await vi.waitFor(() => expect(h.data['popupDraft:42']?.tags).toBe('early'))
  expect(field('title').value).toBe('Early title')
  expect(field('url').value).toBe('https://edited.example')
  expect(Array.from(field('collections').selectedOptions, option => option.value)).toEqual(['early'])
})

it('keeps current choices during delayed catalog initialization and failed check', async () => {
  const h = harness({ defaults: { collectionIds: ['work'] }, catalogCollections: [{ id: 'work', name: 'Work' }, { id: 'read', name: 'Reading' }] })
  const catalog = deferred()
  h.sendMessage.mockImplementation(async message => message.op === 'catalog' ? catalog.promise : { ok: false, error: 'Offline' })
  const opening = h.reopen()
  await vi.waitFor(() => expect(field('collections').options.length).toBe(2))
  edit('collections', 'read')
  edit('tags', 'mine')
  catalog.resolve({ ok: true, collections: [{ id: 'work', name: 'New work' }], tags: [] })
  await opening
  expect(field('collections').selectedOptions[0].value).toBe('read')
  expect(field('tags').value).toBe('mine')
  expect(field('connection').textContent).toContain('Desktop unavailable')
})

it('restores offline draft selections including missing collections and saves the draft URL', async () => {
  const h = harness({ 'popupDraft:42': { tabId: 42, sourceUrl: 'https://example.com/page', title: 'Offline draft', url: 'https://edited.example', tags: 'later', collectionIds: ['missing'] } })
  h.sendMessage.mockImplementation(async message => message.op === 'catalog' ? { ok: false, error: 'Offline' } : { ok: true, status: 'queued' })
  await h.reopen()
  expect(field('collections').selectedOptions[0].value).toBe('missing')
  await field('save').onsubmit({ preventDefault() {} })
  expect(h.sendMessage).toHaveBeenLastCalledWith({ op: 'saveTab', tab: { ...h.tab, title: 'Offline draft', url: 'https://edited.example' }, defaults: { tags: ['later'], collectionIds: ['missing'] } })
  expect(h.data['popupDraft:42']).toBeUndefined()
  field('setup').click()
  expect(h.openOptionsPage).toHaveBeenCalledOnce()
  expect(h.removeTab).not.toHaveBeenCalled()
})

it.each(['queued', 'saved', 'already-saved', 'saved-or-already-saved', 'needs-attention', 'error'])('clears drafts only for accepted saves: %s', async status => {
  const h = harness()
  await h.reopen()
  edit('title', 'Keep me')
  await vi.waitFor(() => expect(h.data['popupDraft:42']).toBeDefined())
  h.sendMessage.mockResolvedValueOnce({ ok: status !== 'error', status, error: 'Retry needed' })
  await field('save').onsubmit({ preventDefault() {} })
  expect(Boolean(h.data['popupDraft:42'])).toBe(['needs-attention', 'error'].includes(status))
  expect(field('submit').disabled).toBe(false)
})

it('retains newer edits made while a save is in flight', async () => {
  const h = harness()
  await h.reopen()
  edit('title', 'Submitted')
  const response = deferred()
  h.sendMessage.mockReturnValueOnce(response.promise)
  const saving = field('save').onsubmit({ preventDefault() {} })
  await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ op: 'saveTab' })))
  edit('title', 'Newer draft')
  response.resolve({ ok: true, status: 'queued' })
  await saving
  await vi.waitFor(() => expect(h.data['popupDraft:42']?.title).toBe('Newer draft'))
  expect(h.storage.remove).not.toHaveBeenCalled()
})
