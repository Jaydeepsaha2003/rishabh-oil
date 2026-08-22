const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2
})

const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 })

export function formatINR(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  return inr.format(value)
}

export function formatNum(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  return num.format(value)
}

// App-wide date format: dd-mm-yyyy. Handles plain 'YYYY-MM-DD' strings directly
// (no timezone shift) and full datetimes by taking their date part.
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const s = String(value)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`
}

// Compact dd/mm/yy, for a dense column that shows two dates stacked in one
// cell (an LC's open + maturity, say) where the full dd-mm-yyyy is wider than
// the column needs. Same no-timezone-shift handling as formatDate.
export function formatDateShort(value: string | null | undefined): string {
  if (!value) return '—'
  const s = String(value)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[3]}/${m[2]}/${m[1].slice(-2)}`
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(-2)}`
}

// dd-mm-yy hh:mm (local time). SQLite datetime('now') is stored as UTC
// 'YYYY-MM-DD HH:MM:SS' — treated as UTC and converted to local for display.
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  let s = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T') + 'Z'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return String(value)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yy = String(d.getFullYear()).slice(-2)
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${dd}-${mm}-${yy} ${hh}:${mi}`
}

// The LOCAL calendar day — never `.toISOString()`, which renders in UTC. For
// any timezone ahead of UTC (IST is UTC+5:30), the stretch between local
// midnight and UTC midnight would read back as YESTERDAY in every date field
// that defaults to "today".
export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Convert a quantity between units of the SAME dimension (mass or volume).
// Mismatched dimensions (e.g. L → MT, needs density) are returned unchanged.
const UNIT_FACTOR: Record<string, { dim: 'mass' | 'vol'; f: number }> = {
  KG: { dim: 'mass', f: 1 },
  QUINTAL: { dim: 'mass', f: 100 },
  MT: { dim: 'mass', f: 1000 },
  TON: { dim: 'mass', f: 1000 },
  ML: { dim: 'vol', f: 0.001 },
  L: { dim: 'vol', f: 1 },
  KL: { dim: 'vol', f: 1000 }
}
export function convertQty(qty: number, from: string, to: string): number {
  const a = UNIT_FACTOR[String(from || '').toUpperCase()]
  const b = UNIT_FACTOR[String(to || '').toUpperCase()]
  if (!a || !b || a.dim !== b.dim) return qty
  return (qty * a.f) / b.f
}

// Electron wraps IPC rejections as: Error invoking remote method 'x:y': Error: …
// Strip that plumbing so users see only the meaningful message.
export function errText(e: unknown): string {
  let m = e instanceof Error ? e.message : String(e)
  m = m.replace(/^Error invoking remote method '[^']*':\s*/i, '')
  m = m.replace(/^(?:Uncaught \(in promise\)\s*)?Error:\s*/i, '')
  return m.trim()
}
