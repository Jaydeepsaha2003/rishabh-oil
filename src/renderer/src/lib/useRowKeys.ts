import { useEffect, useRef, useState } from 'react'
import { OVERLAY_SELECTOR } from './escape'

/**
 * KEYBOARD ON A REGISTER LIST: ↑ ↓ pick a row, PgUp / PgDn ten at a time,
 * Home / End the ends, Enter opens the picked row; ← → (when given) step
 * through the list's tabs. The picked row carries data-rk={index} and is
 * scrolled into view. Typing in a box is left alone, except ↑ ↓ and Enter
 * from the list's own search box, which reach the list.
 */
export function useRowKeys(
  count: number,
  onEnter: (i: number) => void,
  opts: { onLeft?: () => void; onRight?: () => void; resetOn?: unknown[] } = {}
): { sel: number; setSel: (i: number) => void } {
  const [sel, setSel] = useState(-1)
  const live = useRef({ count, onEnter, opts, sel })
  live.current = { count, onEnter, opts, sel }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setSel(-1), opts.resetOn ?? [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      if (document.querySelector(OVERLAY_SELECTOR)) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      const typing = tag === 'TEXTAREA' || tag === 'SELECT' || !!t?.isContentEditable || tag === 'INPUT'
      const searchBox = tag === 'INPUT' && ['text', 'search', ''].includes((t as HTMLInputElement).type)
      if (typing && !(searchBox && ['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key))) return
      const { count: c, onEnter: go, opts: o, sel: s } = live.current
      const move = (to: number): void => {
        e.preventDefault()
        if (!c) return
        const i = Math.max(0, Math.min(c - 1, to))
        setSel(i)
        requestAnimationFrame(() => document.querySelector(`[data-rk="${i}"]`)?.scrollIntoView({ block: 'nearest' }))
      }
      if (e.key === 'ArrowDown') move(s + 1)
      else if (e.key === 'ArrowUp') move(s < 0 ? 0 : s - 1)
      else if (e.key === 'PageDown') move(s + 10)
      else if (e.key === 'PageUp') move(s - 10)
      else if (e.key === 'Home' && !typing) move(0)
      else if (e.key === 'End' && !typing) move(c - 1)
      else if (e.key === 'Enter' && s >= 0 && s < c) {
        e.preventDefault()
        go(s)
      } else if (e.key === 'ArrowLeft' && o.onLeft && !typing) {
        e.preventDefault()
        o.onLeft()
      } else if (e.key === 'ArrowRight' && o.onRight && !typing) {
        e.preventDefault()
        o.onRight()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return { sel, setSel }
}
