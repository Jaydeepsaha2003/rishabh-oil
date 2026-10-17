// The Dashboard's Customize panel: every KPI and card, with a switch each.
// Changes show on the board the moment they are made, and are kept per user —
// see useDashLayout.
import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Check, Eye, EyeOff, LayoutGrid, RotateCcw, SlidersHorizontal, X } from 'lucide-react'
import type { DashTheme } from '@/lib/dashTheme'
import { DASH_GROUPS, dashItemsHere, type DashLayout } from '@/lib/dashLayout'

export function DashCustomizeButton({
  t,
  layout,
  onClick,
  compact
}: {
  t: DashTheme
  layout: DashLayout
  onClick: () => void
  compact?: boolean
}): React.JSX.Element {
  const hiddenHere = dashItemsHere().filter((i) => layout.hidden.has(i.key)).length
  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label="Customize the dashboard"
        className="relative flex h-10 w-10 flex-none items-center justify-center rounded-[4px] bg-white/[.12] text-[#C7F03F] active:bg-white/25"
      >
        <SlidersHorizontal className="h-[20px] w-[20px]" />
        {hiddenHere > 0 && (
          <span className="doc-ref absolute -right-1 -top-1 min-w-[18px] rounded-full bg-[#C7F03F] px-1 text-center text-[10px] font-extrabold leading-[18px] text-[#0B3D2E]">
            {hiddenHere}
          </span>
        )}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title="Choose which KPIs and cards the dashboard shows"
      className="flex h-10 items-center gap-2 rounded-[4px] px-[13px] text-[12.5px] font-extrabold"
      style={{ color: t.ink2, background: t.inset, border: `1px solid ${t.bd}` }}
    >
      <SlidersHorizontal className="h-[17px] w-[17px]" style={{ color: t.accent }} />
      Customize
      {hiddenHere > 0 && (
        <span className="doc-ref rounded-full px-1.5 py-px text-[10.5px] font-extrabold" style={{ background: t.accentSoft, color: t.accent }}>
          {hiddenHere} hidden
        </span>
      )}
    </button>
  )
}

