import { afterEach, expect, it, vi } from 'vitest'
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
it('serializes right-click/popup saves, persists before native transport and retries after offline', async () => {
  const data = { enabled: true, defaults: { tags: ['reading'], collectionIds: [] }, queue: [] }
  const listeners = {}
  const event = name => ({ addListener: handler => { listeners[name] = handler } })
  let online = false
  const received = []
  const native = vi.fn(async (_host, request) => {
    expect(data.queue.some(entry => entry.request.requestId === request.requestId)).toBe(true)
    received.push(request)
    if (!online) throw new Error('Desktop offline')
    return { ok: true, status: 'saved' }
  })
  vi.stubGlobal('chrome', {
    runtime: { id: 'a'.repeat(32), sendNativeMessage: native, onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') },
    contextMenus: { onClicked: event('context'), removeAll: async () => {}, create: vi.fn() },
    alarms: { create: vi.fn(), onAlarm: event('alarm') },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    storage: { local: { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])), set: async values => Object.assign(data, structuredClone(values)) } },
  })
  await import('./background.js')
  const call = message => new Promise(resolve => listeners.message(message, { id: chrome.runtime.id }, resolve))
  const tab = { url: 'https://example.com/', title: 'Captured tab', favIconUrl: 'https://example.com/favicon.ico' }
  const queued = await call({ op: 'saveTab', tab, defaults: data.defaults })
  expect(queued.status).toBe('queued')
  expect(data.queue).toHaveLength(1)
  const requestId = data.queue[0].request.requestId
  online = true
  expect(await call({ op: 'retry' })).toEqual({ ok: true })
  expect(data.queue).toEqual([])
  expect(received.map(request => request.requestId)).toEqual([requestId, requestId])
  listeners.context({ menuItemId: 'save' }, tab)
  await call({ op: 'retry' })
  expect(received.at(-1)).toMatchObject({ title: 'Captured tab', tags: ['reading'] })
  expect(data.queue).toEqual([])
  let responded = false
  expect(listeners.message({ op: 'retry' }, { id: chrome.runtime.id, tab: {} }, () => { responded = true })).toBe(false)
  expect(responded).toBe(false)
})
