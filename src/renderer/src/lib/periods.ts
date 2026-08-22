// Calendar-period presets for the PeriodPicker dropdown. "Quarter" and "Year"
// follow this app's Indian financial year convention (Apr–Mar), matching
// fy.ts/FyPicker elsewhere, rather than a calendar-year quarter.
import { fyBounds, fyStartYear } from './fy'

function pad(v: number): string {
  return String(v).padStart(2, '0')
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function weekBounds(d: Date): { from: string; to: string } {
  const day = d.getDay() // 0=Sun..6=Sat
  const mondayOffset = day === 0 ? -6 : 1 - day
  const monday = new Date(d)
  monday.setDate(d.getDate() + mondayOffset)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  return { from: isoOf(monday), to: isoOf(sunday) }
}

function monthBounds(d: Date): { from: string; to: string } {
  const y = d.getFullYear()
  const m = d.getMonth()
  return { from: isoOf(new Date(y, m, 1)), to: isoOf(new Date(y, m + 1, 0)) }
}

function quarterBounds(d: Date): { from: string; to: string } {
  const y = d.getFullYear()
  const m = d.getMonth() // 0-11
  const fyStartYear = m >= 3 ? y : y - 1
  const monthsSinceApr = ((m - 3) + 12) % 12
  const qIndex = Math.floor(monthsSinceApr / 3) // 0..3
  const start = new Date(fyStartYear, 3 + qIndex * 3, 1)
  const end = new Date(start.getFullYear(), start.getMonth() + 3, 0)
  return { from: isoOf(start), to: isoOf(end) }
}

export interface PeriodOption {
  key: string
  label: string
  from: string
  to: string
}

// The quick-pick list, freshly computed against "now" every time it's read.
export function periodOptions(): PeriodOption[] {
  const now = new Date()
  const today = isoOf(now)
  const week = weekBounds(now)
  const month = monthBounds(now)
  const quarter = quarterBounds(now)
  const year = fyBounds(fyStartYear())
  return [
    { key: 'today', label: 'Today', from: today, to: today },
    { key: 'week', label: 'This week', ...week },
    { key: 'month', label: 'This month', ...month },
    { key: 'quarter', label: 'This quarter', ...quarter },
    { key: 'year', label: 'This financial year', ...year }
  ]
}
