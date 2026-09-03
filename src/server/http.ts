import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { handlers } from './electron-shim'
import { runInRequestContext, type RequestContext } from '../main/requestContext'

// The web front door.
// -----------------------------------------------------------------------------
// Deliberately built on node:http with no framework. Two reasons: adding a
// dependency would put it in the desktop installer as well (electron-builder
// bundles dependencies), and Hostinger then needs nothing installed beyond Node
// itself. What is needed here is a JSON POST, a static file and a cookie.
//
// One endpoint does everything: POST /api/invoke with { channel, args }. That is
// exactly the shape ipcRenderer.invoke already sends, so the renderer does not
// know it has moved.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

interface Session {
  userId: number | null
  username: string
  companyId: number
  seen: number
}

// In memory on purpose, for now: a restart logs everyone out, which is the
// correct behaviour for a first cut and avoids inventing a token format that a
// later phase would have to migrate. Phase 2 moves this to a signed cookie or
// a sessions table.
const sessions = new Map<string, Session>()
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

function sweepSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [k, v] of sessions) if (v.seen < cutoff) sessions.delete(k)
}

function readCookie(req: IncomingMessage, name: string): string {
  const raw = String(req.headers.cookie || '')
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return ''
}

function clientIp(req: IncomingMessage): string {
  // Hostinger fronts the app with a proxy, so the socket address is the proxy.
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return fwd || req.socket.remoteAddress || ''
}

function readBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      // A stock count sheet is the biggest thing posted here; anything past a
      // few megabytes is a mistake or an attack, and either way is refused
      // before it is buffered.
      if (size > limit) {
        reject(new Error('Request too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown, cookie?: string): void {
  const payload = JSON.stringify(body)
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    // The API is not cacheable and must never be stored by a proxy.
    'cache-control': 'no-store'
  }
  if (cookie) headers['set-cookie'] = cookie
  res.writeHead(status, headers)
  res.end(payload)
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
}

// Static files, and the SPA fallback. The path is normalised and confined to the
// web root: a request for ../../.env must not be able to leave it.
function serveStatic(res: ServerResponse, root: string, urlPath: string): boolean {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '')
  if (rel.split(/[/\\]/).includes('..')) return false
  const full = join(root, rel)
  if (!full.startsWith(root + sep) && full !== root) return false
  if (!existsSync(full) || !statSync(full).isFile()) return false
  const ext = extname(full).toLowerCase()
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    // Vite fingerprints its assets, so they are safe to cache hard; index.html
    // must not be, or a deploy never reaches anyone.
    'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
  })
  createReadStream(full).pipe(res)
  return true
}

// Channels that are about the SESSION rather than the data, and so have to be
// reflected in the cookie's session after the handler has had its say. The
// handler still runs and still returns its own shape, so the renderer is none
// the wiser.
function applySessionEffect(channel: string, args: Row, result: unknown, s: Session): void {
  if (channel === 'auth:login') {
    const u = (result || {}) as Row
    if (u && u.id) {
      s.userId = Number(u.id)
      s.username = String(u.username || '')
    }
    return
  }
  if (channel === 'session:setUser') {
    s.userId = args?.id == null ? null : Number(args.id)
    s.username = String(args?.username || 'system')
    return
  }
  if (channel === 'company:setActive') {
    const id = Number(args?.id)
    if (Number.isFinite(id) && id > 0) s.companyId = id
  }
}

export interface ServerOptions {
  port: number
  webRoot: string
}

export function startHttpServer({ port, webRoot }: ServerOptions): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname

    if (path === '/api/health') {
      return json(res, 200, { ok: true, at: new Date().toISOString() })
    }

    if (path === '/api/invoke') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' })
      let payload: Row
      try {
        payload = JSON.parse((await readBody(req)) || '{}')
      } catch (e) {
        return json(res, 400, { error: (e as Error).message })
      }
      const channel = String(payload?.channel || '')
      const args = (payload?.args ?? {}) as Row
      const fn = handlers.get(channel)
      if (!fn) return json(res, 404, { error: `Unknown channel: ${channel}` })

      // The session, and a cookie for it if this caller has none yet.
      sweepSessions()
      let sid = readCookie(req, 'sid')
      let cookie: string | undefined
      if (!sid || !sessions.has(sid)) {
        sid = randomBytes(24).toString('hex')
        sessions.set(sid, { userId: null, username: 'system', companyId: 1, seen: Date.now() })
        // HttpOnly so no script can read it; SameSite=Lax so it survives a
        // normal navigation but not a cross-site form post.
        cookie = `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
      }
      const s = sessions.get(sid)!
      s.seen = Date.now()

      const ctx: RequestContext = {
        userId: s.userId,
        username: s.username,
        companyId: s.companyId,
        ip: clientIp(req)
      }
      try {
        const result = await runInRequestContext(ctx, () => Promise.resolve(fn({}, args)))
        // A handler may have changed who is asking (login) or whose books
        // (company switch); carry that into the session, and keep whatever the
        // handler itself did to the context.
        s.userId = ctx.userId
        s.username = ctx.username
        s.companyId = ctx.companyId
        applySessionEffect(channel, args, result, s)
        return json(res, 200, { ok: true, result: result ?? null }, cookie)
      } catch (e) {
        // The renderer shows `message` on a rejected invoke, so the shape of a
        // failure has to survive the trip: same text, same meaning.
        return json(res, 200, { ok: false, error: (e as Error).message || 'Request failed' }, cookie)
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'Method not allowed' })
    }

    // A built file, else index.html — the app is a single-page router, so every
    // unknown path is one of its own routes rather than a miss.
    if (serveStatic(res, webRoot, path === '/' ? 'index.html' : path)) return
    if (serveStatic(res, webRoot, 'index.html')) return
    return json(res, 404, { error: 'Not built yet — run npm run web:build' })
  })

  server.listen(port, () => {
    console.log(`[web] listening on http://localhost:${port}`)
    console.log(`[web] serving ${webRoot}`)
    console.log(`[web] ${handlers.size} channels registered`)
  })
}
