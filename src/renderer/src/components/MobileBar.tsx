// The strip across the top of every mobile page.
// -----------------------------------------------------------------------------
// Menu on the left, the company in the middle, refresh on the right. It exists
// so those three controls are in the same place on every screen — a phone has
// no room to hunt, and the sidebar's old floating button landed on top of each
// page's title.
//
// THE REFRESH BUTTON IS NOT A CONVENIENCE. Installed to an iPhone home screen
// the app runs standalone: no address bar, no pull-to-reload, no way at all to
// ask for fresh data. Every page polls (useLiveRefresh), but a poll that has
// not come round yet is indistinguishable from a page that has stopped
// working, and on iOS there was nothing to press. This is that button.
//
// It draws no background of its own: it belongs as the first child of the
// page's own forest header, so it inherits that colour and reads as part of it
// rather than as a second bar.
import React, { useEffect, useState } from 'react'
import { Building2, ChevronDown, MoreVertical, RefreshCw } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useCompany } from '@/lib/companyContext'
import { useMobileMenu } from '@/lib/mobileMenu'
import { cn } from '@/lib/utils'

export function MobileBar({
  onRefresh,
  children,
  tone = 'forest'
}: {
  // The page's own reload. Awaited, so the icon can spin while it runs and the
  // press is acknowledged — on a phone a tap with no feedback reads as a tap
  // that missed.
  onRefresh?: () => void | Promise<void>
  // Anything the page wants between the menu and the refresh. Left empty, the
  // company switcher takes the space.
  children?: React.ReactNode
  // StockMobile's Opening Stock wears violet; everything else is forest.
  tone?: 'forest' | 'violet'
}): React.JSX.Element {
  const { setOpen, registerBar } = useMobileMenu()
  const { companies, companyId, onCompanyChange } = useCompany()
  const [spinning, setSpinning] = useState(false)

  // Tells the sidebar it does not need its floating trigger on this page.
  useEffect(() => registerBar(), [registerBar])

  async function refresh(): Promise<void> {
    if (spinning) return
    setSpinning(true)
    try {
      await onRefresh?.()
    } finally {
      // Held briefly on purpose. A reload that answers in 40ms would otherwise
      // flash and look like nothing happened, which is the problem this button
      // exists to solve.
      setTimeout(() => setSpinning(false), 450)
    }
  }

  const btn = cn(
    'flex h-10 w-10 flex-none items-center justify-center rounded-[4px] transition-colors',
    tone === 'violet'
      ? 'bg-white/[.14] text-white active:bg-white/25'
      : 'bg-white/[.12] text-[#C7F03F] active:bg-white/25'
  )
  const active = companies.find((c) => Number(c.id) === Number(companyId))
  // Nothing to switch between — one company, or the list has not loaded — so
  // the control is not drawn at all rather than shown as a dead chip.
  const canSwitch = companies.length > 1

  return (
    <div className="mb-2 flex min-h-11 items-center gap-2">
      <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className={btn}>
        <MoreVertical className="h-[22px] w-[22px]" />
      </button>

      <div className="flex min-w-0 flex-1 items-center">
        {children ??
          (canSwitch ? (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Switch company"
                  className={cn(
                    'flex h-10 min-w-0 max-w-full items-center gap-1.5 rounded-[4px] px-2.5 transition-colors',
                    tone === 'violet'
                      ? 'bg-white/[.14] text-white active:bg-white/25'
                      : 'bg-white/[.12] text-white active:bg-white/25'
                  )}
                >
                  <Building2 className="h-4 w-4 flex-none opacity-80" />
                  <span className="min-w-0 truncate text-[12px] font-extrabold">
                    {String(active?.name || 'Company')}
                  </span>
                  <ChevronDown className="h-4 w-4 flex-none opacity-80" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="max-h-[60vh] w-[248px] overflow-y-auto p-0">
                <p className="border-b border-b-[#EAF0E9] px-3 py-2 text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#7C9188]">
                  Working in
                </p>
                {companies.map((c) => {
                  const on = Number(c.id) === Number(companyId)
                  return (
                    <button
                      key={String(c.id)}
                      type="button"
                      onClick={() => onCompanyChange(String(c.id))}
                      className="flex min-h-11 w-full items-center gap-2.5 border-b border-b-[#EAF0E9] px-3 py-2 text-left last:border-b-0"
                      style={{ background: on ? '#EFF5EC' : '#fff' }}
                    >
                      {/* The colour each company is given elsewhere in the app,
                          so the switcher and the registers agree about which is
                          which. */}
                      <span
                        className="h-2.5 w-2.5 flex-none rounded-full"
                        style={{ background: String(c.colour || '#0B3D2E') }}
                      />
                      <span
                        className={cn('min-w-0 flex-1 truncate text-[12.5px]', on ? 'font-extrabold' : 'font-semibold')}
                      >
                        {String(c.name)}
                      </span>
                      {on && <span className="flex-none text-[10px] font-extrabold text-[#0B6B45]">CURRENT</span>}
                    </button>
                  )
                })}
              </PopoverContent>
            </Popover>
          ) : null)}
      </div>

      <button
        type="button"
        onClick={() => void refresh()}
        aria-label="Refresh"
        disabled={!onRefresh}
        className={cn(btn, !onRefresh && 'opacity-40')}
      >
        <RefreshCw className={cn('h-[20px] w-[20px]', spinning && 'animate-spin')} />
      </button>
    </div>
  )
}
