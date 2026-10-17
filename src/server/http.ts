import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { handlers } from './electron-shim'
import { runInRequestContext, type RequestContext } from '../main/requestContext'
import { getClient } from '../main/db'
import { logEvent } from '../main/access'
import { dbStatus, liveDbFile, restoreFromDump } from './dbrestore'

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
  // When this signed-in session was last written to web_sessions.
  savedAt?: number
}

// WHO IS ASKING, AND HOW THE SERVER KNOWS.
//
// A session is a random id in an HttpOnly cookie. It used to live in memory
// only, so a restart (every deploy) signed everyone out — and to paper over
// that, every page sent an x-user-id header and the server took the user from
// it. That made the header the login: anyone could send any id, an admin's
// included, and be that person. Worse, a caller with no session at all was
// handed an anonymous one and every channel ran for it.
//
// Now: a SIGNED-IN session is kept in web_sessions as well as in memory, so a
// restart forgets nothing and nobody is asked who they are by a header. Only a
// hash of the id is stored — the table can be read by an administrator (the
// database download) and must not hand them working cookies. And nothing but
// signing in runs without a signed-in session: see PUBLIC below.
const sessions = new Map<string, Session>()
// How long a session may sit idle. A page open on a desk beats every thirty
// seconds, so this is what an abandoned login gets, not a working one.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
// How often a live session refreshes its row (and its cookie).
const SESSION_SAVE_MS = 30 * 60 * 1000

// The only channels that answer someone who is not signed in: signing in,
// and the two the page asks before it knows who you are (is the database up,
// what revision is it at). Everything else is refused, whatever it is.
const PUBLIC = new Set(['auth:login', 'db:ping', 'app:revision'])