export function DashCustomize({
  t,
  dark,
  isMobile,
  layout,
  onClose
}: {
  t: DashTheme
  dark: boolean
  isMobile: boolean
  layout: DashLayout
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const items = dashItemsHere()
  const shown = items.filter((i) => layout.isOn(i.key)).length

  const Switch = ({ on }: { on: boolean }): React.JSX.Element => (
    <span
      aria-hidden
      className="relative inline-flex h-[22px] w-[38px] flex-none items-center rounded-full transition-colors"
      style={{ background: on ? t.accent : t.track, border: `1px solid ${on ? t.accentBd : t.bd}` }}
    >
      <span
        className="absolute h-[16px] w-[16px] rounded-full transition-transform"
        style={{ background: on ? (dark ? '#0A1F17' : '#fff') : t.faint, transform: `translateX(${on ? 18 : 3}px)` }}
      />
    </span>
  )

  // Portalled for the same reason as the plan editor: the board's 3D
  // perspective would otherwise pin this inside the board instead of the screen.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" style={{ background: 'rgba(4,21,15,.55)' }} onClick={onClose}>
      <div
        role="dialog"
        aria-label="Customize the dashboard"
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[92dvh] w-full flex-col overflow-hidden ${isMobile ? 'rounded-t-[8px]' : 'max-w-[720px] rounded-[8px]'}`}
        style={{ background: dark ? '#07211A' : '#fff', border: `1px solid ${t.bd}`, color: t.ink, boxShadow: '0 20px 60px rgba(0,0,0,.35)' }}
      >
        <div className="flex items-center gap-2.5 px-4 py-3.5" style={{ borderBottom: `1px solid ${t.hair}` }}>
          <LayoutGrid className="h-5 w-5" style={{ color: t.accent }} />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-extrabold">Customize the dashboard</div>
            <div className="text-[11.5px] font-semibold" style={{ color: t.muted }}>
              {shown} of {items.length} shown · kept for you on every device
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-[4px]" style={{ color: t.muted }}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3.5">
          {DASH_GROUPS.map((g) => {
            const list = items.filter((i) => i.group === g.key)
            const on = list.filter((i) => layout.isOn(i.key)).length
            return (
              <section key={g.key}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10.5px] font-extrabold uppercase tracking-[.14em]" style={{ color: t.accent }}>
                    {g.label}
                  </span>
                  <span className="doc-ref text-[10.5px] font-bold" style={{ color: t.faint }}>
                    {on}/{list.length}
                  </span>
                  <span className="h-px min-w-4 flex-1" style={{ background: t.hair }} />
                  <button
                    type="button"
                    onClick={() => layout.setMany(list.map((i) => i.key), true)}
                    className="inline-flex items-center gap-1 text-[11px] font-extrabold"
                    style={{ color: on === list.length ? t.faint : t.accent }}
                    disabled={on === list.length}
                  >
                    <Eye className="h-3.5 w-3.5" /> Show all
                  </button>
                  <button
                    type="button"
                    onClick={() => layout.setMany(list.map((i) => i.key), false)}
                    className="inline-flex items-center gap-1 text-[11px] font-extrabold"
                    style={{ color: on === 0 ? t.faint : t.muted }}
                    disabled={on === 0}
                  >
                    <EyeOff className="h-3.5 w-3.5" /> Hide all
                  </button>
                </div>
                <div className="mt-1 text-[11px] font-semibold" style={{ color: t.faint }}>
                  {g.hint}
                </div>
                <div className={`mt-2.5 grid gap-2 ${isMobile ? 'grid-cols-1' : 'grid-cols-2'}`}>
                  {list.map((i) => {
                    const isOn = layout.isOn(i.key)
                    return (
                      <button
                        key={i.key}
                        type="button"
                        role="switch"
                        aria-checked={isOn}
                        onClick={() => layout.toggle(i.key)}
                        className="flex items-center gap-2.5 rounded-[5px] px-3 py-2.5 text-left transition-colors"
                        style={{
                          background: isOn ? t.inset : 'transparent',
                          border: `1px solid ${isOn ? t.bd : t.hair}`,
                          opacity: isOn ? 1 : 0.72
                        }}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[12.5px] font-extrabold" style={{ color: isOn ? t.ink : t.muted }}>
                              {i.label}
                            </span>
                            <span
                              className="flex-none rounded-[3px] px-1.5 py-px text-[8.5px] font-extrabold uppercase tracking-[.08em]"
                              style={{ background: t.track, color: t.muted }}
                            >
                              {i.kind === 'kpi' ? 'KPI' : 'Card'}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-[10.5px] font-semibold" style={{ color: t.faint }}>
                            {i.hint}
                          </span>
                        </span>
                        <Switch on={isOn} />
                      </button>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>

        <div className="flex items-center gap-2.5 px-4 py-3" style={{ borderTop: `1px solid ${t.hair}` }}>
          <button
            type="button"
            onClick={layout.showAll}
            disabled={shown === items.length}
            className="inline-flex h-10 items-center gap-1.5 rounded-[4px] px-3 text-[12px] font-extrabold disabled:opacity-50"
            style={{ border: `1px solid ${t.bd}`, color: t.ink2 }}
          >
            <RotateCcw className="h-4 w-4" /> Show everything
          </button>
          <span className="min-w-0 flex-1 truncate text-right text-[11px] font-semibold" style={{ color: layout.failed ? t.red : t.faint }}>
            {layout.failed ? 'Not saved to your account — kept on this device only' : layout.saving ? 'Saving…' : 'Saved'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center gap-1.5 rounded-[4px] px-4 text-[12.5px] font-extrabold"
            style={{ background: '#C7F03F', color: '#0B3D2E' }}
          >
            <Check className="h-4 w-4" /> Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
