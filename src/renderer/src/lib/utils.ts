import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

// Readable ink for a colour someone picked themselves.
//
// A company colour is chosen on the Companies page with no thought for what
// will be written on top of it, and both ends of the range turn up in practice
// — a pale sky blue and a near-black navy. Fixed white text disappears on the
// first, fixed dark text on the second, so the foreground is derived from the
// background rather than assumed.
//
// Rec. 709 luminance, the usual approximation; 0.6 is where mid-tones stop
// carrying white comfortably.
export function inkOn(hex: unknown): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  if (!m) return '#0A1F17'
  const v = parseInt(m[1], 16)
  const r = (v >> 16) & 255
  const g = (v >> 8) & 255
  const b = v & 255
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6 ? '#0A1F17' : '#FFFFFF'
}
