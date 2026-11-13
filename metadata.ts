import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import type { Plugin } from 'vite'

const PAGE_LIMIT = 1024 * 1024
const ICON_LIMIT = 256 * 1024
const REDIRECTS = new Set([301, 302, 303, 307, 308])

type Metadata = { title: string | null; icon: string | null }

// Fail closed for non-global ranges, including IPv4-mapped IPv6 and transition networks.
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113))
  }
  if (isIP(address) !== 6) return false
  const parts = address.toLowerCase().split(':')
  const first = parseInt(parts[0], 16)
  const second = parseInt(parts[1] || '0', 16)
  return first >= 0x2000 && first <= 0x3fff &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
    first !== 0x2002 && !(first === 0x3fff && second < 0x1000)
}

export function publicUrl(input: string, base?: URL): URL {
  const url = new URL(input, base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || input.length > 4096) {
    throw new Error('Invalid destination')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host || (isIP(host) && !isPublicAddress(host))) throw new Error('Non-public destination')
  url.hash = ''
  return url
}

type Resource = { body: Buffer; url: URL; contentType: string }

function requestOnce(url: URL, limit: number, deadline: number): Promise<Resource | URL> {
  return new Promise((resolve, reject) => {
    let settled = false
    let request: ReturnType<typeof httpRequest> | undefined
    const finish = (error?: Error, result?: Resource | URL) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(result!)
    }
    // This wall-clock limit includes DNS, TLS, headers and the entire response body.
    const timer = setTimeout(() => {
      finish(new Error('Metadata request timed out'))
      request?.destroy()
    }, Math.max(1, Math.min(2500, deadline - Date.now())))
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    void (async () => {
      const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await lookup(hostname, { all: true, verbatim: true })
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw new Error('Non-public destination')
      }
      if (settled) return
      const pinned = addresses[0]
      request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        agent: false,
        // Keep the original host for Host/TLS verification, but never resolve it again.
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [pinned])
          else callback(null, pinned.address, pinned.family)
        },
        headers: { Accept: '*/*', 'Accept-Encoding': 'identity', 'User-Agent': 'BookmarkDesk-Metadata/1.0' },
      }, response => {
        const fail = (message: string) => {
          finish(new Error(message))
          response.destroy()
          request?.destroy()
        }
        response.on('error', error => finish(error))
        response.on('aborted', () => finish(new Error('Incomplete response')))
        if (REDIRECTS.has(response.statusCode ?? 0)) {
          try {
            if (!response.headers.location) throw new Error('Missing redirect location')
            finish(undefined, publicUrl(response.headers.location, url))
          } catch (error) { finish(error as Error) }
          response.destroy()
          return
        }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) return fail('HTTP failure')
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') return fail('Unsupported encoding')
        if (Number(response.headers['content-length']) > limit) return fail('Response too large')
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > limit) return fail('Response too large')
          chunks.push(chunk)
        })
        response.on('end', () => finish(undefined, {
          body: Buffer.concat(chunks), url, contentType: (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(),
        }))
      })
      request.on('error', error => finish(error))
      request.end()
    })().catch(error => finish(error as Error))
  })
}

async function fetchResource(url: URL, limit: number, deadline: number): Promise<Resource> {
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (Date.now() >= deadline) throw new Error('Metadata deadline exceeded')
    const result = await requestOnce(url, limit, deadline)
    if (!(result instanceof URL)) return result
    url = result
  }
  throw new Error('Too many redirects')
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }
  return text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (original, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? original
    const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : original
  })
}

export function parsePage(html: string, url: URL): { title: string | null; iconUrl: URL } {
  const rawTitle = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1]
  const title = rawTitle ? decodeEntities(rawTitle).replace(/\s+/g, ' ').trim().slice(0, 1024) || null : null
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes: Record<string, string> = {}
    for (const attr of tag[0].matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      const name = attr[1].toLowerCase()
      if (!(name in attributes)) attributes[name] = decodeEntities(attr[2] ?? attr[3] ?? attr[4])
    }
    if (attributes.rel?.toLowerCase().split(/\s+/).includes('icon') && attributes.href && attributes.type?.toLowerCase() !== 'image/svg+xml') {
      try { return { title, iconUrl: publicUrl(attributes.href, url) } } catch { /* Try another link or the default. */ }
    }
  }
  return { title, iconUrl: new URL('/favicon.ico', url) }
}

export function iconDataUrl(body: Buffer, contentType: string): string | null {
  if (!body.length || body.length > ICON_LIMIT) return null
  let mime: string | undefined
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png'
  else if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) mime = 'image/jpeg'
  else if (['GIF87a', 'GIF89a'].includes(body.subarray(0, 6).toString('ascii'))) mime = 'image/gif'
  else if (body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP') mime = 'image/webp'
  else if (body.length >= 6 && body.readUInt32LE(0) === 0x00010000 && body.readUInt16LE(4) > 0) mime = 'image/x-icon'
  const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon', 'application/octet-stream', ''])
  return mime && allowed.has(contentType) ? `data:${mime};base64,${body.toString('base64')}` : null
}

export async function getMetadata(input: string): Promise<Metadata> {
  const url = publicUrl(input)
  const deadline = Date.now() + 8000
  const page = await fetchResource(url, PAGE_LIMIT, deadline)
  if (page.contentType !== 'text/html' && page.contentType !== 'application/xhtml+xml') return { title: null, icon: null }
  const { title, iconUrl } = parsePage(page.body.toString('utf8'), page.url)
  try {
    const icon = await fetchResource(iconUrl, ICON_LIMIT, deadline)
    return { title, icon: iconDataUrl(icon.body, icon.contentType) }
  } catch { return { title, icon: null } }
}

/** Local dev/preview only; no remote metadata service or frontend proxy. */
export function metadataPlugin(): Plugin {
  let active = 0
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/api/metadata') return next()
    const reply = (status: number, data: Metadata) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(JSON.stringify(data))
    }
    const empty: Metadata = { title: null, icon: null }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return reply(405, empty) }
    const target = url.searchParams.get('url')
    try { if (!target) throw new Error('Missing URL'); publicUrl(target) } catch { return reply(400, empty) }
    if (active >= 8) return reply(503, empty)
    active++
    void getMetadata(target!).then(data => reply(200, data), () => reply(502, empty)).finally(() => { active-- })
  }
  return {
    name: 'local-page-metadata',
    configureServer(server) { server.middlewares.use(middleware) },
    configurePreviewServer(server) { server.middlewares.use(middleware) },
  }
}
