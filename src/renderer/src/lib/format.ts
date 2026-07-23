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

// Electron wraps IPC rejections as: Error invoking remote method 'x:y': Error: …
// Strip that plumbing so users see only the meaningful message.
export function errText(e: unknown): string {
  let m = e instanceof Error ? e.message : String(e)
  m = m.replace(/^Error invoking remote method '[^']*':\s*/i, '')
  m = m.replace(/^(?:Uncaught \(in promise\)\s*)?Error:\s*/i, '')
  return m.trim()
}
