import * as React from 'react'
import { DbStatus } from '@/components/DbStatus'
import { LiveVersionBadge } from '@/components/LiveVersionBadge'
import { UpdateBadge } from '@/components/UpdateBadge'
import { InfoTip } from '@/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCompany, useHeaderExtras } from '@/lib/companyContext'
import { useIsMobile } from '@/lib/useIsMobile'
import { cn } from '@/lib/utils'

interface Props {
  title: string
  subtitle?: string
  hint?: string
  actions?: React.ReactNode
  // Sits to the LEFT of the title, before it — for a Back button on a form
  // page, where "back" belongs at the start of the line the eye reads first,
  // not filed among the actions on the right.
  leading?: React.ReactNode
}

// The active company, switchable from any page's header — not just the
// sidebar's own picker, which on mobile sits behind a tap to open the whole
// overlay. Reads from CompanyProvider (see App.tsx) instead of taking props,
// so every page that already renders <PageHeader> gets it for free.
function HeaderCompanySwitcher(): React.JSX.Element | null {
  const { companies, companyId, onCompanyChange } = useCompany()
  const active = companies.filter((c) => c.active)
  // Shown even when there is only one company to pick. It used to hide in
  // that case, which was fine while the sidebar also named the active
  // company — now that the sidebar's switcher is gone, hiding this would
  // leave no indication anywhere of which books you are in.
  if (active.length === 0) return null
  return (
    <Select value={String(companyId || '')} onValueChange={onCompanyChange}>
      <SelectTrigger className={cn('h-8 w-auto min-w-[7rem] max-w-[10rem] gap-1.5 text-xs', __WEB__ && '!max-w-[13rem]')}>
        <SelectValue placeholder="Company" />
      </SelectTrigger>
      <SelectContent>
        {active.map((c) => (
          <SelectItem key={String(c.id)} value={String(c.id)}>{String(c.name)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function PageHeader({ title, subtitle, hint, actions, leading }: Props): React.JSX.Element {
  const { bell } = useHeaderExtras()
  const isMobile = useIsMobile()
  return (
    <div
      className={cn(
        'sticky top-0 z-10 flex items-start justify-between gap-4 border-b bg-background/80 px-4 py-4 backdrop-blur',
        // Opaque, and above the registers.
        //
        // The header was 80% background with a blur behind it, which is fine
        // over body text and not fine over a forest-green table head — on
        // Treasury the LC register's own sticky <thead> is `top-0 z-10` too,
        // the same layer as this, and being later in the DOM it won the tie
        // and painted straight over the page title. z-30 settles the order and
        // a solid ground stops anything showing through underneath.
        __WEB__ && '!z-30 !bg-background !backdrop-blur-none',
        // The sidebar's tap-to-open button is fixed in the top-left corner on
        // the website at phone width, and every page's title was sitting
        // underneath it. Clear it, and let the row wrap so the actions drop
        // to a second line rather than squeezing the title.
        __WEB__ && isMobile && 'flex-wrap gap-y-2 !pl-[60px]'
      )}
    >
      {leading && <div className="flex shrink-0 items-center self-center">{leading}</div>}
      <div>
        <div className="flex items-center gap-1.5">
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          {hint && <InfoTip text={hint} className="mt-0.5" />}
        </div>
        {/* The website drops the subtitle line from every page header — the
            title plus the ⓘ says enough, and the sentence was costing a row
            of height on each screen. The hint tooltip still carries the long
            explanation, so nothing is lost. The desktop app keeps it. */}
        {subtitle && !__WEB__ && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {/* One height and one corner radius for everything in the action
          cluster. Each control arrives at a different size of its own — the
          company Select at 32, an outline Button at 32, a page's primary CTA
          at 44, the status dot at 32 — and side by side that reads as a row
          of mismatched boxes. Set here rather than per page so every screen
          in the app lines up the same way. */}
      <div
        className={cn(
          'ml-auto flex shrink-0 items-center gap-2',
          __WEB__ &&
            '[&_button]:!h-9 [&_button]:!rounded-[4px] [&_button]:!text-[13px] [&_[data-slot=select-trigger]]:!h-9 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!text-[13px]'
        )}
      >
        {/* Beside UpdateBadge, which is the same message for the desktop
            app: your copy is behind the one that shipped. Only one of the two
            can ever render. */}
        <LiveVersionBadge />
        <UpdateBadge />
        <DbStatus dotOnly className={cn(__WEB__ && '!h-9 !w-9')} />
        <HeaderCompanySwitcher />
        {actions}
        {bell}
      </div>
    </div>
  )
}
