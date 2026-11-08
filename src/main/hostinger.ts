import { getClient } from './db'
import { assertAdmin } from './access-gate'
import { getCurrentUser } from './currentUser'

// HOSTINGER: WHEN THE HOSTING PLAN (AND THE DOMAINS) RUN OUT.
//
// The API token is a secret for the whole hPanel account, so it lives in its
// own table, never in `settings` (which every screen reads), and it never
// leaves this process: the screen gets "set · ends …a1b2", and the calls to
// Hostinger are made from here. Only an administrator may set or remove it.
// Docs: https://developers.hostinger.com (billing/v1/subscriptions,
// domains/v1/portfolio; Authorization: Bearer <token>).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const API = 'https://developers.hostinger.com'
const KEY = 'hostinger_api_token'

async function ensureSecrets(): Promise<void> {
  await getClient().execute(`CREATE TABLE IF NOT EXISTS app_secrets (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT
  )`)
}

async function readToken(): Promise<string> {
  await ensureSecrets()
  const r = await getClient().execute({ sql: 'SELECT value FROM app_secrets WHERE key = ?', args: [KEY] })
  return String(r.rows[0]?.value || '')
}

export async function hostingerStatus(): Promise<{ configured: boolean; hint: string; updated_at: string | null; updated_by: string | null }> {
  await ensureSecrets()
  const r = await getClient().execute({ sql: 'SELECT value, updated_at, updated_by FROM app_secrets WHERE key = ?', args: [KEY] })
  const row = r.rows[0] as Row | undefined
  const v = String(row?.value || '')
  return { configured: !!v, hint: v ? `…${v.slice(-4)}` : '', updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null }
}

let cache: { at: number; data: Row } | null = null

export async function setHostingerToken(token: string | null): Promise<{ configured: boolean }> {
  await assertAdmin('Setting the Hostinger API key')
  await ensureSecrets()
  const t = String(token ?? '').trim()
  // Never removed, only replaced: without it the renewal reminder goes quiet,
  // and a lapsed plan deletes every record. A blank is refused here too.
  if (!t) throw new Error('The Hostinger API key cannot be removed — paste a new one to replace it')
  cache = null
  alertCache = null
  if (t.length < 20 || /\s/.test(t)) throw new Error('That does not look like a Hostinger API token — copy it again from hPanel → Profile → API')
  // Tried before it is kept, so a wrong key is said now, not on the next look.
  await callHostinger('/api/billing/v1/subscriptions', t)
  await getClient().execute({
    sql: `INSERT INTO app_secrets (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    args: [KEY, t, getCurrentUser().username || null]
  })
  return { configured: true }
}

async function callHostinger(path: string, token: string): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 15000)
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: ctl.signal
    })
    if (res.status === 401 || res.status === 403) throw new Error('Hostinger refused the API key — it may be wrong, expired or revoked. Set a new one.')
    if (res.status === 429) throw new Error('Hostinger says too many requests — try again in a minute')
    if (!res.ok) throw new Error(`Hostinger answered ${res.status} for ${path}`)
    return await res.json()
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('Hostinger did not answer within 15 seconds')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// A list endpoint may answer with a bare array or wrap it ({ data: [...] }).
const listOf = (x: unknown): Row[] => (Array.isArray(x) ? x : Array.isArray((x as Row)?.data) ? (x as Row).data : []) as Row[]

/** Every subscription's end or next charge, and every domain's expiry. Cached 10 minutes. */
export async function hostingerPlans(refresh = false): Promise<Row> {
  if (!refresh && cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.data
  const token = await readToken()
  if (!token) return { configured: false, subscriptions: [], domains: [] }
  const subsRaw = listOf(await callHostinger('/api/billing/v1/subscriptions', token))
  // Domains are a second, separate call; a failure there must not hide the plan.
  let domainsRaw: Row[] = []
  let domainsError: string | null = null
  try {
    domainsRaw = listOf(await callHostinger('/api/domains/v1/portfolio', token))
  } catch (e) {
    domainsError = (e as Error).message
  }
  const subscriptions = subsRaw.map((s) => {
    const auto = !!s.is_auto_renewed
    // Auto-renewing: the next charge is the date that matters. Not renewing (or
    // cancelled): expires_at is the day it stops.
    const date = auto ? s.next_billing_at || s.expires_at : s.expires_at || s.next_billing_at
    return {
      id: String(s.id ?? ''),
      name: String(s.name ?? 'Subscription'),
      status: String(s.status ?? ''),
      auto_renew: auto,
      date: date ? String(date) : null,
      date_kind: auto ? 'renews' : 'expires',
      renewal_price: s.renewal_price != null ? Number(s.renewal_price) / 100 : null,
      currency: String(s.currency_code ?? ''),
      billing_period: s.billing_period != null ? `${s.billing_period} ${String(s.billing_period_unit ?? '')}`.trim() : ''
    }
  })
  const domainsAll = domainsRaw.map((d) => ({
    domain: String(d.domain ?? d.name ?? ''),
    status: String(d.status ?? ''),
    date: d.expires_at ? String(d.expires_at) : null
  }))
  // The portfolio can list one domain twice (rrbridge.in, once with no date):
  // a dateless entry goes when the same domain has a dated one.
  const domains = domainsAll.filter((d) => d.date || !domainsAll.some((o) => o !== d && o.domain === d.domain && o.date))
  const data = { configured: true, fetched_at: new Date().toISOString(), subscriptions, domains, domains_error: domainsError }
  cache = { at: Date.now(), data }
  return data
}

// THE RENEWAL REMINDER every screen shows (HostingAlert): the soonest plan or
// domain date inside 30 days. Shared by every user and cached an hour, so a
// whole office opening the app is one call to Hostinger, not one each. Never
// throws — no key, or Hostinger down, simply means no reminder.
let alertCache: { at: number; data: Row | null } | null = null
export async function hostingerAlert(): Promise<Row | null> {
  if (alertCache && Date.now() - alertCache.at < 60 * 60 * 1000) return alertCache.data
  let data: Row | null = null
  try {
    const p = await hostingerPlans()
    const day = (iso: unknown): number | null => {
      const t = Date.parse(String(iso || ''))
      return Number.isFinite(t) ? Math.ceil((t - Date.now()) / 86400000) : null
    }
    const items: Row[] = [
      ...((p.subscriptions as Row[]) || [])
        .filter((s) => !['cancelled', 'transferred'].includes(String(s.status)))
        .map((s) => ({ kind: 'plan', name: String(s.name), date: s.date, days: day(s.date), auto_renew: !!s.auto_renew })),
      ...((p.domains as Row[]) || []).map((d) => ({ kind: 'domain', name: String(d.domain), date: d.date, days: day(d.date), auto_renew: false }))
    ].filter((x) => x.days != null && (x.days as number) <= 30)
    items.sort((a, b) => (a.days as number) - (b.days as number))
    data = items.length ? { days: items[0].days, items } : null
  } catch {
    data = null
  }
  alertCache = { at: Date.now(), data }
  return data
}
