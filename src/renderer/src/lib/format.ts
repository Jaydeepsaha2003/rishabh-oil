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
