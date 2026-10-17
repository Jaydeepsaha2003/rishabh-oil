import { cn } from '@/lib/utils'

// A CARD'S PLACE IN THE LIST, ON A PHONE.
//
// The desktop registers are tables, and a reader can say "the fourth one down"
// and be understood. A phone card list had no such handle — two people looking
// at the same screen had to read a bargain number aloud to agree which card
// they meant. This is the S.No column, carried onto the card: counted down the
// list as it stands, so it follows the filters and the sort in view.
//
// Deliberately quiet and square, and never written with a "#" — the Production
// sheet's "#1" is a run's own number for the day, which this is not.
export function SerialNo({ n, className }: { n: number; className?: string }): React.JSX.Element {
  return (
    <span
      aria-label={`S.No ${n}`}
      title="S.No — its place in this list"
      className={cn(
        'doc-ref inline-flex h-[20px] min-w-[20px] flex-none items-center justify-center rounded-[3px] border border-[#D6E2D6] bg-[#F1F5EF] px-[5px] text-[10.5px] font-extrabold leading-none tabular-nums text-[#5A6B62]',
        className
      )}
    >
      {n}
    </span>
  )
}
