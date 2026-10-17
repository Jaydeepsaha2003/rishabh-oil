// Web Push — a notification that arrives with the app CLOSED.
// -----------------------------------------------------------------------------
// The bell already showed a notification when one appeared: the page polls, and
// a new row raises `showNotification` on the spot. That works, and it only
// works while the app is open. On a phone the app is almost never open — the
// screen is off, or WhatsApp is in front — so the mill was being told nothing
// until somebody happened to look, which is the opposite of what a notification
// is for.
//
// This is the real thing: the browser hands the site a SUBSCRIPTION (an
// endpoint at Google's or Apple's push service plus two keys), the server posts
// an encrypted payload to that endpoint, and the phone's own push service wakes
// the service worker and draws the banner. No app running, no tab open.
//
// WRITTEN AGAINST THE RFCs RATHER THAN A LIBRARY, on purpose. The whole of it
// is VAPID (RFC 8292) and aes128gcm (RFC 8188/8291), both of which node's own
// crypto already carries. A dependency here would have to be installed on the
// host as well, and the deploy installs exactly two packages today — a third
// that silently fails to install is a server that will not boot.
import { createECDH, createHash, createSign, generateKeyPairSync, hkdfSync, randomBytes, createCipheriv } from 'node:crypto'
import { getClient } from './db'
import { getSetting, setSetting } from './repos'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const b64url = (b: Buffer): string => b.toString('base64url')
const unb64url = (s: string): Buffer => Buffer.from(String(s || ''), 'base64url')

// ---------------------------------------------------------------- the keys --
// ONE KEYPAIR FOR THE LIFE OF THE SITE.
//
// The public half is baked into every subscription a browser makes, so changing
// it silently invalidates every phone already subscribed. Generated once and
// kept in app_settings, which is the same database the subscriptions live in —
// they cannot drift apart.
const PUB_KEY = 'push.vapid_public'
const PRIV_KEY = 'push.vapid_private'
const SUBJECT_KEY = 'push.vapid_subject'

export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string; subject: string }> {
  let pub = String((await getSetting(PUB_KEY)) || '')
  let priv = String((await getSetting(PRIV_KEY)) || '')
  if (!pub || !priv) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    // The raw uncompressed point (65 bytes, 0x04 || X || Y) is what a browser
    // wants as applicationServerKey; the private half stays PEM so node can
    // sign with it directly.
    const der = publicKey.export({ type: 'spki', format: 'der' })
    pub = b64url(der.subarray(der.length - 65))
    priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    await setSetting(PUB_KEY, pub)
    await setSetting(PRIV_KEY, priv)
  }
  const subject = String((await getSetting(SUBJECT_KEY)) || '') || 'mailto:admin@rrbridge.in'
  return { publicKey: pub, privateKey: priv, subject }
}

// ------------------------------------------------------------------ VAPID --
// Proof to the push service that this server is who it says it is: a JWT signed
// with the private half of the key the subscription was made against.
function vapidToken(audience: string, privatePem: string, subject: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        // Twelve hours. The spec caps it at 24; a shorter life costs nothing
        // because a token is made per send.
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: subject
      })
    )
  )
  const signer = createSign('SHA256')
  signer.update(`${header}.${claims}`)
  // ieee-p1363 is the raw r||s pair JOSE wants. The default is DER, which every
  // push service rejects.
  const sig = signer.sign({ key: privatePem, dsaEncoding: 'ieee-p1363' })
  return `${header}.${claims}.${b64url(sig)}`
}

// ------------------------------------------------------------- encryption --
/**
 * One aes128gcm record, per RFC 8291.
 *
 * `salt` and `ephemeral` are injectable so the RFC's own test vector can be
 * reproduced exactly; nothing but a test ever passes them.
 */
export function encryptPayload(
  payload: string,
  p256dh: string,
  auth: string,
  opts: { salt?: Buffer; ephemeralPrivate?: Buffer } = {}
): Buffer {
  const uaPublic = unb64url(p256dh)
  const authSecret = unb64url(auth)
  const salt = opts.salt || randomBytes(16)

  const ecdh = createECDH('prime256v1')
  if (opts.ephemeralPrivate) ecdh.setPrivateKey(opts.ephemeralPrivate)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)

  // The key-derivation key: the shared secret, salted with the subscription's
  // own auth secret and bound to BOTH public keys so a record cannot be
  // replayed against a different subscriber.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const prk = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32))

  const cek = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12))

  // 0x02 is the "last record" delimiter. One record is all this ever sends.
  const plaintext = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])])
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header.writeUInt8(asPublic.length, 20)
  return Buffer.concat([header, asPublic, body])
}

