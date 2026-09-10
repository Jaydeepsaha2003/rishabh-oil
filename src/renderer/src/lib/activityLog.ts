// Reading the activity log.
// -----------------------------------------------------------------------------
// Two things the raw rows cannot be shown without.
//
// THE CLOCK. user_logs.created_at is written by SQLite's datetime('now'), which
// is UTC. Printed straight it puts every entry five and a half hours early —
// the 13:24 sale reads 07:54. Same trap as the gate times, the diary and the
// production report's day column; this is the fourth place it has appeared, so
// the conversion lives in one function here rather than at each call site.
//
// THE VERB. `action` is free text and the app writes forty-seven different
// values into it — Created, Updated, weights, adjust, Advanced, setInvoiceStage,
// Marked payment received, kpis. A reader wants four questions answered (what
// was added, changed, removed, moved on) so the verbs are bucketed, and
// anything unrecognised lands in `other` rather than being dropped.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export type Bucket = 'create' | 'edit' | 'delete' | 'status' | 'login' | 'other'

// A stored timestamp as a real Date. The 'Z' is the whole point: without it the
// string is read as local and the correction never happens.
export function logDate(raw: unknown): Date | null {
  const s = String(raw || '').trim()
  if (!s) return null
  const d = new Date(`${s.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

const p2 = (x: number): string => String(x).padStart(2, '0')

// Local wall clock, which is what the desk was looking at when it happened.
export const logTime = (raw: unknown): string => {
  const d = logDate(raw)
  return d ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : ''
}
export const logDay = (raw: unknown): string => {
  const d = logDate(raw)
  return d ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : ''
}
export const logDayLabel = (iso: string): string => {
  const [y, m, d] = iso.split('-')
  return y ? `${d}-${m}-${y}` : ''
}

// "4 min ago", "yesterday". Rounded, because the exact interval is already in
// the column beside it and nobody reads a log to the second.
export function ago(raw: unknown, now = Date.now()): string {
  const d = logDate(raw)
  if (!d) return ''
  const mins = Math.floor((now - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? 'last month' : `${months} months ago`
}

// The verb, bucketed. Ordered so the narrower tests run before the broad ones —
// "Removed a repayment" is a delete, not an edit, and "deleteInvoice" must not
// be caught by the /invoice/ in the create rule.
const RULES: [RegExp, Bucket][] = [
  [/^login$|^logout$/i, 'login'],
  [/delet|remov|cancel|^unraise|revoke|discard/i, 'delete'],
  [
    /advanc|stage|^reject|^unreject|approv|preclos|^revert$|^marked |^markread$|^markreceived$|^cancelled|waive|^undid |^repaid$|^skipweighment$|^nil$/i,
    'status'
  ],
  [/^creat|^raise|^saved$|^new /i, 'create'],
  [/^updat|adjust|^weights$|^changed |^savequality$|^saveq|^setparties$|^savelimit$|^repayments$|^set/i, 'edit'],
  // Reads and report pulls. Not nothing — a database snapshot being downloaded
  // is worth a line — but not a change to anything either.
  [/^kpis$|^registers$|^history$|^active$|^weights$|^download/i, 'other']
]

export function bucketOf(action: unknown): Bucket {
  const a = String(action || '').trim()
  if (!a) return 'other'
  for (const [re, b] of RULES) if (re.test(a)) return b
  return 'other'
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  create: 'Created',
  edit: 'Edited',
  delete: 'Deleted',
  status: 'Stage',
  login: 'Sign-in',
  other: 'Other'
}

// What a row says it did to what. `detail` is often the document number and
// sometimes null, so the entity stands in rather than leaving the cell blank.
export function logDetail(r: Row): string {
  const detail = String(r.detail ?? '').trim()
  const key = String(r.entity_key ?? '').trim()
  const id = r.entity_id == null ? '' : String(r.entity_id)
  if (detail) return detail
  if (id) return `${String(r.entity || 'record')} #${id}`
  if (key) return key
  return String(r.action || '')
}
