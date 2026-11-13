import { describe, expect, it } from 'vitest'
import { capture, flushQueue } from './core.js'
describe('extension capture', () => {
  it('captures title and first-party supplied icon without a network request', () => {
    const value = capture({ url: 'https://example.com/page#part', title: 'Example', favIconUrl: 'https://example.com/icon.png' }, { tags: ['work', 'work'], collectionIds: ['a'] })
    expect(value).toMatchObject({ url: 'https://example.com/page#part', title: 'Example', favicon: 'https://example.com/icon.png', tags: ['work'], collectionIds: ['a'] })
    expect(value.requestId).toBeTruthy()
  })
  it('rejects unsafe page URLs, credentials and oversized metadata', () => {
    for (const url of ['javascript:alert(1)', 'file:///secret', 'chrome://settings', 'https://user:pass@example.com']) expect(() => capture({ url })).toThrow()
    expect(() => capture({ url: 'https://example.com', title: 'x'.repeat(2049) })).toThrow()
    expect(() => capture({ url: 'https://example.com' }, { tags: ['bad\nvalue'] })).toThrow()
    expect(capture({ url: 'https://example.com', favIconUrl: 'javascript:alert(1)' }).favicon).toBe('')
  })
})
describe('durable queue acknowledgements', () => {
  const entry = { request: { op: 'save', requestId: 'stable-retry-id' } }
  it('retains IDs after lost acknowledgement and removes only confirmed receipts', async () => {
    const offline = await flushQueue([entry], async () => { throw new Error('offline') })
    expect(offline).toEqual([{ ...entry, transportError: 'offline' }])
    const ids = []
    expect(await flushQueue(offline, async request => { ids.push(request.requestId); return { ok: true, status: 'already-saved' } })).toEqual([])
    expect(ids).toEqual(['stable-retry-id'])
  })
  it('shows missing registration without dropping or blocking pending retries', async () => {
    const queue = [entry, { request: { requestId: 'next' } }]
    let calls = 0
    const pending = await flushQueue(queue, async () => { calls++; throw new Error('Specified native messaging host not found.') })
    expect(calls).toBe(1)
    expect(pending.map(e => e.request)).toEqual(queue.map(e => e.request))
    expect(pending.every(e => !e.error && e.transportError.includes('not registered'))).toBe(true)
    expect(await flushQueue(pending, async () => ({ ok: true }))).toEqual([])
  })
  it.each(['Bookmark Desk is not running', 'Start Bookmark Desk and pair the extension first', 'Extension origin is not paired', 'Unauthorized connector', 'Extension disabled'])('retries native connection response: %s', async error => {
    const pending = await flushQueue([entry], async () => ({ ok: false, error }))
    expect(pending).toEqual([{ ...entry, transportError: error }])
    expect(await flushQueue(pending, async () => ({ ok: true }))).toEqual([])
  })
  it('recovers connection errors persisted as rejections by older extension versions', async () => {
    expect(await flushQueue([{ ...entry, error: 'Bookmark Desk is not running' }], async () => ({ ok: true }))).toEqual([])
  })
  it('keeps rejected entries visible, continues independent saves, does not blindly retry invalid data', async () => {
    const result = await flushQueue([entry, { request: { requestId: 'next' } }], async request => request.requestId === 'next' ? { ok: true } : { ok: false, error: 'Unknown collection' })
    expect(result).toEqual([{ ...entry, error: 'Unknown collection' }])
    expect(await flushQueue(result, () => { throw new Error('must not retry') })).toEqual(result)
  })
})