// ------------------------------------------------------ the subscriptions --
export async function saveSubscription(sub: Row, userId: number, ua?: string): Promise<{ ok: true }> {
  const endpoint = String(sub?.endpoint || '').trim()
  const p256dh = String(sub?.keys?.p256dh || '').trim()
  const auth = String(sub?.keys?.auth || '').trim()
  if (!endpoint || !p256dh || !auth) throw new Error('That subscription is missing its endpoint or its keys')
  await getClient().execute({
    sql: `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at, last_ok_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'), NULL)
          ON CONFLICT(endpoint) DO UPDATE SET
            user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
            user_agent = excluded.user_agent, failed_at = NULL`,
    args: [Number(userId) || 0, endpoint, p256dh, auth, String(ua || '').slice(0, 300) || null]
  })
  return { ok: true }
}

export async function dropSubscription(endpoint: string): Promise<{ ok: true }> {
  await getClient().execute({
    sql: 'DELETE FROM push_subscriptions WHERE endpoint = ?',
    args: [String(endpoint || '')]
  })
  return { ok: true }
}

export async function subscriptionsFor(userIds: number[] | 'all'): Promise<Row[]> {
  const c = getClient()
  if (userIds === 'all') {
    const r = await c.execute('SELECT * FROM push_subscriptions')
    return r.rows.map((x) => ({ ...(x as unknown as Row) }))
  }
  const ids = userIds.map((x) => Number(x) || 0).filter(Boolean)
  if (!ids.length) return []
  const r = await c.execute({
    sql: `SELECT * FROM push_subscriptions WHERE user_id IN (${ids.map(() => '?').join(',')})`,
    args: ids as never[]
  })
  return r.rows.map((x) => ({ ...(x as unknown as Row) }))
}

// ------------------------------------------------------------- the sending --
/**
 * One push, to one device.
 *
 * A 404 or 410 is the push service saying that subscription is dead — the app
 * was uninstalled, the browser data cleared. It is deleted rather than retried,
 * or the table fills with endpoints nothing will ever answer.
 */
export async function sendOne(sub: Row, payload: Row): Promise<'sent' | 'gone' | 'failed'> {
  try {
    const { privateKey, subject } = await vapidKeys()
    const endpoint = String(sub.endpoint || '')
    const audience = new URL(endpoint).origin
    const body = encryptPayload(JSON.stringify(payload), String(sub.p256dh), String(sub.auth))
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        TTL: '86400',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: `vapid t=${vapidToken(audience, privateKey, subject)}, k=${(await vapidKeys()).publicKey}`
      },
      // A Buffer is a Uint8Array; the DOM's BodyInit type does not know that
      // about node's own class, so it is handed over as the view it already is.
      body: new Uint8Array(body)
    })
    if (res.status === 404 || res.status === 410) {
      await dropSubscription(endpoint)
      return 'gone'
    }
    if (!res.ok) {
      console.error('[push] endpoint refused:', res.status, (await res.text()).slice(0, 200))
      await getClient()
        .execute({ sql: "UPDATE push_subscriptions SET failed_at = datetime('now') WHERE endpoint = ?", args: [endpoint] })
        .catch(() => {})
      return 'failed'
    }
    await getClient()
      .execute({ sql: "UPDATE push_subscriptions SET last_ok_at = datetime('now'), failed_at = NULL WHERE endpoint = ?", args: [endpoint] })
      .catch(() => {})
    return 'sent'
  } catch (e) {
    console.error('[push] send failed:', (e as Error).message)
    return 'failed'
  }
}

/** Push to a set of logins — or to every device the site knows about. */
export async function pushTo(
  userIds: number[] | 'all',
  payload: { title: string; body: string; page?: string; tag?: string }
): Promise<{ sent: number; gone: number; failed: number; devices: number }> {
  const subs = await subscriptionsFor(userIds)
  const out = { sent: 0, gone: 0, failed: 0, devices: subs.length }
  for (const sub of subs) {
    const r = await sendOne(sub, {
      title: String(payload.title || 'Rishabh Oil'),
      body: String(payload.body || ''),
      page: String(payload.page || ''),
      tag: String(payload.tag || `rishabhoil-${Date.now()}`)
    })
    out[r === 'sent' ? 'sent' : r === 'gone' ? 'gone' : 'failed'] += 1
  }
  return out
}

