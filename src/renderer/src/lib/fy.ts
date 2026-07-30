// Indian financial year helpers (1 April — 31 March).

export function fyStartYear(dateISO?: string): number {
  const d = dateISO ? new Date(`${dateISO}T00:00:00`) : new Date()
  return d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1
}

export function fyBounds(startYear: number): { from: string; to: string } {
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` }
}

export function fyLabel(startYear: number): string {
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

// The current FY and a few back — enough for every register's quick filter.
export function fyOptions(count = 4): { label: string; from: string; to: string }[] {
  const cur = fyStartYear()
  return Array.from({ length: count }, (_, i) => {
    const y = cur - i
    return { label: fyLabel(y), ...fyBounds(y) }
  })
}
