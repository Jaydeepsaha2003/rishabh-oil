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

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
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