const hashSid = (sid: string): string => createHash('sha256').update(sid).digest('hex')
const sessionCookie = (sid: string): string =>
  `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
const CLEAR_COOKIE = 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'

// Created on first use rather than in a migration: it belongs to the website
// alone (the desktop has no sessions), and a database restore drops it with
// everything else, so every write makes sure it is there.
async function ensureSessionTable(): Promise<void> {
  await getClient().execute(
    `CREATE TABLE IF NOT EXISTS web_sessions (
       sid_hash TEXT PRIMARY KEY,
       user_id INTEGER NOT NULL,
       username TEXT,
       company_id INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       seen_at INTEGER NOT NULL
     )`
  )
}

async function saveSession(sid: string, s: Session): Promise<void> {
  try {
    await ensureSessionTable()
    if (!s.userId) {
      await getClient().execute({ sql: 'DELETE FROM web_sessions WHERE sid_hash = ?', args: [hashSid(sid)] })
      return
    }
    const now = Date.now()
    await getClient().execute({
      sql: `INSERT INTO web_sessions (sid_hash, user_id, username, company_id, seen_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(sid_hash) DO UPDATE SET user_id = excluded.user_id, username = excluded.username,
              company_id = excluded.company_id, seen_at = excluded.seen_at`,
      args: [hashSid(sid), s.userId, s.username, s.companyId, now]
    })
    s.savedAt = now
  } catch (e) {
    // The session still works from memory; it just will not survive a restart.
    console.error('[web] could not save a session:', (e as Error).message)
  }
}

async function dropSession(sid: string): Promise<void> {
  sessions.delete(sid)
  try {
    await ensureSessionTable()
    await getClient().execute({ sql: 'DELETE FROM web_sessions WHERE sid_hash = ?', args: [hashSid(sid)] })
  } catch {
    // Already gone, or the table is — either way it is not a session any more.
  }
}

// A session this process has not seen — it restarted since — read back from
// the table, and only for an account that still exists and is still active.
async function loadSession(sid: string): Promise<Session | null> {
  try {
    await ensureSessionTable()
    const r = await getClient().execute({
      sql: `SELECT ws.user_id, ws.company_id, ws.seen_at, u.username
              FROM web_sessions ws
              JOIN users u ON u.id = ws.user_id AND COALESCE(u.active, 1) = 1
             WHERE ws.sid_hash = ?`,
      args: [hashSid(sid)]
    })
    const row = r.rows[0]
    if (!row) return null
    if (Date.now() - Number(row.seen_at) > SESSION_TTL_MS) {
      await dropSession(sid)
      return null
    }
    return {
      userId: Number(row.user_id),
      username: String(row.username || ''),
      companyId: Number(row.company_id) || 1,
      seen: Date.now(),
      savedAt: Number(row.seen_at)
    }
  } catch {
    return null
  }
}

let lastTableSweep = 0
function sweepSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [k, v] of sessions) if (v.seen < cutoff) sessions.delete(k)
  // The table too, at most hourly.
  if (Date.now() - lastTableSweep > 60 * 60 * 1000) {
    lastTableSweep = Date.now()
    void ensureSessionTable()
      .then(() => getClient().execute({ sql: 'DELETE FROM web_sessions WHERE seen_at < ?', args: [cutoff] }))
      .catch(() => {})
  }
}

// The session a request belongs to — from memory, else from the table — or a
// fresh anonymous one when `create` says to make one. A signed-in session that
// is in use refreshes its row and its cookie every half hour, so a login that
// is being used never runs out.
async function resolveSession(
  req: IncomingMessage,
  create: boolean
): Promise<{ sid: string; s: Session; cookie?: string } | null> {
  sweepSessions()
  let sid = readCookie(req, 'sid')
  let s = sid ? sessions.get(sid) : undefined
  if (!s && sid) {
    const loaded = await loadSession(sid)
    if (loaded) {
      sessions.set(sid, loaded)
      s = loaded
    }
  }
  let cookie: string | undefined
  if (!s) {
    if (!create) return null
    sid = randomBytes(24).toString('hex')
    s = { userId: null, username: 'system', companyId: 1, seen: Date.now() }
    sessions.set(sid, s)
    // HttpOnly so no script can read it; SameSite=Lax so it survives a normal
    // navigation but not a cross-site form post.
    cookie = sessionCookie(sid)
  }
  s.seen = Date.now()
  if (s.userId && Date.now() - (s.savedAt || 0) > SESSION_SAVE_MS) {
    await saveSession(sid, s)
    cookie = cookie || sessionCookie(sid)
  }
  return { sid, s, cookie }
}

// The answer to anyone who is not (or no longer) signed in. 401 with a code,
// so the page can tell "sign in again" from an ordinary refusal and go back
// to the sign-in screen rather than showing it as a toast.
function signedOut(res: ServerResponse, cookie?: string): void {
  json(res, 401, { ok: false, code: 'signed_out', error: 'You are signed out — please sign in again.' }, cookie)
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

// The same, for bytes. A database snapshot is not text and must not be
// decoded on its way in — and it is far larger than anything else posted here,
// so it gets its own ceiling rather than raising the one every other endpoint
// is protected by.
function readBinary(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error(`That file is larger than the ${Math.round(limit / 1048576)} MB limit`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
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
    // must not be, or a deploy never reaches anyone. `no-store`, not
    // `no-cache`: no-cache still lets a browser (or anything between it and
    // here) keep a copy and decide for itself when to ask again, and after a
    // deploy the plain Reload kept landing on the old page — only
    // Ctrl+Shift+R got through. A page shell that is never stored cannot be
    // served stale. It is a couple of kilobytes; fetching it every time costs
    // nothing next to the hashed bundle it points at, which stays cached.
    // (Either slash: normalize() gives backslashes on Windows.)
    ...(/^assets[\\/]/.test(rel)
      ? { 'cache-control': 'public, max-age=31536000, immutable' }
      : { 'cache-control': 'no-store, no-cache, must-revalidate, max-age=0', pragma: 'no-cache', expires: '0' })
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

// The signed-in session for a request, or null. Unlike the /api/invoke path
// this never CREATES one: the database endpoints are for an administrator who
// is already signed in, and a caller with no session is turned away rather
// than handed a fresh anonymous one.
async function currentSession(req: IncomingMessage): Promise<Session | null> {
  const got = await resolveSession(req, false)
  return got && got.s.userId ? got.s : null
}

// Admin is read from the database rather than trusted from the session,
// because a role can be changed (or a user deleted) while a session is still
// open, and these two endpoints are the ones where that matters most.
async function isAdmin(s: Session | null): Promise<boolean> {
  if (!s || !s.userId) return false
  try {
    const r = await getClient().execute({
      sql: 'SELECT role FROM users WHERE id = ? AND active = 1',
      args: [s.userId]
    })
    return String(r.rows[0]?.role || '') === 'admin'
  } catch {
    return false
  }
}

// Uploads are capped well above any plausible snapshot: the whole database
// gzips to a few megabytes today, and a limit that has to be raised the first
// time the mill has a busy year is not a limit worth having.
const RESTORE_LIMIT = 256 * 1024 * 1024

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

    // The mill's own logo, uploaded under Settings and stored as a data URL in
    // app_settings. It backs the favicon, the apple-touch icon and the PWA
    // manifest's icons, so an installed app carries the mill's mark rather
    // than a generic one. Unset (or unreadable) falls through to the bundled
    // default so the manifest never points at a 404.
    if (path === '/brand-icon') {
      try {
        const fn = handlers.get('settings:get')
        // No session: the icon is fetched by the browser (favicon, manifest)
        // before anyone signs in, and a logo is not private.
        const ctx: RequestContext = { userId: null, username: '', companyId: 0, ip: clientIp(req) }
        const raw = fn ? await runInRequestContext(ctx, () => Promise.resolve(fn({}, { key: 'brand_logo' }))) : null
        const url = String(raw || '')
        const m = /^data:([^;,]+);base64,(.+)$/i.exec(url)
        if (m) {
          const body = Buffer.from(m[2], 'base64')
          res.writeHead(200, {
            'content-type': m[1],
            'content-length': body.length,
            // Short: a logo changes rarely, but when it does the installed
            // app should pick it up without waiting a day.
            'cache-control': 'public, max-age=300'
          })
          return res.end(body)
        }
      } catch {
        // fall through to the bundled default
      }
      if (serveStatic(res, webRoot, 'brand-default.png')) return
      return json(res, 404, { error: 'No brand icon set' })
    }

    // ---- the database itself -------------------------------------------
    //
    // Three endpoints rather than three channels on /api/invoke, because what
    // travels here is a file: JSON would have to base64 it on the way in and
    // out, and buffer the whole thing twice to do so. Admin only, every one.

    // What is in the database now, and what can be rolled back to.
    if (path === '/api/db/info') {
      const s = await currentSession(req)
      if (!(await isAdmin(s))) return json(res, 403, { error: 'Administrators only' })
      try {
        return json(res, 200, { ok: true, result: await dbStatus() })
      } catch (e) {
        return json(res, 200, { ok: false, error: (e as Error).message })
      }
    }

    // A snapshot of whatever database this build is pointed at — Turso on the
    // desktop, the local file here. Streamed as a real download so the browser
    // saves it to disk rather than the page holding it in memory.
    if (path === '/api/db/snapshot') {
      const s = await currentSession(req)
      if (!(await isAdmin(s))) return json(res, 403, { error: 'Administrators only' })
      try {
        // Dispatched through the db:snapshot CHANNEL rather than calling the
        // snapshot maker directly, so the website's download goes through the
        // same admin check and lands in the same audit trail as the desktop
        // app's. Handing someone the entire database is worth a line in the
        // log wherever it is done from.
        const fn = handlers.get('db:snapshot')
        if (!fn) throw new Error('This build has no snapshot channel')
        const ctx: RequestContext = {
          userId: s!.userId,
          username: s!.username,
          companyId: s!.companyId,
          ip: clientIp(req)
        }
        const snap = (await runInRequestContext(ctx, () =>
          Promise.resolve(fn({}, {}))
        )) as { gz: string; fileName: string }
        const body = Buffer.from(snap.gz, 'base64')
        res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-length': body.length,
          'content-disposition': `attachment; filename="${snap.fileName}"`,
          'cache-control': 'no-store'
        })
        return res.end(body)
      } catch (e) {
        return json(res, 200, { ok: false, error: (e as Error).message })
      }
    }

    // THE SAME DATABASE, BUT AS A DATABASE.
    //
    // The route above hands back SQL to restore FROM. This one hands back the
    // file itself, to open and read — which is what is wanted when a figure on
    // screen is being argued with and nobody can see the rows behind it.
    //
    // Same admin gate and the same line in the audit trail: the two downloads
    // differ in format, not in what they give away.
    if (path === '/api/db/file') {
      const s2 = await currentSession(req)
      if (!(await isAdmin(s2))) return json(res, 403, { error: 'Administrators only' })
      try {
        const file = await liveDbFile()
        await logEvent(
          s2!.userId,
          s2!.username,
          clientIp(req),
          'Downloaded the database file',
          `${(file.bytes.length / 1048576).toFixed(2)} MB · ${file.fileName}`,
          s2!.companyId,
          'Database',
          null,
          null
        ).catch(() => {
          // The copy is made; failing to note it must not fail the download.
        })
        console.log(`[web] database file downloaded by ${s2!.username}: ${file.fileName}`)
        res.writeHead(200, {
          'content-type': 'application/vnd.sqlite3',
          'content-length': file.bytes.length,
          'content-disposition': `attachment; filename="${file.fileName}"`,
          'cache-control': 'no-store'
        })
        return res.end(file.bytes)
      } catch (e) {
        return json(res, 200, { ok: false, error: (e as Error).message })
      }
    }

    // Replace it. The body is the snapshot file, posted raw.
    if (path === '/api/db/restore') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' })
      const s = await currentSession(req)
      if (!(await isAdmin(s))) return json(res, 403, { error: 'Administrators only' })
      try {
        const buf = await readBinary(req, RESTORE_LIMIT)
        if (!buf.length) return json(res, 200, { ok: false, error: 'No file was uploaded' })
        const report = await restoreFromDump(buf)
        // Logged AFTER the swap, on purpose: the audit trail is one of the
        // tables the snapshot replaces, so an entry written beforehand would
        // be overwritten by the restore it was recording.
        await logEvent(
          s!.userId,
          s!.username,
          clientIp(req),
          'Restored the database',
          `${report.rows.toLocaleString()} rows across ${report.tables} tables · previous copy kept as ${report.replacedBackup}`,
          s!.companyId,
          'Database',
          null,
          null
        ).catch(() => {
          // A restore that worked must not be reported as failed because the
          // note about it could not be written.
        })
        console.log(
          `[web] database restored by ${s!.username}: ${report.rows} rows, ${report.tables} tables, ${report.tookMs} ms`
        )
        return json(res, 200, { ok: true, result: report })
      } catch (e) {
        console.error('[web] restore failed:', e)
        return json(res, 200, { ok: false, error: (e as Error).message || 'Restore failed' })
      }
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
      let args = (payload?.args ?? {}) as Row
      const fn = handlers.get(channel)
      if (!fn) return json(res, 404, { error: `Unknown channel: ${channel}` })

      // The session, and a cookie for it if this caller has none yet.
      const got = (await resolveSession(req, true))!
      let { sid } = got
      const { s } = got
      let cookie = got.cookie

      // session:setUser is how the page says who it is. It may sign the session
      // OUT, or restate the user it already has — never name somebody else.
      // Naming somebody else is what made it a way in.
      if (channel === 'session:setUser') {
        const want = Number(args?.id) || 0
        if (!want) {
          await dropSession(sid)
          return json(res, 200, { ok: true, result: { ok: true } }, CLEAR_COOKIE)
        }
        if (want !== s.userId) return signedOut(res, cookie)
      }
      if (!s.userId && !PUBLIC.has(channel)) return signedOut(res, cookie)
      // The heartbeat marks a USER live; that user is the session's, not
      // whichever id the page put in the call.
      if (channel === 'access:heartbeat') args = { ...args, userId: s.userId, username: s.username }

      const before = { userId: s.userId, companyId: s.companyId }
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
        // A sign-in gets a NEW session id, so an id handed out before it (or
        // planted in the browser by someone else) does not become a login.
        if (channel === 'auth:login' && s.userId) {
          sessions.delete(sid)
          sid = randomBytes(24).toString('hex')
          sessions.set(sid, s)
          cookie = sessionCookie(sid)
          await saveSession(sid, s)
        } else if (s.userId !== before.userId || s.companyId !== before.companyId) {
          await saveSession(sid, s)
        }
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