/** A digest of what is subscribed, for the Notifications screen. */
export async function pushStatus(): Promise<Row> {
  const c = getClient()
  const r = await c.execute(
    `SELECT COUNT(*) AS devices, COUNT(DISTINCT user_id) AS people,
            SUM(CASE WHEN failed_at IS NOT NULL THEN 1 ELSE 0 END) AS failing
       FROM push_subscriptions`
  )
  const row = (r.rows[0] || {}) as unknown as Row
  return {
    devices: Number(row.devices) || 0,
    people: Number(row.people) || 0,
    failing: Number(row.failing) || 0,
    public_key: (await vapidKeys()).publicKey
  }
}

// Kept for the test harness: the digest of a payload, so a caller can prove two
// encryptions of the same text differ (they must — the salt is per record).
export const _digest = (b: Buffer): string => createHash('sha256').update(b).digest('hex').slice(0, 16)

// ------------------------------------------------------------ the watcher --
// EVERY NOTIFICATION, WITHOUT TOUCHING EVERY CALLER.
//
// Rows land in `notifications` from a dozen places — the rules engine, a
// send-back on the work board, an approval. Hooking each one would mean a
// dozen chances to forget. So this watches the table instead: anything newer
// than the last id it pushed gets pushed, once, to whoever the row is
// addressed to.
//
// The marker starts at the CURRENT maximum, not at zero. A site switching this
// on should not fire two months of history at everybody's phone.
const LAST_KEY = 'push.last_id'
let pushWatcher: ReturnType<typeof setInterval> | null = null

async function recipientsOfRow(row: Row): Promise<number[]> {
  const c = getClient()
  const audience = String(row.audience || 'admins')
  const muteFilter = async (ids: number[]): Promise<number[]> => {
    if (!ids.length) return ids
    const r = await c.execute({
      sql: `SELECT user_id FROM notification_mutes WHERE rule_key = ? AND user_id IN (${ids.map(() => '?').join(',')})`,
      args: [String(row.rule_key || ''), ...ids] as never[]
    })
    const muted = new Set(r.rows.map((x) => Number((x as unknown as Row).user_id)))
    return ids.filter((id) => !muted.has(id))
  }
  if (audience === 'named') {
    let ids: number[] = []
    try {
      const parsed = JSON.parse(String(row.recipients || '[]'))
      if (Array.isArray(parsed)) ids = parsed.map((x) => Number(x) || 0).filter(Boolean)
    } catch {
      ids = []
    }
    return muteFilter(ids)
  }
  const r = await c.execute(
    audience === 'admins'
      ? "SELECT id FROM users WHERE active = 1 AND role = 'admin'"
      : 'SELECT id FROM users WHERE active = 1'
  )
  return muteFilter(r.rows.map((x) => Number((x as unknown as Row).id)).filter(Boolean))
}

export async function pushPendingNotifications(): Promise<{ rows: number; sent: number }> {
  const c = getClient()
  const marker = Number((await getSetting(LAST_KEY)) || 0)
  if (!marker) {
    const m = await c.execute('SELECT COALESCE(MAX(id), 0) AS m FROM notifications')
    await setSetting(LAST_KEY, String(Number((m.rows[0] as unknown as Row)?.m) || 0))
    return { rows: 0, sent: 0 }
  }
  const res = await c.execute({
    sql: `SELECT id, rule_key, severity, audience, recipients, title, body, page
            FROM notifications
           WHERE id > ? AND resolved_at IS NULL
           ORDER BY id
           LIMIT 40`,
    args: [marker]
  })
  const rows = res.rows.map((x) => ({ ...(x as unknown as Row) }))
  let sent = 0
  let last = marker
  for (const row of rows) {
    last = Math.max(last, Number(row.id) || 0)
    const ids = await recipientsOfRow(row)
    if (!ids.length) continue
    const out = await pushTo(ids, {
      title: String(row.title || 'Rishabh Oil'),
      body: String(row.body || ''),
      page: String(row.page || ''),
      tag: `rishabhoil-${Number(row.id)}`
    })
    sent += out.sent
  }
  if (last !== marker) await setSetting(LAST_KEY, String(last))
  return { rows: rows.length, sent }
}

export function startPushWatcher(intervalMs = 20000): void {
  if (pushWatcher) return
  const tick = (): void => {
    pushPendingNotifications().catch((e) => console.error('[push] watcher failed:', (e as Error).message))
  }
  setTimeout(tick, 6000)
  pushWatcher = setInterval(tick, Math.max(5000, intervalMs))
  if (typeof pushWatcher.unref === 'function') pushWatcher.unref()
}
