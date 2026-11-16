import { useState } from 'react'
import { MessageSquareText, Palette, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

// A breakdown part's highlight (journal_line_splits.color) — a key, so the
// look can change without touching saved rows.
export const SPLIT_COLORS: Record<string, { label: string; box: string; dot: string }> = {
  red: { label: 'Red', box: '!border-[#E7A39C] !bg-[#FDECEA] !text-[#8C2F26]', dot: 'bg-[#D9534A]' },
  amber: { label: 'Amber', box: '!border-[#E8C27A] !bg-[#FFF4DC] !text-[#7A4B00]', dot: 'bg-[#E0A325]' },
  green: { label: 'Green', box: '!border-[#9CCFB0] !bg-[#E6F5EC] !text-[#0B5E3C]', dot: 'bg-[#2E9E62]' },
  blue: { label: 'Blue', box: '!border-[#A9C4E6] !bg-[#EAF1FB] !text-[#1B4E82]', dot: 'bg-[#3B7DD8]' },
  pink: { label: 'Pink', box: '!border-[#EBA9C8] !bg-[#FDEEF5] !text-[#8E2A5C]', dot: 'bg-[#D6538F]' },
  violet: { label: 'Violet', box: '!border-[#C7B3E8] !bg-[#F3EEFC] !text-[#5B3A9A]', dot: 'bg-[#8A63D2]' },
  grey: { label: 'Grey', box: '!border-[#C3CCC6] !bg-[#F0F3F1] !text-[#3E4C45]', dot: 'bg-[#8A978F]' }
}
export const splitBox = (c?: string | null): string => (c && SPLIT_COLORS[c] ? SPLIT_COLORS[c].box : '')

/** Colour swatch + remark button for one breakdown part. */
export function SplitPartTools({
  color,
  remark,
  onColor,
  onRemark
}: {
  color?: string
  remark?: string
  onColor: (c: string | undefined) => void
  onRemark: (r: string | undefined) => void
}): React.JSX.Element {
  const [colorOpen, setColorOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const has = !!(remark && remark.trim())
  const btn = 'flex h-8 w-8 flex-none items-center justify-center rounded-[3px] border bg-white'
  return (
    <>
      <Popover open={colorOpen} onOpenChange={setColorOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Highlight this amount"
            aria-label="Highlight colour"
            className={cn(btn, 'border-[#C3D2C6] text-[#8CA396] hover:border-[#1B4E82] hover:text-[#1B4E82]')}
          >
            {color && SPLIT_COLORS[color] ? <span className={cn('h-3.5 w-3.5 rounded-full ring-2 ring-white', SPLIT_COLORS[color].dot)} /> : <Palette className="h-3.5 w-3.5" />}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-auto p-2">
          <div className="mb-1.5 text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Highlight the amount</div>
          <div className="flex items-center gap-1.5">
            {Object.entries(SPLIT_COLORS).map(([k, c]) => (
              <button
                key={k}
                type="button"
                title={c.label}
                aria-label={c.label}
                onClick={() => {
                  onColor(k)
                  setColorOpen(false)
                }}
                className={cn('h-6 w-6 rounded-full border-2', c.dot, color === k ? 'border-[#0A1F17]' : 'border-white shadow-[0_0_0_1px_#C3D2C6]')}
              />
            ))}
            <button
              type="button"
              title="No colour"
              aria-label="No colour"
              onClick={() => {
                onColor(undefined)
                setColorOpen(false)
              }}
              className="flex h-6 w-6 items-center justify-center rounded-full border border-[#C3D2C6] bg-white text-[#8CA396] hover:text-[#B3261E]"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {/* The remark: read on hover, written on click. */}
      <Popover open={noteOpen || (hover && has)} onOpenChange={(o) => { setNoteOpen(o); if (!o) setHover(false) }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            onClick={() => setNoteOpen(true)}
            title={has ? undefined : 'Add a note on this part'}
            aria-label={has ? 'Note on this part' : 'Add a note'}
            className={cn(
              btn,
              'relative',
              has ? 'border-[#E8C27A] bg-[#FFF8E6] text-[#8A5300] hover:bg-[#FFF1CF]' : 'border-[#C3D2C6] text-[#8CA396] hover:border-[#1B4E82] hover:text-[#1B4E82]'
            )}
          >
            <MessageSquareText className="h-3.5 w-3.5" />
            {has && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[#E0A325] ring-2 ring-white" />}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[300px] p-0"
          onOpenAutoFocus={(e) => {
            // Hover only shows it; focus moves in only when it was clicked.
            if (!noteOpen) e.preventDefault()
          }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          <div className="flex items-center gap-1.5 border-b border-[#EEF3EE] bg-[#FFFBF0] px-3 py-1.5 text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#8A5300]">
            <MessageSquareText className="h-3 w-3" /> Note on this part
          </div>
          {noteOpen ? (
            <div className="p-2.5">
              <textarea
                autoFocus
                rows={4}
                value={remark || ''}
                onChange={(e) => onRemark(e.target.value || undefined)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) setNoteOpen(false)
                }}
                placeholder="Anything worth knowing about this part — who, why, reference…"
                className="w-full resize-y rounded-[4px] border border-[#C3D2C6] bg-white px-2 py-1.5 text-[12.5px] outline-none focus:border-[#1B4E82]"
              />
              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-[10.5px] font-semibold text-[#8CA396]">Saved with the breakdown</span>
                {has && (
                  <button type="button" onClick={() => onRemark(undefined)} className="ml-auto text-[11px] font-bold text-[#B3261E] hover:underline">
                    Remove
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setNoteOpen(false)}
                  className={cn('rounded-[3px] bg-[#0B3D2E] px-2.5 py-0.5 text-[11px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38]', !has && 'ml-auto')}
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <div className="whitespace-pre-wrap px-3 py-2 text-[12.5px] text-[#0A1F17]">{remark}</div>
          )}
        </PopoverContent>
      </Popover>
    </>
  )
}
