import { useState } from 'react'
import { StickyNote } from 'lucide-react'
import { cn } from '@/lib/utils'

// A BARGAIN'S NOTE, ON ITS PHONE CARD.
//
// The note is where the desk writes what the contract does not say — and where
// every balance adjustment and move adds its line — so it is labelled and kept
// to its own lines rather than run together. A long one folds to three lines,
// and opening it does not also open the card underneath.
export function BargainNote({ text }: { text: unknown }): React.JSX.Element | null {
  const [all, setAll] = useState(false)
  const t = String(text ?? '').trim()
  if (!t) return null
  const long = t.split('\n').length > 3 || t.length > 180
  return (
    <div className="rounded-[4px] border border-[#F0E3BD] border-l-[3px] border-l-[#C2700A] bg-[#FFFBF2] px-[11px] py-2">
      <div className="flex items-center gap-1.5 text-[9px] font-extrabold uppercase tracking-[.09em] text-[#8A5300]">
        <StickyNote className="h-3.5 w-3.5" /> Note
      </div>
      <div
        className={cn(
          'mt-1 whitespace-pre-line text-[12px] font-semibold leading-[1.5] text-[#33473E] [overflow-wrap:anywhere]',
          long && !all && 'line-clamp-3'
        )}
      >
        {t}
      </div>
      {long && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setAll((v) => !v)
          }}
          className="mt-1 text-[11px] font-extrabold text-[#0B6B45]"
        >
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  )
}
