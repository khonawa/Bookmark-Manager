// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('node:http', () => ({ request: mocks.request }))
vi.mock('node:https', () => ({ request: mocks.request }))
import { getMetadata, iconDataUrl, isPublicAddress, metadataPlugin, parsePage, publicUrl } from './metadata.ts'

type Reply = { status?: number; headers?: Record<string, string>; body?: Buffer | string; hang?: boolean }
let replies: Reply[]
let destinations: string[]
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
beforeEach(() => {
  replies = []
  destinations = []
  mocks.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  mocks.request.mockReset().mockImplementation((url, options, callback) => {
    destinations.push(url.href)
    // Exercise both Node lookup callback shapes; neither may perform another DNS lookup.
    options.lookup(url.hostname, {}, (error: unknown, address: string, family: number) => {
      expect(error).toBeNull(); expect(address).toBe('93.184.216.34'); expect(family).toBe(4)
    })
    options.lookup(url.hostname, { all: true }, (error: unknown, addresses: unknown[]) => {
      expect(error).toBeNull(); expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
    })
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: () => {
      const reply = replies.shift() ?? {}
      if (reply.hang) return
      queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), {
          statusCode: reply.status ?? 200, headers: reply.headers ?? {}, destroy: vi.fn(),
        })
        callback(response)
        response.emit('data', Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body ?? ''))
        response.emit('end')
      })
    } })
    return req
  })
})
afterEach(() => vi.useRealTimers())

describe('public destinations', () => {
  it.each(['127.0.0.1', '10.2.3.4', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.19.0.1', '192.0.2.1', '::1', '::', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:0808:0808::1'])('blocks %s', address => {
    expect(isPublicAddress(address)).toBe(false)
  })
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows %s', address => expect(isPublicAddress(address)).toBe(true))
  it.each(['file:///etc/passwd', 'ftp://example.com', 'http://user:pass@example.com', 'http://2130706433', 'http://[::1]'])('rejects %s', url => expect(() => publicUrl(url)).toThrow())
  it('rejects mixed public/private DNS answers without opening a connection', async () => {
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])
    await expect(getMetadata('https://example.com')).rejects.toThrow('Non-public')
    expect(mocks.request).not.toHaveBeenCalled()
  })
})

describe('metadata fetching', () => {
  it('resolves favicon against final page URL, decodes title and pins DNS', async () => {
    replies.push(
      { status: 302, headers: { location: '/nested/page' } },
      { headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<title>A &amp; B &#x1f600;</title><link href="../icon.png" rel="shortcut icon">' },
      { headers: { 'content-type': 'image/png' }, body: png },
    )
    expect(await getMetadata('https://example.com/start')).toEqual({ title: 'A & B 😀', icon: `data:image/png;base64,${png.toString('base64')}` })
    expect(destinations).toEqual(['https://example.com/start', 'https://example.com/nested/page', 'https://example.com/icon.png'])
    expect(mocks.lookup).toHaveBeenCalledTimes(3)
  })
  it('uses the root favicon fallback and retains title after icon failure', async () => {
    replies.push({ headers: { 'content-type': 'text/html' }, body: '<title> Page </title>' }, { status: 404 })
    expect(await getMetadata('https://example.com/nested/page')).toEqual({ title: 'Page', icon: null })
    expect(destinations[1]).toBe('https://example.com/favicon.ico')
  })
  it('validates redirect DNS before connecting', async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
    replies.push({ status: 302, headers: { location: 'https://internal.example/' } })
    await expect(getMetadata('https://example.com')).rejects.toThrow('Non-public')
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
  it('blocks private icon redirects without losing title', async () => {
    replies.push({ headers: { 'content-type': 'text/html' }, body: '<title>Keep</title>' }, { status: 302, headers: { location: 'http://169.254.169.254/' } })
    expect(await getMetadata('https://example.com')).toEqual({ title: 'Keep', icon: null })
    expect(mocks.request).toHaveBeenCalledTimes(2)
  })
  it('caps redirects', async () => {
    replies.push(...Array.from({ length: 5 }, () => ({ status: 302, headers: { location: '/again' } })))
    await expect(getMetadata('https://example.com')).rejects.toThrow('Too many redirects')
    expect(mocks.request).toHaveBeenCalledTimes(4)
  })
  it('caps page and icon bytes', async () => {
    replies.push({ headers: { 'content-type': 'text/html' }, body: Buffer.alloc(1024 * 1024 + 1) })
    await expect(getMetadata('https://example.com')).rejects.toThrow('too large')
    replies.push({ headers: { 'content-type': 'text/html' }, body: '<title>Keep</title>' }, { body: Buffer.alloc(256 * 1024 + 1) })
    expect(await getMetadata('https://example.com')).toEqual({ title: 'Keep', icon: null })
  })
  it('bounds DNS time', async () => {
    vi.useFakeTimers()
    mocks.lookup.mockReturnValue(new Promise(() => {}))
    const result = expect(getMetadata('https://example.com')).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(2501)
    await result
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('bounds stalled responses', async () => {
    vi.useFakeTimers()
    replies.push({ hang: true })
    const result = expect(getMetadata('https://example.com')).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(2501)
    await result
  })
  it('rejects compressed responses', async () => {
    replies.push({ headers: { 'content-encoding': 'gzip' } })
    await expect(getMetadata('https://example.com')).rejects.toThrow('Unsupported encoding')
  })
})

it('accepts raster signatures only, never SVG or HTML disguised as an icon', () => {
  expect(iconDataUrl(Buffer.from('<svg/>'), 'image/png')).toBeNull()
  expect(iconDataUrl(png, 'image/svg+xml')).toBeNull()
  expect(iconDataUrl(Buffer.from('<html/>'), 'image/x-icon')).toBeNull()
  expect(iconDataUrl(Buffer.from([0, 0, 1, 0, 1, 0]), 'image/vnd.microsoft.icon')).toMatch(/^data:image\/x-icon;base64,/)
})
it('parses unquoted links and skips unsafe links', () => {
  expect(parsePage('<link rel=icon href=http://127.0.0.1/a><link rel=icon href=/good.png>', new URL('https://example.com/a')).iconUrl.href).toBe('https://example.com/good.png')
})
it('registers the same endpoint for dev and preview and enforces method/input', () => {
  const plugin = metadataPlugin()
  const use = vi.fn()
  ;(plugin.configureServer as Function)({ middlewares: { use } })
  ;(plugin.configurePreviewServer as Function)({ middlewares: { use } })
  expect(use.mock.calls[0][0]).toBe(use.mock.calls[1][0])
  const handler = use.mock.calls[0][0]
  const response = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() }
  const next = vi.fn()
  handler({ url: '/other', method: 'GET' }, response, next)
  expect(next).toHaveBeenCalledOnce()
  handler({ url: '/api/metadata', method: 'POST' }, response, next)
  expect(response.writeHead.mock.calls.at(-1)[0]).toBe(405)
  handler({ url: '/api/metadata?url=file:///no', method: 'GET' }, response, next)
  expect(response.writeHead.mock.calls.at(-1)[0]).toBe(400)
})
